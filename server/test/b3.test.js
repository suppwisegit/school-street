// Motor-Tests (T-B3). Laufen gegen eine eigene, frisch geseedete Datenbank
// (server/data/b3-test-<pid>.db) — die echte DB wird nie berührt.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
