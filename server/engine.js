// ============================================================================
// MATCHING ENGINE — XETRA-Prinzip: Price-Time-Priority, Maker-Preis gilt.
// ----------------------------------------------------------------------------
// Aufbau dieser Datei (von innen nach außen):
//   1. Tick                       kleinste Preisgrenze (Aktie und ETF 0,1 Cr)
//   2. Orderbuch                  In-Memory-Bücher, sortierte Einfüge-Logik
//   3. Depot & Cash               Holdings, Avg-Cost, Escrow, Gebühren
//   4. Fairer Kurs & Preis-Band   F aus Orderflow, öffentlicher Kurs K, Band, Ordergrößen-Grenze
//   5. Book-Walk                  "Was kostet es, N Stück zu kaufen/verkaufen?"
//                                  -> Preview & ETF-Arbitrage nutzen dieselbe Logik
//   6. Matching                   Taker frisst sich durch die Gegenseite
//   7. Order-API                  placeOrder/cancelOrder: validieren -> escrowen -> matchen
//   8. Market-Maker V3            Orderflow-Preisfindung (Staffel um F, Nachplatzierung)
//   9. Marktdaten                 Ticker, Stats (Volumen/VWAP/Spread/...), Broadcasts
//
// WICHTIG (Vorgabe): Der Market-Maker erzeugt KEINE Kurstrends. Er führt je
// Wertpapier einen fairen Kurs F, den allein der netto gerichtete Orderflow der
// Teilnehmer gegen seine Quotes bewegt (F ← F · e^(λ·q)), und legt passive
// Quotes um F. Fill-Preise stehen in trades; der öffentliche Kurs (book.last)
// ist immer F auf Tick gerundet.
// ============================================================================
const { db, getSettings, setSetting, q, addNews, DEFAULT_SETTINGS, fmtDe, fmtDeInt } = require('./db');
const bus = require('./bus');
const mmath = require('./mmath');

// ---------------------------------------------------------------------------
// 1) TICK
// ---------------------------------------------------------------------------
function tick(sec) { return 10; } // Aktie und ETF: 0,1 Credit — für Limits, Kurs K, Staffel und Band
const MAX_ORDER_QTY = 1e6; // Obergrenze einer Order; ETF-Quotes setzen sie als Menge an
const fmtCr = (cent) => (cent / 100).toFixed(2);

// ---------------------------------------------------------------------------
// 2) ORDERBUCH
//    bids absteigend, asks aufsteigend (Preis zuerst, dann Zeit = FIFO).
// ---------------------------------------------------------------------------
const books = new Map(); // secId -> { sec, bids: [], asks: [], fair: Milli-Cent, last: cent (= K), mmNextAt?, mmQuotedPrice? }

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
  poolAdd: db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + ? WHERE key = 'fee_pool_cent'"),
  filled: db.prepare('UPDATE orders SET filled = ? WHERE id = ?'),
  filledDone: db.prepare("UPDATE orders SET status='filled' WHERE id = ?"),
  canceled: db.prepare("UPDATE orders SET status='canceled' WHERE id = ?"),
  delHolding: db.prepare('DELETE FROM holdings WHERE user_id=? AND security_id=?'),
  realized: db.prepare('UPDATE users SET realized_pl = realized_pl + ? WHERE id = ?'),
  trade: db.prepare('INSERT INTO trades(security_id, price, amount, buyer_id, seller_id, created_at) VALUES(?,?,?,?,?,?)'),
  order: db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`),
  bank: db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1"),
  setFair: db.prepare('UPDATE securities SET fair_price = ? WHERE id = ?'),
  lastTrades: db.prepare('SELECT price FROM trades WHERE security_id = ? ORDER BY id DESC LIMIT 25'),
  basket: db.prepare('SELECT eb.qty, s.id sid FROM etf_baskets eb JOIN securities s ON s.id = eb.stock_id WHERE eb.etf_id = ?')
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

// Offene Restmenge einer Buchseite — nur was im Preis-Band liegt (mehr kann
// niemand ausgefüllt bekommen). ignoreUserId: eigene Orders zählen nicht
// (Self-Trade-Prevention) — so sieht ein Spieler seine "echt kaufbare" Menge.
function sideDepth(book, side, ignoreUserId = null) {
  const arr = side === 'buy' ? book.bids : book.asks;
  const { min, max } = priceBand(book);
  let sum = 0;
  for (const o of arr) {
    if (o.user_id !== ignoreUserId && o.amount - o.filled > 0 && o.price >= min && o.price <= max) sum += o.amount - o.filled;
  }
  return sum;
}

function makeBook(sec, fair) {
  const book = { sec, bids: [], asks: [], fair: 0, last: 0 };
  setFair(book, fair);
  return book;
}

// Bücher aufbauen. F kommt aus securities.fair_price; Aktien ohne Wert (DB vor
// V3) starten beim Median ihrer letzten 25 Trades und schreiben ihn zurück.
// Auf so einer DB löst migrateOpenOrders außerdem Orders auf, die im neuen
// Modell nie mehr füllen würden.
function loadEngine() {
  books.clear();
  const secs = q.allSecs.all('active');
  const openOrders = db.prepare(`SELECT * FROM orders WHERE status='open' ORDER BY created_at ASC, id ASC`).all();
  const bySec = new Map();
  for (const o of openOrders) {
    if (!bySec.has(o.security_id)) bySec.set(o.security_id, []);
    bySec.get(o.security_id).push(o);
  }
  let initialized = 0;
  for (const sec of secs) {
    if (sec.type === 'etf') { books.set(sec.id, makeBook(sec, 1)); continue; } // F = NAV, steht erst nach allen Aktien
    if (Number.isInteger(sec.fair_price) && sec.fair_price > 0) { books.set(sec.id, makeBook(sec, sec.fair_price)); continue; }
    const book = makeBook(sec, Math.max(1, Math.round(medianPrice(sec.id, sec.ipo_price) * mmath.MILLI)));
    books.set(sec.id, book);
    st.setFair.run(book.fair, sec.id);
    initialized++;
  }
  syncEtfPrices();
  for (const [secId, list] of bySec) {
    const book = books.get(secId);
    if (book) for (const o of list) insertIntoBook(book, o);
  }
  if (initialized) migrateOpenOrders();
}

// Start-Kurs einer Aktie aus einer DB vor V3: Median der letzten 25 Trades
// (bei gerader Zahl Mittel der beiden mittleren), sonst der IPO-Preis. In Cent;
// loadEngine rechnet in Milli-Cent und rundet dort.
function medianPrice(secId, fallback) {
  const p = st.lastTrades.all(secId).map(r => r.price).filter(x => x > 0);
  if (!p.length) return fallback;
  p.sort((a, b) => a - b);
  const m = p.length >> 1;
  return p.length % 2 ? p[m] : (p[m - 1] + p[m]) / 2;
}

// Umstellung einer DB vor V3: Das alte Band war viel weiter — offene Orders
// außerhalb des neuen Bands würden nie mehr füllen (Band-Storno). Dazu alle
// manuellen Orders der Staatskasse (frühere AP-Leitern und Altlasten): die
// Automatik arbeitet heute mit Market-Orders. Alles mit Escrow-Rückbuchung.
function migrateOpenOrders() {
  const t = treasury();
  db.transaction(() => {
    const all = [...books.values()];
    for (const book of all) cancelOutOfBand(book);
    cancelMatching(all, (o) => !o.is_mm && o.user_id === t?.id);
  })();
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

// Der eine Satz für alle vier Gebühr-Stellen (chargeFee, Budget-Guard, Limit-Reserve, Preview):
// Bots zahlen bot_fee_cent, wenn das Setting gesetzt ist (> 0), sonst wie Spieler fee_cent —
// dieselbe Regel, mit der bots.js die Gebühr beim Kauf einplant. Rechnet eine Stelle mit einem
// anderen Satz, rutscht ein Konto ins Minus oder darf zu wenig kaufen.
function feeFor(user, s = getSettings()) {
  return user && user.is_bot && s.bot_fee_cent > 0 ? s.bot_fee_cent : s.fee_cent;
}

// Gebühr = Geldverbrennung pro AUSGEFÜHRTER Order (MM optional befreit).
// Clamp: nie mehr abbuchen als da ist — sonst rutschen Konten ins Minus.
// Recycling: der TATSÄCHLICH abgebuchte Betrag (also nach dem Clamp) wandert in den
// persistenten Gebühren-Pool (Setting fee_pool_cent), in derselben Transaktion wie die
// Order; jobs.payIncome zahlt ihn mit dem Einkommen zurück. Es fließt nur zurück, was
// zuvor wirklich abgezogen wurde.
function chargeFee(order) {
  if (order.fee_charged || order.is_mm && getSettings().mm_fee_exempt) return;
  const s = getSettings();
  const user = q.userById.get(order.user_id);
  const satz = feeFor(user, s);
  const fee = Math.min(satz, Math.max(0, user.cash));
  order.fee_charged = 1;
  st.feeFlag.run(order.id);
  if (fee > 0) {
    st.cash.run(-fee, order.user_id);
    // Der Stand in der Tabelle ist die Wahrheit: er rollt mit der Order zurück. Der RAM-Cache
    // (getSettings) wird nur gespiegelt und kann nach einem Rollback vorauseilen — payIncome
    // liest deshalb aus der Tabelle und richtet den Cache danach.
    st.poolAdd.run(fee);
    setSetting('fee_pool_cent', Number(s.fee_pool_cent || 0) + fee);
  }
}

// Escrow einer offenen Order zurückgeben: Kauf = price × Restmenge an cash;
// Verkauf = Restmenge ins Depot, mit dem an der Order gemerkten Einstandspreis
// (fallbackPrice, falls der nicht mehr bekannt ist — nach einem Neustart).
function refundOrder(o, remaining, fallbackPrice) {
  if (o.side === 'buy') st.cash.run(o.price * remaining, o.user_id);
  else addHolding(o.user_id, o.security_id, remaining, Number.isFinite(o.avg_cost) ? o.avg_cost : fallbackPrice);
}

// ---------------------------------------------------------------------------
// 4) FAIRER KURS, ÖFFENTLICHER KURS, PREIS-BAND
//    book.fair (Milli-Cent) ist im RAM die Quelle; book.last ist immer der auf
//    Tick gerundete F (der öffentliche Kurs K). F ändert sich nur in
//    applyOrderFlow — durch netto gerichteten Orderflow der Teilnehmer gegen
//    die Staatskasse. Limit-Orders von Spielern und Bots müssen innerhalb
//    F ± limit_band_pct liegen, und gefüllt wird für jeden Taker nur dort.
//    Treasury und Admin dürfen Limits außerhalb stellen; außerhalb des Bands
//    werden sie aber nie ausgefüllt.
// ---------------------------------------------------------------------------
function setFair(book, fair) {
  const last = mmath.publicPrice(fair, tick(book.sec));
  if (fair === book.fair && last === book.last) return;
  book.fair = fair;
  book.sec.fair_price = fair;
  book.last = last;
  book.ver = (book.ver || 0) + 1; // Ticker-Cache ungültig
}

function fairPrice(secId) { const b = books.get(secId); return b ? b.fair : null; }

// Streubesitz D = Gesamtaktien − Gründerbestand. Abgeleitet, nie gespeichert.
function impactDepth(secId) {
  const book = books.get(secId);
  if (!book) return null;
  const h = book.sec.founder_id ? q.holding.get(book.sec.founder_id, secId) : null;
  return mmath.depthOf(book.sec.total_shares, h ? h.amount : 0);
}

// Kurswirkung je Stück: λ = ln(1 + p) / D mit p = mm_impact_pct. p wird nach
// unten auf 0 geklemmt — eine negative oder kaputte Einstellung wirkt gar nicht
// statt umgekehrt.
function impactPct(s) { return Math.max(0, Number(s.mm_impact_pct) || 0); }
function flowLambda(book, s = getSettings()) {
  return mmath.impactLambda(impactDepth(book.sec.id), impactPct(s));
}

function priceBand(book) {
  return mmath.band(book.fair, tick(book.sec), getSettings().limit_band_pct);
}
function checkPriceBand(book, price) {
  const b = priceBand(book);
  if (mmath.inBand(b, price)) return;
  throw new Error(
    `Preis zu weit vom Kurs entfernt (Kurs ${fmtCr(b.ref)} ±${getSettings().limit_band_pct}%). Erlaubt: ${fmtCr(b.min)} – ${fmtCr(b.max)}`);
}

// Ordergrößen-Grenze für Flow-Orders an Aktien (Q_max = floor(ln(1+B)/λ)): so
// viele Stück bewegen F je Order um höchstens B. null = keine Grenze.
function orderCap(book, s = getSettings()) {
  const cap = mmath.maxOrderSize(impactDepth(book.sec.id), impactPct(s), s.limit_band_pct);
  return Number.isFinite(cap) && cap < Number.MAX_SAFE_INTEGER ? cap : null;
}

// Flow-Order eines Teilnehmers (role='user', kein MM-Quote) an einer Aktie: nur
// sie unterliegt der Ordergrößen-Grenze. Treasury, Admin, MM-Quotes als Taker
// und ETFs haben keine Grenze.
function isFlowOrder(user, isMm, book) {
  return !!user && user.role === 'user' && !isMm && book.sec.type === 'stock';
}

// Orderflow einer Ausführung (Kauf +, Verkauf −): Sie zählt, wenn GENAU EINE
// Seite eine MM-Quote ist und die andere ein Teilnehmer (role='user') ist.
//   · Taker ist Teilnehmer, Maker MM-Quote: Richtung des Takers.
//   · Taker ist MM-Quote, Maker Teilnehmer: Richtung des Makers — sein liegendes
//     Gebot, das die Staatskasse füllt, ist Nachfrage (+), sein Angebot −.
// So endet das Kreuzen liegender Orders von selbst: Steigt F, liegen die MM-Asks
// irgendwann über dem Gebot. Treasury und Admin als Teilnehmer tragen nichts bei.
function addFlow(taker, maker, qty) {
  if (!!taker.is_mm === !!maker.is_mm) return; // beide oder keine MM-Quote
  const party = taker.is_mm ? maker : taker;
  if (q.userById.get(party.user_id).role !== 'user') return;
  taker.flow += party.side === 'buy' ? qty : -qty;
}

// Einziger Weg, wie sich F ändert — nach dem Matching, in derselben Transaktion:
//   q = order.flow (aus addFlow);   F ← round(F · e^(λ·q))
// Der Limitpreis spielt keine Rolle, Fill-Preise stehen weiter in trades.
// Ohne netto gerichteten Orderflow (q = 0) steht F. Dazu genau ein Kurspunkt
// (K, Menge der Order) statt je Fill.
function applyOrderFlow(book, order, stock) {
  if (stock) {
    const qty = order.flow || 0;
    if (qty !== 0) {
      setFair(book, mmath.applyFlow(book.fair, flowLambda(book), qty));
      st.setFair.run(book.fair, book.sec.id);
      syncEtfPrices();
      // Das Band ist mit F gewandert: Orders, die jetzt außerhalb liegen, können
      // nie mehr füllen — sofort auflösen (Escrow zurück).
      cancelOutOfBand(book);
    }
  }
  q.phIns.run(book.sec.id, Date.now(), book.last, order.filled);
}

// Band-Storno: jede offene Nicht-MM-Order dieses Buchs außerhalb des Bands
// auflösen — auch manuelle Orders der Staatskasse. Nichts Unausführbares soll
// im Buch liegen und Escrow sperren. Läuft nach jedem Flow-Update und bei der
// Umstellung alter DBs.
function cancelOutOfBand(book, band = priceBand(book)) {
  return cancelMatching([book], (o) => !o.is_mm && !mmath.inBand(band, o.price));
}

// Offene Orders nach Kriterium stornieren — wie cancelOrder: volle
// Escrow-Rückbuchung, status 'canceled', raus aus dem Buch; danach je
// betroffenem Nutzer ein dirty-Event (portfolio, orders).
function cancelMatching(bookList, match) {
  const touched = new Set();
  for (const book of bookList) {
    for (const o of [...book.bids, ...book.asks]) {
      if (!match(o)) continue;
      refundOrder(o, o.amount - o.filled, o.price);
      removeFromBook(book, o.id);
      o.status = 'canceled';
      st.canceled.run(o.id);
      touched.add(o.user_id);
    }
  }
  for (const user_id of touched) bus.emit({ type: 'dirty', user_id, what: ['portfolio', 'orders'] });
  return touched.size;
}

// NAV-Anker: Kurs eines ETF ist sein NAV — der Korb bewertet zu den F-Preisen
// der Aktien, in Milli-Cent: round(Σ qty_i · F_i / shares_per_unit). Wird nicht
// persistiert; neu gerechnet beim Laden und nach jedem Flow-Update einer
// Korbaktie. Orderflow im ETF kann daher kein Aufgeld erzeugen. Wirft nie (läuft
// in der Order-Transaktion): fehlt zu einem ETF etwas, behält er seinen Kurs.
// Wandert der NAV, greift das Band-Storno wie bei jeder Kursänderung.
function syncEtfPrices() {
  for (const etf of books.values()) {
    if (etf.sec.type !== 'etf') continue;
    try { syncEtfPrice(etf); }
    catch (e) { console.error(`[ETF] NAV konnte nicht neu gerechnet werden (security_id ${etf.sec.id}):`, e.message); }
  }
}
function syncEtfPrice(etf) {
  const spu = etf.sec.shares_per_unit;
  if (!(spu > 0)) return;
  const rows = st.basket.all(etf.sec.id);
  if (!rows.length) return;
  let nav = 0;
  for (const r of rows) {
    const b = books.get(r.sid);
    if (!b || !(b.fair > 0)) return; // Korbaktie ohne Kurs: diesen ETF nicht neu rechnen
    nav += r.qty * b.fair;
  }
  const fair = Math.max(1, Math.round(nav / spu));
  if (fair === etf.fair) return;
  // erst das Band-Storno nach dem neuen Kurs, dann den Kurs setzen: scheitert das
  // Storno, bleibt der alte Kurs im RAM (kein Phantom-NAV, die DB ist zurückgerollt)
  cancelOutOfBand(etf, mmath.band(fair, tick(etf.sec), getSettings().limit_band_pct));
  setFair(etf, fair);
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
//   opts.maxQty: nimmt höchstens so viele Stück (Ordergrößen-Grenze); der Rest zählt zu rest
//   Außerhalb des Preis-Bands wird nie genommen; da die Gegenseite sortiert ist,
//   endet der Walk an ihrem Rand.
function walkBook(book, side, amount, { limitPrice = null, ignoreUserId = null, maxQty = null } = {}) {
  const arr = side === 'buy' ? book.asks : book.bids;
  const { min, max } = priceBand(book); // ausgefüllt wird nur innerhalb des Bands
  const want = Math.floor(amount);
  const limit = maxQty != null ? Math.min(want, maxQty) : want;
  let left = limit, gross = 0;
  const fills = [];
  for (const o of arr) {
    if (left <= 0) break;
    if (side === 'buy' ? o.price > max : o.price < min) break;
    if (limitPrice != null && (side === 'buy' ? o.price > limitPrice : o.price < limitPrice)) break;
    if (o.user_id === ignoreUserId || o.amount - o.filled <= 0) continue;
    if (side === 'buy' ? o.price < min : o.price > max) continue; // hinter dem Band: überlesen
    const take = Math.min(left, o.amount - o.filled);
    fills.push({ price: o.price, qty: take });
    gross += take * o.price;
    left -= take;
  }
  const qty = limit - left;
  return { fills, qty, gross, rest: want - qty, vwap: qty > 0 ? gross / qty : 0 };
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
// Muss dieselbe Sicht haben wie die Ausführung: nur das Band, und für Flow-Orders
// höchstens Q_max Stück je Order (cap). Bei ETFs gibt es keine Grenze (cap null).
function previewOrder(user, { security_id, side, type, price, amount }) {
  const book = books.get(security_id);
  if (!book) throw new Error('Orderbuch nicht initialisiert');
  side = side === 'buy' ? 'buy' : 'sell';
  amount = Math.floor(Number(amount));
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Ungültige Stückzahl');
  const s = getSettings();
  const fee = user ? feeFor(user, s) : 0;
  const cap = isFlowOrder(user, false, book) ? orderCap(book, s) : null; // Ordergrößen-Grenze wie bei der Ausführung

  if (type === 'market') {
    const w = walkBook(book, side, amount, { ignoreUserId: user?.id, maxQty: cap });
    return {
      side, type, amount, fee,
      fills: w.fills, matched_qty: w.qty, rest: w.rest,
      avg_price: w.vwap ? Math.round(w.vwap) : null,
      gross: w.gross, // buy: Gesamtkosten, sell: Gesamterlös
      available: sideDepth(book, side === 'buy' ? 'sell' : 'buy', user?.id),
      band: priceBand(book), cap
    };
  }
  // Limit: sofort matchbare Menge + Rest liegt im Buch (Escrow = limit*amount)
  const w = walkBook(book, side, amount, { limitPrice: price, ignoreUserId: user?.id, maxQty: cap });
  const escrow = (price || 0) * amount;
  return {
    side, type: 'limit', amount, fee, limit_price: price,
    fills: w.fills, matched_qty: w.qty, rest: w.rest,
    avg_price: w.vwap ? Math.round(w.vwap) : null,
    immediate_gross: w.gross,         // was davon SOFORT executes
    escrow: side === 'buy' ? escrow : 0, // Kauf: treuhänderisch hinterlegt
    est_proceeds: side === 'sell' ? escrow : 0,
    available: sideDepth(book, side === 'buy' ? 'sell' : 'buy', user?.id),
    band: priceBand(book), cap
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

  chargeFee(buyerOrder); // vor dem Kaufpreis: die Orderprüfung hat Kosten + Gebühr gedeckt gesehen

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
  // Gebühr NACH dem Erlös: sie wird aus dem Brutto-Erlös gezogen und nicht auf das Restcash
  // geklemmt, solange der Erlös sie deckt (sonst zahlte, wer sein Geld in Aktien hatte, kaum Gebühr).
  chargeFee(sellerOrder);
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

  // Der Fill-Preis ist Ausführungskosten, kein Kurs: book.last bleibt der aus F
  // abgeleitete Kurs K (siehe applyOrderFlow). Ebenso der Kurspunkt: einer je
  // Order, nicht je Fill.
  book.ver = (book.ver || 0) + 1;
  st.trade.run(book.sec.id, price, qty, buyer.id, seller.id, Date.now());
  return { security_id: book.sec.id, price, amount: qty, buyer: buyer.username, seller: seller.username, ts: Date.now() };
}

// maxQty: Ordergrößen-Grenze eines Flow-Takers (Q_max) oder null — dann füllt
// nur der Budget-Guard (Markt-Kauf) weniger als die Ordermenge.
function matchOrder(taker, book, maxQty = null) {
  const trades = [];
  const opposite = () => taker.side === 'buy' ? book.asks : book.bids;
  const { min, max } = priceBand(book); // Maker außerhalb des Bands werden nie getroffen
  let budget = null;
  if (taker.type === 'market' && taker.side === 'buy') {
    const u = q.userById.get(taker.user_id);
    budget = u.cash - (taker.is_mm && getSettings().mm_fee_exempt ? 0 : feeFor(u, getSettings()));
    if (budget < 0) budget = 0;
  }
  while (taker.filled < taker.amount) {
    const arr = opposite();
    // Self-Trade-Prevention strikt; die Gegenseite ist sortiert, deshalb genügt
    // der Band-Filter: liegt der nächste freie Maker hinter dem Band, kommt nichts mehr.
    const maker = arr.find(o => o.user_id !== taker.user_id && o.amount - o.filled > 0 && o.price >= min && o.price <= max);
    if (!maker) break;
    if (taker.type === 'limit') {
      if (taker.side === 'buy' && maker.price > taker.price) break;
      if (taker.side === 'sell' && maker.price < taker.price) break;
    }
    let qty = Math.min(taker.amount - taker.filled, maker.amount - maker.filled);
    if (maxQty != null) {
      qty = Math.min(qty, maxQty - taker.filled);
      if (qty <= 0) break;
    }
    if (budget != null) {
      qty = Math.min(qty, Math.floor(budget / maker.price));
      if (qty <= 0) break;
      budget -= qty * maker.price;
    }
    if (qty <= 0) break;
    trades.push(executeFill(taker, maker, maker.price, qty, book));
    taker.filled += qty;
    addFlow(taker, maker, qty);
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
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_ORDER_QTY) throw new Error('Ungültige Stückzahl');
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
  const feeReserve = (isMM && s.mm_fee_exempt) ? 0 : feeFor(user, s);
  // Ordergrößen-Grenze einer Flow-Order (Aktie): höchstens cap Stück je Order
  const cap = isFlowOrder(user, isMM, book) ? orderCap(book, s) : null;

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
    // Eine Markt-Order bewegt F um höchstens limit_band_pct % — größere Orders
    // werden vor jeder Prüfung/Buchung abgelehnt (Limit-Orders dürfen größer sein).
    if (cap != null && amount > cap)
      throw new Error(`Zu groß für eine Order: höchstens ${cap} Stück, damit der Kurs pro Order höchstens ${s.limit_band_pct} % springt. Teile die Order.`);
    // Markt-Orders können nur füllen, was im Buch liegt — vorher ehrlich ablehnen
    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    const available = sideDepth(book, oppositeSide, user.id);
    if (amount > available)
      throw new Error(`Nicht genug Liquidität: nur ${available} Stück ${side === 'buy' ? 'kaufbar (Asks)' : 'verkaufbar (Bids)'} — reduziere die Stückzahl`);
    if (side === 'buy') {
      const { gross } = walkBook(book, 'buy', amount, { ignoreUserId: user.id, maxQty: cap });
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
    price: null, amount, filled: 0, flow: 0, status: 'open', is_mm: isMM ? 1 : 0,
    fee_charged: 0, created_at: Date.now()
  };

  // Escrow, Insert und Matching in EINER Transaktion: ein Fehler dazwischen
  // hinterlässt keine halbe Buchung (Gebühr, Depot, Trade, Orderstatus).
  let trades;
  try {
    trades = runOrder(order, price, user);
  } catch (e) {
    restoreBook(book); // die DB ist zurückgerollt — der RAM auch: F, ETF-Kurse, Orderbuch
    throw e;
  }
  if (type === 'limit' && side === 'buy') user.cash -= price * order.amount;

  if (trades.length && !isMM) mmRecenter(book); // die Staffel steht wieder um den fairen Kurs — Trades der Teilnehmer bewegen ihn über den Orderflow
  if (trades.length) checkTakeover(book.sec);
  if (trades.length || order.status === 'open') broadcastChanges(book, trades, user.id);
  const { flow, ...publicOrder } = order; // flow ist Rechengröße des Orderflow, kein API-Feld
  return { order: publicOrder, trades, last: book.last };
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
  const trades = matchOrder(order, book, isFlowOrder(user, order.is_mm, book) ? orderCap(book) : null);
  if (trades.length) applyOrderFlow(book, order, book.sec.type === 'stock');
  return trades;
});

// Hebt ALLE offenen Orders eines Nutzers auf (Einfrieren, Löschen) — mit
// Escrow-Rückzahlung und einem Buch-Event je betroffenem Wert.
function cancelUserOrders(userId) {
  let n = 0;
  for (const book of books.values()) {
    let here = 0;
    for (const o of [...book.bids, ...book.asks].filter(x => x.user_id === userId)) {
      refundOrder(o, o.amount - o.filled, o.price);
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
  // Bereits storniert (z. B. vom automatischen Band-Storno): der Wunsch ist
  // erfüllt, keine zweite Buchung.
  if (o.status === 'canceled') return { ok: true };
  if (o.status !== 'open') throw new Error('Order ist nicht mehr offen');
  const book = books.get(o.security_id);
  // Die Order im RAM kennt den Einstandspreis der hinterlegten Aktien.
  const mem = [...book.bids, ...book.asks].find(x => x.id === o.id);
  removeFromBook(book, o.id);
  st.canceled.run(o.id);
  refundOrder(mem || o, o.amount - o.filled, o.price);
  broadcastChanges(book, [], o.user_id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 8) MARKET-MAKER V3 — Orderflow-Preisfindung. Die Staatskasse stellt nur
//    Liquidität bereit und hat keine Meinung:
//      · Fairer Kurs F: bewegt sich ausschließlich durch den netto gerichteten
//        Orderflow der Teilnehmer (applyOrderFlow). Ohne ihre Orders steht F.
//      · Staffel um F: die Grenzpreise folgen genau der Kurswirkung der schon
//        liegenden Menge (λ·X); Größen und Abstände tragen Zufalls-Jitter, das
//        Buch sieht aus wie viele Marktteilnehmer, nicht wie eine Maschine.
//      · ETFs notieren am NAV: eine flache Quote je Seite (syncEtfPrices).
//      · Faires Cash-Budget JE Wert + Teil-Quotes: die Bid-Seite bleibt auch
//        bei vielen Wertpapieren handelbar (früher frass das erste Buch alles).
//      · Self-Healing: fehlt auf einer Seite jede MM-Quote, wird das Buch im
//        3-s-Takt neu gelegt, nicht erst im Turnus.
//      · Nachplatzierung: ist der Streubesitz aufgebraucht, kommt neuer
//        Bestand dazu — ohne Kursbedingung, mit Cooldown; läuft der Cooldown,
//        wird trotzdem sofort der Mindestbestand nachgelegt.
//      · Notkredit: droht der Staatskasse das Cash auszugehen (Dividenden,
//        Netto-Käufe), stützt die Zentralbank sie wieder auf Spiel-Niveau.
//    Vorgabe bleibt: der MM ist passiv und MEINUNGSLOS — er macht keinen Trend,
//    sondern bietet Liquidität um den fairen Kurs.
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

// Quotes für ein Buch: { bids: [{price,size}], asks: [{price,size}] }.
// Aktien: Staffel aus mmath.ladder — der Abstand einer Stufe ist die Kurswirkung
// der bereits liegenden Menge, alle Preise im Band.
// ETF: eine Stufe je Seite um den NAV; die Menge (MAX_ORDER_QTY)
// begrenzt recenterBody auf Bestand bzw. Cash-Budget.
// Staffel-Parameter absichern: mm_levels ist über die Einstellungen frei setzbar.
// Nicht endliche oder negative Werte fallen auf den Default zurück.
const MM_LEVELS_MAX = 50;
function ladderLevels(v) { return Number.isFinite(v) ? Math.min(MM_LEVELS_MAX, Math.max(1, Math.floor(v))) : DEFAULT_SETTINGS.mm_levels; }
function atLeast(v, lo, fallback) { return Number.isFinite(v) ? Math.max(lo, v) : fallback; }

function mmLadder(book) {
  const s = getSettings();
  const t = tick(book.sec);
  if (book.sec.type === 'etf') {
    const { bid, ask } = mmath.flatQuotes({ fair: book.fair, tick: t, halfSpreadBp: s.mm_spread_bp / 2 });
    const size = MAX_ORDER_QTY;
    return { bids: [{ price: bid, size }], asks: [{ price: ask, size }] };
  }
  // mm_min_ask_shares > 0: Anschluss-Stufen, bis die Angebotsseite so viele Stück hält
  // oder das Band endet (V4). Fehlt das Setting (oder ist es kaputt): 0 = alte Leiste.
  return mmath.ladder({
    ...stockLadderArgs(book, s),
    jitterBp: s.mm_jitter_bp, sizeJitter: s.mm_size_jitter, rnd: Math.random,
    minTotal: atLeast(s.mm_min_ask_shares, 0, 0)
  });
}

// Kursbezogene Argumente der Aktien-Staffel aus den Einstellungen (ohne Zufall).
function stockLadderArgs(book, s) {
  return {
    fair: book.fair, tick: tick(book.sec), lambda: flowLambda(book, s),
    halfSpreadBp: s.mm_spread_bp / 2, levels: ladderLevels(s.mm_levels),
    size: atLeast(s.mm_size, 1, DEFAULT_SETTINGS.mm_size), sizeStep: atLeast(s.mm_size_step, 0, DEFAULT_SETTINGS.mm_size_step), bandPct: s.limit_band_pct
  };
}
const noJitter = () => 0.5; // rnd ohne Jitter: Stufe i hat genau mm_size + i·mm_size_step Stück

// Wie viele Stück die Angebotsseite im Band höchstens hält, wenn der Streubesitz
// `depth` beträgt (Staffel ohne Jitter, Anschluss-Stufen bis zur Bandkante). Das
// Band begrenzt die Stückzahl: bei D = 2000, Impact 50 %, Band 15 % sind es rund
// 780 — mehr Angebot gibt es nur mit größerem Streubesitz.
function mmAskRoom(book, depth, s, target) {
  const l = mmath.ladder({ ...stockLadderArgs(book, s), lambda: mmath.impactLambda(depth, impactPct(s)), jitterBp: 0, sizeJitter: 0, minTotal: target, rnd: noJitter });
  return l.asks.reduce((sum, e) => sum + e.size, 0);
}

// Kleinster Streubesitz, in dessen Band die Angebotsseite `target` Stück hält.
// Das Band wächst ungefähr proportional zum Streubesitz: erst eine Schätzung nach
// Verhältnis, dann in Schritten von 10 % nachbessern. null = nicht erreichbar
// (z. B. Stufen von 1 Stück) — dann greift die Regel nicht.
// `from`: Streubesitz, ab dem gesucht wird (Default: der aktuelle des Werts). Das
// Ergebnis ist nie kleiner als `from` — für den Start-Streubesitz (mmFloatBase)
// steht dort ein fester Wert statt des gewachsenen.
function mmDepthForAsk(book, target, s, from = impactDepth(book.sec.id)) {
  const depth = from;
  if (!(mmath.impactLambda(depth, impactPct(s)) > 0)) return null; // keine Kurswirkung: das Band begrenzt nichts
  const room = mmAskRoom(book, depth, s, target);
  if (!(room > 0)) return null;
  let need = Math.max(depth, Math.ceil(depth * target / room));
  for (let i = 0; i < 25 && mmAskRoom(book, need, s, target) < target; i++) need = Math.ceil(need * 1.1);
  return mmAskRoom(book, need, s, target) >= target ? need : null;
}

// Hebt MM-Quoten eines Werts auf (Escrow zurück ins Treasury-Depot/-konto)
function mmCancelQuotes(book) {
  // Die offenen MM-Orders stehen im RAM — keine Tabellen-Abfrage je Order nötig.
  for (const o of [...book.bids, ...book.asks].filter(x => x.is_mm && x.status === 'open')) {
    refundOrder(o, o.amount - o.filled, undefined);
    removeFromBook(book, o.id);
    o.status = 'canceled';
    st.canceled.run(o.id);
  }
  book.mmNextAt = 0; // ohne Quotes sofort fällig: der nächste mmRefreshAll legt neu (≤ 3 s)
}

// Nachplatzierung: Streubesitz aufgebraucht => neue Aktien. Nur bei Aktien
// (ETFs haben die AP-Creation), max. 1x pro 30 Min je Wert — im Fast-Mode
// entsprechend schneller (Zeitkompression), damit das ANGEBOT auf eine
// 100×-Nachfragewelle reagieren kann. Ohne Kursbedingung: auch eine Aktie unter
// dem IPO braucht eine Angebotsseite.
// Streubesitz-Regeln (mm_min_depth > 0, sonst alte Regeln): (1) Der Streubesitz
// sinkt nie unter mm_min_depth — kleine IPOs werden handelbar für große Orders.
// (2) Das Band muss mm_min_ask_shares Stück fassen: tut es das beim aktuellen
// Streubesitz nicht, kommt in einem Schritt so viel dazu, dass es passt — sonst
// bliebe „mindestens N Stück im Buch" bei kleinem Float unerreichbar. Beide
// Regeln gelten ohne Cooldown und ohne News, denn nach einer Platzierung ist die
// Bedingung erfüllt; sie lösen also je Wert nur erneut aus, wenn der Streubesitz schrumpft.
// (3) Nachplatzierungsschwelle: Bestand der Staatskasse unter max(25 % des
//     Streubesitzes, mm_min_ask_shares + Zuschlag) statt unter mm_replenish_min.
// (4) Deckel: Der Streubesitz wächst durch Nachplatzieren höchstens auf
//     MM_FLOAT_MAX_FACTOR × Start-Streubesitz. Ohne Deckel wächst er bei anhaltendem
//     Nettokauf mit jeder Nachplatzierung um 50 % (gemessen im Fast-Modus, 3 Minuten:
//     2822 → 27 461), und mit ihm schrumpft die Kurswirkung je Stück. Die Struktur-
//     Regeln (1) und (2) gelten weiter; am Deckel bleibt das Angebot, was die Staatskasse
//     noch hat. Sind die Streubesitz-Regeln aus, gibt es keinen Start-Streubesitz und
//     keinen Deckel — altes Verhalten.
const MM_FLOAT_TRIMMED_PCT = 25;
const MM_REPLENISH_HEADROOM = 100; // Stück, die im Buch zusätzlich zum Mindestangebot bleiben sollen
const MM_FLOAT_MAX_FACTOR = 3;
const replenishedAt = new Map(); // secId -> ts
// Start-Streubesitz nach den Struktur-Regeln: der Streubesitz, den sie einem frisch
// gelisteten Wert mindestens geben (so steht der Seed bei 2822). Er hängt nur von den
// Einstellungen ab, nicht vom Wertpapier — gesucht ab mm_min_depth (mindestens 100, dem
// kleinsten Streubesitz, in dessen Band überhaupt eine Stufe Platz hat), damit der 10-%-
// Schritt der Suche für jeden Wert gleich landet. 0 = Regeln aus.
function mmFloatBase(book, s) {
  const minDepth = atLeast(s.mm_min_depth, 0, 0);
  const minAsk = atLeast(s.mm_min_ask_shares, 0, 0);
  if (minDepth <= 0 && minAsk <= 0) return 0;
  const byAsk = minAsk > 0 ? mmDepthForAsk(book, minAsk, s, Math.max(minDepth, 100)) : 0;
  return Math.max(minDepth, byAsk || 0);
}
function mmMaybeReplenish(book, t) {
  const s = getSettings();
  const sec = book.sec;
  if (sec.type !== 'stock') return;
  // Gesamt-Angebot = Depotbestand + offene MM-Verkaufsorders (Escrow). Ohne die
  // Escrow-Zählung würde die Nachplatzierung nie auslösen, obwohl der Float
  // längst von Spielern aufgesaugt wurde.
  const escrowed = db.prepare("SELECT SUM(amount - filled) q FROM orders WHERE security_id=? AND user_id=? AND is_mm=1 AND side='sell' AND status='open'").get(sec.id, t.id).q || 0;
  const stock = holdingOf(t.id, sec.id) + escrowed;
  const depth = impactDepth(sec.id);
  const minDepth = atLeast(s.mm_min_depth, 0, 0);
  const minAsk = atLeast(s.mm_min_ask_shares, 0, 0);
  let structural = minDepth > depth ? minDepth - depth : 0;
  if (minAsk > 0) {
    const need = mmDepthForAsk(book, minAsk, s);
    if (need > depth) structural = Math.max(structural, need - depth);
  }
  // Ohne News: das ist keine Nachplatzierung wegen Nachfrage, und eine `ipo`-Zeile
  // ließe alte Aktien im Client als „neu an der Börse" gelten.
  if (structural > 0) { mmAddShares(sec, t, structural); return; }
  // Schwelle: nie unter dem Mindestangebot plus Zuschlag — sonst fällt das Buch unter
  // mm_min_ask_shares, ehe nachplatziert wird (E015).
  const triggerFor = (d) => minDepth > 0
    ? Math.max(s.mm_replenish_min, Math.floor(d * MM_FLOAT_TRIMMED_PCT / 100), minAsk > 0 ? minAsk + MM_REPLENISH_HEADROOM : 0)
    : s.mm_replenish_min;
  const trigger = triggerFor(depth);
  if (stock > trigger) return;
  // Deckel: so viel darf der Streubesitz noch wachsen. Ohne Start-Streubesitz (Regeln
  // aus) ist unbegrenzt.
  const base = mmFloatBase(book, s);
  const room = base > 0 ? MM_FLOAT_MAX_FACTOR * base - depth : Infinity;
  if (room < 1) return;
  const cooldownMs = (30 * 60 * 1000) / (s.bot_fast ? 100 : 1);
  const last = replenishedAt.get(sec.id) || 0;
  if (Date.now() - last < cooldownMs) {
    // Cooldown läuft: trotzdem ohne Wartezeit so viel nachlegen, dass der
    // Mindestbestand wieder steht (ohne News) — die Verkaufsseite darf nie leer bleiben.
    // unter mm_replenish_min wie bisher den Mindestbestand, sonst nur bis zur Schwelle; steht der
    // Bestand genau auf ihr, ist nichts zu tun (sonst wüchse er ohne jeden Handel)
    const minimum = Math.floor(s.mm_replenish_min);
    let qty = stock < minimum ? Math.max(1, minimum, trigger - stock) : trigger - stock;
    // Die Auffüllung vergrößert den Streubesitz und damit seinen 25-%-Anteil an der Schwelle:
    // bis die Schwelle nach der Auffüllung steht, sonst folgt im Leerlauf eine Kette Mini-Runden.
    for (let i = 0; qty > 0 && i < 60 && stock + qty < triggerFor(depth + qty); i++) qty = triggerFor(depth + qty) - stock;
    qty = Math.min(qty, room); // Deckel: notfalls weniger als die Schwelle
    if (qty > 0) mmAddShares(sec, t, qty);
    return;
  }
  replenishedAt.set(sec.id, Date.now());
  // Menge: mm_replenish_pct % des Streubesitzes, mindestens 100 Stück. Mit dem
  // größeren Streubesitz sinkt die Kurswirkung je Stück (λ = ln(1+p)/D).
  const qty = Math.min(room, Math.max(100, Math.round(impactDepth(sec.id) * s.mm_replenish_pct / 100)));
  if (qty < 1) return; // Deckel erreicht: keine Platzierung, keine News
  mmAddShares(sec, t, qty);
  const n = addNews('ipo', `Nachplatzierung: ${sec.name} (${sec.ticker}) platziert ${qty} neue Aktien`,
    `Die Nachfrage war so groß, dass der Streubesitz der Staatskasse aufgebraucht ist. Die Investment AG platziert ${qty} zusätzliche Aktien am Markt — frisches Angebot für alle, die mitsteigen wollen.`, sec.id);
  bus.emit({ type: 'news', news: n });
}
function mmAddShares(sec, t, qty) {
  db.prepare('UPDATE securities SET total_shares = total_shares + ? WHERE id = ?').run(qty, sec.id);
  sec.total_shares += qty;
  addHolding(t.id, sec.id, qty);
}

// Stellt ein Buch nach einem fehlgeschlagenen Recenter aus der DB wieder her
// (die Transaktion wurde zurückgerollt, der RAM könnte noch Orders führen).
function rebuildBook(book) {
  book.bids = [];
  book.asks = [];
  for (const o of db.prepare("SELECT * FROM orders WHERE security_id = ? AND status='open' ORDER BY created_at ASC, id ASC").all(book.sec.id)) insertIntoBook(book, o);
  book.ver = (book.ver || 0) + 1;
}

// Nach einem Fehler in runOrder/recenterBody ist die DB zurückgerollt, der RAM
// aber schon auf dem neuen Stand: F (Flow-Update), die ETF-Kurse (syncEtfPrices)
// und Orders, die das Band-Storno aus dem Buch genommen hat. Also das Buch aus
// der DB aufbauen: Wertpapierzeile neu lesen, F aus fair_price (ETFs über den
// NAV), alle offenen Orders aus der Tabelle.
function restoreBook(book) {
  const sec = q.secById.get(book.sec.id);
  if (!sec) {
    // Die Zeile muss nach einem Rollback existieren. Tut sie es nicht, ist nichts
    // mehr konsistent herstellbar — dann darf in diesem Buch nichts mehr
    // gehandelt werden: leeren und aus der Karte nehmen (placeOrder lehnt dann ab).
    console.error(`[Engine] Wertpapier ${book.sec.id} fehlt in der Datenbank — Buch aus dem RAM entfernt`);
    books.delete(book.sec.id);
    book.bids = [];
    book.asks = [];
    return;
  }
  book.sec = sec;
  if (sec.type !== 'etf') setFair(book, Number.isInteger(sec.fair_price) && sec.fair_price > 0 ? sec.fair_price : book.fair);
  syncEtfPrices();
  rebuildBook(book);
  for (const etf of books.values()) {
    if (etf !== book && etf.sec.type === 'etf') rebuildBook(etf); // ihr Band-Storno kann in derselben Transaktion gelaufen sein
  }
}

// Kreuzungsraum: Wie viele Stück die Staatskasse in eine liegende Order eines
// Teilnehmers zum Preis p füllen darf, ohne F über ein Gebot (side 'sell') bzw.
// unter ein Angebot (side 'buy') zu bewegen: floor(ln(p/F)/λ) bzw. floor(ln(F/p)/λ).
// null = keine Begrenzung (λ = 0: keine Kurswirkung).
function crossRoom(book, price, side) {
  const lambda = flowLambda(book);
  if (!(lambda > 0)) return null;
  const fair = book.fair / mmath.MILLI; // F in Cent, wie der Preis
  const log = side === 'sell' ? Math.log(price / fair) : Math.log(fair / price);
  return Math.max(0, Math.floor(log / lambda + 1e-9));
}

// Eine Leiste neu legen = ~25 Orders. Alles läuft in EINER Transaktion und
// sendet am Ende EIN Buch-Event (früher 13). Rückgabe: false, wenn es nicht geht
// (keine Staatskasse); sonst { changed }: ob sich F während des Recenters geändert
// hat (eine neue Quote, die einen liegenden Auftrag kreuzt, ist Orderflow) —
// dann legt mmRecenter erneut.
const recenterBody = db.transaction((book) => {
  const fairBefore = book.fair;
  if (book.sec.type === 'etf') syncEtfPrices(); // F (= NAV) zuerst, damit die Quotes am aktuellen NAV liegen
  const t0 = treasury();
  if (!t0) return false;
  mmCancelQuotes(book);          // alte Leiter abbauen (Escrow fließt zurück)
  mmMaybeReplenish(book, t0);    // ggf. frische Aktien nachlegen, BEVOR neu quotiert wird
  const t = treasury();          // frischer Stand (Cancel-Refunds + Nachplatzierung)
  if (!t) return false;
  const { bids, asks } = mmLadder(book);
  const s = getSettings();

  // Bid-Seite: Cash-Budget FAIR auf alle betreuten Werte verteilt (früher
  // konnte das erste Buch fast die gesamte Cash binden => einseitige Bücher).
  const nActive = [...books.values()].filter((b) => b.sec.mm_enabled).length || 1;
  const cashBudget = Math.floor(t.cash * s.mm_cash_budget_pct / nActive);
  // Bestes liegendes Angebot eines Teilnehmers: MM-Gebote, die es kreuzen, sind
  // Orderflow und drücken F — höchstens bis auf seinen Preis (crossRoom).
  const topOffer = book.asks.find((o) => !o.is_mm && o.amount - o.filled > 0);
  let roomBid = topOffer && book.sec.type === 'stock' ? crossRoom(book, topOffer.price, 'buy') : null;
  let bidEscrow = 0;
  for (const lvl of bids) {
    let size = lvl.size;
    if (bidEscrow + lvl.price * size > cashBudget) {
      size = Math.floor((cashBudget - bidEscrow) / lvl.price); // Teil-Quote statt Lücke
      if (size < 5) break;
    }
    if (roomBid != null && lvl.price >= topOffer.price) {
      if (roomBid < 1) continue; // Raum aufgebraucht: diese und keine weitere kreuzende Stufe
      size = Math.min(size, roomBid);
    }
    try {
      placeOrder(t, { security_id: book.sec.id, side: 'buy', type: 'limit', price: lvl.price, amount: size }, { mm: true });
      bidEscrow += lvl.price * size;
      if (roomBid != null && lvl.price >= topOffer.price) roomBid -= size;
    } catch (e) { break; }
  }
  // Ask-Seite: den ganzen Bestand anbieten — ohne Reserve, bis auf die letzte
  // Stückzahl (Teil-Quote statt Lücke). Fehlt Bestand, legt mmMaybeReplenish
  // beim nächsten Mal nach.
  let left = holdingOf(t.id, book.sec.id);
  // Spiegelbild: bestes liegendes Gebot eines Teilnehmers. MM-Asks darunter
  // füllen es höchstens so weit, dass F den Gebotspreis nicht überschreitet —
  // danach beginnt die Verkaufsseite oberhalb des Gebots.
  const topBid = book.bids.find((o) => !o.is_mm && o.amount - o.filled > 0);
  let roomAsk = topBid && book.sec.type === 'stock' ? crossRoom(book, topBid.price, 'sell') : null;
  for (const lvl of asks) {
    if (left < 1) break;
    let size = Math.min(lvl.size, left);
    const crossing = roomAsk != null && lvl.price <= topBid.price;
    if (crossing) {
      if (roomAsk < 1) continue;
      size = Math.min(size, roomAsk);
    }
    try { placeOrder(q.userById.get(t.id), { security_id: book.sec.id, side: 'sell', type: 'limit', price: lvl.price, amount: size }, { mm: true }); }
    catch (e) { break; }
    left -= size;
    if (crossing) roomAsk -= size;
  }
  return { changed: book.fair !== fairBefore };
});

// Rückgabe: true = Leiste gelegt; false = es geht nicht (keine Staatskasse) oder der
// Körper ist fehlgeschlagen (DB zurückgerollt, im Turnus erneut). Im Refresh-Loop ist
// false der Normalfall für leere Kassen und darf nicht werfen. Wer den Aufruf braucht,
// damit etwas gilt — ETF: Creation/Redemption ohne Leiste wäre ein halber Schritt —,
// ruft mit { strict: true }; dann kommt der Fehler nach dem Zurückrollen beim Aufrufer an.
function mmRecenter(book, { strict = false } = {}) {
  if (!book.sec.mm_enabled) return false;
  quiet++;
  quietTrades = [];
  let res = false;
  try {
    let n = 1; // immer mindestens einmal
    res = recenterBody(book);
    while (res && res.changed && n++ < 3) res = recenterBody(book);
  } catch (e) {
    console.error('[Market-Maker] Leiste konnte nicht neu gelegt werden:', e.message);
    restoreBook(book); // DB zurückgerollt: F, ETF-Kurse und Orderbuch aus der Tabelle
    book.mmNextAt = Date.now() + getSettings().mm_refresh_sec * 1000; // im Turnus erneut, nicht alle 3 s
    const pending = quietTrades;
    quietTrades = [];
    quiet--;
    if (strict) throw e;
    return false;
  }
  const pending = quietTrades;
  quietTrades = [];
  quiet--;
  if (!res) { if (strict) throw new Error(`[Market-Maker] Leiste für ${book.sec.ticker} nicht gelegt: keine Staatskasse`); return false; } // keine Staatskasse: nichts gelegt, kein Event
  book.mmQuotedPrice = book.last; // ETF: ist K seither gewandert, wird im 3-s-Takt neu gelegt
  // Gestaffelter Refresh: jedes Buch bekommt seinen eigenen Takt (±30%).
  book.mmNextAt = Date.now() + getSettings().mm_refresh_sec * 1000 * (0.7 + Math.random() * 0.6);
  if (pending.length) checkTakeover(book.sec);
  broadcastChanges(book, pending, null);
  return true;
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
        `Die Staatskasse war durch Ausschüttungen und Netto-Käufe fast leer gelaufen und hätte keine Kauforders mehr legen können. Die Zentralbank hat sie mit ${fmtDeInt(topUp)} Credits gestützt — der Market Maker bleibt handlungsfähig.`);
      bus.emit({ type: 'news', news: n });
    }
  }
  const now = Date.now();
  for (const book of books.values()) {
    if (!book.sec.mm_enabled) continue;
    // Self-Healing über den Takt: Jeder Recenter setzt mmNextAt; wurden Quotes
    // außen aufgehoben (etf.js, mmCancelQuotes), steht mmNextAt auf 0 und das
    // Buch ist sofort fällig. Eine Seite, die sich nicht quotieren lässt (kein
    // Bestand, kein Cash), wird so nur im Turnus erneut versucht, nicht alle 3 s.
    // ETFs außerdem, sobald K seit der letzten Quotierung gewandert ist.
    const moved = book.sec.type === 'etf' && book.last !== book.mmQuotedPrice;
    if (moved || book.mmNextAt === undefined || book.mmNextAt <= now) mmRecenter(book);
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
  if (trades.length) pushTicker(book.sec.id);
  bus.emit({ type: 'book', security_id: book.sec.id, book: bookSnapshot(book.sec.id) });
  for (const t of trades) bus.emit({ type: 'trade', ...t });
  if (touchedUserId) bus.emit({ type: 'dirty', user_id: touchedUserId, what: ['portfolio', 'orders'] });
}

// `ticker` geht an ALLE Verbindungen: je Wert höchstens einer je TICKER_PUSH_MS, mit dem
// letzten Stand. Der erste nach einer Ruhepause geht sofort (die Anzeige zögert nicht);
// was folgt, wird zu einem Push am Ende der Frist zusammengefasst. Im Fast-Modus waren es
// vorher einer je Order mit Fills (Lasttest: 4 425 je s für 300 Verbindungen).
const TICKER_PUSH_MS = 250;
const tickerNext = new Map();      // secId -> frühester Zeitpunkt des nächsten Pushes
const tickerWaiting = new Set();   // Werte mit Stand nach dem letzten Push
let tickerTimer = null;
function pushTicker(secId) {
  const now = Date.now();
  const next = tickerNext.get(secId);
  if (next !== undefined && next > now) {        // Frist läuft: ein Push am Fristende
    tickerWaiting.add(secId);
    if (tickerTimer === null) {
      tickerTimer = setTimeout(flushTickers, next - now);
      if (tickerTimer.unref) tickerTimer.unref();
    }
    return;
  }
  tickerNext.set(secId, now + TICKER_PUSH_MS);
  bus.emit({ type: 'ticker', ticker: tickerRow(secId) });
}
function flushTickers() {
  tickerTimer = null;
  const now = Date.now();
  for (const [secId, next] of tickerNext) if (next <= now) tickerNext.delete(secId);
  const due = [...tickerWaiting];
  tickerWaiting.clear();
  // Läuft die Frist erst nach dem Herunterfahren ab (DB zu), bleibt der Push aus — ohne Fehler.
  if (!db.open) return;
  for (const secId of due) pushTicker(secId);
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
// F startet beim ersten Kurs (initial_last oder IPO-Preis) und wird persistiert.
// Ein ETF hat hier noch keinen Korb — sein F (= NAV) steht mit syncEtfPrices.
function listSecurity({ type, ticker, name, description, founder_id, ipo_price, total_shares, mm_enabled = 1, shares_per_unit = null, initial_last = null }) {
  const now = Date.now();
  const fair = (initial_last || ipo_price) * mmath.MILLI;
  const r = db.prepare(`INSERT INTO securities(type, ticker, name, description, founder_id, ipo_price, total_shares, lockup_until, mm_enabled, shares_per_unit, fair_price, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, ticker.toUpperCase(), name, description || '', founder_id || null, ipo_price, total_shares, founder_id ? now + getSettings().lockup_sec * 1000 : 0, mm_enabled, shares_per_unit, fair, now);
  const sec = q.secById.get(r.lastInsertRowid);
  books.set(sec.id, makeBook(sec, fair));
  return sec;
}

module.exports = {
  books, loadEngine, placeOrder, cancelOrder, cancelUserOrders, bookSnapshot, tickerAll, tickerRow,
  costToBuy, proceedsToSell, walkBook, previewOrder, computeStats, priceBand,
  listSecurity, mmRecenter, mmCancelQuotes, mmRefreshAll, mmLadder, holdingOf,
  treasury, tick, checkTakeover, addHoldingPublic: addHolding, sideDepth,
  fairPrice, impactDepth, syncEtfPrices
};
