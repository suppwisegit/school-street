// Motor-Tests (T-B3). Laufen gegen eine eigene, frisch geseedete Datenbank
// (server/data/b3-test-<pid>.db) — die echte DB wird nie berührt.
// Teil 2 (ab "Market Maker V3") prüft die Orderflow-Preisfindung der Engine:
// fairer Kurs F, Band, Ordergrößen-Grenze, Band-Storno, ETF am NAV, Neustart
// und Migration. Alle Tests teilen sich eine Datenbank und laufen in Reihenfolge;
// deshalb rechnen sie mit relativen Werten, Neustart und Migration stehen am Ende.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const mmath = require('../mmath');

const DB_NAME = `b3-test-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);

const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

// Erst seeden, DANN öffnen: seed.js löscht die Datei und legt sie neu an —
// eine vorher geöffnete Verbindung zeigte noch in die leere Datei.
let db, getSettings, setSetting, q, auth, bus, engine, jobs;

before(() => {
  clean();
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
  ({ db, getSettings, setSetting, q } = require('../db'));
  auth = require('../auth');
  bus = require('../bus');
  engine = require('../engine');
  jobs = require('../jobs');
  engine.loadEngine();
});
after(clean);

let n = 0;
const newUser = async (cash = 1_000_000) => auth.createUser(`motor-test-${++n}`, 'pw1234', 'user', cash);
const fresh = (u) => q.userById.get(u.id);
const sum = (trades) => trades.reduce((s, t) => s + t.price * t.amount, 0);
const firstSec = () => engine.books.keys().next().value;

test('Marktkauf füllt gegen die Leiste und bucht Cash, Depot und Gebühr in einem Zug', async () => {
  const secId = firstSec();
  const u = await newUser();
  const r = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 5 });
  assert.ok(r.trades.length >= 1, 'Marktkauf muss gegen die Market-Maker-Leiste füllen');
  assert.equal(fresh(u).cash, 1_000_000 - sum(r.trades) - getSettings().fee_cent);
  assert.equal(engine.holdingOf(u.id, secId), 5);
});

test('Schlägt eine Order mitten im Ablauf fehl, bleibt keine halbe Buchung stehen', async () => {
  const secId = firstSec();
  const u = await newUser();
  const cashBefore = fresh(u).cash;
  // Verkauf ohne Bestand wird vor jeder Buchung abgelehnt — Markt und Limit
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'market', amount: 3 }), /Depot/);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'limit', price: engine.tickerRow(secId).bid, amount: 3 }), /Depot/);
  assert.equal(fresh(u).cash, cashBefore);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(u.id).c, 0);
});

test('Limitkauf ohne genug Geld wird abgelehnt — kein Kauf auf Kredit', async () => {
  const secId = firstSec();
  const u = await newUser(1000); // 10 Credits
  const before = fresh(u).cash;
  const price = engine.books.get(secId).bids[0].price;
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price, amount: 100000 }), /Credits/);
  assert.equal(fresh(u).cash, before);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status = 'open'").get(u.id).c, 0);
});

test('Pausierte Börse: Spieler können nicht handeln, der Market-Maker quotiert weiter', async () => {
  const secId = firstSec();
  setSetting('trading_paused', 1);
  try {
    const u = await newUser();
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 1 }), /Pause/);
    const book = engine.books.get(secId);
    assert.doesNotThrow(() => engine.mmRecenter(book));
    assert.ok(book.bids.length > 0 && book.asks.length > 0, 'Leiste muss auch in der Pause stehen');
  } finally {
    setSetting('trading_paused', 0);
  }
});

test('cancelUserOrders storniert alle offenen Orders und zahlt das Escrow vollständig zurück', async () => {
  const secId = firstSec();
  const u = await newUser();
  const book = engine.books.get(secId);
  const low = book.bids[0].price - engine.tick(book.sec); // unter dem besten Gebot → bleibt liegen
  const cashBefore = fresh(u).cash;
  engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: low, amount: 3 });
  assert.equal(fresh(u).cash, cashBefore - low * 3);
  assert.equal(engine.cancelUserOrders(u.id), 1);
  assert.equal(fresh(u).cash, cashBefore);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id = ? AND status = 'open'").get(u.id).c, 0);
  assert.equal(book.bids.filter(o => o.user_id === u.id).length, 0);
});

test('Kompletter Limitverkauf bucht den Gewinn mit dem echten Einstandspreis', async () => {
  const secId = firstSec();
  const seller = await newUser();
  const buy = engine.placeOrder(fresh(seller), { security_id: secId, side: 'buy', type: 'market', amount: 4 });
  const avg = q.holding.get(seller.id, secId).avg_cost;
  assert.equal(avg, Math.round(sum(buy.trades) / 4));
  // Verkauf ins beste Gebot: füllt sofort, die Position läuft dabei leer
  const sell = engine.placeOrder(fresh(seller), { security_id: secId, side: 'sell', type: 'limit', price: engine.books.get(secId).bids[0].price, amount: 4 });
  assert.equal(sell.trades.reduce((s, t) => s + t.amount, 0), 4);
  assert.equal(fresh(seller).realized_pl, sum(sell.trades) - avg * 4);
  assert.equal(engine.holdingOf(seller.id, secId), 0);
});

test('Storno eines Limitverkaufs bringt die Aktien mit ihrem Einstandspreis zurück', async () => {
  const secId = firstSec();
  const u = await newUser();
  const book = engine.books.get(secId);
  const buy = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 3 });
  const avg = q.holding.get(u.id, secId).avg_cost;
  // Verkaufslimit über dem besten Gebot → bleibt liegen, Aktien liegen im Escrow
  const o = engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'limit', price: book.bids[0].price + engine.tick(book.sec), amount: 3 });
  assert.equal(engine.holdingOf(u.id, secId), 0);
  assert.equal(o.order.status, 'open');
  engine.cancelOrder(fresh(u), o.order.id);
  assert.equal(q.holding.get(u.id, secId).amount, 3);
  assert.equal(q.holding.get(u.id, secId).avg_cost, avg);
});

test('mmRecenter legt eine neue Leiste und sendet genau EIN Buch-Event', () => {
  const secId = firstSec();
  let listening = true;
  let bookEvents = 0;
  bus.on((m) => { if (listening && m.type === 'book' && m.security_id === secId) bookEvents++; });
  try {
    engine.mmRecenter(engine.books.get(secId));
  } finally {
    listening = false;
  }
  assert.equal(bookEvents, 1);
  const book = engine.books.get(secId);
  assert.ok(book.bids.length > 0 && book.asks.length > 0);
});

test('Ticker-Zeile ist nach einem Trade sofort aktuell', async () => {
  const secId = firstSec();
  engine.tickerRow(secId); // Cache anwärmen
  engine.placeOrder(fresh(await newUser()), { security_id: secId, side: 'buy', type: 'market', amount: 1 });
  const row = engine.tickerRow(secId);
  const book = engine.books.get(secId);
  assert.equal(row.last, book.last);
  assert.equal(row.bid, book.bids[0].price);
});

test('Ghost-Cleanup rechnet in Sekunden: zwei Stunden Inaktivität löscht niemanden', async () => {
  const u = await newUser();
  db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(Date.now() - 2 * 3600 * 1000, u.id);
  jobs.ghostCleanup();
  assert.ok(q.userById.get(u.id), 'Konto darf nach 2 Stunden nicht gelöscht werden (Frist: 21 Tage)');
});

test('incomeNextAt: Zeitpunkt in der Zukunft, oder null wenn das Einkommen aus ist', () => {
  jobs.state.last_income = Date.now();
  setSetting('income_sec', 300);
  assert.ok(jobs.incomeNextAt() > Date.now());
  setSetting('income_sec', 0);
  assert.equal(jobs.incomeNextAt(), null);
  setSetting('income_sec', 300);
});

// ===========================================================================
// Market Maker V3 — Orderflow-Preisfindung
// ===========================================================================
const fmt = (cent) => (cent / 100).toFixed(2);
const mmath_MILLI = 1000; // Milli-Cent je Cent
const ordersOf = (book) => [...book.bids, ...book.asks];
const isMmQuote = (o) => !!o.is_mm && o.status === 'open' && o.amount - o.filled > 0;
const etfId = () => db.prepare("SELECT id FROM securities WHERE type = 'etf'").get().id;
// Zufall der MM-Staffel für einen Aufruf festlegen: rnd = 0,5 heißt Größen und Abstände ohne Jitter
const noJitter = (fn) => { const orig = Math.random; Math.random = () => 0.5; try { return fn(); } finally { Math.random = orig; } };
// Ereignisse auf dem Bus zählen, solange der Zähler an ist
function counter(pred) { let on = true, n = 0; bus.on((m) => { if (on && pred(m)) n++; }); return { get count() { return n; }, stop() { on = false; } }; }
// Aktie mit Gründer (1000 Stück, gesperrt) und Streubesitz in der Staatskasse anlegen
async function listStock(ticker, ipo, float) {
  const founder = await newUser();
  const sec = engine.listSecurity({ type: 'stock', ticker, name: `${ticker} AG`, founder_id: founder.id, ipo_price: ipo, total_shares: 1000 + float });
  engine.addHoldingPublic(founder.id, sec.id, 1000, ipo);
  engine.addHoldingPublic(engine.treasury().id, sec.id, float, ipo);
  return { sec, book: engine.books.get(sec.id) };
}
// Alle Orders von Teilnehmern (und manuelle der Staatskasse) aus einem Buch nehmen —
// der Seed hinterlässt in den Korbaktien ruhende Verkaufsorders von Dummies
function clearBook(book) {
  for (const o of ordersOf(book)) if (!o.is_mm && o.status === 'open') engine.cancelOrder(q.userById.get(o.user_id), o.id);
}
const newsCount = () => db.prepare('SELECT COUNT(*) c FROM news').get().c;
// Streubesitz im Spiel-Default (mm_min_ask_shares = 1000, mm_min_depth = 2000) aus der Tabelle:
// Gesamtaktien − Gründerbestand, so rechnet auch engine.impactDepth
const tableDepth = (secId) => {
  const sec = q.secById.get(secId);
  const h = sec.founder_id ? q.holding.get(sec.founder_id, secId) : null;
  return sec.total_shares - (h ? h.amount : 0);
};
// Streubesitz-Regeln für einen Test ausschalten (auf 0 = alte Leiste, alte Nachplatzierung
// nach mm_replenish_min): nur für Tests, die Alt-Verhalten prüfen, das vom Streubesitz
// unabhängig ist (D = 400/2000, Leiste 435 Stück, Ordergrenze 137). Am Testende zurück.
function withoutFloatRules(t, { ask = true, depth = true } = {}) {
  const prev = getSettings();
  if (ask) setSetting('mm_min_ask_shares', 0);
  if (depth) setSetting('mm_min_depth', 0);
  t.after(() => {
    if (ask) setSetting('mm_min_ask_shares', prev.mm_min_ask_shares);
    if (depth) setSetting('mm_min_depth', prev.mm_min_depth);
  });
}
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

test('V3 · Tick: Aktie und ETF in 0,1-Credit-Schritten, Band ±15 % ohne 100-Cr-Boden', async () => {
  assert.equal(engine.tick({ type: 'stock' }), 10);
  assert.equal(engine.tick({ type: 'etf' }), 10);
  const u = await newUser();
  for (const type of ['stock', 'etf']) {
    const secId = [...engine.books.keys()].find((id) => engine.books.get(id).sec.type === type);
    const book = engine.books.get(secId);
    const { ref, min, max } = engine.priceBand(book);
    assert.equal(ref % 10, 0);
    assert.ok(ref - min >= 20 && max - ref >= 20, `Band um ${ref}: ${min}–${max}`); // mindestens 2 Ticks je Seite
    assert.ok(max - min <= Math.round(ref * 0.30) + 30, `Band ${min}–${max} ist weiter als ±15 % um ${ref}`);
    assert.equal(book.last, ref);
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: ref + 5, amount: 1 }), /Ungültiger Preis \(Tick 0\.1 Credits\)/);
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: max + 10, amount: 1 }), /zu weit/);
    const edge = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: min, amount: 1 }); // Bandgrenze selbst ist erlaubt
    engine.cancelOrder(fresh(u), edge.order.id);
  }
});

test('V3 · Absurdes Limit: 10 000 Credits bei einer 20-Cr-Aktie werden mit Bereich abgelehnt', async () => {
  const sec = q.secByTicker.get('EVENT');
  const u = await newUser();
  const { ref, min, max } = engine.priceBand(engine.books.get(sec.id));
  assert.ok(ref >= 1800 && ref <= 2200, `EVENT sollte um 20 Cr notieren, nicht ${ref}`);
  const f0 = engine.fairPrice(sec.id);
  for (const side of ['buy', 'sell']) {
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: sec.id, side, type: 'limit', price: 1_000_000, amount: 1 }), (e) => {
      assert.match(e.message, /Preis zu weit vom Kurs entfernt/);
      assert.ok(e.message.includes(`Kurs ${fmt(ref)} ±15%`), e.message);
      assert.ok(e.message.includes(`Erlaubt: ${fmt(min)} – ${fmt(max)}`), e.message);
      return true;
    });
  }
  assert.equal(fresh(u).cash, 1_000_000);
  assert.equal(engine.fairPrice(sec.id), f0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(u.id).c, 0);
});

test('V3 · Orderflow: 1 Stück gegen die Staatskasse bewegt F um λ (unter 0,05 %), 100 Stück um das Hundertfache', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const u = await newUser();
  clearBook(book);
  noJitter(() => engine.mmRecenter(book));
  assert.equal(book.asks[0].is_mm, 1, 'bester Ask muss eine MM-Quote sein');
  // Der Streubesitz steht nicht mehr fest: der Seed füllt per Struktur-Auffüllung auf (E015,
  // 2000 → 2822) und er wächst mit der Nachplatzierung. Erwartung deshalb aus der Tabelle.
  const D = tableDepth(secId);
  assert.equal(engine.impactDepth(secId), D);
  assert.ok(D >= 2000, `Streubesitz ${D}`);
  const lambda = Math.log(1.5) / D;
  const f0 = engine.fairPrice(secId);
  const k0 = book.last;
  noJitter(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 1 }));
  const f1 = engine.fairPrice(secId);
  assert.ok(Math.abs(f1 / f0 - 1) < 0.0005, `1 Stück: ${(f1 / f0 - 1) * 100} %`);
  assert.ok(Math.abs(f1 - f0) <= f0 * (Math.exp(lambda) - 1) + 0.5 + 1e-6, 'weniger als λ plus Rundung');
  assert.ok(Math.abs(f1 / f0 - 1) >= lambda * 0.99);
  assert.equal(q.secById.get(secId).fair_price, f1, 'F wird persistiert');
  noJitter(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 100 }));
  const f2 = engine.fairPrice(secId);
  const ratio = Math.log(f2 / f1) / Math.log(f1 / f0);
  assert.ok(Math.abs(ratio - 100) <= 5, `Verhältnis 1 Stück : 100 Stück = ${ratio}`);
  assert.ok(book.last > k0);
  noJitter(() => engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'market', amount: 101 }));
  assert.ok(Math.abs(engine.fairPrice(secId) - f0) <= 2, 'Verkauf derselben Menge bringt F zurück');
});

test('V3 · Flow nur gegen die Staatskasse: 20 × 300 Stück zwischen zwei Konten lassen F exakt stehen', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const a = await newUser(100_000_000), b = await newUser(100_000_000);
  noJitter(() => {
    engine.placeOrder(fresh(a), { security_id: secId, side: 'buy', type: 'market', amount: 300 });
    engine.placeOrder(fresh(b), { security_id: secId, side: 'buy', type: 'market', amount: 300 });
  });
  const f0 = engine.fairPrice(secId);
  let [seller, buyer] = [a, b];
  for (let i = 0; i < 20; i++) {
    const price = book.asks[0].price - engine.tick(book.sec); // ein Tick vor der MM-Quote: bestes Angebot
    const offer = engine.placeOrder(fresh(seller), { security_id: secId, side: 'sell', type: 'limit', price, amount: 300 });
    assert.equal(offer.order.status, 'open');
    const r = engine.placeOrder(fresh(buyer), { security_id: secId, side: 'buy', type: 'market', amount: 300 });
    assert.equal(r.order.filled, 300);
    assert.ok(r.trades.every((x) => x.price === price), `Runde ${i}: gegen Teilnehmer gefüllt`);
    assert.equal(engine.fairPrice(secId), f0, `Runde ${i}: F unverändert`);
    [seller, buyer] = [buyer, seller];
  }
  engine.placeOrder(fresh(seller), { security_id: secId, side: 'buy', type: 'market', amount: 50 });
  assert.notEqual(engine.fairPrice(secId), f0, 'Kauf gegen die Staatskasse bewegt F');
  engine.placeOrder(fresh(seller), { security_id: secId, side: 'sell', type: 'market', amount: 50 });
  assert.equal(engine.fairPrice(secId), f0, 'Verkauf derselben Menge an die Staatskasse: F exakt F0');
});

test('V3 · Fill-Preis ist kein Kurs: Gebot +14,9 % wird vom Mitspieler getroffen, F und K bleiben', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const bidder = await newUser(), seller = await newUser();
  noJitter(() => engine.placeOrder(fresh(seller), { security_id: secId, side: 'buy', type: 'market', amount: 1 }));
  clearBook(book);
  engine.mmCancelQuotes(book); // nur Teilnehmer-Orders im Buch
  const f0 = engine.fairPrice(secId), k0 = engine.tickerRow(secId).last;
  const price = engine.priceBand(book).ref + Math.round(engine.priceBand(book).ref * 0.149 / 10) * 10;
  const bid = engine.placeOrder(fresh(bidder), { security_id: secId, side: 'buy', type: 'limit', price, amount: 1 });
  assert.equal(bid.order.status, 'open');
  const sell = engine.placeOrder(fresh(seller), { security_id: secId, side: 'sell', type: 'market', amount: 1 });
  assert.deepEqual(sell.trades.map((x) => [x.price, x.amount]), [[price, 1]], 'Fill beim Gebotspreis, nicht beim Kurs');
  assert.equal(orderRow(bid.order.id).status, 'filled');
  assert.equal(engine.fairPrice(secId), f0, 'Geschäft zwischen zwei Teilnehmern: F unverändert');
  assert.equal(engine.tickerRow(secId).last, k0, 'K springt nicht zum Fill-Preis');
  assert.equal(q.secById.get(book.sec.id).fair_price, f0);
});

test('V3 · Ausgeführt wird nur im Band: Orders außerhalb werden nie getroffen, Vorschau = Ausführung', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const t = engine.treasury();
  noJitter(() => engine.mmRecenter(book));
  const { min, max } = engine.priceBand(book);
  // Nur die Staatskasse darf so weit vom Kurs stellen
  const farBid = engine.placeOrder(t, { security_id: secId, side: 'buy', type: 'limit', price: min - 100, amount: 500 }, { mm: false });
  const farAsk = engine.placeOrder(t, { security_id: secId, side: 'sell', type: 'limit', price: max + 100, amount: 500 }, { mm: false });
  assert.equal(farBid.order.status, 'open');
  assert.equal(farAsk.order.status, 'open');
  const mmBids = book.bids.filter(isMmQuote).reduce((s, o) => s + o.amount - o.filled, 0);
  assert.equal(engine.sideDepth(book, 'buy'), mmBids, 'Tiefe zählt das Gebot außerhalb nicht');
  const u = await newUser(100_000_000);
  const run = (side, amount) => {
    const pv = engine.previewOrder(fresh(u), { security_id: secId, side, type: 'market', amount });
    const r = engine.placeOrder(fresh(u), { security_id: secId, side, type: 'market', amount });
    assert.deepEqual(r.trades.map((x) => [x.price, x.amount]), pv.fills.map((x) => [x.price, x.qty]));
    return r;
  };
  const buy = run('buy', 80);
  const sell = run('sell', 30);
  assert.ok(buy.trades.length >= 2 && buy.trades.every((x) => x.price <= max));
  assert.ok(sell.trades.length >= 2 && sell.trades.every((x) => priceIn(x.price, min, max)));
  assert.equal(orderRow(farBid.order.id).filled, 0);
  assert.equal(orderRow(farAsk.order.id).filled, 0);
  assert.equal(orderRow(farBid.order.id).status, 'canceled', 'Gebot weit unter Kurs ist nach dem Kauf außerhalb des Bands → Band-Storno');
  for (const o of [farBid, farAsk]) if (orderRow(o.order.id).status === 'open') engine.cancelOrder(t, o.order.id);
  function priceIn(p, lo, hi) { return p >= lo && p <= hi; }
});

test('V3 · Band-Storno: Order außerhalb des gewanderten Bands wird storniert, Escrow vollständig zurück', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const u = await newUser(), buyer = await newUser();
  noJitter(() => engine.mmRecenter(book));
  const price = engine.priceBand(book).min + engine.tick(book.sec); // knapp unter −14,9 %
  const cashBefore = fresh(u).cash;
  const r = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price, amount: 3 });
  assert.equal(r.order.status, 'open');
  assert.equal(fresh(u).cash, cashBefore - price * 3);
  const dirty = counter((m) => m.type === 'dirty' && m.user_id === u.id && m.what.includes('orders'));
  const f0 = engine.fairPrice(secId);
  // so viele Stück gegen die Staatskasse, dass F um gut 2 % steigt (früher 60 Stück bei D = 2000);
  // Menge aus dem Streubesitz der Tabelle, statt fest
  const qty = Math.ceil(Math.log(1.02) / (Math.log(1.5) / tableDepth(secId))) + 1;
  assert.ok(engine.sideDepth(book, 'sell') >= qty, 'Angebot reicht für die Kaufmenge');
  engine.placeOrder(fresh(buyer), { security_id: secId, side: 'buy', type: 'market', amount: qty });
  dirty.stop();
  assert.ok(engine.fairPrice(secId) >= f0 * 1.01, 'Kauf hebt F um mindestens 1 %');
  assert.equal(orderRow(r.order.id).status, 'canceled');
  assert.equal(fresh(u).cash, cashBefore, 'Escrow vollständig zurück');
  assert.equal(ordersOf(book).some((o) => o.id === r.order.id), false, 'nicht mehr im Buch');
  assert.equal(dirty.count, 1);
  engine.cancelOrder(fresh(u), r.order.id); // nochmals stornieren: idempotent, keine zweite Buchung
  assert.equal(fresh(u).cash, cashBefore);
});

test('V3 · Kreuzende MM-Quotes sind Orderflow: liegendes Gebot am Band-Maximum hebt F bei jeder Füllung', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const { sec, book } = await listStock('KREUZ', 2000, 2000);
  const u = await newUser(100_000_000);
  const f0 = engine.fairPrice(sec.id);
  const price = engine.priceBand(book).max;
  const cash0 = fresh(u).cash;
  // Das Buch ist frisch angelegt und leer: das Gebot liegt, ohne etwas zu kreuzen
  assert.equal(ordersOf(book).length, 0);
  const bid = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price, amount: 200 });
  assert.equal(bid.order.status, 'open');
  assert.equal(engine.fairPrice(sec.id), f0, 'ohne Kreuzung kein Orderflow');
  // Die neuen MM-Asks liegen unter dem Gebot: die Staatskasse füllt es als Taker — je Füllung steigt F
  const steps = [];
  noJitter(() => {
    for (let i = 0; i < 3; i++) {
      const before = engine.fairPrice(sec.id);
      const filled = orderRow(bid.order.id).filled;
      engine.mmRecenter(book);
      steps.push([orderRow(bid.order.id).filled - filled, engine.fairPrice(sec.id) - before]);
    }
  });
  const bought = orderRow(bid.order.id).filled;
  assert.ok(bought > 0, 'Gebot wurde von MM-Quotes gefüllt');
  const f1 = engine.fairPrice(sec.id);
  // F wird je MM-Order (je Kreuzung) einmal gerundet: bis zu 1 Milli-Cent Abweichung je Durchlauf
  assert.ok(Math.abs(f1 - f0 * Math.exp((Math.log(1.5) / 2000) * bought)) <= 3, `F = F0 · e^(λ · gekaufte Menge): ${f1}`);
  assert.ok(steps.every(([qty, d]) => (qty > 0) === (d > 0)), 'F steigt genau dann, wenn das Gebot gefüllt wird');
  assert.ok(f1 / f0 <= 1.15, `Bewegung ${((f1 / f0 - 1) * 100).toFixed(2)} % bleibt im Band`);
  assert.ok(steps[steps.length - 1][0] === 0, 'das Kreuzen hört von selbst auf');
  assert.equal(fresh(u).cash, cash0 - price * bought - getSettings().fee_cent, 'Käufer zahlt Gebotspreis × Menge plus Gebühr');
  // Das Gebot ist vollständig gefüllt: nichts liegt mehr über dem Markt, alle MM-Asks darüber
  assert.equal(orderRow(bid.order.id).status, 'filled');
  assert.equal(bought, 200);
  assert.ok(book.asks.filter(isMmQuote).length > 0, 'die Staatskasse quotiert weiter');
});

test('V3 · Schlägt eine Order nach dem Flow-Update fehl, steht der Kurs im RAM nicht auf dem neuen Stand', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const { sec, book } = await listStock('FEHL', 2000, 400);
  const u = await newUser(100_000_000);
  noJitter(() => engine.mmRecenter(book));
  const bank = engine.treasury();
  // eine Order, die das Band-Storno treffen würde, und eine manuelle Order der Staatskasse
  const low = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: engine.priceBand(book).min, amount: 2 });
  const manual = engine.placeOrder(bank, { security_id: sec.id, side: 'buy', type: 'limit', price: engine.priceBand(book).ref - 20, amount: 1 }, { mm: false });
  engine.mmCancelQuotes(book);
  noJitter(() => engine.mmRecenter(book));
  const etf = engine.books.get(etfId());
  const state = () => ({
    fair: engine.fairPrice(sec.id), last: book.last, sec: book.sec.fair_price, ver: book.ver,
    book: ordersOf(book).map((o) => [o.id, o.filled, o.status]).sort((x, y) => x[0] - y[0]),
    table: db.prepare("SELECT id, filled, status FROM orders WHERE security_id = ? AND status = 'open' ORDER BY id").all(sec.id).map((o) => [o.id, o.filled, o.status]),
    etf: engine.fairPrice(etf.sec.id)
  });
  const before = state();
  const cash = fresh(u).cash;
  const depth = engine.sideDepth(book, 'sell');
  assert.ok(depth >= 60);
  const order = { security_id: sec.id, side: 'buy', type: 'market', amount: 60 };
  const real = q.phIns;
  q.phIns = { run() { throw new Error('simuliert: SQLITE_FULL'); } }; // letzter Schreibzugriff nach dem Flow-Update
  let failed = false;
  try { engine.placeOrder(fresh(u), order); } catch (e) { failed = /simuliert/.test(e.message); } finally { q.phIns = real; }
  assert.equal(failed, true);
  const after = state();
  assert.equal(after.fair, before.fair, 'F im RAM unverändert');
  assert.equal(after.last, before.last, 'K im RAM unverändert');
  assert.equal(after.sec, q.secById.get(sec.id).fair_price, 'RAM-Zeile = Tabelle');
  assert.deepEqual(after.book, after.table, 'RAM-Buch = offene Orders der Tabelle');
  assert.deepEqual(after.book, before.book, 'Band-Storno zurückgerollt');
  assert.equal(after.etf, before.etf, 'ETF-Kurs zurückgerollt');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM trades WHERE security_id = ?').get(sec.id).c,
    db.prepare('SELECT COUNT(*) c FROM trades WHERE buyer_id = ?').get(u.id).c + db.prepare('SELECT COUNT(*) c FROM trades WHERE security_id = ? AND buyer_id <> ?').get(sec.id, u.id).c);
  assert.equal(fresh(u).cash, cash, 'keine halbe Buchung');
  // dieselbe Order nochmal: der Flow wirkt genau einmal
  const r = engine.placeOrder(fresh(u), order);
  assert.equal(r.order.filled, 60);
  assert.equal(engine.fairPrice(sec.id), Math.round(before.fair * Math.exp((Math.log(1.5) / 400) * 60)));
  assert.equal(orderRow(low.order.id).status, 'canceled', 'jetzt greift das Band-Storno');
  engine.cancelOrder(bank, manual.order.id);
});

test('V3 · Ordergrößen-Grenze: Q_max + 1 abgelehnt, Q_max füllt, Treasury und ETF ohne Grenze', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const { sec, book } = await listStock('QMAX', 2000, 400);
  const bank = engine.treasury();
  noJitter(() => engine.mmRecenter(book));
  assert.equal(q.secById.get(sec.id).fair_price, 2_000_000);
  assert.equal(book.last, 2000);
  const u = await newUser();
  const cap = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: 1 }).cap;
  assert.equal(cap, 137); // floor(ln 1,15 / (ln 1,5 / 400))
  const f0 = engine.fairPrice(sec.id);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: cap + 1 }),
    (e) => e.message === `Zu groß für eine Order: höchstens ${cap} Stück, damit der Kurs pro Order höchstens 15 % springt. Teile die Order.`);
  assert.equal(fresh(u).cash, 1_000_000, 'keine Buchung');
  assert.equal(engine.fairPrice(sec.id), f0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(u.id).c, 0);
  const pvBig = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: cap + 1 });
  assert.equal(pvBig.cap, cap);
  assert.ok(pvBig.matched_qty <= cap);
  assert.equal(pvBig.rest, cap + 1 - pvBig.matched_qty);
  // Die MM-Staffel bietet im Band weniger als Q_max — ein Mitspieler bietet den Rest oben an
  const seller = await newUser();
  engine.addHoldingPublic(seller.id, sec.id, 100, 2000);
  const offerPrice = engine.priceBand(book).max;
  engine.placeOrder(fresh(seller), { security_id: sec.id, side: 'sell', type: 'limit', price: offerPrice, amount: 100 });
  const pv = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: cap });
  const r = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: cap });
  assert.equal(r.order.status, 'filled');
  assert.equal(r.order.filled, cap);
  assert.deepEqual(r.trades.map((x) => [x.price, x.amount]), pv.fills.map((x) => [x.price, x.qty]));
  assert.equal('flow' in r.order, false, 'flow ist keine API-Größe');
  const mmQty = r.trades.filter((x) => x.price < offerPrice).reduce((s, x) => s + x.amount, 0);
  assert.ok(mmQty > 0 && mmQty < cap, `MM-Anteil ${mmQty} übt die Grenze aus`);
  const f1 = engine.fairPrice(sec.id);
  assert.equal(f1, Math.round(f0 * Math.exp((Math.log(1.5) / 400) * mmQty)), 'nur der MM-Anteil ist Orderflow');
  assert.ok(f1 / f0 <= 1.15);
  assert.equal(engine.previewOrder(bank, { security_id: sec.id, side: 'buy', type: 'market', amount: 5000 }).cap, null);
  assert.equal(engine.previewOrder(fresh(u), { security_id: etfId(), side: 'buy', type: 'market', amount: 5000 }).cap, null);
});

test('V3 · Ordergrößen-Grenze bei Limits: sofort höchstens Q_max, der Rest liegt offen im Buch', async () => {
  const sec = q.secByTicker.get('QMAX');
  const book = engine.books.get(sec.id);
  const u = await newUser(100_000_000);
  const cap = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: 1 }).cap;
  engine.mmCancelQuotes(book);
  for (const o of ordersOf(book)) if (o.status === 'open') engine.cancelOrder(q.userById.get(o.user_id), o.id);
  const seller = await newUser();
  engine.addHoldingPublic(seller.id, sec.id, cap, 2000);
  engine.placeOrder(fresh(seller), { security_id: sec.id, side: 'sell', type: 'limit', price: engine.priceBand(book).ref, amount: cap });
  const order = { security_id: sec.id, side: 'buy', type: 'limit', price: engine.priceBand(book).ref, amount: cap + 50 };
  const f0 = engine.fairPrice(sec.id);
  const pv = engine.previewOrder(fresh(u), order);
  assert.equal(pv.cap, cap);
  assert.equal(pv.matched_qty, cap);
  assert.equal(pv.rest, 50);
  const r = engine.placeOrder(fresh(u), order);
  assert.equal(r.order.filled, cap);
  assert.equal(r.order.status, 'open');
  assert.equal(engine.fairPrice(sec.id), f0, 'nur Teilnehmer beteiligt: kein Orderflow');
  assert.equal(book.bids[0].id, r.order.id, 'Rest liegt als bestes Gebot');
  assert.equal(book.bids[0].amount - book.bids[0].filled, 50);
  // walkBook begrenzt auf maxQty
  const w = engine.walkBook(book, 'buy', cap + 500, { maxQty: 5 });
  assert.ok(w.qty > 0 && w.qty <= 5);
  assert.equal(w.rest, cap + 500 - w.qty);
  assert.ok(engine.walkBook(book, 'buy', cap + 500).qty > 5);
});

test('V3 · Kursverlauf: genau ein Punkt je Order, mit dem öffentlichen Kurs K statt der Fill-Preise', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const u = await newUser();
  noJitter(() => engine.mmRecenter(book));
  const count = () => db.prepare('SELECT COUNT(*) c FROM price_history WHERE security_id = ?').get(secId).c;
  const n0 = count();
  const r = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount: 80 });
  assert.ok(r.trades.length >= 2, 'mehrere Fills nötig, um den Unterschied zu zeigen');
  assert.equal(count(), n0 + 1);
  const point = db.prepare('SELECT price, amount FROM price_history WHERE security_id = ? ORDER BY rowid DESC LIMIT 1').get(secId);
  assert.deepEqual(point, { price: book.last, amount: 80 });
});

test('V3 · Pfadunabhängigkeit: 20 × 1 Stück und 1 × 20 Stück führen zum selben F', async () => {
  const a = await listStock('PATA', 2000, 400), b = await listStock('PATB', 2000, 400);
  const ua = await newUser(), ub = await newUser();
  noJitter(() => { engine.mmRecenter(a.book); engine.mmRecenter(b.book); });
  assert.equal(engine.fairPrice(a.sec.id), engine.fairPrice(b.sec.id));
  noJitter(() => {
    for (let i = 0; i < 20; i++) engine.placeOrder(fresh(ua), { security_id: a.sec.id, side: 'buy', type: 'market', amount: 1 });
    engine.placeOrder(fresh(ub), { security_id: b.sec.id, side: 'buy', type: 'market', amount: 20 });
  });
  const start = 2_000_000;
  assert.ok(Math.abs(engine.fairPrice(a.sec.id) - engine.fairPrice(b.sec.id)) <= 21); // ± 1 Milli-Cent je Schritt
  const up = engine.fairPrice(a.sec.id);
  noJitter(() => {
    for (let i = 0; i < 20; i++) engine.placeOrder(fresh(ua), { security_id: a.sec.id, side: 'sell', type: 'market', amount: 1 });
    engine.placeOrder(fresh(ub), { security_id: b.sec.id, side: 'sell', type: 'market', amount: 20 });
  });
  assert.ok(Math.abs(engine.fairPrice(a.sec.id) - engine.fairPrice(b.sec.id)) <= 21);
  assert.ok(Math.abs(engine.fairPrice(a.sec.id) - start) <= 21, '20 Stück hin und zurück: F am Start');
  assert.ok(up > start);
});

test('V3 · Der Market Maker selbst macht keinen Kurs: Recenter und Refresh lassen F exakt stehen, Staffel im Band', () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const f = engine.fairPrice(secId);
  const ladder = () => {
    const { min, max } = engine.priceBand(book);
    const mm = ordersOf(book).filter(isMmQuote);
    assert.ok(mm.some((o) => o.side === 'buy') && mm.some((o) => o.side === 'sell'), 'beide Seiten quotiert');
    assert.ok(mm.every((o) => o.price >= min && o.price <= max && o.price % engine.tick(book.sec) === 0));
    assert.ok(book.bids[0].price < book.asks[0].price, 'kein gekreuztes Buch');
  };
  for (let i = 0; i < 300; i++) { engine.mmRecenter(book); ladder(); }
  for (let i = 0; i < 20; i++) engine.mmRefreshAll();
  ladder();
  assert.equal(engine.fairPrice(secId), f);
  assert.equal(engine.tickerRow(secId).last, book.last);
});

test('V3 · Self-Healing: geleertes Buch wird beim nächsten mmRefreshAll sofort neu quotiert', () => {
  const book = engine.books.get(firstSec());
  engine.mmCancelQuotes(book);
  assert.equal(ordersOf(book).some(isMmQuote), false);
  engine.mmRefreshAll();
  assert.ok(book.bids.some(isMmQuote) && book.asks.some(isMmQuote));
});

test('V3 · ETF am NAV: Korb bewegt den Kurs, ETF-Handel nicht; Quotes folgen im 3-s-Takt', async () => {
  const id = etfId();
  const etf = q.secById.get(id), book = engine.books.get(id);
  const basket = db.prepare('SELECT qty, stock_id sid FROM etf_baskets WHERE etf_id = ?').all(id);
  const navFair = () => Math.round(basket.reduce((s, b) => s + b.qty * engine.fairPrice(b.sid), 0) / etf.shares_per_unit);
  const navCents = () => basket.reduce((s, b) => s + b.qty * engine.books.get(b.sid).last, 0) / etf.shares_per_unit;
  assert.equal(engine.fairPrice(id), navFair());
  clearBook(book);
  const u = await newUser(100_000_000);
  const f0 = engine.fairPrice(id);
  engine.placeOrder(fresh(u), { security_id: id, side: 'buy', type: 'market', amount: 5 });
  engine.placeOrder(fresh(u), { security_id: id, side: 'sell', type: 'market', amount: 5 });
  assert.equal(engine.fairPrice(id), f0, 'Orderflow im ETF macht kein Aufgeld');
  noJitter(() => engine.placeOrder(fresh(u), { security_id: basket[0].sid, side: 'buy', type: 'market', amount: 300 }));
  assert.equal(engine.books.get(basket[0].sid).asks[0].is_mm, 1, 'Kauf ging gegen die Staatskasse');
  assert.equal(engine.fairPrice(id), navFair(), 'F = round(Σ qty · F / shares_per_unit)');
  assert.ok(Math.abs(book.last - navCents()) <= engine.tick(etf), '|K − NAV| ≤ 1 Tick');
  const stale = book.last !== book.mmQuotedPrice;
  engine.mmRefreshAll();
  const flat = engine.mmLadder(book);
  assert.ok(stale && book.mmQuotedPrice === book.last, 'Quotes wurden am neuen NAV neu gelegt');
  assert.equal(book.asks.find(isMmQuote).price, flat.asks[0].price);
  assert.equal(book.bids.find(isMmQuote).price, flat.bids[0].price);
  assert.equal(flat.bids[0].size, 1e6);
  assert.equal(flat.asks[0].size, 1e6);
});

test('V3 · syncEtfPrices wirft nie und storniert am NAV gewanderte Orders: leerer Korb, Korbaktie ohne Buch oder Kurs', async () => {
  const mensa = q.secByTicker.get('MENSA');
  const etf = engine.listSecurity({ type: 'etf', ticker: 'TSTX', name: 'Test-ETF', ipo_price: 0, total_shares: 0, shares_per_unit: 10 });
  const book = engine.books.get(etf.id);
  const zero = engine.listSecurity({ type: 'stock', ticker: 'TSTZ', name: 'Ohne Kurs', ipo_price: 0, total_shares: 100 });
  const add = (stockId, qty) => db.prepare('INSERT INTO etf_baskets(etf_id, stock_id, qty) VALUES(?,?,?)').run(etf.id, stockId, qty);
  const u = await newUser(100_000_000);
  try {
    assert.doesNotThrow(() => engine.syncEtfPrices()); // leerer Korb
    assert.equal(book.fair, 0);
    add(mensa.id, 5);
    engine.syncEtfPrices();
    assert.equal(book.fair, Math.round(5 * engine.fairPrice(mensa.id) / 10));
    add(999999, 1); // Korbaktie ohne Buch
    engine.placeOrder(fresh(u), { security_id: mensa.id, side: 'buy', type: 'market', amount: 60 });
    const before = book.fair;
    assert.doesNotThrow(() => engine.syncEtfPrices());
    assert.equal(book.fair, before, 'ETF behält seinen Kurs');
    db.prepare('DELETE FROM etf_baskets WHERE etf_id = ? AND stock_id = ?').run(etf.id, 999999);
    add(zero.id, 1); // Korbaktie ohne Kurs
    assert.doesNotThrow(() => engine.syncEtfPrices());
    assert.equal(book.fair, before);
    db.prepare('DELETE FROM etf_baskets WHERE etf_id = ? AND stock_id = ?').run(etf.id, zero.id);
    // Band-Storno am ETF: Order am Rand wird storniert, sobald der NAV wandert
    noJitter(() => engine.mmRecenter(book));
    const f = engine.priceBand(book);
    const near = engine.placeOrder(fresh(u), { security_id: etf.id, side: 'buy', type: 'limit', price: f.min, amount: 1 }); // am unteren Bandrand
    const cash = fresh(u).cash; // Gebots-Escrow ist bereits abgezogen und kommt mit dem Storno zurück
    const moved = noJitter(() => engine.placeOrder(fresh(u), { security_id: mensa.id, side: 'buy', type: 'market', amount: 300 }));
    const paid = moved.trades.reduce((s, x) => s + x.price * x.amount, 0) + getSettings().fee_cent;
    assert.ok(book.fair > before, 'NAV gestiegen');
    assert.equal(orderRow(near.order.id).status, 'canceled', 'Gebot am alten Band-Minimum liegt nach dem Anstieg unter dem Band');
    assert.equal(fresh(u).cash, cash + near.order.price - paid, 'Escrow des Gebots zurück, nur der Aktienkauf bezahlt');
  } finally {
    db.prepare('DELETE FROM etf_baskets WHERE etf_id = ?').run(etf.id);
    db.prepare('DELETE FROM securities WHERE id IN (?, ?)').run(etf.id, zero.id);
    engine.books.delete(etf.id);
    engine.books.delete(zero.id);
  }
});

test('V3 · Nachplatzierung ohne Kursbedingung; im Cooldown bleibt die Verkaufsseite nie leer', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const { sec, book } = await listStock('REPL', 1000, 100);
  const bank = engine.treasury();
  const min = getSettings().mm_replenish_min;
  assert.equal(book.last, 1000); // Kurs = IPO: die alte Kursbedingung (1,15 × IPO) griff hier nie
  const news0 = newsCount();
  engine.mmRecenter(book);
  assert.equal(sec.total_shares, 1200); // + max(100, 50 % von 100)
  assert.equal(engine.impactDepth(sec.id), 200);
  assert.equal(newsCount(), news0 + 1);
  const stock = () => engine.holdingOf(bank.id, sec.id) + book.asks.filter(isMmQuote).reduce((s, o) => s + o.amount - o.filled, 0);
  assert.equal(stock(), 200);
  const u = await newUser(100_000_000);
  const growth = [];
  for (let i = 0; i < 6; i++) {
    const cap = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: 1 }).cap;
    const depth = engine.sideDepth(book, 'sell');
    const shares = sec.total_shares;
    const r = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: Math.min(cap, depth) });
    assert.equal(r.order.filled, Math.min(cap, depth), `Sweep ${i + 1}`);
    growth.push(sec.total_shares - shares);
    assert.ok(engine.sideDepth(book, 'sell') > 0, `Sweep ${i + 1}: Verkaufsseite nicht leer`);
    assert.ok(stock() >= min, `Sweep ${i + 1}: Bestand der Staatskasse ≥ mm_replenish_min`);
  }
  assert.ok(growth.every((g) => g === 0 || g === min), `Nachlegungen nur zu mm_replenish_min: ${growth}`);
  assert.equal(newsCount(), news0 + 1, 'im Cooldown keine News');
});

test('Spiel-Default: kleiner IPO wird sofort aufgefüllt, Angebot ≥ mm_min_ask_shares, nachgelegt ab der E015-Schwelle', async (t) => {
  // Hält das neue Spiel-Default fest (E015): Die Streubesitz-Regeln gelten hier ausdrücklich —
  // alle anderen V3-Tests schalten sie aus, wo sie Alt-Verhalten an festen Zahlen prüfen.
  const s = getSettings();
  assert.equal(s.mm_min_ask_shares, 1000);
  assert.equal(s.mm_min_depth, 2000);
  const { sec, book } = await listStock('STBB', 2000, 400);
  const u = await newUser(100_000_000);
  const t0 = engine.treasury().id;
  const depth = () => engine.impactDepth(sec.id);
  const trigger = () => Math.max(s.mm_replenish_min, Math.floor(depth() * 25 / 100), s.mm_min_ask_shares + 100);
  const stock = () => engine.holdingOf(t0, sec.id) + book.asks.filter(isMmQuote).reduce((a, o) => a + o.amount - o.filled, 0);
  const offered = () => book.asks.filter(isMmQuote).reduce((a, o) => a + o.amount - o.filled, 0);
  const quoted = () => {
    const { min, max } = engine.priceBand(book);
    assert.ok(offered() >= s.mm_min_ask_shares, `Angebot ${offered()} Stück`);
    assert.ok(book.asks.filter(isMmQuote).every((o) => o.price >= min && o.price <= max), 'Angebot im Band');
  };
  // (1) 400 Stück Streubesitz reichen weder für mm_min_depth noch für 1000 Stück im Band: in einem
  // Schritt aufgefüllt, ohne News
  const news0 = newsCount();
  noJitter(() => engine.mmRecenter(book));
  assert.ok(depth() >= s.mm_min_depth, `Streubesitz ${depth()}`);
  assert.equal(newsCount(), news0, 'Struktur-Auffüllung ohne News');
  quoted();
  // Die Ordergrenze folgt dem größeren Streubesitz (mmath.maxOrderSize), nicht mehr 137
  const cap = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: 1 }).cap;
  assert.equal(cap, mmath.maxOrderSize(depth(), s.mm_impact_pct, s.limit_band_pct));
  assert.ok(cap > 137);
  // (2) Nachplatzierung: erst, wenn der Bestand der Staatskasse unter die Schwelle fällt; danach hält
  // die Leiste wieder mindestens mm_min_ask_shares und der Bestand steht nie darunter
  const log = [];
  for (let i = 0; i < 4; i++) {
    const before = { d: depth(), stock: stock(), news: newsCount() };
    noJitter(() => { engine.mmRecenter(book); engine.mmRecenter(book); });
    // News nur bei einer Nachplatzierung (höchstens eine), nie beim Auffüllen im Cooldown
    assert.ok(newsCount() - before.news <= (depth() > before.d ? 1 : 0), `News +${newsCount() - before.news}`);
    if (before.stock > trigger()) assert.equal(depth(), before.d, 'über der Schwelle wird nichts nachgelegt');
    else assert.ok(stock() >= trigger(), `Bestand ${stock()} < Schwelle ${trigger()}`);
    quoted();
    const o = noJitter(() => engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: Math.min(cap, engine.sideDepth(book, 'sell')) }));
    assert.equal(o.order.filled, Math.min(cap, engine.sideDepth(book, 'sell')));
    log.push(`${before.d}/${before.stock} → ${depth()}/${stock()}`);
  }
  t.diagnostic(`STBB: D/Bestand je Runde ${log.join(' → ')}`);
});

test('Spiel-Default: Deckel — der Streubesitz wächst höchstens auf das Dreifache des Start-Streubesitzes', async (t) => {
  // Risiko „D wächst" (PLAN.md): bei anhaltendem Nettokauf legte jede Nachplatzierung 50 % auf
  // (im Fast-Modus gemessen 2822 → 27 461 in 3 Minuten). Deckel in mmMaybeReplenish:
  // D ≤ 3 × Start-Streubesitz. Start-Streubesitz = das, was die Struktur-Regeln einem frisch
  // gelisteten Wert geben: 2822 (von mm_min_depth = 2000 aus in 10-%-Schritten, bis das Band
  // 1000 Stück Angebot hält).
  const { sec, book } = await listStock('DECK', 2000, 400);
  const u = await newUser(1_000_000_000);
  const tId = engine.treasury().id;
  const depth = () => engine.impactDepth(sec.id);
  const stock = () => engine.holdingOf(tId, sec.id) + book.asks.filter(isMmQuote).reduce((a, o) => a + o.amount - o.filled, 0);
  const LIMIT = 3 * 2822;
  noJitter(() => engine.mmRecenter(book));
  const start = depth();
  assert.ok(start > 2000 && start < LIMIT, `Start-Streubesitz ${start}`);
  const news0 = newsCount();
  const seen = [];
  for (let i = 0; i < 30 && depth() < LIMIT; i++) {
    const cap = engine.previewOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: 1 }).cap;
    const qty = Math.min(cap, engine.sideDepth(book, 'sell'));
    assert.ok(qty > 0, `Runde ${i}: nichts im Buch`);
    engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: qty });
    noJitter(() => { engine.mmRecenter(book); engine.mmRecenter(book); });
    assert.ok(depth() <= LIMIT, `Runde ${i}: Streubesitz ${depth()} über dem Deckel ${LIMIT}`);
    seen.push(depth());
  }
  assert.equal(depth(), LIMIT, `Deckel erreicht: ${seen.join(' → ')}`);
  assert.ok(seen.length >= 2 && seen[0] < LIMIT, 'der Weg zum Deckel wird durchlaufen, nicht übersprungen');
  assert.ok(stock() > 0, 'am Deckel liegt noch Angebot');
  // Am Deckel: weiter kaufen, nachlegen funktioniert nicht mehr — kein Wachstum, keine News
  const newsAtCap = newsCount();
  let bought = 0;
  for (let i = 0; i < 6; i++) {
    const qty = engine.sideDepth(book, 'sell');
    if (qty < 1) break;
    engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'market', amount: qty });
    bought += qty;
    noJitter(() => { engine.mmRecenter(book); engine.mmRecenter(book); });
    assert.equal(depth(), LIMIT, `am Deckel: Streubesitz bleibt ${LIMIT}`);
  }
  assert.ok(bought > 0 && newsCount() === newsAtCap, 'am Deckel keine Nachplatzierung, keine News');
  assert.equal(stock(), 0, 'was da war, ist verkauft — mehr gibt der Deckel nicht her');
  t.diagnostic(`DECK: ${start} → ${seen.join(' → ')}; am Deckel noch ${bought} Stück gekauft`);
});

test('V3 · Leer- und Fehlerzustände: unbekanntes Wertpapier, leere Menge, Order über die Tiefe', async (t) => {
  // Nur die Anschluss-Stufen aus und die Leiste neu legen: sie hält dann 435 Stück, weniger als die
  // Ordergrenze. Sonst kommt „Zu groß für eine Order" vor der Tiefenprüfung (Spiel-Default: ≥ 1000
  // Stück Angebot, Ordergrenze 972 bei D = 2822) — geprüft wird hier aber die Tiefenprüfung.
  withoutFloatRules(t, { depth: false });
  const book = engine.books.get(firstSec());
  noJitter(() => engine.mmRecenter(book));
  assert.ok(engine.sideDepth(book, 'sell') < mmath.maxOrderSize(tableDepth(firstSec()), getSettings().mm_impact_pct, getSettings().limit_band_pct), 'Vorbedingung: Buch kleiner als die Ordergrenze');
  assert.equal(engine.fairPrice(999999), null);
  assert.equal(engine.impactDepth(999999), null);
  assert.doesNotThrow(() => engine.syncEtfPrices());
  const u = await newUser();
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: 999999, side: 'buy', type: 'market', amount: 1 }), /nicht handelbar/);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: firstSec(), side: 'buy', type: 'stop', amount: 1 }), /Ordertyp/);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: firstSec(), side: 'buy', type: 'market', amount: 0 }), /Stückzahl/);
  assert.throws(() => engine.previewOrder(null, { security_id: 999999, side: 'buy', type: 'market', amount: 1 }), /Orderbuch nicht initialisiert/);
  assert.throws(() => engine.previewOrder(null, { security_id: firstSec(), side: 'buy', type: 'market', amount: 0 }), /Stückzahl/);
  const depth = engine.sideDepth(book, 'sell', u.id);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: firstSec(), side: 'buy', type: 'market', amount: depth + 1 }), /Nicht genug Liquidität/);
  assert.throws(() => engine.cancelOrder(fresh(u), 999999), /nicht gefunden/);
});

// deterministischer Zufall für die Jitter-Tests (mulberry32)
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const withRandom = (rnd, fn) => { const orig = Math.random; Math.random = rnd; try { return fn(); } finally { Math.random = orig; } };
const DRAWS = 200;
// Hunderte zusätzliche Bücher teilen das Bid-Cash-Budget der Staatskasse; für die Kaufseite auffüllen
const fundTreasury = () => db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(50_000_000_000, engine.treasury().id);

// Gebot/Angebot eines Teilnehmers in ein frisch angelegtes, leeres Buch (D = 400) legen
async function restingCase(tag, side, priceOf, amount, founder) {
  const sec = engine.listSecurity({ type: 'stock', ticker: tag, name: tag, founder_id: founder.id, ipo_price: 2000, total_shares: 1400 });
  engine.addHoldingPublic(founder.id, sec.id, 1000, 2000);
  const treasury = engine.treasury().id;
  engine.addHoldingPublic(treasury, sec.id, 400, 2000);
  const book = engine.books.get(sec.id);
  const price = priceOf(engine.priceBand(book));
  return { sec, book, treasury, price, order: { security_id: sec.id, side, type: 'limit', price, amount } };
}
const treasuryStock = (book, treasury) => engine.holdingOf(treasury, book.sec.id) + book.asks.filter(isMmQuote).reduce((a, o) => a + o.amount - o.filled, 0);
// keine MM-Quote kreuzt eine liegende Order: alle MM-Asks über dem besten fremden Gebot, alle MM-Gebote unter dem besten fremden Angebot
function assertNoCrossing(book) {
  const bid = book.bids.find((o) => !o.is_mm && o.amount - o.filled > 0), ask = book.asks.find((o) => !o.is_mm && o.amount - o.filled > 0);
  if (bid) assert.ok(book.asks.filter(isMmQuote).every((o) => o.price > bid.price), `MM-Ask ${book.asks[0].price} kreuzt Gebot ${bid.price}`);
  if (ask) assert.ok(book.bids.filter(isMmQuote).every((o) => o.price < ask.price), 'MM-Gebot kreuzt Angebot');
  assert.ok(!book.bids.some(isMmQuote) || !book.asks.some(isMmQuote) || book.bids[0].price < book.asks[0].price, 'Buch nicht gekreuzt');
}

test('V3 · Kreuzen begrenzt: Gebot am Band-Maximum (D = 400, 200 Ziehungen mit Jitter) bewegt F um höchstens 15 % + 1 Tick', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const founder = await newUser();
  const u = await newUser(5_000_000_000);
  const rnd = seeded(20261126);
  let worst = 0, smallest = Infinity, last = null;
  for (let i = 0; i < DRAWS; i++) {
    const c = await restingCase('KXA' + String(i).padStart(3, '0'), 'buy', (b) => b.max, 300, founder);
    const r = engine.placeOrder(fresh(u), c.order);
    const f0 = engine.fairPrice(c.sec.id);
    const stock0 = treasuryStock(c.book, c.treasury);
    withRandom(rnd, () => { engine.mmRecenter(c.book); engine.mmRecenter(c.book); });
    const f1 = engine.fairPrice(c.sec.id), move = f1 / f0 - 1;
    const sold = orderRow(r.order.id).filled;
    assert.ok(sold > 0, `Ziehung ${i}: Gebot wurde von MM-Quotes gefüllt`);
    assert.ok(f1 / mmath_MILLI <= c.price, `Ziehung ${i}: F ${f1} über dem Gebotspreis ${c.price}`);
    assert.ok(move <= 0.15 + 10 / 2000, `Ziehung ${i}: Bewegung ${(move * 100).toFixed(2)} %`);
    assert.equal(stock0 - treasuryStock(c.book, c.treasury), sold, 'Bestand der Staatskasse sinkt genau um die verkaufte Menge');
    assertNoCrossing(c.book);
    worst = Math.max(worst, move);
    smallest = Math.min(smallest, move);
    last = { sold, rest: orderRow(r.order.id).amount - sold };
  }
  assert.ok(worst > 0.05, `die Ziehungen üben die Grenze aus (kleinste ${(smallest * 100).toFixed(2)} %, letzte ${JSON.stringify(last)})`);
  // Raum = floor(ln 1,15 / λ) = 137 Stück → F = e^(137 λ) = +14,89 %: das ist das Maximum, das die Regel erlaubt
  assert.ok(worst > 0.148, `mindestens eine Ziehung schöpft den Raum aus: ${(worst * 100).toFixed(3)} %`);
});

test('V3 · Kreuzen begrenzt, Spiegelfall: Angebot am Band-Minimum (200 Ziehungen) bewegt F um höchstens 15 % + 1 Tick nach unten', async (t) => {
  withoutFloatRules(t); // Alt-Verhalten unabhängig vom Streubesitz: D bleibt wie angelegt
  const founder = await newUser();
  const u = await newUser();
  const rnd = seeded(1126);
  let worst = 0;
  fundTreasury();
  for (let i = 0; i < DRAWS; i++) {
    const c = await restingCase('KXS' + String(i).padStart(3, '0'), 'sell', (b) => b.min, 300, founder);
    engine.addHoldingPublic(u.id, c.sec.id, 300, 2000);
    const r = engine.placeOrder(fresh(u), c.order);
    const f0 = engine.fairPrice(c.sec.id);
    withRandom(rnd, () => { engine.mmRecenter(c.book); engine.mmRecenter(c.book); });
    const f1 = engine.fairPrice(c.sec.id), move = 1 - f1 / f0;
    assert.ok(orderRow(r.order.id).filled > 0, `Ziehung ${i}: Angebot wurde genommen`);
    assert.ok(f1 / mmath_MILLI >= c.price, `Ziehung ${i}: F ${f1} unter dem Angebotspreis ${c.price}`);
    assert.ok(move <= 0.15 + 10 / 2000, `Ziehung ${i}: Bewegung −${(move * 100).toFixed(2)} %`);
    assertNoCrossing(c.book);
    worst = Math.max(worst, move);
  }
  assert.ok(worst > 0.148, `mindestens eine Ziehung schöpft den Raum aus: ${(worst * 100).toFixed(3)} %`);
});

test('V3 · Kreuzen begrenzt: Gebot mitten im Band (+5 %) hebt F höchstens bis zum Gebotspreis, nicht bis zum Band', async () => {
  const founder = await newUser();
  const u = await newUser(5_000_000_000);
  const rnd = seeded(7);
  fundTreasury();
  for (let i = 0; i < 20; i++) {
    const c = await restingCase('KXM' + String(i).padStart(3, '0'), 'buy', (b) => b.ref + Math.round(b.ref * 0.05 / 10) * 10, 300, founder);
    const r = engine.placeOrder(fresh(u), c.order);
    const f0 = engine.fairPrice(c.sec.id);
    withRandom(rnd, () => { engine.mmRecenter(c.book); engine.mmRecenter(c.book); });
    const f1 = engine.fairPrice(c.sec.id);
    assert.ok(orderRow(r.order.id).filled > 0);
    assert.ok(f0 < f1 && f1 / mmath_MILLI <= c.price, `F ${f1} zwischen ${f0} und Gebotspreis ${c.price}`);
    assert.ok(f1 / f0 - 1 < 0.05, 'nicht bis zum Bandrand (15 %)');
    assertNoCrossing(c.book);
  }
});

test('V3 · Kreuzen begrenzt nur den Randfall: altes Angebot 10 % unter F nimmt die Staatskasse weiterhin vollständig', async () => {
  const founder = await newUser();
  const u = await newUser();
  const c = await restingCase('KXN', 'sell', (b) => b.ref - Math.round(b.ref * 0.10 / 10) * 10, 50, founder);
  fundTreasury();
  engine.addHoldingPublic(u.id, c.sec.id, 50, 2000);
  const tenBelow = () => engine.priceBand(c.book).ref - Math.round(engine.priceBand(c.book).ref * 0.10 / 10) * 10;
  let r = engine.placeOrder(fresh(u), { ...c.order, price: tenBelow() });
  for (let seed = 1; seed <= 12; seed++) {
    withRandom(seeded(seed), () => engine.mmRecenter(c.book));
    assert.equal(orderRow(r.order.id).filled, 50, `Seed ${seed}: Angebot 10 % unter F komplett genommen`);
    assert.equal(engine.holdingOf(u.id, c.sec.id), 0, 'alles verkauft');
    assertNoCrossing(c.book);
    // neues Angebot für den nächsten Durchlauf
    if (seed < 12) {
      engine.addHoldingPublic(u.id, c.sec.id, 50, 2000);
      r = engine.placeOrder(fresh(u), { ...c.order, price: tenBelow() }); // kreuzt liegende MM-Gebote evtl. sofort
    }
  }
});

test('V3 · Staffel-Parameter geklemmt: mm_levels = 1e9 endet schnell mit höchstens 50 Stufen, mm_size = 0 gibt Stufen ab 1 Stück', () => {
  const book = engine.books.get(firstSec());
  const mmSides = () => [book.bids.filter(isMmQuote).length, book.asks.filter(isMmQuote).length];
  try {
    setSetting('mm_levels', 1e9);
    const t0 = process.hrtime.bigint();
    noJitter(() => engine.mmRecenter(book));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, `mmRecenter mit mm_levels = 1e9 dauert ${ms.toFixed(1)} ms`);
    for (const levels of mmSides()) assert.ok(levels > 0 && levels <= 50, `Stufen je Seite: ${levels}`);
    assert.ok(engine.mmLadder(book).asks.length <= 50);
    for (const bad of [0, -5, NaN, Infinity, 'abc', null]) {
      setSetting('mm_levels', bad);
      assert.ok(engine.mmLadder(book).asks.length >= 1 && engine.mmLadder(book).asks.length <= 50, `mm_levels = ${String(bad)}`);
    }
    setSetting('mm_levels', 3);
    setSetting('mm_size', 0);
    setSetting('mm_size_step', -100);
    const ladder = engine.mmLadder(book);
    assert.equal(ladder.asks.length, 3);
    for (const lvl of [...ladder.bids, ...ladder.asks]) assert.ok(Number.isInteger(lvl.size) && lvl.size >= 1, `Stufe ${lvl.size} Stück`);
    for (const bad of [-1, NaN, Infinity]) {
      setSetting('mm_size', bad);
      assert.ok(engine.mmLadder(book).asks.every((lvl) => lvl.size >= 1), `mm_size = ${String(bad)}`);
    }
  } finally {
    setSetting('mm_levels', 6);
    setSetting('mm_size', 10);
    setSetting('mm_size_step', 25);
  }
});

test('V3 · Neustart: F exakt erhalten, Kurs und Orderbuch kommen aus der Datenbank', () => {
  const secId = firstSec();
  const before = engine.books.get(secId);
  const f = engine.fairPrice(secId);
  const ids = () => ordersOf(engine.books.get(secId)).map((o) => [o.id, o.filled]).sort((a, b) => a[0] - b[0]);
  const snapshot = ids();
  engine.loadEngine();
  assert.equal(engine.fairPrice(secId), f);
  assert.equal(q.secById.get(secId).fair_price, f);
  assert.deepEqual(ids(), snapshot);
  assert.equal(engine.books.get(secId).last, before.last);
  assert.equal(engine.tickerRow(secId).last, before.last);
  for (const id of engine.books.keys()) {
    if (engine.books.get(id).sec.type !== 'stock' || engine.fairPrice(id) <= 0) continue;
    assert.equal(engine.fairPrice(id), q.secById.get(id).fair_price);
  }
});

test('V3 · Migration einer DB vor V3: Startkurs = Median, unausführbare und alte Staatskassen-Orders storniert', async () => {
  const secId = firstSec();
  const book = engine.books.get(secId);
  const t = engine.treasury();
  const u = await newUser(), seller = await newUser();
  setSetting('limit_band_pct', 500); // altes, sehr weites Band nachbilden
  const cashBefore = fresh(u).cash;
  const farBuy = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: 500, amount: 3 });
  engine.addHoldingPublic(seller.id, secId, 5, 1000);
  const farSell = engine.placeOrder(fresh(seller), { security_id: secId, side: 'sell', type: 'limit', price: engine.priceBand(book).max - 1000, amount: 5 });
  const manual = engine.placeOrder(t, { security_id: secId, side: 'buy', type: 'limit', price: book.bids[0].price, amount: 5 }, { mm: false });
  setSetting('limit_band_pct', 15);
  const ref = engine.priceBand(book).ref;
  const near = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', price: ref - 100, amount: 2 });
  const mmBefore = ordersOf(book).filter(isMmQuote).length;
  db.prepare('UPDATE securities SET fair_price = NULL WHERE id = ?').run(secId); // Aktie ohne F
  const prices = db.prepare('SELECT price FROM trades WHERE security_id = ? ORDER BY id DESC LIMIT 25').all(secId).map((r) => r.price).sort((a, b) => a - b);
  const expected = Math.round(prices[12] * 1000);
  engine.loadEngine();
  const after = engine.books.get(secId);
  assert.equal(engine.fairPrice(secId), expected, 'F = Median der letzten 25 Trades × 1000');
  assert.equal(q.secById.get(secId).fair_price, expected, 'zurückgeschrieben');
  assert.equal(after.last, engine.priceBand(after).ref);
  assert.equal(orderRow(farBuy.order.id).status, 'canceled');
  assert.equal(fresh(u).cash, cashBefore - near.order.price * 2, 'Escrow vollständig zurück');
  assert.equal(orderRow(farSell.order.id).status, 'canceled');
  assert.equal(engine.holdingOf(seller.id, secId), 5, 'Aktien zurück, obwohl der Einstandspreis nach dem Neustart nicht mehr im RAM steht');
  assert.equal(orderRow(manual.order.id).status, 'canceled', 'alte Staatskassen-Order mit is_mm = 0');
  assert.equal(orderRow(near.order.id).status, 'open', 'Limit im Band bleibt');
  assert.equal(ordersOf(after).some((o) => o.id === near.order.id), true);
  assert.equal(ordersOf(after).filter(isMmQuote).length, mmBefore, 'MM-Quotes bleiben');
  const f = engine.fairPrice(secId);
  engine.loadEngine(); // zweite Ladung: nichts mehr zu migrieren
  assert.equal(engine.fairPrice(secId), f);
  assert.equal(orderRow(near.order.id).status, 'open');
});
