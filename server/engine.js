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
//   8. Market-Maker               Staffel-Quotes (Ladder) um den letzten Kurs
//   9. Marktdaten                 Ticker, Stats (Volumen/VWAP/Spread/...), Broadcasts
//
// WICHTIG (Vorgabe): Der Market-Maker erzeugt KEINE Kurstrends. Er legt nur
// passive Staffel-Quotes um den LETZTEN HANDELSPREIS. Kursbewegungen entstehen
// ausschließlich durch Spieler-Trades — der MM re-zentriert nach jedem Trade.
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
      ? (o.price > x.price || (o.price === x.price && o.created_at <= x.created_at))
      : (o.price < x.price || (o.price === x.price && o.created_at <= x.created_at)));
  arr.splice(i === -1 ? arr.length : i, 0, o);
}
function removeFromBook(book, orderId) {
  book.bids = book.bids.filter(o => o.id !== orderId);
  book.asks = book.asks.filter(o => o.id !== orderId);
}

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
function touch(userId) { db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(Date.now(), userId); }

function holdingOf(userId, secId) { const h = q.holding.get(userId, secId); return h ? h.amount : 0; }
function addHolding(userId, secId, delta, price = null) {
  const h = q.holding.get(userId, secId);
  if (!h || h.amount + delta === 0) {
    if (h && h.amount + delta === 0) db.prepare('DELETE FROM holdings WHERE user_id=? AND security_id=?').run(userId, secId);
    else if (delta !== 0) q.upsertHolding.run(userId, secId, delta, price || 0);
    return;
  }
  let amount = h.amount + delta, avg = h.avg_cost;
  if (delta > 0 && price != null) avg = Math.round((h.avg_cost * h.amount + price * delta) / amount);
  q.upsertHolding.run(userId, secId, amount, avg);
}

// Gebühr = Geldverbrennung pro AUSGEFÜHRTER Order (MM optional befreit).
function chargeFee(order) {
  if (order.fee_charged || order.is_mm && getSettings().mm_fee_exempt) return;
  const fee = getSettings().fee_cent;
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(fee, order.user_id);
  order.fee_charged = 1;
  db.prepare('UPDATE orders SET fee_charged = 1 WHERE id = ?').run(order.id);
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
    if (refund > 0) db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(refund, buyer.id);
  } else {
    db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(price * qty, buyer.id);
  }
  addHolding(buyer.id, book.sec.id, qty, price);

  // Verkäufer: Aktien liegen bei Limit schon im Escrow, bei Market jetzt abbuchen
  db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(price * qty, seller.id);
  const h = q.holding.get(seller.id, book.sec.id);
  const avg = h ? h.avg_cost : price;
  db.prepare('UPDATE users SET realized_pl = realized_pl + ? WHERE id = ?').run((price - avg) * qty, seller.id);
  if (sellerOrder.type === 'market') addHolding(seller.id, book.sec.id, -qty);

  // Maker-Order fortschreiben (Taker erledigt sich selbst in matchOrder)
  maker.filled += qty;
  db.prepare('UPDATE orders SET filled = ? WHERE id = ?').run(maker.filled, maker.id);
  if (maker.filled >= maker.amount) {
    maker.status = 'filled';
    db.prepare("UPDATE orders SET status='filled' WHERE id = ?").run(maker.id);
    removeFromBook(book, maker.id);
  }

  book.last = price;
  db.prepare('INSERT INTO trades(security_id, price, amount, buyer_id, seller_id, created_at) VALUES(?,?,?,?,?,?)')
    .run(book.sec.id, price, qty, buyer.id, seller.id, Date.now());
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
  db.prepare('UPDATE orders SET filled = ? WHERE id = ?').run(taker.filled, taker.id);
  if (taker.filled >= taker.amount) {
    taker.status = 'filled';
    db.prepare("UPDATE orders SET status='filled' WHERE id = ?").run(taker.id);
    removeFromBook(book, taker.id);
  } else if (taker.type === 'market') {
    taker.status = 'canceled'; // Rest verfällt (XETRA: Market-Orders liegen nicht im Buch)
    db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(taker.id);
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

  const order = {
    security_id: sec.id, user_id: user.id, side, type,
    price: null, amount, filled: 0, status: 'open', is_mm: isMM ? 1 : 0,
    fee_charged: 0, created_at: Date.now()
  };

  if (type === 'limit') {
    order.price = price;
    if (side === 'buy') {
      const cost = price * amount + feeReserve;
      if (user.cash < cost) throw new Error(`Nicht genug Credits (benötigt ${fmtCr(cost)} inkl. Gebühr)`);
      db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(price * amount, user.id);
      user.cash -= price * amount;
    } else {
      if (holdingOf(user.id, sec.id) < amount) throw new Error('Nicht genug Aktien im Depot');
      addHolding(user.id, sec.id, -amount);
    }
    const r = db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(order.security_id, order.user_id, order.side, 'limit', price, amount, 0, 'open', isMM ? 1 : 0, order.created_at);
    order.id = r.lastInsertRowid;
    insertIntoBook(book, order);
  } else { // market
    if (side === 'sell' && holdingOf(user.id, sec.id) < amount) throw new Error('Nicht genug Aktien im Depot');
    const r = db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(order.security_id, order.user_id, order.side, 'market', null, amount, 0, 'open', isMM ? 1 : 0, order.created_at);
    order.id = r.lastInsertRowid;
  }

  const trades = matchOrder(order, book);

  if (trades.length && !isMM) mmRecenter(book); // MM folgt dem Marktpreis – nur passive Liquidität
  if (trades.length) checkTakeover(book.sec);
  if (trades.length || order.status === 'open') broadcastChanges(book, trades, user.id);
  return { order: { ...order }, trades, last: book.last };
}

function cancelOrder(user, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.user_id !== user.id) throw new Error('Order nicht gefunden');
  if (o.status !== 'open') throw new Error('Order ist nicht mehr offen');
  const book = books.get(o.security_id);
  removeFromBook(book, o.id);
  db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(o.id);
  const remaining = o.amount - o.filled;
  if (o.side === 'buy') db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(o.price * remaining, o.user_id);
  else addHolding(o.user_id, o.security_id, remaining);
  broadcastChanges(book, [], o.user_id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 8) MARKET-MAKER — Staffel-Quotes (Ladder) um den letzten Kurs.
//    Stufe 0 liegt am engsten (mm_size Stück @ ±mm_spread_bp/2), jede weitere
//    Stufe rückt um mm_step_bp weiter raus UND wird größer (mm_size_step).
//    => Schüler-Market-Orders fressen sich durch die Staffel: kleine Orders
//       fillen knapp am Kurs, große Orders schieben den Preis (Kurswechsel!)
//       — aber niemals ins Leere, die Tiefe dämpft insane Sprünge.
//    Der MM hat keine Meinung: nach jedem Trade re-zentriert er aufs new Last.
// ---------------------------------------------------------------------------
function treasury() { return db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1").get(); }

// Ladder für ein Buch: { bids: [{price,size}], asks: [{price,size}] }
function mmLadder(book) {
  const s = getSettings();
  const half = s.mm_spread_bp / 10000 / 2;
  const step = s.mm_step_bp / 10000;
  const levels = Math.max(1, Math.floor(s.mm_levels));
  const bids = [], asks = [];
  for (let i = 0; i < levels; i++) {
    const dist = half + i * step;                       // Abstand vom letzten Kurs
    const size = Math.floor(s.mm_size + i * s.mm_size_step); // Tiefe wächst mit Abstand
    bids.push({ price: Math.max(tick(book.sec), roundToTick(book.last * (1 - dist), book.sec, 'down')), size });
    asks.push({ price: roundToTick(book.last * (1 + dist), book.sec, 'up'), size });
  }
  return { bids, asks };
}

// Hebt MM-Quoten eines Werts auf (Escrow zurück ins Treasury-Depot/-konto)
function mmCancelQuotes(book) {
  const mmOrders = db.prepare("SELECT id FROM orders WHERE security_id = ? AND status='open' AND is_mm = 1").all(book.sec.id);
  for (const { id } of mmOrders) {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    const remaining = o.amount - o.filled;
    if (o.side === 'buy') db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(o.price * remaining, o.user_id);
    else addHolding(o.user_id, o.security_id, remaining);
    removeFromBook(book, id);
    db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(id);
  }
}

function mmRecenter(book) {
  if (!book.sec.mm_enabled) return;
  const t0 = treasury();
  if (!t0) return;
  mmCancelQuotes(book); // alte Leiter abbauen (Escrow fließt zurück)
  const { bids, asks } = mmLadder(book);

  // Bid-Seite: max. 60% der Cash in Escrow binden — der Rest bleibt als
  // Liquiditäts-Puffer für AP-Operationen (ETF-Arbitrage, Dividenden).
  const cashBudget = Math.floor(treasury().cash * 0.6);
  let bidEscrow = 0;
  for (const lvl of bids) {
    if (bidEscrow + lvl.price * lvl.size > cashBudget) break; // höhere Stufen sind teurer
    try {
      placeOrder(treasury(), { security_id: book.sec.id, side: 'buy', type: 'limit', price: lvl.price, amount: lvl.size }, { mm: true });
      bidEscrow += lvl.price * lvl.size;
    } catch (e) { break; }
  }
  // Ask-Seite: Stufe für Stufe, solange Treasury-Bestand reicht.
  for (const lvl of asks) {
    const t = treasury();
    if (holdingOf(t.id, book.sec.id) < lvl.size) continue;
    try { placeOrder(t, { security_id: book.sec.id, side: 'sell', type: 'limit', price: lvl.price, amount: lvl.size }, { mm: true }); }
    catch (e) { break; }
  }
  broadcastChanges(book, [], null);
}
function mmRefreshAll() {
  for (const book of books.values()) mmRecenter(book);
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
      const n = addNews('takeover', `🚨 FEINDLICHE ÜBERNAHME: ${u.username} übernimmt ${sec.name}!`,
        `${u.username} hält jetzt über 50% der Anteile an ${sec.name} (${sec.ticker}) und erhält Sonderrechte: Firmenumbenennung und Antrag auf Sonderdividende.`, sec.id);
      bus.emit({ type: 'news', news: n });
    }
  }
}

function broadcastChanges(book, trades, touchedUserId) {
  if (trades.length) bus.emit({ type: 'ticker', ticker: tickerRow(book.sec.id) });
  bus.emit({ type: 'book', security_id: book.sec.id, book: bookSnapshot(book.sec.id) });
  for (const t of trades) bus.emit({ type: 'trade', ...t });
  if (touchedUserId) bus.emit({ type: 'dirty', user_id: touchedUserId, what: ['portfolio', 'orders'] });
}

function tickerRow(secId) { return tickerRowCached(secId, books.get(secId)); }
function tickerRowCached(secId, b) {
  const day = Date.now() - 24 * 3600 * 1000;
  const ref = db.prepare('SELECT price FROM price_history WHERE security_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1').get(secId, day);
  const refPrice = ref ? ref.price : b.sec.ipo_price;
  const bookSnap = bookSnapshot(secId, 1);
  const vol = db.prepare('SELECT SUM(amount) v FROM trades WHERE security_id = ? AND created_at >= ?').get(secId, day).v || 0;
  return {
    id: secId, ticker: b.sec.ticker, name: b.sec.name, type: b.sec.type,
    last: b.last, ref: refPrice, chg: refPrice ? Math.round((b.last / refPrice - 1) * 10000) / 100 : 0,
    bid: bookSnap.bids[0]?.[0] || null, ask: bookSnap.asks[0]?.[0] || null, vol
  };
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
  books, loadEngine, placeOrder, cancelOrder, bookSnapshot, tickerAll, tickerRow,
  costToBuy, proceedsToSell, walkBook, previewOrder, computeStats, priceBand,
  listSecurity, mmRecenter, mmCancelQuotes, mmRefreshAll, mmLadder, holdingOf,
  treasury, tick, checkTakeover, addHoldingPublic: addHolding, sideDepth
};
