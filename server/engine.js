// ============================================================================
// MATCHING ENGINE — XETRA-Prinzip: Price-Time-Priority, Maker-Preis gilt.
// ----------------------------------------------------------------------------
// Aufbau dieser Datei (von innen nach außen):
//   1. Ticks & Rundung            kleinste Preisgrenzen (Aktie 1 / ETF 0,1 Cr)
//   2. Orderbuch                  In-Memory-Bücher, sortierte Einfüge-Logik
//   3. Depot & Cash               Holdings, Avg-Cost, Escrow, Gebühren
//   4. Preis-Schutzband           Anti-Manipulation für Limit-Preise
//   5. Book-Walk                  "Was kostet es, N Stück zu kaufen/verkaufen?"
//                                  -> Preview & ETF-Arbitrage nutzen dieselbe Logik
//   6. Matching                   Taker frisst sich durch die Gegenseite
//   7. Order-API                  placeOrder/cancelOrder: validieren -> escrowen -> matchen
//   8. Market-Maker V2            adaptiver Liquidity Provider (Jitter, Skew, Nachplatzierung)
//   9. Marktdaten                 Ticker, Stats (Volumen/VWAP/Spread/...), Broadcasts
//
// WICHTIG (Vorgabe): Der Market-Maker erzeugt KEINE Kurstrends. Er legt nur
// passive Quotes um den LETZTEN HANDELSPREIS (mit organischem Jitter und
// Bestands-Skew). Kursbewegungen entstehen durch Trades der Teilnehmer.
// ============================================================================
const { db, getSettings, q, addNews } = require('./db');
const bus = require('./bus');

// ---------------------------------------------------------------------------
// 1) TICKS & RUNDUNG
// ---------------------------------------------------------------------------
function tick(sec) { return sec.type === 'etf' ? 10 : 100; } // Aktie: 1 Credit, ETF: 0,1 Credit
function roundToTick(p, sec, dir) {
  const t = tick(sec);
  return dir === 'down' ? Math.floor(p / t) * t : Math.ceil(p / t) * t;
}
const fmtCr = (cent) => (cent / 100).toFixed(2);

// ---------------------------------------------------------------------------
// 2) ORDERBUCH
//    bids absteigend, asks aufsteigend (Preis zuerst, dann Zeit = FIFO).
// ---------------------------------------------------------------------------
const books = new Map(); // secId -> { sec, bids: [], asks: [], last: cent }

function getBook(secId) { return books.get(secId); }

function insertIntoBook(book, o) {
  const arr = o.side === 'buy' ? book.bids : book.asks;
  const i = arr.findIndex(x =>
    o.side === 'buy'
      ? (o.price > x.price || (o.price === x.price && o.created_at < x.created_at))
      : (o.price < x.price || (o.price === x.price && o.created_at < x.created_at)));
  arr.splice(i === -1 ? arr.length : i, 0, o);
  book.ver = (book.ver || 0) + 1;
}
function removeFromBook(book, orderId) {
  book.bids = book.bids.filter(o => o.id !== orderId);
  book.asks = book.asks.filter(o => o.id !== orderId);
  book.ver = (book.ver || 0) + 1;
}

// Vorbereitete Statements für den Heißpfad: einmal kompiliert statt pro Fill.
const st = {
  touch: db.prepare('UPDATE users SET last_active = ? WHERE id = ?'),
  cash: db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?'),
  feeFlag: db.prepare('UPDATE orders SET fee_charged = 1 WHERE id = ?'),
  filled: db.prepare('UPDATE orders SET filled = ? WHERE id = ?'),
  filledDone: db.prepare("UPDATE orders SET status='filled' WHERE id = ?"),
  canceled: db.prepare("UPDATE orders SET status='canceled' WHERE id = ?"),
  delHolding: db.prepare('DELETE FROM holdings WHERE user_id=? AND security_id=?'),
  realized: db.prepare('UPDATE users SET realized_pl = realized_pl + ? WHERE id = ?'),
  trade: db.prepare('INSERT INTO trades(security_id, price, amount, buyer_id, seller_id, created_at) VALUES(?,?,?,?,?,?)'),
  order: db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`),
  bank: db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1")
};

// Broadcast-Sammler: Während der Market-Maker eine Leiste neu legt, entstehen
// ~25 Orders. Statt 13 Buch-Events wird EIN Event am Ende gesendet.
let quiet = 0;
let quietTrades = [];

// Aggregiertes Orderbuch für die UI: [[preis, restmenge], ...] je Seite.
function bookSnapshot(secId, depth = 10) {
  const b = books.get(secId);
  if (!b) return { bids: [], asks: [] };
  const agg = (arr) => {
    const m = new Map();
    for (const o of arr) m.set(o.price, (m.get(o.price) || 0) + (o.amount - o.filled));
    return [...m.entries()].slice(0, depth);
  };
  return { bids: agg(b.bids), asks: agg(b.asks) };
}

// Offene Restmenge einer Buchseite. ignoreUserId: eigene Orders zählen nicht
// (Self-Trade-Prevention) — so sieht ein Spieler seine "echt kaufbare" Menge.
function sideDepth(book, side, ignoreUserId = null) {
  const arr = side === 'buy' ? book.bids : book.asks;
  let sum = 0;
  for (const o of arr) if (o.user_id !== ignoreUserId && o.amount - o.filled > 0) sum += o.amount - o.filled;
  return sum;
}

function loadEngine() {
  books.clear();
  const secs = q.allSecs.all('active');
  const openOrders = db.prepare(`SELECT * FROM orders WHERE status='open' ORDER BY created_at ASC, id ASC`).all();
  const bySec = new Map();
  for (const o of openOrders) {
    if (!bySec.has(o.security_id)) bySec.set(o.security_id, []);
    bySec.get(o.security_id).push(o);
  }
  for (const sec of secs) {
    const lastTrade = db.prepare('SELECT price FROM trades WHERE security_id = ? ORDER BY id DESC LIMIT 1').get(sec.id);
    books.set(sec.id, {
      sec, bids: [], asks: [],
      last: lastTrade ? lastTrade.price : sec.ipo_price
    });
    for (const o of bySec.get(sec.id) || []) insertIntoBook(books.get(sec.id), o);
  }
}

// ---------------------------------------------------------------------------
// 3) DEPOT & CASH
// ---------------------------------------------------------------------------
function touch(userId) { st.touch.run(Date.now(), userId); }

function holdingOf(userId, secId) { const h = q.holding.get(userId, secId); return h ? h.amount : 0; }
function addHolding(userId, secId, delta, price = null) {
  const h = q.holding.get(userId, secId);
  if (!h || h.amount + delta === 0) {
    if (h && h.amount + delta === 0) st.delHolding.run(userId, secId);
    else if (delta !== 0) q.upsertHolding.run(userId, secId, delta, price || 0);
    return;
  }
  let amount = h.amount + delta, avg = h.avg_cost;
  if (delta > 0 && price != null) avg = Math.round((h.avg_cost * h.amount + price * delta) / amount);
  q.upsertHolding.run(userId, secId, amount, avg);
}

// Gebühr = Geldverbrennung pro AUSGEFÜHRTER Order (MM optional befreit).
// Clamp: nie mehr abbuchen als da ist — sonst rutschen Konten ins Minus.
function chargeFee(order) {
  if (order.fee_charged || order.is_mm && getSettings().mm_fee_exempt) return;
  const cash = q.userById.get(order.user_id).cash;
  const fee = Math.min(getSettings().fee_cent, Math.max(0, cash));
  order.fee_charged = 1;
  st.feeFlag.run(order.id);
  if (fee > 0) st.cash.run(-fee, order.user_id);
}

// ---------------------------------------------------------------------------
// 4) PREIS-SCHUTZBAND (Anti-Manipulation)
//    Spieler-Limit-Orders müssen innerhalb von
//    last ± max(limit_band_cents, last * limit_band_pct/100) liegen.
//    Treasury/MM/Admin sind bewusst ausgenommen (AP-Arbitrage braucht weite Limits).
// ---------------------------------------------------------------------------
function priceBand(book) {
  const s = getSettings();
  const bestBid = book.bids[0]?.price || null;
  const bestAsk = book.asks[0]?.price || null;
  const ref = book.last || bestBid || bestAsk || book.sec.ipo_price;
  const bandCents = Math.max(s.limit_band_cents, Math.round(ref * s.limit_band_pct / 100));
  return {
    ref,
    min: Math.max(tick(book.sec), roundToTick(ref - bandCents, book.sec, 'down')),
    max: roundToTick(ref + bandCents, book.sec, 'up')
  };
}
function checkPriceBand(book, price) {
  const { min, max, ref } = priceBand(book);
  if (price < min || price > max) {
    throw new Error(
      `Preis zu weit vom Kurs entfernt (${fmtCr(ref)} ±${getSettings().limit_band_pct}% bzw. ` +
      `min. ${fmtCr(getSettings().limit_band_cents)} Credits). Erlaubt: ${fmtCr(min)} – ${fmtCr(max)}`);
  }
}

// ---------------------------------------------------------------------------
// 5) BOOK-WALK — die zentrale Preisberechnung.
//    Beantwortet: "Was kostet es REALLY, N Stück zu kaufen/verkaufen?"
//    Walks die Gegenseite Level für Level ab (10@50 + 10@55 = 1050, nicht 20@50).
//    Wird genutzt für: Order-Preview (UI), ETF-Arbitrage-Vorschau,
//    Markt-Order-Validierung (Budget & verfügbare Menge).
// ---------------------------------------------------------------------------
// walkBook(book, side, amount, opts) -> { fills, qty, gross, rest, vwap }
//   side='buy'  -> frisst ASKS, gross = Kosten (Cents)
//   side='sell' -> frisst BIDS,  gross = Erlös  (Cents)
//   opts.limitPrice: Walk stoppt am Limit-Preis (kreuzende Reste zählen zu rest)
//   opts.ignoreUserId: dessen Orders werden übersprungen (Self-Trade-Prevention)
function walkBook(book, side, amount, { limitPrice = null, ignoreUserId = null } = {}) {
  const arr = side === 'buy' ? book.asks : book.bids;
  let left = Math.floor(amount), gross = 0;
  const fills = [];
  for (const o of arr) {
    if (left <= 0) break;
    if (limitPrice != null && (side === 'buy' ? o.price > limitPrice : o.price < limitPrice)) break;
    if (o.user_id === ignoreUserId || o.amount - o.filled <= 0) continue;
    const take = Math.min(left, o.amount - o.filled);
    fills.push({ price: o.price, qty: take });
    gross += take * o.price;
    left -= take;
  }
  return { fills, qty: amount - left, gross, rest: left, vwap: amount - left > 0 ? gross / (amount - left) : 0 };
}

// Öffentliche Wrapper für ETF-Arbitrage (etf.js) — ohne Self-Trade-Filter,
// da das Treasury als AP gegen DEN GESAMTEN Markt walked.
function costToBuy(secId, qty) {
  const w = walkBook(books.get(secId), 'buy', qty);
  return { cost: w.gross, shortfall: w.rest, fills: w.fills };
}
function proceedsToSell(secId, qty) {
  const w = walkBook(books.get(secId), 'sell', qty);
  return { proceeds: w.gross, shortfall: w.rest, fills: w.fills };
}

// Order-Preview für die UI: zeigt exakte Fills, Ø-Preis, Gebühr — NICHT ausführend.
function previewOrder(user, { security_id, side, type, price, amount }) {
  const book = books.get(security_id);
  if (!book) throw new Error('Orderbuch nicht initialisiert');
  side = side === 'buy' ? 'buy' : 'sell';
  amount = Math.floor(Number(amount));
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Ungültige Stückzahl');
  const s = getSettings();
  const fee = user ? s.fee_cent : 0;

  if (type === 'market') {
    const w = walkBook(book, side, amount, { ignoreUserId: user?.id });
    return {
      side, type, amount, fee,
      fills: w.fills, matched_qty: w.qty, rest: w.rest,
      avg_price: w.vwap ? Math.round(w.vwap) : null,
      gross: w.gross, // buy: Gesamtkosten, sell: Gesamterlös
      available: sideDepth(book, side === 'buy' ? 'sell' : 'buy', user?.id),
      band: priceBand(book)
    };
  }
  // Limit: sofort matchbare Menge + Rest liegt im Buch (Escrow = limit*amount)
  const w = walkBook(book, side, amount, { limitPrice: price, ignoreUserId: user?.id });
  const escrow = (price || 0) * amount;
  return {
    side, type: 'limit', amount, fee, limit_price: price,
    fills: w.fills, matched_qty: w.qty, rest: w.rest,
    avg_price: w.vwap ? Math.round(w.vwap) : null,
    immediate_gross: w.gross,         // was davon SOFORT executes
    escrow: side === 'buy' ? escrow : 0, // Kauf: treuhänderisch hinterlegt
    est_proceeds: side === 'sell' ? escrow : 0,
    available: sideDepth(book, side === 'buy' ? 'sell' : 'buy', user?.id),
    band: priceBand(book)
  };
}

// ---------------------------------------------------------------------------
// 6) MATCHING — Taker frisst die Gegenseite, Maker-Preis gilt (XETRA).
// ---------------------------------------------------------------------------
function executeFill(taker, maker, price, qty, book) {
  const buyerOrder = taker.side === 'buy' ? taker : maker;
  const sellerOrder = taker.side === 'buy' ? maker : taker;
  const buyer = q.userById.get(buyerOrder.user_id);
  const seller = q.userById.get(sellerOrder.user_id);

  for (const o of [buyerOrder, sellerOrder]) chargeFee(o);

  // Käufer: Limit-Käufe haben price*amount treuhänderisch hinterlegt -> Differenz zurück
  if (buyerOrder.type === 'limit') {
    const refund = (buyerOrder.price - price) * qty; // >= 0
    if (refund > 0) st.cash.run(refund, buyer.id);
  } else {
    st.cash.run(-(price * qty), buyer.id);
  }
  addHolding(buyer.id, book.sec.id, qty, price);

  // Verkäufer: Aktien liegen bei Limit schon im Escrow, bei Market jetzt abbuchen
  st.cash.run(price * qty, seller.id);
  // Einstandspreis: steht die Position noch, ihr Mittelwert; ist sie durch den
  // Verkauf leer (Limit-Verkauf: Aktien liegen im Escrow), der an der Order
  // gemerkte Wert — sonst würde der Gewinn mit 0 gebucht.
  const h = q.holding.get(seller.id, book.sec.id);
  const avg = h ? h.avg_cost : (Number.isFinite(sellerOrder.avg_cost) ? sellerOrder.avg_cost : price);
  st.realized.run((price - avg) * qty, seller.id);
  if (sellerOrder.type === 'market') addHolding(seller.id, book.sec.id, -qty);

  // Maker-Order fortschreiben (Taker erledigt sich selbst in matchOrder)
  maker.filled += qty;
  st.filled.run(maker.filled, maker.id);
  if (maker.filled >= maker.amount) {
    maker.status = 'filled';
    st.filledDone.run(maker.id);
    removeFromBook(book, maker.id);
  }

  book.last = price;
  book.ver = (book.ver || 0) + 1;
  st.trade.run(book.sec.id, price, qty, buyer.id, seller.id, Date.now());
  q.phIns.run(book.sec.id, Date.now(), price, qty);
  return { security_id: book.sec.id, price, amount: qty, buyer: buyer.username, seller: seller.username, ts: Date.now() };
}

function matchOrder(taker, book) {
  const trades = [];
  const opposite = () => taker.side === 'buy' ? book.asks : book.bids;
  let budget = null;
  if (taker.type === 'market' && taker.side === 'buy') {
    budget = q.userById.get(taker.user_id).cash - (taker.is_mm && getSettings().mm_fee_exempt ? 0 : getSettings().fee_cent);
    if (budget < 0) budget = 0;
  }
  while (taker.filled < taker.amount) {
    const arr = opposite();
    const maker = arr.find(o => o.user_id !== taker.user_id && o.amount - o.filled > 0); // Self-Trade-Prevention strikt
    if (!maker) break;
    if (taker.type === 'limit') {
      if (taker.side === 'buy' && maker.price > taker.price) break;
      if (taker.side === 'sell' && maker.price < taker.price) break;
    }
    let qty = Math.min(taker.amount - taker.filled, maker.amount - maker.filled);
    if (budget != null) {
      qty = Math.min(qty, Math.floor(budget / maker.price));
      if (qty <= 0) break;
      budget -= qty * maker.price;
    }
    if (qty <= 0) break;
    trades.push(executeFill(taker, maker, maker.price, qty, book));
    taker.filled += qty;
  }
  st.filled.run(taker.filled, taker.id);
  if (taker.filled >= taker.amount) {
    taker.status = 'filled';
    st.filledDone.run(taker.id);
    removeFromBook(book, taker.id);
  } else if (taker.type === 'market') {
    taker.status = 'canceled'; // Rest verfällt (XETRA: Market-Orders liegen nicht im Buch)
    st.canceled.run(taker.id);
  }
  return trades;
}

// ---------------------------------------------------------------------------
// 7) ORDER-API: validieren -> escrowen -> matchen -> MM nachziehen.
// ---------------------------------------------------------------------------
function placeOrder(user, { security_id, side, type, price, amount }, opts = {}) {
  const sec = q.secById.get(security_id);
  if (!sec || sec.status !== 'active') throw new Error('Wertpapier nicht handelbar');
  const book = books.get(sec.id);
  if (!book) throw new Error('Orderbuch nicht initialisiert');
  side = side === 'buy' ? 'buy' : 'sell';
  amount = Math.floor(Number(amount));
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e6) throw new Error('Ungültige Stückzahl');
  const isMM = !!opts.mm;
  const isPlayer = user.role === 'user' && !isMM; // Band- & Tiefen-Schutz nur für Spieler
  if (user.frozen && !isMM) throw new Error('Konto eingefroren – BaFin ermittelt');
  if (user.role === 'user' && !isMM) touch(user.id);

  // Founder-Lock-up: eigene Aktien in den ersten Wochen nicht verkaufen
  if (!isMM && sec.type === 'stock' && side === 'sell' && sec.founder_id === user.id && Date.now() < sec.lockup_until) {
    throw new Error(`Lock-up: Du darfst Deine Gründeraktien noch nicht verkaufen (bis ${new Date(sec.lockup_until).toLocaleString('de-DE')})`);
  }
  const s = getSettings();
  // Pause („Börse verwalten" → Spiel): Spieler und Bots können nicht handeln,
  // der Market-Maker quotiert weiter, damit die Bücher erhalten bleiben.
  if (isPlayer && s.trading_paused) throw new Error('Die Börse macht gerade Pause.');
  const feeReserve = (isMM && s.mm_fee_exempt) ? 0 : s.fee_cent;

  // --- Validierung VOR Ausführung: Preis-Band & Markt-Order-Schutz ---
  if (type === 'limit') {
    price = Math.round(Number(price));
    if (!Number.isInteger(price) || price <= 0 || price % tick(sec) !== 0)
      throw new Error(`Ungültiger Preis (Tick ${tick(sec) / 100} Credits)`);
    if (isPlayer) checkPriceBand(book, price);
  } else if (type !== 'market') {
    throw new Error('Ungültiger Ordertyp');
  }
  if (type === 'market' && isPlayer) {
    // Markt-Orders können nur füllen, was im Buch liegt — vorher ehrlich ablehnen
    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    const available = sideDepth(book, oppositeSide, user.id);
    if (amount > available)
      throw new Error(`Nicht genug Liquidität: nur ${available} Stück ${side === 'buy' ? 'kaufbar (Asks)' : 'verkaufbar (Bids)'} — reduziere die Stückzahl`);
    if (side === 'buy') {
      const { gross } = walkBook(book, 'buy', amount, { ignoreUserId: user.id });
      if (gross + feeReserve > user.cash)
        throw new Error(`Nicht genug Credits: ${fmtCr(gross + feeReserve)} benötigt für ${amount} Stück (Ø ${fmtCr(gross / amount)})`);
    }
  }

  // Limit-Kauf: Geld für die ganze Menge plus Gebühr muss da sein (wird hinterlegt)
  if (type === 'limit' && side === 'buy') {
    const cost = price * amount + feeReserve;
    if (user.cash < cost) throw new Error(`Nicht genug Credits (benötigt ${fmtCr(cost)} inkl. Gebühr)`);
  }

  const order = {
    security_id: sec.id, user_id: user.id, side, type,
    price: null, amount, filled: 0, status: 'open', is_mm: isMM ? 1 : 0,
    fee_charged: 0, created_at: Date.now()
  };

  // Escrow, Insert und Matching in EINER Transaktion: ein Fehler dazwischen
  // hinterlässt keine halbe Buchung (Gebühr, Depot, Trade, Orderstatus).
  let trades;
  try {
    trades = runOrder(order, price, user);
  } catch (e) {
    removeFromBook(book, order.id); // Rollback gilt auch fürs Buch im RAM
    throw e;
  }
  if (type === 'limit' && side === 'buy') user.cash -= price * order.amount;

  if (trades.length && !isMM) mmRecenter(book); // MM folgt dem Marktpreis – nur passive Liquidität
  if (trades.length) checkTakeover(book.sec);
  if (trades.length || order.status === 'open') broadcastChanges(book, trades, user.id);
  return { order: { ...order }, trades, last: book.last };
}

const runOrder = db.transaction((order, price, user) => {
  const book = books.get(order.security_id);
  const isLimit = order.type === 'limit';
  if (isLimit) order.price = price;
  if (isLimit) {
    if (order.side === 'buy') {
      st.cash.run(-(order.price * order.amount), user.id);
    } else {
      // Limit-Verkauf: Aktien wandern ins Escrow. Den Einstandspreis an der
      // Order merken, bevor die Position leerläuft (siehe executeFill).
      const h = q.holding.get(user.id, order.security_id);
      if (!h || h.amount < order.amount) throw new Error('Nicht genug Aktien im Depot');
      order.avg_cost = h.avg_cost;
      addHolding(user.id, order.security_id, -order.amount);
    }
  } else if (order.side === 'sell' && holdingOf(user.id, order.security_id) < order.amount) {
    throw new Error('Nicht genug Aktien im Depot'); // Markt-Verkauf: Prüfung vor jeder Buchung
  }
  order.id = st.order.run(order.security_id, order.user_id, order.side, order.type, order.price, order.amount, 0, 'open', order.is_mm, order.created_at).lastInsertRowid;
  if (isLimit) insertIntoBook(book, order);
  return matchOrder(order, book);
});

// Hebt ALLE offenen Orders eines Nutzers auf (Einfrieren, Löschen) — mit
// Escrow-Rückzahlung und einem Buch-Event je betroffenem Wert.
function cancelUserOrders(userId) {
  let n = 0;
  for (const book of books.values()) {
    let here = 0;
    for (const o of [...book.bids, ...book.asks].filter(x => x.user_id === userId)) {
      const remaining = o.amount - o.filled;
      if (o.side === 'buy') st.cash.run(o.price * remaining, userId);
      else addHolding(userId, o.security_id, remaining, Number.isFinite(o.avg_cost) ? o.avg_cost : o.price);
      removeFromBook(book, o.id);
      o.status = 'canceled';
      st.canceled.run(o.id);
      here++;
    }
    if (here) { n += here; broadcastChanges(book, [], null); }
  }
  if (n) bus.emit({ type: 'dirty', user_id: userId, what: ['portfolio', 'orders'] });
  return n;
}

function cancelOrder(user, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.user_id !== user.id) throw new Error('Order nicht gefunden');
  if (o.status !== 'open') throw new Error('Order ist nicht mehr offen');
  const book = books.get(o.security_id);
  // Die Order im RAM kennt den Einstandspreis der hinterlegten Aktien.
  const mem = [...book.bids, ...book.asks].find(x => x.id === o.id);
  removeFromBook(book, o.id);
  st.canceled.run(o.id);
  const remaining = o.amount - o.filled;
  if (o.side === 'buy') st.cash.run(o.price * remaining, o.user_id);
  else addHolding(o.user_id, o.security_id, remaining, mem && Number.isFinite(mem.avg_cost) ? mem.avg_cost : o.price);
  broadcastChanges(book, [], o.user_id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 8) MARKET-MAKER V2 — adaptiver Liquidity Provider der Staatskasse.
//    Keine symmetrische Perfekt-Treppe mehr (unrealistisch & langweilig), sondern:
//      · Ragged Ladder: Abstände & Größen je Stufe mit Zufalls-Jitter — das Buch
//        sieht aus wie viele Marktteilnehmer, nicht wie eine Maschine.
//      · Referenz-Noise: Quotes zentrieren nicht exakt auf den letzten Kurs,
//        sondern auf einem kleinen Random Walk => organische Buchentwicklung.
//      · Volatilitäts-Skalierung (wie echte LPs): Spread wächst kontinuierlich
//        mit der gemessenen Volatilität (sigma), die Quote-Größen schrumpfen —
//        ruhiger Markt = eng & groß, wilder Markt = breit & klein.
//      · Inventory-Skew (Avellaneda-light): hoher Treasury-Bestand => Quotes
//        tiefer (Bestand abstoßen), niedriger Bestand => Quotes höher (sparsam
//        verkaufen, günstig zurückkaufen). Hält Cash- und Aktienbestand im
//        Gleichgewicht, statt einseitig leergelaufen zu werden.
//      · Momentum-Bremse: nach schneller 10-Min-Bewegung verbreitert der MM
//        beide Seiten => Trends stolpern, es entsteht Mean Reversion statt
//        endloser Einheitsrichtung.
//      · Faires Cash-Budget JE Wert + Teil-Quotes: die Bid-Seite bleibt auch
//        bei vielen Wertpapieren handelbar (früher frass das erste Buch alles).
//      · Nachplatzierung: ist der Streubesitz aufgebraucht UND der Kurs klar
//        über dem IPO, platziert die Staatskasse neue Aktien dazu — der
//        Ask-Seite geht nie die Ware aus (Nachfrage wird beliefert).
//      · Notkredit: droht der Staatskasse das Cash auszugehen (Dividenden,
//        Netto-Verkäufe), stützt die Zentralbank sie wieder auf Spiel-Niveau.
//    Vorgabe bleibt: der MM ist passiv und MEINUNGSLOS — er macht keinen Trend,
//    sondern bietet Liquidität um den zuletzt GEHANDELTEN Kurs.
// ---------------------------------------------------------------------------
// Staatskasse: sehr oft gefragt (jede Stufe einer Leiter). Die ID ändert sich
// nie — also einmal suchen, danach per Primärschlüssel lesen. Der Kontostand
// im Ergebnis ist immer frisch, weil die Zeile bei jedem Lesen neu geholt wird.
let bankId = null;
function treasury() {
  if (bankId == null) {
    const t = st.bank.get();
    if (!t) return undefined;
    bankId = t.id;
  }
  return q.userById.get(bankId);
}

// NAV eines ETF (aus Korb-Preisen) — direkt in der Engine berechnet, da etf.js
// die Engine benötigt (kein zirkulärer Import möglich).
function etfNavApprox(book) {
  if (book.sec.type !== 'etf' || !book.sec.shares_per_unit) return null;
  const rows = db.prepare('SELECT eb.qty, s.id sid FROM etf_baskets eb JOIN securities s ON s.id = eb.stock_id WHERE eb.etf_id = ?').all(book.sec.id);
  if (!rows.length) return null;
  let v = 0;
  for (const r of rows) { const b = books.get(r.sid); v += r.qty * (b ? b.last : 0); }
  return v / book.sec.shares_per_unit;
}

// Referenzpreis inkl. kleinem Random-Walk-Noise. Bei ETFs (Auto-Modus aktiv)
// quotiert der MM NAV-orientiert — genau deshalb kleben echte ETFs intraday
// am NAV: Je weiter der Kurs vom NAV entfernt ist, desto stärker zieht der
// NAV die Referenz an (max. 60%). Bei kleinem Premium wirkt er kaum.
function mmRefPrice(book) {
  const s = getSettings();
  let ref = book.last;
  if (s.etf_auto && book.sec.type === 'etf') {
    const nav = etfNavApprox(book);
    if (nav > 0) {
      const dev = Math.abs(book.last / nav - 1);
      const alpha = Math.min(1, dev / (s.etf_auto_threshold_pct / 100)) * 0.6;
      ref = ref * (1 - alpha) + nav * alpha;
    }
  }
  const noise = (Math.random() * 2 - 1) * (s.mm_noise_bp / 10000);
  return Math.max(tick(book.sec), ref * (1 + noise));
}

// Kursbewegung der letzten 10 Minuten (Momentum-Bremse). Im Bot-Fast-Mode
// komprimiert sich die Zeit ×100 — das Fenster schrumpft mit, sonst hängt die
// Bremse forever an Bewegungen, die "in Fast-Zeit" Ewigkeiten her sind.
function mmRecentMove(book) {
  const winMs = (10 * 60 * 1000) / (getSettings().bot_fast ? 100 : 1);
  const rows = db.prepare('SELECT price FROM price_history WHERE security_id=? AND ts>=? ORDER BY ts ASC LIMIT 1')
    .get(book.sec.id, Date.now() - winMs);
  if (!rows || !rows.price) return 0;
  return book.last / rows.price - 1;
}

// Realisierte Volatilität: Standardabweichung der relativen Kursänderungen der
// letzten Punkte. Null-Renditen (Preis-Sampler alle 30s) werden gefiltert,
// sonst würde der 30s-Takt die Volatilität künstlich nullen. So quotieren echte
// Liquiditäts-Provider: Spread wächst mit sigma, Größe schrumpft mit sigma.
function mmVolatility(book) {
  const rows = db.prepare('SELECT price FROM price_history WHERE security_id=? ORDER BY ts DESC LIMIT 40').all(book.sec.id).reverse();
  const rets = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i - 1].price) continue;
    const r = rows[i].price / rows[i - 1].price - 1;
    if (r !== 0) rets.push(r); // Sampler-Punkte ohne Kurswechsel ignorieren
  }
  if (rets.length < 3) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length);
}

// Ladder für ein Buch: { bids: [{price,size}], asks: [{price,size}] } — ausgefranst.
function mmLadder(book) {
  const s = getSettings();
  const t = treasury();
  const ref = mmRefPrice(book);
  // Inventory-Skew: Überschuss drückt die Quotes, Mangel hebt sie (max ±skew_bp).
  const inv = t ? holdingOf(t.id, book.sec.id) : 0;
  const target = Math.max(50, Math.round(book.sec.total_shares * s.mm_inv_target_pct));
  const skew = Math.max(-1, Math.min(1, (inv - target) / target)) * (s.mm_inv_skew_bp / 10000);
  // Volatilitäts-Skalierung (kontinuierlich): ruhig = eng & groß, wild = breit & klein.
  const volF = Math.max(0.7, Math.min(s.mm_vol_mult_max, s.mm_vol_ref ? mmVolatility(book) / s.mm_vol_ref : 1));
  // Momentum-Bremse als Extrem-Circuit-Breaker obendrauf.
  const guard = Math.abs(mmRecentMove(book)) > s.mm_guard_pct / 100 ? s.mm_guard_widen : 1;
  const sizeScale = 1 / Math.max(1, volF); // in turbulenten Phasen kleinere Quotes (Risiko!)
  const center = ref * (1 - skew);
  const half = s.mm_spread_bp / 10000 / 2;
  const step = s.mm_step_bp / 10000;
  const jit = s.mm_jitter_bp / 10000;
  const levels = Math.max(1, Math.floor(s.mm_levels));
  const bids = [], asks = [];
  for (let i = 0; i < levels; i++) {
    const dist = (half + i * step + Math.random() * jit) * volF * guard;
    const sizeF = 1 + (Math.random() * 2 - 1) * s.mm_size_jitter;
    const size = Math.max(1, Math.round((s.mm_size + i * s.mm_size_step) * sizeF * sizeScale));
    bids.push({ price: Math.max(tick(book.sec), roundToTick(center * (1 - dist), book.sec, 'down')), size });
    asks.push({ price: roundToTick(center * (1 + dist), book.sec, 'up'), size });
  }
  return { bids, asks };
}

// Hebt MM-Quoten eines Werts auf (Escrow zurück ins Treasury-Depot/-konto)
function mmCancelQuotes(book) {
  // Die offenen MM-Orders stehen im RAM — keine Tabellen-Abfrage je Order nötig.
  for (const o of [...book.bids, ...book.asks].filter(x => x.is_mm && x.status === 'open')) {
    const remaining = o.amount - o.filled;
    if (o.side === 'buy') st.cash.run(o.price * remaining, o.user_id);
    else addHolding(o.user_id, o.security_id, remaining, Number.isFinite(o.avg_cost) ? o.avg_cost : undefined);
    removeFromBook(book, o.id);
    o.status = 'canceled';
    st.canceled.run(o.id);
  }
}

// Nachplatzierung: Streubesitz aufgebraucht & Kurs klar über IPO => neue Aktien.
// Nur bei Aktien (ETFs haben die AP-Creation), max. 1x pro 30 Min je Wert —
// im Fast-Mode entsprechend schneller (Zeitkompression), damit das ANGEBOT auf
// eine 100×-Nachfragewelle realistisch reagieren und Pumps begrenzen kann.
const replenishedAt = new Map(); // secId -> ts
function mmMaybeReplenish(book, t) {
  const s = getSettings();
  const sec = book.sec;
  if (sec.type !== 'stock') return;
  // Gesamt-Angebot = Depotbestand + offene MM-Verkaufsorders (Escrow). Die
  // Ask-Reserve hält sonst immer mm_replenish_min Stück im Depot — ohne die
  // Escrow-Zählung würde die Nachplatzierung nie auslösen, obwohl der Float
  // längst von Spielern aufgesaugt wurde.
  const escrowed = db.prepare("SELECT SUM(amount - filled) q FROM orders WHERE security_id=? AND user_id=? AND is_mm=1 AND side='sell' AND status='open'").get(sec.id, t.id).q || 0;
  if (holdingOf(t.id, sec.id) + escrowed > s.mm_replenish_min) return;
  if (book.last < sec.ipo_price * s.mm_replenish_price_mult) return; // schwacher Kurs wird NICHT verwässert
  const cooldownMs = (30 * 60 * 1000) / (s.bot_fast ? 100 : 1);
  const last = replenishedAt.get(sec.id) || 0;
  if (Date.now() - last < cooldownMs) return;
  replenishedAt.set(sec.id, Date.now());
  const qty = Math.max(1, Math.floor(s.mm_replenish_qty));
  db.prepare('UPDATE securities SET total_shares = total_shares + ? WHERE id = ?').run(qty, sec.id);
  sec.total_shares += qty;
  addHolding(t.id, sec.id, qty);
  const n = addNews('ipo', `Nachplatzierung: ${sec.name} (${sec.ticker}) platziert ${qty} neue Aktien`,
    `Die Nachfrage war so groß, dass der Streubesitz der Staatskasse aufgebraucht ist. Die Investment AG platziert ${qty} zusätzliche Aktien am Markt — frisches Angebot für alle, die mitsteigen wollen.`, sec.id);
  bus.emit({ type: 'news', news: n });
}

// Stellt ein Buch nach einem fehlgeschlagenen Recenter aus der DB wieder her
// (die Transaktion wurde zurückgerollt, der RAM könnte noch Orders führen).
function rebuildBook(book) {
  book.bids = [];
  book.asks = [];
  for (const o of db.prepare("SELECT * FROM orders WHERE security_id = ? AND status='open' ORDER BY created_at ASC, id ASC").all(book.sec.id)) insertIntoBook(book, o);
}

// Eine Leiste neu legen = ~25 Orders. Alles läuft in EINER Transaktion und
// sendet am Ende EIN Buch-Event (früher 13).
const recenterBody = db.transaction((book) => {
  const t0 = treasury();
  if (!t0) return false;
  mmCancelQuotes(book);          // alte Leiter abbauen (Escrow fließt zurück)
  mmMaybeReplenish(book, t0);    // ggf. frische Aktien nachlegen, BEVOR neu quotiert wird
  const t = treasury();          // frischer Stand (Cancel-Refunds + Nachplatzierung)
  if (!t) return false;
  const { bids, asks } = mmLadder(book);
  const s = getSettings();

  // Bid-Seite: Cash-Budget FAIR auf alle betreuten Werte verteilen (früher
  // konnte das erste Buch fast die gesamte Cash binden => einseitige Bücher).
  const nActive = [...books.values()].filter((b) => b.sec.mm_enabled).length || 1;
  const cashBudget = Math.floor(t.cash * s.mm_cash_budget_pct / nActive);
  let bidEscrow = 0;
  for (const lvl of bids) {
    let size = lvl.size;
    if (bidEscrow + lvl.price * size > cashBudget) {
      size = Math.floor((cashBudget - bidEscrow) / lvl.price); // Teil-Quote statt Lücke
      if (size < 5) break;
    }
    try {
      placeOrder(t, { security_id: book.sec.id, side: 'buy', type: 'limit', price: lvl.price, amount: size }, { mm: true });
      bidEscrow += lvl.price * size;
    } catch (e) { break; }
  }
  // Ask-Seite: Bestand komplett ausreizen — auch Teil-Quotes (früher wurde eine
  // ganze Stufe übersprungen, nur weil der Restbestand kleiner als die Stufe war).
  // Reserve: über der Nachplatzierungs-Schwelle bleibt Puffer zurück, damit der
  // MM nach Sweep-Orders sofort neu quoten kann; darunter wird bis auf 5 Stück
  // alles angeboten (beidseitige Liquidität geht vor).
  let inv = holdingOf(t.id, book.sec.id);
  const reserve = Math.max(5, Math.floor(s.mm_replenish_min));
  let left = inv > reserve ? inv - reserve : Math.max(0, inv - 5);
  for (const lvl of asks) {
    if (left < 5) break;
    const size = Math.min(lvl.size, left);
    try { placeOrder(q.userById.get(t.id), { security_id: book.sec.id, side: 'sell', type: 'limit', price: lvl.price, amount: size }, { mm: true }); }
    catch (e) { break; }
    left -= size;
  }
  // Gestaffelter Refresh: jedes Buch bekommt seinen eigenen Takt (±30%).
  book.mmNextAt = Date.now() + s.mm_refresh_sec * 1000 * (0.7 + Math.random() * 0.6);
  return true;
});

function mmRecenter(book) {
  if (!book.sec.mm_enabled) return;
  quiet++;
  quietTrades = [];
  let ok = false;
  try {
    ok = recenterBody(book);
  } catch (e) {
    console.error('[Market-Maker] Leiste konnte nicht neu gelegt werden:', e.message);
    rebuildBook(book);
  }
  const pending = quietTrades;
  quietTrades = [];
  quiet--;
  if (!ok) return;
  if (pending.length) checkTakeover(book.sec);
  broadcastChanges(book, pending, null);
}

// Refresh-Loop (jobs ruft alle 3s): nur fällige Bücher + Zentralbank-Notkredit.
// Cooldown 10 Min / Auffüllung auf 25%: die Staatskasse darf über lange
// Testspiele nie ohne Bid-Seite dastehen.
let lastRecapAt = 0;
function mmRefreshAll() {
  const s = getSettings();
  const t = treasury();
  if (t && t.cash < Math.floor(s.treasury_capital * s.mm_recap_min_pct) && Date.now() - lastRecapAt > 10 * 60 * 1000) {
    const topUp = Math.floor(s.treasury_capital * 0.25) - t.cash;
    if (topUp > 0) {
      lastRecapAt = Date.now();
      db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(topUp, t.id);
      const n = addNews('system', 'Notkredit: Zentralbank stützt die Staatskasse',
        `Die Staatskasse war durch Ausschüttungen und Netto-Käufe fast leer gelaufen und hätte keine Kauforders mehr legen können. Die Zentralbank hat sie mit ${(topUp / 100).toFixed(0)} Credits gestützt — der Market Maker bleibt handlungsfähig.`);
      bus.emit({ type: 'news', news: n });
    }
  }
  for (const book of books.values()) {
    if (!book.sec.mm_enabled) continue;
    if (book.mmNextAt === undefined) book.mmNextAt = 0;
    if (book.mmNextAt <= Date.now()) mmRecenter(book);
  }
}

// ---------------------------------------------------------------------------
// 9) MARKTDATEN: Ticker, Stats, Takeover-Check, Broadcasts
// ---------------------------------------------------------------------------
function checkTakeover(sec) {
  if (sec.type !== 'stock' || sec.status !== 'active') return;
  const rows = db.prepare('SELECT user_id, amount FROM holdings WHERE security_id = ?').all(sec.id);
  for (const r of rows) {
    if (r.user_id !== sec.founder_id && r.amount * 2 > sec.total_shares && sec.majority_holder_id !== r.user_id) {
      db.prepare('UPDATE securities SET majority_holder_id = ? WHERE id = ?').run(r.user_id, sec.id);
      sec.majority_holder_id = r.user_id;
      const u = q.userById.get(r.user_id);
      const n = addNews('takeover', `FEINDLICHE ÜBERNAHME: ${u.username} übernimmt ${sec.name}!`,
        `${u.username} hält jetzt über 50% der Anteile an ${sec.name} (${sec.ticker}) und erhält Sonderrechte: Firmenumbenennung und Antrag auf Sonderdividende.`, sec.id);
      bus.emit({ type: 'news', news: n });
    }
  }
}

function broadcastChanges(book, trades, touchedUserId) {
  if (quiet) { if (trades.length) quietTrades.push(...trades); return; } // gesammelt bis zum Ende der Leiste
  if (trades.length) bus.emit({ type: 'ticker', ticker: tickerRow(book.sec.id) });
  bus.emit({ type: 'book', security_id: book.sec.id, book: bookSnapshot(book.sec.id) });
  for (const t of trades) bus.emit({ type: 'trade', ...t });
  if (touchedUserId) bus.emit({ type: 'dirty', user_id: touchedUserId, what: ['portfolio', 'orders'] });
}

function tickerRow(secId) { return tickerRowCached(secId, books.get(secId)); }
// Ticker-Zeile mit Cache: Kurs, Geld/Brief und Volumen ändern sich nur mit dem
// Buch (book.ver); der 24-h-Bezugswert höchstens alle 5 s. So kostet der Ticker
// für alle Verbindungen zusammen 2 Abfragen je Wert statt 2 je Wert UND je Aufruf.
function tickerRowCached(secId, b) {
  const now = Date.now();
  const c = b.rowCache;
  if (c && c.ver === b.ver && now - c.at < 5000) return { ...c.row };
  const day = now - 24 * 3600 * 1000;
  const ref = db.prepare('SELECT price FROM price_history WHERE security_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1').get(secId, day);
  const refPrice = ref ? ref.price : b.sec.ipo_price;
  const bookSnap = bookSnapshot(secId, 1);
  const vol = db.prepare('SELECT SUM(amount) v FROM trades WHERE security_id = ? AND created_at >= ?').get(secId, day).v || 0;
  b.rowCache = {
    ver: b.ver, at: now,
    row: {
      id: secId, ticker: b.sec.ticker, name: b.sec.name, type: b.sec.type,
      last: b.last, ref: refPrice, chg: refPrice ? Math.round((b.last / refPrice - 1) * 10000) / 100 : 0,
      bid: bookSnap.bids[0]?.[0] || null, ask: bookSnap.asks[0]?.[0] || null, vol
    }
  };
  return { ...b.rowCache.row };
}
function tickerAll() { return [...books.keys()].map(id => tickerRowCached(id, books.get(id))); }

// Kennzahlen für den Pro-View (alles ehrlich aus Trades/Orderbuch berechenbar).
function computeStats(secId) {
  const book = books.get(secId);
  if (!book) return null;
  const day = Date.now() - 24 * 3600 * 1000;
  const t = db.prepare('SELECT COUNT(*) n, SUM(amount) vol, SUM(price*amount) turnover, MIN(price) lo, MAX(price) hi FROM trades WHERE security_id=? AND created_at>=?').get(secId, day);
  const vol = t.vol || 0, turnover = t.turnover || 0;
  const bid = book.bids[0]?.price || null, ask = book.asks[0]?.price || null;
  const mid = bid != null && ask != null ? Math.round((bid + ask) / 2) : (bid ?? ask ?? book.last);
  const spread = bid != null && ask != null ? ask - bid : null;
  // Volatilität: Standardabweichung der rel. Kursänderungen der letzten 60 Preise
  const ph = db.prepare('SELECT price FROM price_history WHERE security_id=? ORDER BY ts DESC LIMIT 60').all(secId).reverse();
  let vola = null;
  if (ph.length >= 3) {
    const rets = [];
    for (let i = 1; i < ph.length; i++) if (ph[i - 1].price > 0) rets.push(ph[i].price / ph[i - 1].price - 1);
    if (rets.length >= 2) {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      vola = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length) * 100;
    }
  }
  return {
    vol24: vol, turnover24: turnover, trades24: t.n || 0,
    vwap24: vol > 0 ? Math.round(turnover / vol) : null,
    high24: t.hi || null, low24: t.lo || null,
    bid, ask, mid, spread, spread_bp: spread != null && mid ? Math.round(spread / mid * 10000) : null,
    bid_depth: sideDepth(book, 'buy'), ask_depth: sideDepth(book, 'sell'),
    mcap: book.last * book.sec.total_shares,
    volatility_pct: vola
  };
}

// ---------------------------------------------------------------------------
// 10) WERTPAPIER ANLEGEN (IPO / ETF)
// ---------------------------------------------------------------------------
function listSecurity({ type, ticker, name, description, founder_id, ipo_price, total_shares, mm_enabled = 1, shares_per_unit = null, initial_last = null }) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO securities(type, ticker, name, description, founder_id, ipo_price, total_shares, lockup_until, mm_enabled, shares_per_unit, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, ticker.toUpperCase(), name, description || '', founder_id || null, ipo_price, total_shares, founder_id ? now + getSettings().lockup_sec * 1000 : 0, mm_enabled, shares_per_unit, now);
  const sec = q.secById.get(r.lastInsertRowid);
  books.set(sec.id, { sec, bids: [], asks: [], last: initial_last || ipo_price });
  return sec;
}

module.exports = {
  books, loadEngine, placeOrder, cancelOrder, cancelUserOrders, bookSnapshot, tickerAll, tickerRow,
  costToBuy, proceedsToSell, walkBook, previewOrder, computeStats, priceBand,
  listSecurity, mmRecenter, mmCancelQuotes, mmRefreshAll, mmLadder, holdingOf,
  treasury, tick, checkTakeover, addHoldingPublic: addHolding, sideDepth
};
