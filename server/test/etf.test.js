// QA-Tests Market Maker V3 — Schul-ETF (T6): NAV-Anker, Arbeitsbestand-Regel der
// AP-Automatik (Creation und Redemption), Re-Quoting. Abgeleitet aus PLAN.md 2.5,
// V2, V4 und Abschnitt 7 (Prüfmatrix), nicht aus dem Implementierungscode.
//
// Isolation wie b3.test.js: eigene, frisch geseedete DB (server/data/etf-test-<pid>.db),
// ein eigener ETF mit eigenen Korbaktien je Test, geänderte Einstellungen und
// Math.random werden zurückgestellt. Die echte DB wird nie berührt.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `etf-test-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);

const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

// Erst seeden, DANN öffnen (siehe b3.test.js).
let db, getSettings, setSetting, q, auth, engine, etf;
before(() => {
  clean();
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
  ({ db, getSettings, setSetting, q } = require('../db'));
  auth = require('../auth');
  engine = require('../engine');
  etf = require('../etf');
  engine.loadEngine();
  // Wie in mm.test.js: Die Geld-Seite der MM-Quotes hängt am Cash der Staatskasse (Budget je Wert);
  // die Tests legen viele eigene Werte an, deshalb bekommt sie hier reichlich Cash.
  db.prepare("UPDATE users SET cash = cash + ? WHERE role = 'bank'").run(50_000_000 * 100);
});
after(clean);

// ---------------------------------------------------------------------------
// Helfer — Maße aus PLAN 2.5, hier neu gerechnet
// ---------------------------------------------------------------------------
const MILLI = 1000;                                    // Milli-Cent je Cent
const Cr = (credits) => Math.round(credits * 100);     // Credits → Cent
// Tick-Rundung float-sicher (V1): ein Wert, der rechnerisch genau auf einem Tick liegt, bleibt dort
const floorTick = (p, t) => Math.floor(p / t + 1e-9) * t;
const ceilTick = (p, t) => Math.ceil(p / t - 1e-9) * t;
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let n = 0, seq = 0;
const newUser = async (cash = 2_000_000) => auth.createUser(`etf-qa-${++n}`, 'pw1234', 'user', cash);
const fresh = (u) => q.userById.get(u.id);
const letters = (num) => {
  let s = '';
  for (let x = num; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + (x - 1) % 26) + s;
  return s;
};
const withRnd = (rnd, fn) => { const orig = Math.random; Math.random = rnd; try { return fn(); } finally { Math.random = orig; } };
// V2: Die Staffel liest rnd je Aufruf als Math.random — hier deterministisch ersetzt
// (0,5 = kein Jitter). Nur die Aktien-Staffel nutzt Zufall, die ETF-Quotes nicht.
const fixed = async (fn) => {
  const orig = Math.random;
  Math.random = () => 0.5;
  try { return await fn(); } finally { Math.random = orig; }
};
async function withSettings(values, fn) {
  const s = getSettings();
  const prev = Object.fromEntries(Object.keys(values).map((k) => [k, s[k]]));
  for (const [k, v] of Object.entries(values)) setSetting(k, v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) setSetting(k, v); }
}

// Frische Aktie nur für diesen Test: F0 = IPO-Preis 20 Cr, Staatskasse hält den Streubesitz.
function newStock({ float = 2000 } = {}) {
  const t = engine.treasury();
  const sec = engine.listSecurity({ type: 'stock', ticker: `QA${letters(++seq)}`, name: `QA-Aktie ${seq}`, ipo_price: Cr(20), total_shares: float });
  engine.addHoldingPublic(t.id, sec.id, float, Cr(20));
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(20) * float, t.id);
  withRnd(() => 0.5, () => engine.mmRecenter(engine.books.get(sec.id)));
  return sec;
}

// Frischer ETF nur für diesen Test: Korb aus zwei frischen Aktien (2 + 1 Stück),
// shares_per_unit Anteile je Unit, initial_units Units bei der Schöpfung.
const BASKET = [2, 1];
function newEtf({ initial_units = 25, shares_per_unit = 10, basket = BASKET, floats = [2000, 2000] } = {}) {
  const stocks = basket.map((_, i) => newStock({ float: floats[i] }));
  const t = engine.treasury();
  // Liegt der Korb ganz oder teilweise in MM-Quotes (Ask-Escrow), holt ihn die Staatskasse vorher
  // zurück — wie im Seed, wo sie den Korb am Markt kauft, bevor sie Units schafft.
  const recalled = [];
  stocks.forEach((s, i) => {
    if (engine.holdingOf(t.id, s.id) < basket[i] * initial_units) { engine.mmCancelQuotes(engine.books.get(s.id)); recalled.push(s); }
  });
  const sec = etf.createEtf({
    ticker: `QE${letters(++seq)}`, name: `QA-ETF ${seq}`, shares_per_unit, initial_units,
    basket: stocks.map((s, i) => ({ stock_id: s.id, qty: basket[i] }))
  });
  for (const s of recalled) engine.mmRecenter(engine.books.get(s.id));   // Korbaktien wieder quotiert
  return { sec, stocks };
}

const T = () => engine.treasury();
const mmOpen = (book, side) => book[side].filter((o) => o.is_mm && o.status === 'open' && o.amount - o.filled > 0);
const askEscrow = (book) => mmOpen(book, 'asks').reduce((s, o) => s + o.amount - o.filled, 0);
// Bestand der Staatskasse: Depot + ihre offenen MM-Verkaufsorders (bei ETFs: T)
const stock = (secId) => engine.holdingOf(T().id, secId) + askEscrow(engine.books.get(secId));
const floatOf = (secId) => q.secById.get(secId).total_shares;                     // Umlauf
const targetOf = (secId) => q.secById.get(secId).ap_inventory_target;             // W0
// W = max(W0, round(etf_ap_inventory_pct / 100 · Umlauf))
const workOf = (secId) => Math.max(targetOf(secId), Math.round(getSettings().etf_ap_inventory_pct / 100 * floatOf(secId)));
// Offene Orders der Staatskasse, die keine MM-Quotes sind (Peg-Leiter, Marktkäufe)
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const openAp = (secId) => db.prepare("SELECT COUNT(*) c FROM orders WHERE security_id = ? AND user_id = ? AND is_mm = 0 AND status = 'open'").get(secId, T().id).c;

// NAV = round(Σ qty_i · F_i / shares_per_unit) in Milli-Cent (2.5); K = F auf Tick gerundet
function navOf(etfId) {
  const spu = q.secById.get(etfId).shares_per_unit;
  const fairEtf = Math.round(etf.basketOf(etfId).reduce((s, b) => s + b.qty * engine.fairPrice(b.stock_id), 0) / spu);
  const tk = engine.tick(engine.books.get(etfId).sec);
  return { fair: fairEtf, navC: fairEtf / MILLI, k: Math.max(tk, Math.round(fairEtf / MILLI / tk) * tk) };
}
// Prüfmatrix „ETF-Kurs": abs(last − nav_per_share) ≤ 1 Tick = 10 Cent, absolut. etf.nav() rechnet
// mit den auf Tick gerundeten Kursen K, die Engine mit F — Toleranz für diese Rundung des Korbs:
// round(Σ qty_i · tick_i / 2 / shares_per_unit) + 1 Tick.
function anchorTolerance(etfId) {
  const spu = q.secById.get(etfId).shares_per_unit;
  const ticks = etf.basketOf(etfId).reduce((s, b) => s + b.qty * engine.tick(engine.books.get(b.stock_id).sec), 0);
  return Math.round(ticks / 2 / spu) + engine.tick(engine.books.get(etfId).sec);
}
function anchored(etfId, why) {
  const nav = etf.nav(etfId);
  assert.ok(nav.nav_per_share > 0, `${why}: NAV fehlt`);
  const gap = Math.abs(engine.books.get(etfId).last - nav.nav_per_share);
  const tol = anchorTolerance(etfId);
  assert.ok(gap <= tol + 1e-6, `${why}: |last − NAV| = ${gap.toFixed(2)} Cent > ${tol} Cent (1 Tick + Korbrundung)`);
}
const mine = (actions, sec) => actions.filter((a) => a.ticker === sec.ticker);
const actionList = (actions) => actions.map((a) => [a.action, a.units]);
const buyEtf = (u, etfId, amount) => engine.placeOrder(fresh(u), { security_id: etfId, side: 'buy', type: 'market', amount });
const sellEtf = (u, etfId, amount) => engine.placeOrder(fresh(u), { security_id: etfId, side: 'sell', type: 'market', amount });
// Zustand, den ein Lauf ohne Aktion nicht ändern darf: Umlauf, W0, Depotbestand, Kurs, alle Order-IDs
function snap(ids) {
  return ids.map((id) => {
    const row = q.secById.get(id);
    const book = engine.books.get(id);
    return [id, row.total_shares, row.ap_inventory_target, engine.holdingOf(T().id, id), book.last,
      [...book.bids, ...book.asks].map((o) => `${o.id}:${o.filled}`).sort()];
  });
}
// Nach einer Aktion: ETF und Korbaktien wieder quotiert — Geld, sofern Cash reicht;
// Brief, sofern die Staatskasse Bestand hat (eine verbrauchte Korbaktie hat keinen).
function assertQuoted(ids, why) {
  for (const id of ids) {
    const book = engine.books.get(id);
    assert.ok(mmOpen(book, 'bids').length >= 1, `${why}: keine offene MM-Bid an ${book.sec.ticker}`);
    if (stock(id) > 0) assert.ok(mmOpen(book, 'asks').length >= 1, `${why}: keine offene MM-Ask an ${book.sec.ticker} trotz Bestand ${stock(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Geseedeter ETF (Auftrag: am Seed nur Neutralzone, [] und „nichts ändert sich";
// T gegen W0 als Diagnose — der Seed handelt zufällig ETF-Anteile, T ist dort nicht exakt W0)
// ---------------------------------------------------------------------------
test('Geseedeter ETF SETF: Bestand in der Neutralzone — autoArbitrage() ohne Aktion, nichts ändert sich', (t) => {
  const setf = q.secByTicker.get('SETF');
  const ids = [setf.id, ...etf.basketOf(setf.id).map((b) => b.stock_id)];
  const before = snap(ids);
  const T0 = stock(setf.id);
  t.diagnostic(`SETF nach dem Seed: T = ${T0}, W0 = ${targetOf(setf.id)}, W = ${workOf(setf.id)}, Umlauf = ${floatOf(setf.id)}`);
  assert.ok(T0 > 0.5 * workOf(setf.id) && T0 <= 1.25 * workOf(setf.id), `SETF muss nach dem Seed in der Neutralzone liegen (T = ${T0}, W = ${workOf(setf.id)})`);
  assert.deepEqual(etf.autoArbitrage().filter((a) => a.ticker === setf.ticker), []);
  assert.deepEqual(snap(ids), before);
});

// ---------------------------------------------------------------------------
// NAV-Anker
// ---------------------------------------------------------------------------
test('createEtf: Kurs = NAV auf Tick, ap_inventory_target = initial_units · shares_per_unit, Staatskasse hält genau W0', () => fixed(() => {
  const { sec, stocks } = newEtf({ initial_units: 25 });
  const book = engine.books.get(sec.id);
  assert.equal(navOf(sec.id).k, Cr(6));                        // (2 · 20 Cr + 1 · 20 Cr) / 10 Anteile = 6,00 Cr
  assert.equal(book.last, navOf(sec.id).k);
  anchored(sec.id, 'nach der Schöpfung');
  assert.equal(targetOf(sec.id), 250);                         // 25 Units · 10 Anteile
  assert.equal(stock(sec.id), 250);                            // T = W0
  assert.equal(workOf(sec.id), 250);                           // W = max(250, round(0,25 · 250)) = 250
  // Korb kam aus dem Depot. Der Streubesitz je Aktie steht nicht fest (T5: der Market Maker füllt beim ersten
  // Recenter auf, bis das Band mm_min_ask_shares fasst) — geprüft wird die Beziehung: Bestand = Umlauf − Korb.
  stocks.forEach((s, i) => assert.equal(stock(s.id), floatOf(s.id) - BASKET[i] * 25, `${s.ticker}: Bestand nach der Schöpfung`));
  assert.ok(stock(stocks[0].id) >= 2000 - 2 * 25, 'der Seed-Streubesitz darf durch die Auffüllung nicht schrumpfen');
  assert.equal(floatOf(sec.id), 250);
}));

test('ETF-Kurs folgt jeder Änderung einer Korbaktie sofort: last = K(NAV), Abweichung vom NAV höchstens 1 Tick', () => fixed(async () => {
  const { sec, stocks } = newEtf();
  const u = await newUser(100_000_000);
  const steps = [[stocks[0].id, 'buy', 1], [stocks[0].id, 'buy', 37], [stocks[1].id, 'buy', 250], [stocks[0].id, 'buy', 300], [stocks[0].id, 'sell', 100], [stocks[1].id, 'sell', 60]];
  for (const [secId, side, amount] of steps) {
    engine.placeOrder(fresh(u), { security_id: secId, side, type: 'market', amount });
    assert.equal(engine.books.get(sec.id).last, navOf(sec.id).k, `sofort nach ${side} ${amount} ${q.secById.get(secId).ticker}`);
    anchored(sec.id, `nach ${side} ${amount} ${q.secById.get(secId).ticker}`);
  }
  assert.notEqual(engine.books.get(sec.id).last, Cr(6));       // der Korb hat sich bewegt, der Kurs mit ihm
}));

test('ETF-Kurs: einseitiger Kauf- und Verkaufsdruck — zu jedem Zeitpunkt höchstens 1 Tick vom NAV, Fills ohne Aufgeld, kein Flow-Impact im ETF', () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });       // 250 Anteile, alle bei der Staatskasse
  const book = engine.books.get(sec.id);
  const tk = engine.tick(book.sec);
  const h = getSettings().mm_spread_bp / 2 / 1e4;              // halber Spread
  const k0 = navOf(sec.id).k;
  const f0 = stocks.map((s) => engine.fairPrice(s.id));
  const buyer = await newUser(100_000_000);
  const noPremium = (r, why) => {
    const { navC } = navOf(sec.id);
    for (const x of r.trades) assert.ok(x.price <= navC * (1 + h) + tk && x.price >= navC * (1 - h) - tk, `${why}: Fill ${x.price} weit vom NAV ${navC.toFixed(2)}`);
  };
  // Kaufdruck: kaufen, was die Staatskasse anbietet, bis die Ask-Seite leer ist
  for (let i = 0; engine.sideDepth(book, 'sell') > 0; i++) {
    assert.ok(i < 10, 'Ask-Seite wird nicht leer');
    anchored(sec.id, `vor Kauf ${i + 1}`);
    const r = buyEtf(buyer, sec.id, engine.sideDepth(book, 'sell'));
    noPremium(r, 'Kauf');
    anchored(sec.id, `nach Kauf ${i + 1}`);
  }
  assert.equal(stock(sec.id), 0);
  assert.throws(() => buyEtf(buyer, sec.id, 1), /Nicht genug Liquidität/);
  anchored(sec.id, 'bei leerer Ask-Seite');
  // Verkaufsdruck: alles zurück an die Staatskasse
  for (let i = 0; engine.holdingOf(buyer.id, sec.id) > 0; i++) {
    assert.ok(i < 10, 'Bestand wird nicht leer');
    const r = sellEtf(buyer, sec.id, Math.min(engine.holdingOf(buyer.id, sec.id), engine.sideDepth(book, 'buy')));
    noPremium(r, 'Verkauf');
    anchored(sec.id, `nach Verkauf ${i + 1}`);
  }
  assert.equal(stock(sec.id), 250);
  // Korb unverändert → Kurs unverändert; ETF-Orderflow bewegt keine Korbaktie
  assert.equal(book.last, k0);
  stocks.forEach((s, i) => assert.equal(engine.fairPrice(s.id), f0[i]));
  anchored(sec.id, 'nach Kauf- und Verkaufsdruck');
}));

test('ETF-Quotes: flach — eine Stufe je Seite bei NAV ± halber Spread, die Ask mit dem ganzen freien Bestand (keine Reserve)', () => fixed(() => {
  const { sec } = newEtf({ initial_units: 25 });
  const book = engine.books.get(sec.id);
  const tk = engine.tick(book.sec);
  const h = getSettings().mm_spread_bp / 2 / 1e4;
  const { navC } = navOf(sec.id);
  const bid = Math.max(tk, floorTick(navC * (1 - h), tk));
  const ask = Math.max(ceilTick(navC * (1 + h), tk), bid + tk);   // Brief nie auf oder unter dem Geld
  assert.equal(navC, Cr(6));
  assert.deepEqual(mmOpen(book, 'bids').map((o) => [o.price, o.amount - o.filled > 0]), [[bid, true]]);
  assert.deepEqual(mmOpen(book, 'asks').map((o) => [o.price, o.amount - o.filled]), [[ask, 250]]);
  assert.equal(engine.holdingOf(T().id, sec.id), 0);              // alles im Ask-Escrow, kein Bestand zurückgehalten
  assert.ok(bid < Cr(6) && ask > Cr(6));
}));

test('Re-Quoting: mmRefreshAll legt die ETF-Quotes neu, sobald K sich um mindestens 1 Tick von der letzten Quotierung entfernt hat', () => fixed(async () => {
  const { sec, stocks } = newEtf();
  const book = engine.books.get(sec.id);
  const tk = engine.tick(book.sec);
  const h = getSettings().mm_spread_bp / 2 / 1e4;
  const u = await newUser(100_000_000);
  const ids = () => [...book.bids, ...book.asks].map((o) => o.id).sort((a, b) => a - b);
  engine.mmRefreshAll();                                          // K unverändert, Turnus nicht fällig
  const quoted = ids();
  assert.equal(quoted.length, 2);
  const k0 = book.last;
  engine.mmRefreshAll();
  assert.deepEqual(ids(), quoted);                                // kein neues Legen ohne Anlass
  engine.placeOrder(fresh(u), { security_id: stocks[0].id, side: 'buy', type: 'market', amount: 1 });     // NAV +0,03 %: K bleibt
  assert.equal(book.last, k0);
  engine.mmRefreshAll();
  assert.deepEqual(ids(), quoted);                                // unter 1 Tick: weiterhin kein neues Legen
  engine.placeOrder(fresh(u), { security_id: stocks[0].id, side: 'buy', type: 'market', amount: 300 });   // NAV +2,5 %: viele Ticks
  const { navC, k } = navOf(sec.id);
  assert.ok(Math.abs(k - k0) >= tk);
  assert.equal(book.last, k);
  engine.mmRefreshAll();
  assert.notDeepEqual(ids(), quoted, 'Quotes müssen neu gelegt werden');
  const bid = Math.max(tk, floorTick(navC * (1 - h), tk));
  const ask = Math.max(ceilTick(navC * (1 + h), tk), bid + tk);
  assert.deepEqual(mmOpen(book, 'bids').map((o) => o.price), [bid]);
  assert.deepEqual(mmOpen(book, 'asks').map((o) => o.price), [ask]);
  anchored(sec.id, 'nach dem Re-Quoting');
}));

// ---------------------------------------------------------------------------
// AP-Arbeitsbestand: Creation
// ---------------------------------------------------------------------------
test('AP-Arbeitsbestand: frisch geschaffener ETF hält T = W0 → autoArbitrage() = [] und ändert nichts', () => fixed(() => {
  const { sec, stocks } = newEtf({ initial_units: 25 });
  const ids = [sec.id, ...stocks.map((s) => s.id)];
  assert.equal(stock(sec.id), targetOf(sec.id));
  const before = snap(ids);
  assert.deepEqual(etf.autoArbitrage().filter((a) => a.ticker === sec.ticker), []);
  assert.deepEqual(snap(ids), before);
  assert.equal(openAp(sec.id), 0);                                // keine Peg-Leiter, kein Marktkauf von ETF-Anteilen
}));

test('AP-Arbeitsbestand: T < 0,5·W → Creation bis W; Korb sinkt, Umlauf steigt, danach MM-Quotes auf ETF und Korbaktien', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });          // W0 = W = 250 Anteile, Umlauf 250
  const buyer = await newUser(100_000_000);
  buyEtf(buyer, sec.id, 200);                                      // T = 50 < 125
  assert.equal(stock(sec.id), 50);
  const basket = stocks.map((s) => stock(s.id));
  const a = etf.autoArbitrage().filter((x) => x.ticker === sec.ticker);
  assert.deepEqual(actionList(a), [['creation', 20]]);             // clamp(ceil((250 − 50) / 10), 1, 25) = 20 Units
  assert.deepEqual(Object.keys(a[0]).sort(), ['action', 'premium_pct', 'ticker', 'units']);
  assert.ok(Number.isFinite(a[0].premium_pct));
  assert.equal(floatOf(sec.id), 450);                              // 250 + 20 · 10
  assert.equal(stock(sec.id), 250);                                // T = W
  assert.equal(workOf(sec.id), 250);                               // W0 bleibt der Boden (25 % von 450 = 113)
  stocks.forEach((s, i) => assert.equal(stock(s.id), basket[i] - 20 * BASKET[i], `${s.ticker}: Korb aus dem Depot`));
  assertQuoted([sec.id, ...stocks.map((s) => s.id)], 'nach der Creation');
  anchored(sec.id, 'nach der Creation');
  assert.equal(openAp(sec.id), 0);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);   // kein Umkippen in die Redemption
})));

test('AP-Arbeitsbestand, Grenzen der Creation: genau 0,5·W keine Aktion, darunter Creation bis W (aufgerundet), höchstens etf_auto_max_units', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec } = newEtf({ initial_units: 25 });                  // W = 250
  const buyer = await newUser(100_000_000);
  buyEtf(buyer, sec.id, 125);                                      // T = 125 = 0,5 · W
  const before = snap([sec.id]);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);
  assert.deepEqual(snap([sec.id]), before);
  buyEtf(buyer, sec.id, 1);                                        // T = 124 < 0,5 · W
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 13]]);   // ceil(126 / 10)
  assert.equal(stock(sec.id), 254);                                // bis W, aufgerundet auf ganze Units
  assert.equal(floatOf(sec.id), 380);                              // 250 + 13 · 10
  // Obergrenze: aus verkauftem ETF (T = 0) werden höchstens etf_auto_max_units Units geschaffen
  await withSettings({ etf_auto_max_units: 5 }, async () => {
    buyEtf(buyer, sec.id, 254);                                    // T = 0
    assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 5]]);
    assert.equal(stock(sec.id), 50);
    assert.equal(floatOf(sec.id), 430);                            // 380 + 5 · 10
  });
})));

test('AP-Arbeitsbestand: W folgt dem Umlauf — 25 % des Umlaufs, sobald über W0; keine Aktion im neutralen Bereich', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec } = newEtf({ initial_units: 25 });
  const trader = await newUser(100_000_000);
  etf.createUnits(sec.id, 175);                                    // bestehender AP-Endpunkt: Umlauf 2000, Staatskasse hält alle
  assert.equal(floatOf(sec.id), 2000);
  assert.equal(stock(sec.id), 2000);
  const r = buyEtf(trader, sec.id, 1600);                          // T = 400; Umlauf 2000 → W = max(250, 500) = 500
  assert.equal(r.order.filled, 1600);                              // ETF: keine Ordergrößen-Grenze (Q_max der Aktien wäre 689)
  assert.equal(stock(sec.id), 400);
  assert.equal(workOf(sec.id), 500);
  const before = snap([sec.id]);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);   // 250 ≤ 400 ≤ 625: nichts (mit W = W0 allein wäre 400 > 312,5)
  assert.deepEqual(snap([sec.id]), before);
  sellEtf(trader, sec.id, 300);                                    // T = 700 > 625, Überschuss 200 = 20 Units
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['redemption', 20]]);
  assert.equal(floatOf(sec.id), 1800);
  assert.equal(stock(sec.id), 500);                                // = W
})));

// ---------------------------------------------------------------------------
// AP-Arbeitsbestand: Redemption (beginnt nach einer Creation — am Anfang ist W = W0 = ganzer Umlauf)
// ---------------------------------------------------------------------------
test('AP-Arbeitsbestand: T > 1,25·W mit Überschuss ≥ 1 Unit → Redemption bis W; Umlauf sinkt, Korb wächst, danach MM-Quotes', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });          // W0 = W = 250
  const trader = await newUser(100_000_000);
  buyEtf(trader, sec.id, 200);                                     // erst Nachfrage → Creation
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 20]]);   // Umlauf 450, T 250
  const basket = stocks.map((s) => stock(s.id));
  const floatBefore = floatOf(sec.id);
  sellEtf(trader, sec.id, 200);                                    // dann einseitiger Verkauf: T = 450 > 312,5, Überschuss 200
  assert.equal(stock(sec.id), 450);
  anchored(sec.id, 'nach dem Verkauf');
  const r = etf.autoArbitrage().filter((x) => x.ticker === sec.ticker);
  assert.deepEqual(actionList(r), [['redemption', 20]]);           // min(floor(200 / 10), 25)
  assert.deepEqual(Object.keys(r[0]).sort(), ['action', 'premium_pct', 'ticker', 'units']);
  assert.equal(floatOf(sec.id), floatBefore - 20 * 10);            // 250: Umlauf nie unter W0
  assert.ok(Math.abs(stock(sec.id) - workOf(sec.id)) <= 10, `T = ${stock(sec.id)}, W = ${workOf(sec.id)}`);   // etwa W (± 1 Unit)
  assert.equal(stock(sec.id), 250);
  stocks.forEach((s, i) => assert.equal(stock(s.id), basket[i] + 20 * BASKET[i], `${s.ticker}: Korb zurück`));
  assertQuoted([sec.id, ...stocks.map((s) => s.id)], 'nach der Redemption');
  anchored(sec.id, 'nach der Redemption');
  assert.equal(openAp(sec.id), 0);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);   // kein Umkippen in die Creation
})));

test('AP-Arbeitsbestand, kleines ETF (W < 4 Units): über 1,25·W mit Überschuss < 1 Unit → nichts; ab 1 Unit → floor(Überschuss / spu) Units, nie unter W', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec } = newEtf({ initial_units: 2 });                   // W0 = W = 20 Anteile (2 Units), Umlauf 20
  const trader = await newUser(100_000_000);
  buyEtf(trader, sec.id, 20);                                      // T = 0 → Creation
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 2]]);    // ceil(20 / 10)
  assert.equal(floatOf(sec.id), 40);
  assert.equal(stock(sec.id), 20);
  assert.equal(workOf(sec.id), 20);
  sellEtf(trader, sec.id, 6);                                      // T = 26 > 25, Überschuss 6 < 10
  const before = snap([sec.id]);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);
  assert.deepEqual(snap([sec.id]), before);
  sellEtf(trader, sec.id, 3);                                      // T = 29, Überschuss 9
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);
  sellEtf(trader, sec.id, 1);                                      // T = 30, Überschuss 10 = genau 1 Unit
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['redemption', 1]]);
  assert.equal(floatOf(sec.id), 30);
  assert.equal(stock(sec.id), 20);                                 // = W: es wird nie unter W eingelöst
  buyEtf(trader, sec.id, 20);                                      // T = 0 → wieder Creation (2 Units): Umlauf 50, T 20
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 2]]);
  sellEtf(trader, sec.id, 30);                                     // T = 50 > 25, Überschuss 30 = 3 Units
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['redemption', 3]]);
  assert.equal(floatOf(sec.id), 20);
  assert.equal(stock(sec.id), 20);
})));

test('Keine Spirale, kein Umkippen: ETF mit W0 = 1 Unit über 80 einseitige Schübe (Kauf und Verkauf im Wechsel)', () => withSettings({ etf_auto_interval_sec: 0 }, () => {
  const rnd = mulberry32(26112026);
  return withRnd(rnd, () => fixed(async () => {
    const { sec, stocks } = newEtf({ initial_units: 1 });         // W0 = 10 Anteile
    const W0 = targetOf(sec.id);
    const sharesPerUnit = q.secById.get(sec.id).shares_per_unit;
    const trader = await newUser(100_000_000);
    const book = engine.books.get(sec.id);
    const ids = [sec.id, ...stocks.map((s) => s.id)];
    let creations = 0, redemptions = 0;
    for (let i = 0; i < 80; i++) {
      const buy = Math.floor(i / 5) % 2 === 0;                    // je fünf Schübe in eine Richtung
      const chunk = 1 + Math.floor(rnd() * 30);
      let r = null;
      if (buy) {
        const amount = Math.min(chunk, engine.sideDepth(book, 'sell'));
        if (amount > 0) r = buyEtf(trader, sec.id, amount);
      } else {
        const amount = Math.min(chunk, engine.holdingOf(trader.id, sec.id), engine.sideDepth(book, 'buy'));
        if (amount > 0) r = sellEtf(trader, sec.id, amount);
      }
      if (r) anchored(sec.id, `Schub ${i + 1}`);
      const Fbefore = floatOf(sec.id);
      const a = etf.autoArbitrage().filter((x) => x.ticker === sec.ticker);
      assert.ok(a.length <= 1, `Schub ${i + 1}: mehr als eine Aktion`);
      for (const x of a) {
        if (x.action === 'creation') creations++;
        else if (x.action === 'redemption') redemptions++;
        else assert.fail(`unbekannte Aktion ${x.action}`);
      }
      const F = floatOf(sec.id), T0 = stock(sec.id), W = workOf(sec.id);
      assert.ok(F >= W0, `Schub ${i + 1}: Umlauf ${F} unter W0 ${W0}`);
      assert.ok(T0 <= F, `Schub ${i + 1}: Bestand ${T0} über Umlauf ${F}`);
      if (a.length) {
        // W zur Zeit der Entscheidung (vor der Schöpfung/Einlösung); nach einer Redemption gilt es auch danach.
        const WDecision = Math.max(W0, sharesPerUnit, Math.round(getSettings().etf_ap_inventory_pct / 100 * Fbefore));
        assert.ok(T0 >= WDecision, `nach ${a[0].action} in Schub ${i + 1}: Bestand ${T0} unter W ${WDecision} zur Entscheidung`);
        if (a[0].action === 'redemption') assert.ok(T0 >= W, `nach redemption in Schub ${i + 1}: Bestand ${T0} unter W ${W}`);
        assertQuoted(ids, `nach ${a[0].action} in Schub ${i + 1}`);
        // Kein Umkippen: die folgenden Takte lösen nie die Gegenrichtung aus; gleichgerichtete
        // Folgeaktionen (W folgt dem Umlauf) kommen nach wenigen Takten zur Ruhe.
        const dir = a[0].action;
        for (let k = 0; k < 6; k++) {
          const again = etf.autoArbitrage().filter((x) => x.ticker === sec.ticker);
          if (!again.length) break;
          assert.ok(again.every((x) => x.action === dir), `nach ${dir} in Schub ${i + 1}: nächster Takt löst ${again.map((x) => x.action).join(',')} aus`);
          assert.ok(floatOf(sec.id) >= W0 && stock(sec.id) >= 0, `Schub ${i + 1}, Folgetakt: Umlauf ${floatOf(sec.id)}, Bestand ${stock(sec.id)}`);
          if (dir === 'redemption') assert.ok(stock(sec.id) >= workOf(sec.id), `Schub ${i + 1}, Folgetakt: Bestand ${stock(sec.id)} unter W ${workOf(sec.id)}`);
          assertQuoted(ids, `nach ${dir} in Schub ${i + 1}, Folgetakt`);
        }
        assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), [], `Schub ${i + 1}: nach ${dir} kommt die Automatik nicht zur Ruhe`);
      }
    }
    assert.ok(creations >= 1 && redemptions >= 1, `das Szenario muss beide Richtungen auslösen (Creation ${creations}, Redemption ${redemptions})`);
  }));
}));

test('Mindestabstand: je ETF höchstens eine Aktion pro etf_auto_interval_sec — für beide Richtungen', () => withSettings({ etf_auto_interval_sec: 10 }, () => fixed(async () => {
  const { sec } = newEtf({ initial_units: 25 });
  const trader = await newUser(100_000_000);
  // Uhr ersetzt (kein Warten im Test): schon vor der ersten Aktion, damit der Mindestabstand an ihr gemessen wird
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    buyEtf(trader, sec.id, 200);                                   // T = 50
    assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 20]]);   // Umlauf 450, T 250
    sellEtf(trader, sec.id, 150);                                  // T = 400 > 312,5: Redemption fällig
    assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);   // unterdrückt (Gegenrichtung)
    assert.equal(stock(sec.id), 400);
    buyEtf(trader, sec.id, 300);                                   // T = 100 < 125: Creation fällig
    now += 10 * 1000 - 1;                                          // 1 ms vor Ablauf
    assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);   // ebenfalls unterdrückt
    assert.equal(stock(sec.id), 100);
    now += 2;                                                      // Mindestabstand abgelaufen
    assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 15]]);   // ceil((250 − 100) / 10)
    assert.equal(stock(sec.id), 250);
  } finally {
    Date.now = realNow;
  }
})));

// T5: Knapper Bestand ist die Prämisse dieses Falls. Die Streubesitz-Regeln (Auffüllen bis
// mm_min_ask_shares, Nachplatzierung ab 25 % von D) würden die Knappheit sofort aufheben — für
// diese Fixture also aus, wie in mm.test.js; die Zahlen (10 und 5 Stück) bleiben die alten.
test('Creation am Korb: fehlt eine Korbaktie, wird auch von den anderen nichts gekauft — Bestände, Orders und MM-Quotes unverändert, [], kein Mindestabstand; mit Angeboten sofort geschaffen', () => withSettings({ mm_replenish_min: 0, mm_min_ask_shares: 0, mm_min_depth: 0 }, () => fixed(async () => {
  // Beide Korbaktien sind knapp: der Staatskasse bleiben nach der Schöpfung 10 und 5 Stück
  // (60 − 10·5, 30 − 5·5); für die Creation von 5 Units (T = 0 → ceil(50/10)) werden 50 und 25 gebraucht.
  const { sec, stocks } = newEtf({ initial_units: 5, basket: [10, 5], floats: [60, 30] });
  assert.equal(targetOf(sec.id), 50);
  assert.deepEqual(stocks.map((s) => stock(s.id)), [10, 5]);
  const ids = [sec.id, ...stocks.map((s) => s.id)];
  const buyer = await newUser(100_000_000), offerA = await newUser(), offerB = await newUser();
  buyEtf(buyer, sec.id, 50);                                       // T = 0 < 0,5 · W
  assert.equal(stock(sec.id), 0);
  assertQuoted(ids, 'vor der Creation');                           // MM-Quotes auf ETF und Korbaktien liegen
  // Nur für die zweite Korbaktie gibt es ein Angebot im Band — die erste ist nicht beschaffbar
  engine.addHoldingPublic(offerB.id, stocks[1].id, 20, Cr(20));
  const offerOrderB = engine.placeOrder(fresh(offerB), { security_id: stocks[1].id, side: 'sell', type: 'limit', price: Cr(21), amount: 20 }).order;   // Aktien liegen im Escrow
  const before = snap(ids);
  assert.deepEqual(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker), []);
  assert.deepEqual(snap(ids), before);                             // nichts gekauft, keine Quote angefasst
  assert.equal(orderRow(offerOrderB.id).filled, 0);                // das vorhandene Angebot bleibt unberührt
  assert.equal(orderRow(offerOrderB.id).status, 'open');
  assert.equal(openAp(stocks[0].id) + openAp(stocks[1].id), 0);
  assert.equal(stock(sec.id), 0);
  assert.equal(floatOf(sec.id), 50);
  // Jetzt ist auch die erste Korbaktie beschaffbar → sofort, obwohl etf_auto_interval_sec = 10 s ist (kein Mindestabstand gesetzt)
  engine.addHoldingPublic(offerA.id, stocks[0].id, 40, Cr(20));
  const offerOrderA = engine.placeOrder(fresh(offerA), { security_id: stocks[0].id, side: 'sell', type: 'limit', price: Cr(21), amount: 40 }).order;
  assert.deepEqual(actionList(etf.autoArbitrage().filter((x) => x.ticker === sec.ticker)), [['creation', 5]]);
  assert.equal(orderRow(offerOrderA.id).filled, 40);               // Fehlmengen am Markt von Spielern gekauft
  assert.equal(orderRow(offerOrderB.id).filled, 20);
  assert.equal(floatOf(sec.id), 100);
  assert.equal(stock(sec.id), 50);                                 // = W
  assertQuoted(ids, 'nach der Creation');
  anchored(sec.id, 'nach der Creation');
})));

test('etf_auto = 0: die Automatik tut nichts, auch bei Unterbestand', () => withSettings({ etf_auto: 0 }, () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });
  const buyer = await newUser(100_000_000);
  buyEtf(buyer, sec.id, 200);                                      // T = 50 < 0,5 · W
  const ids = [sec.id, ...stocks.map((s) => s.id)];
  const before = snap(ids);
  assert.deepEqual(etf.autoArbitrage(), []);
  assert.deepEqual(snap(ids), before);
})));

test('Alter ETF ohne ap_inventory_target (NULL oder 0): am Anfang von autoArbitrage() einmalig max(1 Unit, round(25 % · Umlauf)) setzen und speichern', () => withSettings({ etf_auto_interval_sec: 0 }, () => fixed(async () => {
  const { sec } = newEtf({ initial_units: 25 });
  const trader = await newUser(100_000_000);
  buyEtf(trader, sec.id, 200);
  etf.autoArbitrage();                                             // Umlauf 450, T 250
  assert.equal(floatOf(sec.id), 450);
  db.prepare('UPDATE securities SET ap_inventory_target = NULL WHERE id = ?').run(sec.id);
  etf.autoArbitrage();
  assert.equal(targetOf(sec.id), 113);                             // max(10, round(0,25 · 450))
  engine.loadEngine();
  assert.equal(targetOf(sec.id), 113);                             // gespeichert, kein Zufallswert
  // Alter ETF, den die Staatskasse vollständig hält: W0 = max(1 Unit, 25 % des Umlaufs) —
  // es wird nie unter W0 eingelöst, der Umlauf bleibt ≥ W0, auch über viele Läufe
  for (const stale of [null, 0]) {
    const { sec: full } = newEtf({ initial_units: 25 });           // Umlauf 250, Staatskasse hält alle 250
    assert.equal(stock(full.id), 250);
    db.prepare('UPDATE securities SET ap_inventory_target = ? WHERE id = ?').run(stale, full.id);
    for (let i = 0; i < 8; i++) {
      etf.autoArbitrage();
      assert.equal(targetOf(full.id), 63, `Lauf ${i + 1}: W0 = max(10, round(0,25 · 250))`);   // einmalig gesetzt und gespeichert
      assert.ok(floatOf(full.id) >= 63, `Lauf ${i + 1}: Umlauf ${floatOf(full.id)} unter W0`);
      assert.ok(stock(full.id) >= 63, `Lauf ${i + 1}: Bestand ${stock(full.id)} unter W0`);
    }
    assert.equal(floatOf(full.id), 70);                            // 250 − 18 Units: Überschuss 187 → floor(18,7); Rest 7 < 1 Unit → Stopp
    assert.equal(stock(full.id), 70);
  }
  // winziger ETF (1 Unit Umlauf): mindestens 1 Unit
  const { sec: tiny } = newEtf({ initial_units: 1 });
  assert.equal(floatOf(tiny.id), 10);
  db.prepare('UPDATE securities SET ap_inventory_target = NULL WHERE id = ?').run(tiny.id);
  etf.autoArbitrage();
  assert.equal(targetOf(tiny.id), 10);
})));

// ---------------------------------------------------------------------------
// V4: bestehende AP-Funktionen behalten Signatur und Verhalten; Neustart
// ---------------------------------------------------------------------------
test('Bestehende AP-Funktionen behalten Signatur und Verhalten: basketOf, nav, preview, createUnits, redeemUnits, routeDividend', () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });
  const basket = etf.basketOf(sec.id);
  assert.deepEqual(basket.map((b) => [b.stock_id, b.qty]), stocks.map((s, i) => [s.id, BASKET[i]]));
  const n = etf.nav(sec.id);
  assert.deepEqual(Object.keys(n).sort(), ['basket_value', 'items', 'last', 'nav_per_share', 'premium_pct', 'shares_per_unit']);
  assert.equal(n.shares_per_unit, 10);
  assert.equal(n.basket_value, basket.reduce((s, b) => s + b.qty * engine.books.get(b.stock_id).last, 0));
  assert.equal(n.nav_per_share, n.basket_value / 10);
  assert.equal(n.last, engine.books.get(sec.id).last);
  const pv = etf.preview(sec.id, 2);
  assert.equal(pv.units, 2);
  assert.equal(pv.etf_shares, 20);
  for (const key of ['buy_basket_cost', 'etf_sell_proceeds', 'est_profit']) assert.ok(Number.isFinite(pv.creation[key]), `creation.${key}`);
  for (const key of ['etf_buy_cost', 'basket_sell_proceeds', 'est_profit']) assert.ok(Number.isFinite(pv.redemption[key]), `redemption.${key}`);
  const c = etf.createUnits(sec.id, 2);
  assert.equal(c.units, 2);
  assert.equal(c.shares_created, 20);
  assert.equal(floatOf(sec.id), 270);
  const r = etf.redeemUnits(sec.id, 1);
  assert.equal(r.units, 1);
  assert.equal(r.shares_redeemed, 10);
  assert.equal(floatOf(sec.id), 260);
  // Fehlerfälle
  assert.throws(() => etf.createUnits(sec.id, 0), /Ungültige Anzahl Creation Units/);
  assert.throws(() => etf.redeemUnits(sec.id, 0), /Ungültige Anzahl Creation Units/);
  assert.throws(() => etf.createUnits(sec.id, 1000000), /besitzt nicht genug/);
  assert.throws(() => etf.redeemUnits(sec.id, 1000000), /besitzt nur/);
  assert.throws(() => etf.createUnits(99999999, 1), /ETF nicht gefunden/);
  // Dividenden-Routing: 1 Cr je Korbaktie → floor(2 · 100 / 10) = 20 Cent je ETF-Anteil
  const holder = await newUser();
  engine.addHoldingPublic(holder.id, sec.id, 50, Cr(6));
  const cash0 = fresh(holder).cash;
  const routed = etf.routeDividend(stocks[0].id, 100);
  assert.equal(fresh(holder).cash, cash0 + 50 * 20);
  assert.deepEqual([routed[0].etf, routed[0].per_etf_share], [sec.ticker, 20]);
}));

test('Neustart: loadEngine() rechnet den ETF-Kurs aus dem Korb neu, ap_inventory_target bleibt gespeichert, ETF ist weiter quotiert', () => fixed(async () => {
  const { sec, stocks } = newEtf({ initial_units: 25 });
  const u = await newUser(100_000_000);
  engine.placeOrder(fresh(u), { security_id: stocks[0].id, side: 'buy', type: 'market', amount: 120 });
  const last = engine.books.get(sec.id).last;
  assert.notEqual(last, Cr(6));
  engine.loadEngine();
  assert.equal(engine.books.get(sec.id).last, last);
  assert.equal(engine.books.get(sec.id).last, navOf(sec.id).k);
  assert.equal(targetOf(sec.id), 250);
  assert.equal(floatOf(sec.id), 250);
  assert.equal(stock(sec.id), 250);
  engine.mmRefreshAll();
  assertQuoted([sec.id], 'nach dem Neustart');
  anchored(sec.id, 'nach dem Neustart');
}));

// ---------------------------------------------------------------------------
// T9 (Vertrag V6): ETF im Admin anlegen — createEtf übernimmt die Beschreibung und
// meldet den Bestandsmangel der Staatskasse mit Kürzel und Fehlmenge
// ---------------------------------------------------------------------------
test('createEtf (V6): Beschreibung aus dem Formular wird übernommen, ohne Angabe der Standardtext', () => fixed(() => {
  const { sec: ohne } = newEtf({ initial_units: 2 });
  const a = newStock({ float: 500 }), b = newStock({ float: 500 });
  const eigener = etf.createEtf({ ticker: `QD${letters(++seq)}`, name: 'QA-ETF mit Text', shares_per_unit: 1, initial_units: 3,
    basket: [{ stock_id: a.id, qty: 2 }, { stock_id: b.id, qty: 1 }], description: '  Kantine und Kopierer.  ' });
  assert.equal(q.secById.get(eigener.id).description, 'Kantine und Kopierer.');
  assert.equal(eigener.type, 'etf');
  assert.ok(etf.nav(eigener.id).nav_per_share > 0, 'NAV je Anteil > 0');
  assert.equal(q.secById.get(ohne.id).description, 'Schul-ETF (Indexfonds)', 'ohne description: Standardtext');
}));

test('createEtf (V6): Bestandsmangel der Staatskasse — Fehler mit Kürzel und Fehlmenge, nichts wird angelegt', () => fixed(() => {
  const a = newStock({ float: 50 }), b = newStock({ float: 300 });
  // Bedarf 10 Stück über dem, was die Staatskasse unquotiert im Depot hat 
  const bedarf = engine.holdingOf(T().id, a.id) + 10;
  const basket = [{ stock_id: a.id, qty: bedarf }, { stock_id: b.id, qty: 1 }];
  const n0 = db.prepare("SELECT COUNT(*) c FROM securities WHERE type='etf'").get().c;
  const bestand = [engine.holdingOf(T().id, a.id), engine.holdingOf(T().id, b.id)];
  assert.throws(() => etf.createEtf({ ticker: `QD${letters(++seq)}`, name: 'QA-ETF zu groß', shares_per_unit: 1, initial_units: 1, basket }), (e) => {
    assert.equal(e.message, `Die Staatskasse hat zu wenig ${a.ticker}: es fehlen 10 Stück.`);
    return true;
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM securities WHERE type='etf'").get().c, n0, 'kein ETF angelegt');
  assert.deepEqual([engine.holdingOf(T().id, a.id), engine.holdingOf(T().id, b.id)], bestand, 'nichts abgebucht');
  // Reicht der Korb, wird er genau um Stück × Units aus dem Depot genommen
  const ok = etf.createEtf({ ticker: `QD${letters(++seq)}`, name: 'QA-ETF passt', shares_per_unit: 1, initial_units: 2, basket: [{ stock_id: a.id, qty: 3 }, { stock_id: b.id, qty: 1 }] });
  assert.deepEqual([engine.holdingOf(T().id, a.id), engine.holdingOf(T().id, b.id)], [bestand[0] - 6, bestand[1] - 2]);
  assert.equal(etf.basketOf(ok.id).length, 2);
}));
