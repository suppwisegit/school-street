// QA-Tests Market Maker V3 — Engine (T6).
// Abgeleitet aus PLAN.md Abschnitt 2 (Modell), Vertrag V2 und Abschnitt 7 (Prüfmatrix),
// nicht aus dem Implementierungscode: Erwartete Werte sind hier aus den Formeln des
// Plans neu gerechnet (kein require von server/mmath).
//
// Isolation wie b3.test.js: eigene, frisch geseedete DB (server/data/mm-test-<pid>.db),
// ein eigenes Wertpapier je Test, geänderte Einstellungen und Math.random werden
// zurückgestellt. Die echte DB wird nie berührt.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `mm-test-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);

const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

// Erst seeden, DANN öffnen (siehe b3.test.js).
let db, getSettings, setSetting, q, auth, engine, bus;
before(() => {
  clean();
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
  ({ db, DEFAULT_SETTINGS, getSettings, setSetting, q } = require('../db'));
  // T5 (V4): Die Prüfmatrizen dieses Datei beschreiben das MM-V3-Modell mit fester Leiste
  // (6 Stufen = 435 Stück je Seite, Nachplatzierung erst unter mm_replenish_min). Die neuen
  // Streubesitz-Regeln schalten sie für diese Fixture ab — jede Prüfung bleibt unverändert.
  // Das Spiel-Default (Leiste bis mm_min_ask_shares, Streubesitz-Regeln an) prüft der
  // Abschnitt „Streubesitz (V4)“ am Ende mit ausdrücklich gesetzten Werten.
  setSetting('mm_min_ask_shares', 0);
  setSetting('mm_min_depth', 0);
  // Eigene, wegwerfbare DB: Commits ohne fsync. Jeder Recenter ist eine Transaktion; mit
  // fsync kosten 16 000 Round-Trip-Läufe über eine Minute, ohne rund eine Sekunde.
  db.pragma('synchronous = OFF');
  auth = require('../auth');
  bus = require('../bus');
  engine = require('../engine');
  engine.loadEngine();
  // Die Staatskasse der geseedeten DB hat nach vier Aktien nur rund 250 000 Cr; die Tests
  // legen aber 60 und mehr eigene Aktien an, und ihr Geld-Budget je Wert hängt am Cash
  // (Budget = Cash · mm_cash_budget_pct / Zahl der Werte). Damit die Geld-Seite in den
  // Fixtures nie am Budget hängt, bekommt sie hier reichlich Cash (50 Mio. Cr).
  db.prepare("UPDATE users SET cash = cash + ? WHERE role = 'bank'").run(50_000_000 * 100);
});
after(clean);

// ---------------------------------------------------------------------------
// Formeln aus PLAN 2.1 / 2.2 / 2.4 und V1 — hier neu gerechnet, als Maßstab.
// ---------------------------------------------------------------------------
const MILLI = 1000;                                    // Milli-Cent je Cent
const Cr = (credits) => Math.round(credits * 100);     // Credits → Cent
const lambdaOf = (depth, impactPct) => Math.log(1 + impactPct / 100) / Math.max(1, depth);
// Q_max = floor(ln(1 + B) / λ); λ ≤ 0 → keine Grenze
const qMaxOf = (depth, impactPct, bandPct) => {
  const lambda = lambdaOf(depth, impactPct);
  if (!(lambda > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(Math.log(1 + bandPct / 100) / lambda + 1e-9));
};
// Tick-Rundung float-sicher (V1): ein Wert, der rechnerisch genau auf einem Tick liegt, bleibt dort
const floorTick = (p, t) => Math.floor(p / t + 1e-9) * t;
const ceilTick = (p, t) => Math.ceil(p / t - 1e-9) * t;
const publicOf = (fair, t) => Math.max(t, Math.round(fair / MILLI / t) * t);
const flowF = (F0, lambda, qty) => Math.round(F0 * Math.exp(lambda * qty));   // F ← round(F · e^(λ·q))
function expectedBand(fair, t, pct) {
  const fc = fair / MILLI;
  const span = Math.max(Math.round(fc * pct / 100), 2 * t);
  return { ref: publicOf(fair, t), min: Math.max(t, floorTick(fc - span, t)), max: ceilTick(fc + span, t) };
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
let n = 0, seq = 0;
const newUser = async (cash = 2_000_000, role = 'user') => auth.createUser(`mm-qa-${++n}`, 'pw1234', role, cash);
const fresh = (u) => q.userById.get(u.id);
const letters = (num) => {
  let s = '';
  for (let x = num; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + (x - 1) % 26) + s;
  return s;
};
const withRnd = (rnd, fn) => { const orig = Math.random; Math.random = rnd; try { return fn(); } finally { Math.random = orig; } };
// V2: Die Staffel liest rnd je Aufruf als Math.random — hier deterministisch ersetzt.
const withRandom = (rnd) => async (fn) => {
  const orig = Math.random;
  Math.random = rnd;
  try { return await fn(); } finally { Math.random = orig; }
};
// Mit rnd = 0,5 gibt es keinen Jitter: Stufe i hat genau mm_size + i·mm_size_step Stück
// (Standard 10/35/60/85/110/135 = 435 je Seite), die Leiter ist berechenbar.
const fixed = withRandom(() => 0.5);
async function withSettings(values, fn) {
  const s = getSettings();
  const prev = Object.fromEntries(Object.keys(values).map((k) => [k, s[k]]));
  for (const [k, v] of Object.entries(values)) setSetting(k, v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) setSetting(k, v); }
}
// Fixture für die Ordergrößen-Grenze: eine MM-Stufe mit 700 Stück, damit Q_max = 689
// vollständig von MM-Quotes füllt (nur Ausführungen gegen MM-Quotes sind Flow).
const bigLadder = (fn) => withSettings({ mm_levels: 1, mm_size: 700 }, () => fixed(fn));

// Frische Aktie nur für diesen Test: F0 = IPO-Preis, die Staatskasse hält den Streubesitz
// (und zahlt ihn wie im Seed). Ohne Gründer ist D = float.
function newStock({ ipo = 20, float = 2000, founderShares = 0, quote = true, mmEnabled = 1, jitter = false } = {}) {
  const t = engine.treasury();
  const founder = founderShares ? auth.createUser(`mm-qa-gruender-${seq + 1}`, 'pw1234', 'user', 10_000_000) : null;
  const sec = engine.listSecurity({
    type: 'stock', ticker: `QA${letters(++seq)}`, name: `QA-Aktie ${seq}`, founder_id: founder ? founder.id : null,
    ipo_price: Cr(ipo), total_shares: float + founderShares, mm_enabled: mmEnabled
  });
  engine.addHoldingPublic(t.id, sec.id, float, Cr(ipo));
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(ipo) * float, t.id);
  if (founder) engine.addHoldingPublic(founder.id, sec.id, founderShares, Cr(ipo));
  if (quote && mmEnabled) {
    if (jitter) engine.mmRecenter(engine.books.get(sec.id));            // Zufallsstaffeln aus dem umgebenden Math.random
    else withRnd(() => 0.5, () => engine.mmRecenter(engine.books.get(sec.id)));
  }
  return { sec, founder, book: engine.books.get(sec.id) };
}

const fair = (secId) => engine.fairPrice(secId);
const lambda = (secId) => lambdaOf(engine.impactDepth(secId), getSettings().mm_impact_pct);
const ladderTotal = () => {
  const s = getSettings();
  let sum = 0;
  for (let i = 0; i < s.mm_levels; i++) sum += s.mm_size + i * s.mm_size_step;
  return sum;
};
const mmOpen = (book, side) => book[side].filter((o) => o.is_mm && o.status === 'open' && o.amount - o.filled > 0);
const askEscrow = (book) => mmOpen(book, 'asks').reduce((s, o) => s + o.amount - o.filled, 0);
const treasuryStock = (secId) => engine.holdingOf(engine.treasury().id, secId) + askEscrow(engine.books.get(secId));   // Depot + Ask-Escrow
const orderCount = (userId) => db.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(userId).c;
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const inBook = (book, orderId) => [...book.bids, ...book.asks].some((o) => o.id === orderId);
const orderIds = (book) => [...book.bids, ...book.asks].map((o) => o.id).sort((a, b) => a - b);
const market = (secId, side, amount) => ({ security_id: secId, side, type: 'market', amount });
const fillList = (rows, qtyKey) => rows.map((x) => [x.price, x[qtyKey]]);
const near = (actual, expected, tol, why) => assert.ok(Math.abs(actual - expected) <= tol, `${why}: ${actual}, erwartet ${expected} (± ${tol})`);
const priceOf = (cr) => cr.toFixed(2).replace('.', '[.,]');
// Ein Spieler bietet `amount` Stück per Limit bei +5 % (ruht, kreuzt die MM-Leiste nicht).
const restAsk = (holder, sec, amount) => {
  engine.addHoldingPublic(holder.id, sec.id, amount, Cr(20));
  engine.placeOrder(fresh(holder), { security_id: sec.id, side: 'sell', type: 'limit', price: Cr(21), amount });
};
// Zeile einer alten DB: offene Limit-Order, außerhalb der Engine eingefügt.
const insertOpen = (secId, userId, side, price, amount, filled = 0, isMm = 0) =>
  db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, fee_charged, created_at)
    VALUES(?,?,?, 'limit', ?,?,?, 'open', ?, 0, ?)`).run(secId, userId, side, price, amount, filled, isMm, Date.now()).lastInsertRowid;

// V2, Fehlertext ohne Cent-Boden: „Preis zu weit vom Kurs entfernt (Kurs X ±Y %). Erlaubt: min – max"
const bandError = (refCr, pct, minCr, maxCr) => (e) =>
  /Preis zu weit vom Kurs entfernt/.test(e.message) &&
  new RegExp(`Kurs ${priceOf(refCr)} ±${pct}%`).test(e.message) &&
  new RegExp(`Erlaubt: ${priceOf(minCr)} – ${priceOf(maxCr)}`).test(e.message) &&
  !/bzw\.|Credits/.test(e.message);
// 2.4: „Zu groß für eine Order: höchstens {Q_max} Stück, damit der Kurs pro Order höchstens {B} % springt. Teile die Order."
const sizeError = (qMax, pct) => (e) =>
  new RegExp(`Zu groß für eine Order: höchstens ${qMax} Stück, damit der Kurs pro Order höchstens ${pct} % springt\\. Teile die Order\\.`).test(e.message);
const fullLadder = (book, why) => {
  const levels = getSettings().mm_levels;
  for (const side of ['bids', 'asks']) {
    const mm = mmOpen(book, side);
    assert.equal(mm.length, levels, `${why}: ${side} hat ${mm.length} statt ${levels} MM-Stufen`);
    for (let i = 1; i < mm.length; i++) {
      assert.ok(side === 'bids' ? mm[i - 1].price > mm[i].price : mm[i - 1].price < mm[i].price, `${why}: ${side} nicht streng sortiert`);
    }
  }
  assert.ok(book.bids[0].price < book.asks[0].price, `${why}: Buch kreuzt`);
};

// ---------------------------------------------------------------------------
// Grundlagen: Tick, F bei listSecurity, Streubesitz
// ---------------------------------------------------------------------------
test('Tick: 10 Cent (0,1 Credit) für Aktien und ETFs — maßgeblich für K, Band und Staffel', () => {
  assert.equal(engine.tick({ type: 'stock' }), 10);
  assert.equal(engine.tick({ type: 'etf' }), 10);
  const { sec } = newStock();
  assert.equal(engine.tick(engine.books.get(sec.id).sec), 10);
});

test('listSecurity setzt F = (initial_last || ipo_price) · 1000; K = F auf Tick', () => {
  const a = newStock({ ipo: 25, quote: false }).sec;
  assert.equal(fair(a.id), Cr(25) * MILLI);
  assert.equal(q.secById.get(a.id).fair_price, Cr(25) * MILLI);
  assert.equal(engine.books.get(a.id).last, Cr(25));
  const b = engine.listSecurity({ type: 'stock', ticker: `QA${letters(++seq)}`, name: 'QA initial_last', ipo_price: Cr(10), total_shares: 100, initial_last: Cr(15) });
  assert.equal(fair(b.id), Cr(15) * MILLI);
  assert.equal(engine.books.get(b.id).last, Cr(15));
});

test('impactDepth = Streubesitz: Gesamtaktien − Gründerbestand, mindestens 1', () => fixed(async () => {
  const { sec, founder } = newStock({ float: 2000, founderShares: 1000 });
  assert.equal(engine.impactDepth(sec.id), 2000);
  engine.placeOrder(fresh(founder), market(sec.id, 'buy', 100));        // Gründer kauft hinzu: Streubesitz sinkt
  assert.equal(engine.impactDepth(sec.id), 1900);
  engine.addHoldingPublic(founder.id, sec.id, 3500);                     // Gründer hält mehr als alle Stücke
  assert.equal(engine.impactDepth(sec.id), 1);
  // Gründer ohne Depotzeile (alles verkauft): Streubesitz = alle Stücke — weder NaN noch 0
  const sold = newStock({ float: 2000, founderShares: 1000 });
  assert.equal(engine.impactDepth(sold.sec.id), 2000);
  engine.addHoldingPublic(sold.founder.id, sold.sec.id, -1000);         // Position läuft leer, die Zeile verschwindet
  assert.equal(q.holding.get(sold.founder.id, sold.sec.id), undefined);
  assert.equal(engine.impactDepth(sold.sec.id), 3000);
  const F1 = fair(sold.sec.id);
  assert.equal(engine.placeOrder(fresh(sold.founder), market(sold.sec.id, 'buy', 1)).order.filled, 1);   // danach normales Flow-Update
  near(fair(sold.sec.id), flowF(F1, lambdaOf(3000, getSettings().mm_impact_pct), 1), 1, 'F bei 1 Stück mit Streubesitz 3000');
  assert.equal(engine.impactDepth(sold.sec.id), 2999);               // der Gründer hält wieder 1 Stück
  assert.equal(engine.previewOrder(fresh(sold.founder), market(sold.sec.id, 'buy', 10)).cap, qMaxOf(2999, 50, 15));
}));

// ---------------------------------------------------------------------------
// Prüfmatrix: Limitpreis-irrelevant; Flow nur gegen die Staatskasse
// ---------------------------------------------------------------------------
// Die Matrix verlangt „Auftrag bleibt offen". Das gilt im Buch ohne MM-Quotes. Mit MM kreuzt
// die nach dem Trade sofort neu gelegte Leiste den weit vom Kurs liegenden Auftrag und nimmt
// den Rest zum Limitpreis ab (MM-Quote als Taker: Flow λ · Restmenge). Vom Spieler-Trade
// allein (Teilnehmer gegen Teilnehmer) geht nie eine Bewegung aus — der Limitpreis nicht.
test('Limitpreis ist irrelevant: Gebot +14,9 % über F, zweiter Account verkauft 1 Stück per Markt-Order — Fill bei +14,9 %; ohne MM-Quotes bleibt F unverändert und der Auftrag offen', () => fixed(async () => {
  for (const mmEnabled of [0, 1]) {
    for (const side of ['buy', 'sell']) {                           // side = Seite des Auftrags weit vom Kurs
      const { sec, book } = newStock({ mmEnabled });
      const tk = engine.tick(book.sec);
      const F0 = fair(sec.id), K0 = book.last, l = lambda(sec.id);
      const maker = await newUser(), taker = await newUser();
      if (mmEnabled) engine.mmCancelQuotes(book);                   // sonst kreuzt der Auftrag die MM-Leiste
      const far = side === 'buy' ? floorTick(Cr(20) * 1.149, tk) : ceilTick(Cr(20) * 0.851, tk);
      assert.ok(Math.abs(far / Cr(20) - 1) >= 0.144, `Fixture: Auftrag muss weit vom Kurs liegen (${far})`);
      if (side === 'sell') engine.addHoldingPublic(maker.id, sec.id, 3, Cr(20));
      else engine.addHoldingPublic(taker.id, sec.id, 1, Cr(20));
      const cash0 = fresh(maker).cash;
      const resting = engine.placeOrder(fresh(maker), { security_id: sec.id, side, type: 'limit', price: far, amount: 3 });
      assert.equal(resting.trades.length, 0);
      assert.equal(fair(sec.id), F0);
      const r = engine.placeOrder(fresh(taker), market(sec.id, side === 'buy' ? 'sell' : 'buy', 1));
      assert.deepEqual(fillList(r.trades, 'amount'), [[far, 1]]);   // Fill zum Limit des Makers
      assert.equal(r.last, K0);
      assert.equal(engine.tickerRow(sec.id).last, K0);              // K = F auf Tick, nicht der Fill-Preis
      const row = orderRow(resting.order.id);
      assert.deepEqual(db.prepare('SELECT DISTINCT price FROM trades WHERE security_id = ?').all(sec.id).map((x) => x.price), [far]);   // Fill-Preise bleiben
      // F hängt nur an Mengen: der Spieler-Trade zählt nicht, die Kreuzung der MM-Leiste mit der Restmenge zählt
      const crossed = row.filled - 1;
      near(fair(sec.id), flowF(F0, l, side === 'buy' ? crossed : -crossed), 1, `MM ${mmEnabled}, ${side}: F`);
      assert.equal(book.last, publicOf(fair(sec.id), tk));
      // Kauf: Escrow für alle 3 Stück bei Aufgabe abgezogen, Gebühr einmal beim Fill. Verkauf: Erlös je gefülltem Stück.
      if (side === 'buy') assert.equal(fresh(maker).cash, cash0 - far * 3 - getSettings().fee_cent);
      else assert.equal(fresh(maker).cash, cash0 + far * row.filled - getSettings().fee_cent);
      if (!mmEnabled) {                                             // Auftrag bleibt offen: Restmenge 2 liegt weiter im Buch
        assert.equal(row.status, 'open');
        assert.equal(row.filled, 1);
        assert.ok(inBook(book, resting.order.id));
        if (side === 'sell') assert.equal(engine.holdingOf(maker.id, sec.id), 0);   // Rest weiter im Escrow
      } else {
        assert.equal(row.status, 'filled', 'die neue MM-Leiste nimmt den Rest zum Limitpreis');
        assert.equal(row.filled, 3);
      }
    }
  }
}));

test('Flow nur gegen die Staatskasse: 300 Stück zwischen zwei Konten ändern F nicht; Kauf q von und Verkauf q an die Staatskasse führt auf F0 zurück', (t) => fixed(async () => {
  const { sec } = newStock();
  const book = engine.books.get(sec.id);
  const F0 = fair(sec.id), K0 = book.last;
  const a = await newUser(), b = await newUser();
  engine.addHoldingPublic(a.id, sec.id, 300, Cr(20));
  const inside = book.asks[0].price - 10;                             // innerhalb des MM-Spreads: die Staatskasse wird nie Maker
  assert.ok(inside > book.bids[0].price && inside < book.asks[0].price);
  for (let i = 0; i < 20; i++) {                                      // 20 × 15 Stück hin und her = 300
    const seller = i % 2 === 0 ? a : b, buyer = i % 2 === 0 ? b : a;
    const offer = engine.placeOrder(fresh(seller), { security_id: sec.id, side: 'sell', type: 'limit', price: inside, amount: 15 });
    assert.equal(offer.trades.length, 0);
    const r = engine.placeOrder(fresh(buyer), { security_id: sec.id, side: 'buy', type: 'limit', price: inside, amount: 15 });   // marketable gegen das liegende Angebot
    assert.deepEqual(fillList(r.trades, 'amount'), [[inside, 15]], `Runde ${i + 1}: nur der andere Spieler darf Maker sein`);
    assert.equal(fair(sec.id), F0, `Runde ${i + 1}`);
  }
  // 20 Wege à 15 Stück: hin und her — am Ende sind alle 300 wieder bei a
  assert.equal(fair(sec.id), F0);
  assert.equal(book.last, K0);
  assert.equal(engine.holdingOf(a.id, sec.id), 300);
  assert.equal(engine.holdingOf(b.id, sec.id), 0);
  assert.deepEqual(db.prepare('SELECT COUNT(*) c, MIN(price) lo, MAX(price) hi FROM price_history WHERE security_id = ?').get(sec.id), { c: 20, lo: K0, hi: K0 });   // ein Punkt je Order, alle bei K0
  // (b) q von der Staatskasse kaufen und q an sie zurückverkaufen
  const qty = 100;
  const buy = engine.placeOrder(fresh(b), market(sec.id, 'buy', qty));
  const sell = engine.placeOrder(fresh(b), market(sec.id, 'sell', qty));
  assert.equal(buy.order.filled, qty);
  assert.equal(sell.order.filled, qty);
  near(fair(sec.id), F0, 2, 'F nach Kauf und Rückverkauf von q (± 1 Mill-Cent je Schritt)');
  t.diagnostic(`Kauf ${qty} von und Verkauf ${qty} an die Staatskasse: Abweichung von F0 ${fair(sec.id) - F0} Mill-Cent`);
}));

// ---------------------------------------------------------------------------
// Prüfmatrix: Band-Storno, Absurdes Limit
// ---------------------------------------------------------------------------
test('Band-Storno: Spieler-Auftrag am Band-Rand verlässt das Band, weil F sich bewegt → automatisch storniert, Escrow vollständig zurück, dirty-Event; Aufträge im Band bleiben', () => fixed(async () => {
  const { sec } = newStock();
  const book = engine.books.get(sec.id);
  const tk = engine.tick(book.sec);
  const u = await newUser(3_000_000), other = await newUser(), mover = await newUser(100_000_000);
  engine.addHoldingPublic(u.id, sec.id, 8, Cr(20));
  engine.addHoldingPublic(other.id, sec.id, 5, Cr(20));
  engine.addHoldingPublic(mover.id, sec.id, 500, Cr(20));
  const cash0 = fresh(u).cash, cashOther0 = fresh(other).cash;
  const dirty = new Set();
  let listening = true;
  bus.on((m) => { if (listening && m.type === 'dirty' && m.user_id === u.id) dirty.add(m.what.join(',')); });
  try {
    const low = ceilTick(Cr(20) * 0.851, tk), high = floorTick(Cr(20) * 1.149, tk);   // −14,9 % / +14,9 %, auf Tick: am Band-Rand
    const bid = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: low, amount: 5 });
    const ask = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'sell', type: 'limit', price: high, amount: 3 });
    const bidMid = engine.placeOrder(fresh(other), { security_id: sec.id, side: 'buy', type: 'limit', price: Cr(18), amount: 2 });   // −10 %: bleibt im Band
    assert.equal(fresh(u).cash, cash0 - low * 5);                    // Kauf-Escrow abgezogen
    assert.equal(engine.holdingOf(u.id, sec.id), 5);                 // 3 Aktien im Verkaufs-Escrow
    // Ein großer Kauf hebt F um mindestens 1 % → das Gebot am unteren Rand liegt außerhalb des Bands
    const F0 = fair(sec.id);
    engine.placeOrder(fresh(mover), market(sec.id, 'buy', 100));
    assert.ok(fair(sec.id) / F0 - 1 >= 0.01);
    assert.equal(orderRow(bid.order.id).status, 'canceled');
    assert.equal(fresh(u).cash, cash0);                              // Escrow vollständig zurück, keine Gebühr
    assert.equal(inBook(book, bid.order.id), false);
    assert.ok(dirty.has('portfolio,orders'), `dirty-Event für den Benutzer fehlt (${[...dirty].join(' | ')})`);
    assert.equal(orderRow(ask.order.id).status, 'open');             // am oberen Rand noch im Band
    assert.equal(orderRow(bidMid.order.id).status, 'open');
    // Ein großer Verkauf senkt F um mindestens 1 % → das Angebot am oberen Rand liegt außerhalb
    const F1 = fair(sec.id);
    engine.placeOrder(fresh(mover), market(sec.id, 'sell', 300));
    assert.ok(fair(sec.id) / F1 - 1 <= -0.01);
    assert.equal(orderRow(ask.order.id).status, 'canceled');
    assert.equal(engine.holdingOf(u.id, sec.id), 8);                 // Restmenge zurück ins Depot
    assert.equal(q.holding.get(u.id, sec.id).avg_cost, Cr(20));      // mit dem Einstandspreis der Order
    assert.equal(inBook(book, ask.order.id), false);
    assert.equal(orderRow(bidMid.order.id).status, 'open');         // mitten im Band: bleibt
    assert.equal(fresh(other).cash, cashOther0 - Cr(18) * 2);
    assert.ok(mmOpen(book, 'bids').length >= 1 && mmOpen(book, 'asks').length >= 1, 'MM-Quotes bleiben');   // vom Storno ausgenommen
  } finally {
    listening = false;
  }
}));

test('Absurdes Limit (10 000 Cr bei Kurs 20): mit Bereichsmeldung abgelehnt, keine Buchung', () => fixed(async () => {
  const { sec } = newStock();
  const u = await newUser(100_000_000);
  engine.addHoldingPublic(u.id, sec.id, 10, Cr(20));
  const cash0 = fresh(u).cash;
  for (const side of ['buy', 'sell']) {
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: sec.id, side, type: 'limit', price: Cr(10_000), amount: 1 }), bandError(20, 15, 17, 23));
  }
  assert.equal(fresh(u).cash, cash0);
  assert.equal(engine.holdingOf(u.id, sec.id), 10);
  assert.equal(orderCount(u.id), 0);
  assert.equal(fair(sec.id), Cr(20) * MILLI);
}));

test('Band: genau min und max sind erlaubt, ein Tick darüber hinaus nicht; Band folgt F; mindestens 2 Ticks je Seite', () => fixed(async () => {
  const { sec } = newStock();
  const book = engine.books.get(sec.id);
  const tk = engine.tick(book.sec);
  const pct = getSettings().limit_band_pct;
  const u = await newUser(2_000_000);
  engine.addHoldingPublic(u.id, sec.id, 10, Cr(20));
  assert.deepEqual(engine.priceBand(book), expectedBand(Cr(20) * MILLI, tk, pct));
  assert.deepEqual(engine.priceBand(book), { ref: Cr(20), min: Cr(17), max: Cr(23) });
  const { min, max } = engine.priceBand(book);
  assert.equal(engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: min, amount: 1 }).trades.length, 0);
  assert.equal(engine.placeOrder(fresh(u), { security_id: sec.id, side: 'sell', type: 'limit', price: max, amount: 1 }).trades.length, 0);
  for (const [side, price] of [['buy', min - tk], ['sell', max + tk], ['buy', max + tk], ['sell', min - tk]]) {
    assert.throws(() => engine.placeOrder(fresh(u), { security_id: sec.id, side, type: 'limit', price, amount: 1 }), bandError(20, 15, 17, 23), `${side} @ ${price}`);
  }
  engine.cancelUserOrders(u.id);
  // Das Band hängt an F: nach Kauf von 100 Stück (+2 %) liegt es entsprechend höher
  engine.placeOrder(fresh(u), market(sec.id, 'buy', 100));
  assert.deepEqual(engine.priceBand(book), expectedBand(fair(sec.id), tk, pct));
  // Billige Aktie (1 Cr): der Prozentsatz würde nur 15 Cent spielen, mindestens aber 2 Ticks je Seite
  const cheap = newStock({ ipo: 1 }).sec;
  const eb = expectedBand(Cr(1) * MILLI, tk, pct);
  assert.deepEqual(engine.priceBand(engine.books.get(cheap.id)), eb);
  assert.ok(eb.max - Cr(1) >= 2 * tk && Cr(1) - eb.min >= 2 * tk, `Band zu schmal: ${JSON.stringify(eb)}`);
  assert.throws(() => engine.placeOrder(fresh(u), { security_id: cheap.id, side: 'buy', type: 'limit', price: eb.min - tk, amount: 1 }), bandError(1, 15, eb.min / 100, eb.max / 100));
}));

// ---------------------------------------------------------------------------
// Prüfmatrix: Proportionalität, Pfadunabhängigkeit, MM-Anteil
// ---------------------------------------------------------------------------
test('Proportionalität: 1 Stück vs. 100 Stück → Δln F im Verhältnis 1 : 100 (±5 %); je Order exakt F ← round(F · e^(λ·q))', () => fixed(async () => {
  const small = newStock({ ipo: 20 }).sec, big = newStock({ ipo: 200 }).sec;
  const u = await newUser(100_000_000);
  const deltas = async (secId) => {
    assert.equal(engine.impactDepth(secId), 2000);
    const l = lambda(secId);
    const out = [];
    for (const qty of [1, 100]) {
      const F0 = fair(secId);
      const r = engine.placeOrder(fresh(u), market(secId, 'buy', qty));
      assert.equal(r.order.filled, qty);
      near(fair(secId), flowF(F0, l, qty), 1, `${qty} Stück: F`);
      assert.equal(q.secById.get(secId).fair_price, fair(secId));       // F wird bei jeder Änderung persistiert
      out.push(Math.log(fair(secId) / F0));
    }
    return out;
  };
  const [d1, d100] = await deltas(small.id);
  assert.ok(d1 > 0 && Math.abs(d100 / d1 - 100) <= 5, `Verhältnis Δln F: ${d100 / d1}`);
  const [D1, D100] = await deltas(big.id);                              // Skalenfrei: 10-facher Kurs, gleiche Δln F
  near(d1, D1, 1e-6, 'Δln F für 1 Stück bei 20 Cr vs. 200 Cr');
  near(d100, D100, 1e-6, 'Δln F für 100 Stück bei 20 Cr vs. 200 Cr');
}));

test('Pfadunabhängigkeit: 20 × 1 Stück = 1 × 20 Stück; Kauf 500 dann Verkauf 500 führt auf F0 zurück', () => fixed(async () => {
  const a = newStock().sec, b = newStock().sec, c = newStock().sec;
  const ua = await newUser(), ub = await newUser(), uc = await newUser(100_000_000);
  for (let i = 0; i < 20; i++) engine.placeOrder(fresh(ua), market(a.id, 'buy', 1));
  engine.placeOrder(fresh(ub), market(b.id, 'buy', 20));
  near(fair(a.id), fair(b.id), 21, '20 × 1 Stück vs. 1 × 20 Stück (± 1 Mill-Cent je Schritt)');
  const F0 = fair(c.id);
  let prev = F0;
  for (let i = 0; i < 10; i++) {                                        // monoton: jeder Kauf hebt F
    engine.placeOrder(fresh(uc), market(c.id, 'buy', 50));
    assert.ok(fair(c.id) > prev); prev = fair(c.id);
  }
  assert.ok(prev / F0 > 1.09 && prev / F0 < 1.13, `F nach Kauf 500: ${prev / F0}`);   // e^(500·λ) = 1,107
  for (let i = 0; i < 10; i++) {                                        // und jeder Verkauf senkt es
    engine.placeOrder(fresh(uc), market(c.id, 'sell', 50));
    assert.ok(fair(c.id) < prev); prev = fair(c.id);
  }
  near(fair(c.id), F0, 20, 'Kauf 500 dann Verkauf 500 (20 Rundungsschritte)');
}));

test('MM-Anteil: 1000 Recenters ohne Teilnehmer-Order lassen F unverändert; MM-Quotes liegen im Band', () => {
  const rnd = mulberry32(20261126);
  const { sec } = newStock();
  const F0 = fair(sec.id), K0 = engine.books.get(sec.id).last;
  withRnd(rnd, () => {
    for (let i = 0; i < 1000; i++) {
      engine.mmRecenter(engine.books.get(sec.id));
      if (i % 100 === 99) engine.mmRefreshAll();
    }
  });
  assert.equal(fair(sec.id), F0);
  assert.equal(engine.books.get(sec.id).last, K0);
  assert.equal(q.secById.get(sec.id).fair_price, F0);
  const book = engine.books.get(sec.id);
  const band = engine.priceBand(book);
  const quotes = [...mmOpen(book, 'bids'), ...mmOpen(book, 'asks')];
  assert.ok(quotes.length >= 2);
  for (const o of quotes) assert.ok(o.price >= band.min && o.price <= band.max, `MM-Quote ${o.price} außerhalb ${band.min}–${band.max}`);
});

test('Nur Ausführungen gegen MM-Quotes von role=user sind Flow: Treasury und Admin als Käufer der MM-Leiste bewegen F nicht', () => fixed(async () => {
  const { sec } = newStock();
  const F0 = fair(sec.id);
  const admin = await newUser(10_000_000, 'admin');
  const r1 = engine.placeOrder(fresh(admin), market(sec.id, 'buy', 3));           // Admin kauft aus der MM-Leiste
  assert.ok(r1.trades.length >= 1);
  assert.equal(fair(sec.id), F0);
  const player = await newUser();
  engine.mmCancelQuotes(engine.books.get(sec.id));                                // nur noch ein Spieler bietet
  engine.addHoldingPublic(player.id, sec.id, 2, Cr(20));
  engine.placeOrder(fresh(player), { security_id: sec.id, side: 'sell', type: 'limit', price: Cr(20.5), amount: 2 });
  assert.equal(fair(sec.id), F0);                                                 // Order ohne Fills
  const r2 = engine.placeOrder(engine.treasury(), market(sec.id, 'buy', 2));      // Treasury kauft vom Spieler
  assert.equal(r2.trades.reduce((s, t) => s + t.amount, 0), 2);
  assert.equal(fair(sec.id), F0);
  assert.equal(engine.books.get(sec.id).last, publicOf(F0, 10));
}));

// ---------------------------------------------------------------------------
// Flow auch dann, wenn die MM-Quote der Taker ist und ein Teilnehmer der Maker:
// großes liegendes Gebot am Band-Rand, die neue MM-Leiste kreuzt es beim Recenter.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2.2/2.4, Drossel: Der Market Maker beliefert eine liegende Order eines Teilnehmers nur so weit,
// dass der faire Kurs ihren Preis nicht überschreitet (Gebot) bzw. unterschreitet (Angebot).
// ---------------------------------------------------------------------------
// Kreuzend ist nur die Gegenseite: MM-Asks zum Preis ≤ Gebot, MM-Bids zum Preis ≥ Angebot.
const noCrossing = (book, side, price, what) => {
  for (const o of mmOpen(book, side === 'buy' ? 'asks' : 'bids')) {
    assert.ok(side === 'buy' ? o.price > price : o.price < price, `${what}: kreuzende MM-Quote ${o.side} ${o.price} im Buch (Auftrag ${price})`);
  }
};

// Ein großer liegender Auftrag (amount weit über Q_max) zu `priceOf(book)`, danach Recenter,
// bis nichts mehr passiert. Zufallsstaffeln kommen vom umgebenden Math.random.
async function restingRun(depth, side, priceOf, amount, what, restFirst = false) {
  const { sec, book } = newStock({ float: depth, jitter: true });
  const u = await newUser(100_000_000);
  if (side === 'sell') engine.addHoldingPublic(u.id, sec.id, 2000, Cr(20));
  const F0 = fair(sec.id), l = lambda(sec.id);
  const stock0 = treasuryStock(sec.id);
  const price = priceOf(book);
  const order = { security_id: sec.id, side, type: 'limit', price, amount };
  const pv = engine.previewOrder(fresh(u), order);
  if (restFirst) engine.mmCancelQuotes(book);                     // der Auftrag ruht erst einmal: nur die Staatskasse beliefert ihn
  const r = engine.placeOrder(fresh(u), order);
  // eigener Fill als Taker gegen die Staffel (die placeOrder-Rückgabe enthält schon die Kreuzungen des Recenters)
  const initial = fair(sec.id), initialFilled = restFirst ? 0 : pv.matched_qty;
  let last = null;
  for (let i = 1; i <= 10; i++) {
    if (i % 2) engine.mmRecenter(book); else { book.mmNextAt = 0; engine.mmRefreshAll(); }
    noCrossing(book, side, price, `${what}, nach Recenter ${i}`);  // nach jedem Recenter: keine kreuzende MM-Quote im Buch
    if (fair(sec.id) === last) break;
    last = fair(sec.id);
  }
  assert.notEqual(last, null, `${what}: die Recenter kommen nicht zur Ruhe`);
  const F = fair(sec.id);
  const sold = stock0 - treasuryStock(sec.id);                     // > 0: Staatskasse hat verkauft, < 0: gekauft
  assert.equal(orderRow(r.order.id).filled, Math.abs(sold), `${what}: alles Ausgeführte kam über diesen Auftrag`);
  near(F, flowF(F0, l, sold), 3, `${what}: F = F0 · e^(λ · Menge) (pfadunabhängig)`);   // mehrere Durchläufe: je ± 1 Mill-Cent
  return { F0, F, price, initial, initialFilled, sold, id: r.order.id, amount };
}

const DRAWS = 200;
const movedPct = (r) => 100 * (r.F / r.F0 - 1);

test('Drossel (a): großes liegendes Gebot am Band-Maximum, D = 2000 und D = 400, je 200 Ziehungen mit Jitter — F überschreitet den Gebotspreis nie, Gesamtbewegung ≤ 15 % + 1 Tick, nach jedem Recenter keine kreuzende MM-Quote', (t) => withRandom(mulberry32(20261126))(async () => {
  for (const depth of [2000, 400]) {
    let worst = -Infinity, worstCent = -Infinity, leastGap = Infinity, crossed = 0;
    for (let i = 0; i < DRAWS; i++) {
      const r = await restingRun(depth, 'buy', (book) => engine.priceBand(book).max, 2000, `D = ${depth}, Ziehung ${i + 1}`);
      const fc = r.F / MILLI, f0c = r.F0 / MILLI;
      assert.ok(fc <= r.price + 1e-9, `D = ${depth}, Ziehung ${i + 1}: F ${fc} über dem Gebotspreis ${r.price}`);
      assert.ok(fc <= 1.15 * f0c + 10 + 1e-9, `D = ${depth}, Ziehung ${i + 1}: Gesamtbewegung ${movedPct(r).toFixed(2)} % > 15 % + 1 Tick`);
      if (r.sold > r.initialFilled) crossed++;                    // der eigene Fill reicht nicht bis zum Preis: die Staatskasse liefert den Rest
      worst = Math.max(worst, movedPct(r));
      worstCent = Math.max(worstCent, fc - f0c);
      leastGap = Math.min(leastGap, r.price - fc);
    }
    assert.ok(crossed >= 1, `D = ${depth}: in keiner Ziehung beliefert die Staatskasse das Gebot über den eigenen Fill hinaus`);
    t.diagnostic(`Drossel (a) D = ${depth}, Gebot am Band-Maximum, ${DRAWS} Ziehungen mit Jitter: größte Gesamtbewegung von F ${worst.toFixed(3)} % (${worstCent.toFixed(2)} Cent über F0), kleinster Abstand F unter dem Gebotspreis ${leastGap.toFixed(2)} Cent; Ziehungen mit Lieferung über den eigenen Fill hinaus: ${crossed}`);
  }
}));

test('Drossel (b), Spiegelfall: großes liegendes Angebot am Band-Minimum, D = 2000 und D = 400, je 200 Ziehungen mit Jitter — F unterschreitet das Angebot nie, Gesamtbewegung ≥ −15 % − 1 Tick', (t) => withRandom(mulberry32(20261126))(async () => {
  for (const depth of [2000, 400]) {
    let worst = Infinity, leastGap = Infinity, crossed = 0;
    for (let i = 0; i < DRAWS; i++) {
      const r = await restingRun(depth, 'sell', (book) => engine.priceBand(book).min, 2000, `D = ${depth}, Ziehung ${i + 1}`);
      const fc = r.F / MILLI, f0c = r.F0 / MILLI;
      assert.ok(fc >= r.price - 1e-9, `D = ${depth}, Ziehung ${i + 1}: F ${fc} unter dem Angebot ${r.price}`);
      assert.ok(fc >= 0.85 * f0c - 10 - 1e-9, `D = ${depth}, Ziehung ${i + 1}: Gesamtbewegung ${movedPct(r).toFixed(2)} % < −15 % − 1 Tick`);
      if (-r.sold > r.initialFilled) crossed++;
      worst = Math.min(worst, movedPct(r));
      leastGap = Math.min(leastGap, fc - r.price);
    }
    assert.ok(crossed >= 1, `D = ${depth}: in keiner Ziehung kauft die Staatskasse über den eigenen Fill hinaus`);
    t.diagnostic(`Drossel (b) D = ${depth}, Angebot am Band-Minimum, ${DRAWS} Ziehungen mit Jitter: größte Gegenbewegung von F ${worst.toFixed(3)} %, kleinster Abstand F über dem Angebot ${leastGap.toFixed(2)} Cent; Ziehungen mit Einkauf über den eigenen Fill hinaus: ${crossed}`);
  }
}));

test('Drossel (c): Gebot mitten im Band (+5 %) — die Staatskasse beliefert es nur bis zum Gebotspreis; Spiegelfall Angebot bei −5 %', () => withRandom(mulberry32(20261126))(async () => {
  // Der Auftrag ruht, bevor die MM-Leiste liegt: Nur die Staatskasse beliefert ihn — ungedrosselt
  // wäre das die ganze Staffel (435 Stück, F +9 %), gedrosselt nur der Raum bis zum Preis.
  const bid = await restingRun(2000, 'buy', () => Cr(21), 500, 'Gebot +5 %', true);
  assert.ok(bid.F > bid.F0 && bid.sold > 0, 'die Staatskasse beliefert das Gebot');
  assert.ok(bid.F / MILLI <= Cr(21) + 1e-9, `F ${bid.F / MILLI} über dem Gebot ${Cr(21)} (${((bid.F / bid.F0 - 1) * 100).toFixed(2)} %)`);
  assert.equal(orderRow(bid.id).status, 'open');                  // der Rest liegt weiter
  const ask = await restingRun(2000, 'sell', () => Cr(19), 500, 'Angebot −5 %', true);
  assert.ok(ask.F < ask.F0 && ask.sold < 0, 'die Staatskasse kauft aus dem Angebot');
  assert.ok(ask.F / MILLI >= Cr(19) - 1e-9, `F ${ask.F / MILLI} unter dem Angebot ${Cr(19)} (${((ask.F / ask.F0 - 1) * 100).toFixed(2)} %)`);
  assert.equal(orderRow(ask.id).status, 'open');
}));

test('Drossel (d), Normalfall ungedrosselt: ein altes Angebot eines Teilnehmers weit unter F (−10 %) nimmt die Staatskasse vollständig; Spiegelfall altes Gebot bei +10 %', () => withRandom(mulberry32(20261126))(async () => {
  for (const side of ['sell', 'buy']) {
    const { sec, book } = newStock({ jitter: true });             // 20 Cr, D = 2000
    const u = await newUser(100_000_000);
    engine.addHoldingPublic(u.id, sec.id, 100, Cr(20));
    const F0 = fair(sec.id), l = lambda(sec.id);
    // Die MM-Quotes waren aufgehoben (wie bei einer ETF-Creation), der Teilnehmer hat zu dem
    // damaligen Kurs ein Angebot bei 18,00 Cr / ein Gebot bei 22,00 Cr liegen — jetzt ±10 % vom Kurs.
    engine.mmCancelQuotes(book);
    const price = side === 'sell' ? Cr(18) : Cr(22);
    const o = engine.placeOrder(fresh(u), { security_id: sec.id, side, type: 'limit', price, amount: 100 });
    assert.equal(o.trades.length, 0);
    engine.mmRecenter(book);
    assert.equal(orderRow(o.order.id).status, 'filled', `${side}: altes Angebot/Gebot wird vollständig genommen`);
    assert.equal(orderRow(o.order.id).filled, 100);
    near(fair(sec.id), flowF(F0, l, side === 'sell' ? -100 : 100), 3, `${side}: F nach 100 Stück`);
  }
}));

test('Kauf von der Staatskasse und Verkauf an sie bringen F exakt zurück — als Taker oder über eine liegende Order (MM-Quote als Taker)', () => fixed(async () => {
  for (const [buyVia, sellVia] of [['taker', 'liegend'], ['liegend', 'taker']]) {
    const { sec, book } = newStock();
    const u = await newUser(100_000_000);
    const F0 = fair(sec.id);
    const qty = 100;
    const what = `Kauf ${buyVia}, Verkauf ${sellVia}`;
    // Über eine liegende Order: MM-Quotes aufheben, Auftrag am Band-Rand legen; beim Recenter kreuzt ihn die neue Leiste.
    const viaResting = (side) => {
      engine.mmCancelQuotes(book);
      const price = side === 'buy' ? engine.priceBand(book).max : engine.priceBand(book).min;
      const o = engine.placeOrder(fresh(u), { security_id: sec.id, side, type: 'limit', price, amount: qty });
      assert.equal(o.trades.length, 0);
      engine.mmRecenter(book);
      assert.equal(orderRow(o.order.id).filled, qty, `${what}: liegende Order muss in einem Recenter vollständig füllen`);
    };
    const viaTaker = (side) => assert.equal(engine.placeOrder(fresh(u), market(sec.id, side, qty)).order.filled, qty, `${what}: ${side} als Taker`);
    (buyVia === 'taker' ? viaTaker : viaResting)('buy');
    assert.ok(fair(sec.id) > F0);
    (sellVia === 'taker' ? viaTaker : viaResting)('sell');
    near(fair(sec.id), F0, 2, `${what}: F nach Hin- und Rückweg (± 1 Mill-Cent je Schritt)`);
  }
}));

test('cancelOrder ist idempotent: erneutes Stornieren liefert { ok: true } — auch nach dem automatischen Band-Storno; gefüllte Orders bleiben ein Fehler', () => fixed(async () => {
  const { sec, book } = newStock();
  const u = await newUser(10_000_000), mover = await newUser(100_000_000);
  const cash0 = fresh(u).cash;
  const resting = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: book.bids[book.bids.length - 1].price - 10, amount: 5 });
  assert.deepEqual(engine.cancelOrder(fresh(u), resting.order.id), { ok: true });
  assert.equal(fresh(u).cash, cash0);
  assert.deepEqual(engine.cancelOrder(fresh(u), resting.order.id), { ok: true });   // zweites Stornieren
  assert.equal(fresh(u).cash, cash0);                                              // keine doppelte Rückbuchung
  // vom automatischen Band-Storno bereits weggenommen
  const edge = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: ceilTick(Cr(20) * 0.851, 10), amount: 5 });
  engine.placeOrder(fresh(mover), market(sec.id, 'buy', 100));                       // F +2 %: der Auftrag am Band-Rand liegt außerhalb
  assert.equal(orderRow(edge.order.id).status, 'canceled');
  assert.equal(fresh(u).cash, cash0);
  assert.deepEqual(engine.cancelOrder(fresh(u), edge.order.id), { ok: true });
  assert.equal(fresh(u).cash, cash0);                                               // Escrow nur einmal zurück
  // gefüllte Order: weiterhin ein Fehler
  const filled = engine.placeOrder(fresh(mover), market(sec.id, 'buy', 1));
  assert.equal(filled.order.status, 'filled');
  assert.throws(() => engine.cancelOrder(fresh(mover), filled.order.id), /nicht mehr offen/);
}));

// ---------------------------------------------------------------------------
// Prüfmatrix: Bewegungsgrenze (Ordergrößen-Grenze Q_max aus 2.4)
// ---------------------------------------------------------------------------
test('Bewegungsgrenze (a): Markt-Order mit Q_max + 1 Stück wird vor jeder Buchung und vor der Liquiditätsprüfung abgelehnt — Q_max in der Meldung, F unverändert', () => fixed(async () => {
  const { sec } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  assert.equal(Q, 689);                                           // PLAN 2.4: D = 2000 → Q_max = 689
  const taker = await newUser(200_000_000);
  const F0 = fair(sec.id), cash0 = fresh(taker).cash;
  assert.throws(() => engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q + 1)), sizeError(Q, 15));
  assert.throws(() => engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q + 500)), sizeError(Q, 15));
  assert.equal(fresh(taker).cash, cash0);
  assert.equal(orderCount(taker.id), 0);
  assert.equal(fair(sec.id), F0);
  engine.addHoldingPublic(taker.id, sec.id, Q + 1, Cr(20));
  assert.throws(() => engine.placeOrder(fresh(taker), market(sec.id, 'sell', Q + 1)), sizeError(Q, 15));
  assert.equal(engine.holdingOf(taker.id, sec.id), Q + 1);        // keine Aktien ins Escrow
  assert.equal(fair(sec.id), F0);
  // vor der Liquiditätsprüfung: wo nur die Standard-Leiste bietet (435 Stück), kommt ebenfalls die Stückgrenze
  assert.throws(() => engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q + 1)), (e) => sizeError(Q, 15)(e) && !/Liquidit/.test(e.message));
}));

test('Bewegungsgrenze (b): Markt-Order mit genau Q_max füllt vollständig gegen MM-Quotes und bewegt F um höchstens B; Vorschau = Ausführung', () => bigLadder(async () => {
  const { sec, book } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  const taker = await newUser(200_000_000);
  const F0 = fair(sec.id), l = lambda(sec.id), band = engine.priceBand(book);
  const pv = engine.previewOrder(fresh(taker), market(sec.id, 'buy', Q));
  assert.equal(pv.cap, Q);
  assert.equal(pv.available, 700);                                // available bleibt Band-Liquidität
  assert.equal(pv.matched_qty, Q);
  const r = engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q));
  assert.equal(r.order.filled, Q);
  assert.deepEqual(fillList(r.trades, 'amount'), fillList(pv.fills, 'qty'));
  for (const x of r.trades) assert.ok(x.price >= band.min && x.price <= band.max, `Fill ${x.price} außerhalb ${band.min}–${band.max}`);
  assert.ok(fair(sec.id) / F0 - 1 <= 0.15 + 1e-9, `F ist um ${(fair(sec.id) / F0 - 1) * 100} % gestiegen`);
  near(fair(sec.id), flowF(F0, l, Q), 1, 'F nach Q_max');
  const big = engine.previewOrder(fresh(taker), market(sec.id, 'buy', Q + 1));
  assert.equal(big.cap, Q);                                       // die Vorschau zeigt dieselbe Grenze
  assert.ok(big.matched_qty <= Q);
}));

test('Bewegungsgrenze (c): Limit-Order über Q_max füllt sofort höchstens Q_max, der Rest liegt offen', () => bigLadder(async () => {
  const { sec, book } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  const taker = await newUser(200_000_000);
  const F0 = fair(sec.id), l = lambda(sec.id);
  assert.equal(engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q)).order.filled, Q);
  const cash0 = fresh(taker).cash;
  const price = engine.priceBand(book).max;                       // über allem, was im Band liegt
  const order = { security_id: sec.id, side: 'buy', type: 'limit', price, amount: Q + 500 };
  const pv = engine.previewOrder(fresh(taker), order);
  assert.equal(pv.cap, Q);
  assert.equal(pv.matched_qty, Q);
  assert.equal(pv.rest, 500);
  const r = engine.placeOrder(fresh(taker), order);
  assert.equal(r.order.filled, Q);
  assert.equal(r.order.status, 'open');
  assert.deepEqual(fillList(r.trades, 'amount'), fillList(pv.fills, 'qty'));
  const resting = book.bids.find((o) => o.id === r.order.id);
  assert.ok(resting, 'Rest muss im Buch liegen');
  assert.equal(resting.amount - resting.filled, 500);
  const spent = r.trades.reduce((s, x) => s + x.price * x.amount, 0);
  assert.equal(fresh(taker).cash, cash0 - spent - price * 500 - getSettings().fee_cent);   // Escrow Limit × Menge, Differenz je Fill zurück
  near(fair(sec.id), F0 * Math.exp(2 * l * Q), 2, 'F nach zwei Orders à Q_max (Markt, dann Limit)');
}));

test('Bewegungsgrenze (d): zwei Markt-Orders à Q_max hintereinander → F = F0 · e^(2·λ·Q_max)', () => bigLadder(async () => {
  const { sec } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  const taker = await newUser(200_000_000);
  const F0 = fair(sec.id), l = lambda(sec.id);
  for (let i = 1; i <= 2; i++) {
    const r = engine.placeOrder(fresh(taker), market(sec.id, 'buy', Q));
    assert.equal(r.order.filled, Q, `${i}. Order`);
    near(fair(sec.id), F0 * Math.exp(l * Q * i), 2, `F nach ${i} Order(s) à Q_max`);
  }
  assert.equal(fair(sec.id), flowF(flowF(F0, l, Q), l, Q));
}));

test('Bewegungsgrenze, Verkaufsseite: Limit-Verkauf über Q_max füllt sofort höchstens Q_max, Rest offen; Markt-Verkauf darüber abgelehnt', () => bigLadder(async () => {
  const { sec, book } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  const holder = await newUser();
  engine.addHoldingPublic(holder.id, sec.id, Q + 500, Cr(20));
  const F0 = fair(sec.id), l = lambda(sec.id);
  assert.throws(() => engine.placeOrder(fresh(holder), market(sec.id, 'sell', Q + 1)), sizeError(Q, 15));
  const r = engine.placeOrder(fresh(holder), { security_id: sec.id, side: 'sell', type: 'limit', price: engine.priceBand(book).min, amount: Q + 500 });
  assert.equal(r.order.filled, Q);
  assert.equal(r.order.status, 'open');
  const resting = book.asks.find((o) => o.id === r.order.id);
  assert.ok(resting, 'Rest muss im Buch liegen');
  assert.equal(resting.amount - resting.filled, 500);
  assert.equal(engine.holdingOf(holder.id, sec.id), 0);
  assert.ok(fair(sec.id) / F0 - 1 >= -0.15 - 1e-9, `F ist um ${(fair(sec.id) / F0 - 1) * 100} % gefallen`);
  near(fair(sec.id), flowF(F0, l, -Q), 1, 'F nach Q_max Verkauf');
}));

test('Ordergrößen-Grenze folgt dem Streubesitz: D = 400 → 137, D = 1 → 1, mm_impact_pct = 0 → keine', () => fixed(async () => {
  const u = await newUser(100_000_000);
  // D = 400 → Q_max = 137 (PLAN 2.4). Die MM-Stufe hat 200 Stück, damit Q_max füllbar ist.
  await withSettings({ mm_levels: 1, mm_size: 200 }, () => fixed(async () => {
    const { sec } = newStock({ float: 400 });
    assert.throws(() => engine.placeOrder(fresh(u), market(sec.id, 'buy', 138)), sizeError(137, 15));
    const F0 = fair(sec.id);
    const r = engine.placeOrder(fresh(u), market(sec.id, 'buy', 137));
    assert.equal(r.order.filled, 137);
    near(fair(sec.id), flowF(F0, lambdaOf(400, 50), 137), 1, 'F nach Q_max bei D = 400');
  }));
  // Gründer hält alles bis auf 1 Stück: Q_max = mindestens 1
  const { sec: tiny } = newStock({ float: 1, founderShares: 1000, quote: false });
  assert.equal(engine.impactDepth(tiny.id), 1);
  assert.equal(engine.previewOrder(fresh(u), market(tiny.id, 'buy', 5)).cap, 1);
  assert.throws(() => engine.placeOrder(fresh(u), market(tiny.id, 'buy', 2)), sizeError(1, 15));
  // mm_impact_pct = 0: λ = 0 → kein Flow-Impact und keine Stückgrenze
  await withSettings({ mm_impact_pct: 0 }, () => withSettings({ mm_levels: 1, mm_size: 700 }, () => fixed(async () => {
    const { sec: flat } = newStock();
    const F1 = fair(flat.id);
    assert.equal(engine.previewOrder(fresh(u), market(flat.id, 'buy', 10)).cap, null);   // null = keine Grenze (wie bei ETFs)
    assert.equal(engine.placeOrder(fresh(u), market(flat.id, 'buy', 700)).order.filled, 700);
    assert.equal(fair(flat.id), F1);
  })));
}));

test('Treasury, Admin und MM-Quotes haben keine Ordergrößen-Grenze', () => fixed(async () => {
  const u = await newUser(100_000_000);
  const { sec, book } = newStock();
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  assert.ok(Q < 800);
  engine.mmCancelQuotes(book);
  restAsk(u, sec, 800);                                           // ein Spieler bietet 800 Stück: mehr als Q_max
  assert.equal(engine.placeOrder(engine.treasury(), market(sec.id, 'buy', 800)).order.filled, 800);
  restAsk(u, sec, 800);
  assert.equal(engine.placeOrder(fresh(await newUser(10_000_000, 'admin')), market(sec.id, 'buy', 800)).order.filled, 800);
  // MM-Quotes: keine Grenze — eine MM-Stufe darf deutlich über Q_max liegen (Stufe 1000 bei Q_max 689)
  await withSettings({ mm_size: 1000 }, () => fixed(() => {
    const { sec, book } = newStock();
    const Qw = qMaxOf(2000, 50, 15);
    assert.equal(Qw, 689);
    assert.ok(mmOpen(book, 'asks')[0].amount > Qw, `MM-Stufe muss über Q_max = ${Qw} liegen`);
  }));
}));

// ---------------------------------------------------------------------------
// Prüfmatrix: Liquidität, Nachplatzierung, Ask-Seite nie leer
// ---------------------------------------------------------------------------
test('Liquidität: nach jedem Trade volle Staffel je Seite; leeres Buch ist nach einem mmRefreshAll wieder quotiert; Ask-Seite bietet den ganzen Bestand', () => fixed(async () => {
  const { sec } = newStock();
  const book = engine.books.get(sec.id);
  const u = await newUser(100_000_000);
  fullLadder(book, 'nach dem ersten Recenter');
  for (let i = 1; i <= 5; i++) { engine.placeOrder(fresh(u), market(sec.id, 'buy', 37)); fullLadder(book, `nach Kauf ${i}`); }
  for (let i = 1; i <= 5; i++) { engine.placeOrder(fresh(u), market(sec.id, 'sell', 23)); fullLadder(book, `nach Verkauf ${i}`); }
  const depth = engine.sideDepth(book, 'sell');
  assert.equal(engine.placeOrder(fresh(u), market(sec.id, 'buy', depth)).order.filled, depth);
  fullLadder(book, 'nach dem Sweep über die ganze Ask-Seite');
  // Self-Healing (2.6): beide MM-Seiten weg → nach einem mmRefreshAll wieder quotiert.
  // (mmCancelQuotes setzt den Takt auf sofort fällig; ein geleertes Buch mit nicht fälligem Takt stellt der Motor nicht her.)
  engine.mmCancelQuotes(book);
  assert.equal(mmOpen(book, 'bids').length + mmOpen(book, 'asks').length, 0);
  engine.mmRefreshAll();
  fullLadder(book, 'leeres Buch nach einem mmRefreshAll');
  // Verkaufsseite bietet den ganzen Bestand — keine Reserve im Depot. Vier Sweeps lassen der
  // Staatskasse 260 Stück (2000 − 4 · 435): mehr als mm_replenish_min, weniger als die Leiter fasst.
  const drained = newStock();
  for (let i = 0; i < 4; i++) engine.placeOrder(fresh(u), market(drained.sec.id, 'buy', engine.sideDepth(drained.book, 'sell')));
  const left = 2000 - 4 * ladderTotal();
  assert.equal(left, 260);
  assert.equal(treasuryStock(drained.sec.id), left);
  assert.equal(engine.holdingOf(engine.treasury().id, drained.sec.id), 0);   // alles an der Ask-Seite
  assert.equal(askEscrow(drained.book), left);
  // Grenzfall: ein Buch ohne mm_enabled bleibt leer
  const off = newStock({ mmEnabled: 0 }).sec;
  engine.mmRefreshAll();
  assert.equal(orderIds(engine.books.get(off.id)).length, 0);
}));

test('Nachplatzierung: ohne Kursbedingung, max(100, round(D · mm_replenish_pct / 100)) Stück; im Cooldown ohne Wartezeit mm_replenish_min Stück — die Ask-Seite bleibt nie leer', () => {
  const minDefault = getSettings().mm_replenish_min;
  return withSettings({ mm_replenish_min: 0 }, () => fixed(async () => {
    assert.ok(minDefault >= 100);
    const { sec } = newStock({ float: 1500 });                   // D = 1500
    const book = engine.books.get(sec.id);
    const buyer = await newUser(100_000_000), seller = await newUser();
    // Kurs deutlich unter den IPO-Preis drücken — die alte Regel hätte unter 1,15 × IPO nicht nachplatziert
    engine.addHoldingPublic(seller.id, sec.id, 700, Cr(20));
    engine.placeOrder(fresh(seller), market(sec.id, 'sell', 350));
    engine.placeOrder(fresh(seller), market(sec.id, 'sell', 350));
    assert.ok(book.last < Cr(20) * 0.9, `Kurs ${book.last} sollte unter IPO liegen`);
    // Schwelle über den Bestand der Staatskasse (1500 + 700 gekaufte Stück) legen → die nächste Quotierung platziert nach
    const depth0 = engine.impactDepth(sec.id);
    const total0 = q.secById.get(sec.id).total_shares;
    const qty = Math.max(100, Math.round(depth0 * getSettings().mm_replenish_pct / 100));
    assert.equal(qty, 750);                                          // 50 % von 1500
    setSetting('mm_replenish_min', 3000);
    const F0 = fair(sec.id);
    engine.placeOrder(fresh(buyer), market(sec.id, 'buy', 1));      // Trade → Recenter → Nachplatzierung
    assert.equal(q.secById.get(sec.id).total_shares, total0 + qty);
    assert.equal(engine.impactDepth(sec.id), depth0 + qty);
    assert.equal(treasuryStock(sec.id), 1500 + 700 - 1 + qty);      // Depot + Ask-Escrow
    assert.ok(book.last < Cr(20) * 0.9);                            // weiterhin unter IPO: keine Kursbedingung
    near(fair(sec.id), flowF(F0, lambdaOf(depth0, getSettings().mm_impact_pct), 1), 1, 'Nachplatzierung bewegt F nicht');
    fullLadder(book, 'nach der Nachplatzierung');
    // Cooldown läuft (30 Minuten): Verkaufsseite immer vollständig kaufen
    setSetting('mm_replenish_min', minDefault);
    // Nachplatzierungs-News (Art ipo) — Übernahme-News durch den großen Käufer zählen nicht
    const newsCount = () => db.prepare("SELECT COUNT(*) c FROM news WHERE security_id = ? AND kind = 'ipo'").get(sec.id).c;
    const news0 = newsCount();
    let total = total0 + qty, emergency = 0;
    for (let i = 1; i <= 10; i++) {
      const depth = engine.sideDepth(book, 'sell');
      assert.ok(depth > 0, `vor Kauf ${i}: Ask-Seite leer`);
      assert.equal(engine.placeOrder(fresh(buyer), market(sec.id, 'buy', depth)).order.filled, depth);
      const after = q.secById.get(sec.id).total_shares;
      assert.ok(after === total || after === total + minDefault, `Kauf ${i}: Umlauf ${total} → ${after} (im Cooldown höchstens +${minDefault} ohne Wartezeit)`);
      if (after !== total) emergency++;
      total = after;
      // „mindestens mm_replenish_min“ gilt für den Bestand der Staatskasse; im Band kaufbar ist mindestens die unterste Stufe.
      assert.ok(treasuryStock(sec.id) >= minDefault, `nach Kauf ${i}: Bestand der Staatskasse ${treasuryStock(sec.id)} unter ${minDefault}`);
      assert.ok(engine.sideDepth(book, 'sell') >= getSettings().mm_size, `nach Kauf ${i}: nur ${engine.sideDepth(book, 'sell')} statt mindestens ${getSettings().mm_size} Stück kaufbar`);
    }
    assert.equal(total, total0 + qty + emergency * minDefault, 'genau die Not-Nachlegung, keine zweite reguläre Nachplatzierung');
    assert.ok(emergency >= 1, 'der Bestand muss im Lauf leer werden, sonst prüft der Test die Not-Nachlegung nicht');
    assert.equal(newsCount(), news0);                               // Not-Nachlegung ohne News
  }));
});

// ---------------------------------------------------------------------------
// Prüfmatrix: Band im Matching (mit Band-Storno aller Nicht-MM-Orders)
// ---------------------------------------------------------------------------
// ANNAHME: Die Band-Prüfung beim Aufgabe bleibt wie in der Baseline auf Spieler und Bots
// beschränkt — ein Admin-Konto darf deshalb außerhalb des Bands liegen (der Smoke-Test
// „Treasury: limit buy weit unten" verlangt das für die Staatskasse).
async function checkBandSide(takerSide) {
  const { sec } = newStock();                                      // 20 Cr, Leiter 435 je Seite
  const book = engine.books.get(sec.id);
  const ladder = ladderTotal();
  const F0 = fair(sec.id);
  const makerSide = takerSide === 'buy' ? 'sell' : 'buy';
  const admin = await newUser(20_000_000, 'admin'), admin2 = await newUser(100_000_000, 'admin'), taker = await newUser(100_000_000);
  // Auftrag außerhalb des Bands: ±30 % (auch nach einem Flow von rund 9 % noch außerhalb)
  const far = takerSide === 'buy' ? Cr(26) : Cr(14);
  if (makerSide === 'sell') engine.addHoldingPublic(admin.id, sec.id, 500, Cr(20));
  if (takerSide === 'sell') engine.addHoldingPublic(admin2.id, sec.id, 2000, Cr(20));
  const cashAdmin0 = fresh(admin).cash;
  const outside = engine.placeOrder(fresh(admin), { security_id: sec.id, side: makerSide, type: 'limit', price: far, amount: 500 });
  assert.equal(outside.trades.length, 0);
  const band = engine.priceBand(book);
  assert.ok(takerSide === 'buy' ? far > band.max : far < band.min, `Fixture: ${far} muss außerhalb ${band.min}–${band.max} liegen`);
  const what = `Taker ${takerSide}:`;
  // (1) Tiefenprüfung, Walk, Kosten/Erlös und Vorschau zählen nur das Band
  assert.equal(engine.sideDepth(book, makerSide), ladder, `${what} sideDepth`);
  const w = engine.walkBook(book, takerSide, 5000);
  assert.equal(w.qty, ladder, `${what} walkBook`);
  for (const f of w.fills) assert.ok(f.price >= band.min && f.price <= band.max, `${what} Walk-Fill ${f.price} außerhalb des Bands`);
  const wrap = takerSide === 'buy' ? engine.costToBuy(sec.id, ladder + 500) : engine.proceedsToSell(sec.id, ladder + 500);
  assert.equal(wrap.shortfall, 500, `${what} Fehlmenge`);
  assert.equal(wrap.fills.reduce((s, f) => s + f.qty, 0), ladder, `${what} Kosten/Erlös`);
  const pv = engine.previewOrder(fresh(taker), market(sec.id, takerSide, ladder));
  assert.equal(pv.available, ladder, `${what} Vorschau available`);
  assert.equal(pv.matched_qty, ladder, `${what} Vorschau matched_qty`);
  // Für jeden Taker — auch ohne Band-Prüfung beim Aufgabe: die Treasury handelt weder mit sich selbst noch außerhalb des Bands;
  // ein Admin füllt mit einer Order über der MM-Staffel genau die Band-Liquidität, ohne einen Fill außerhalb
  assert.equal(engine.placeOrder(engine.treasury(), market(sec.id, takerSide, 10)).trades.length, 0, `${what} Treasury als Taker`);
  const big = engine.placeOrder(fresh(admin2), market(sec.id, takerSide, ladder + 500));
  assert.equal(big.order.filled, ladder, `${what} Order größer als die MM-Staffel`);
  for (const x of big.trades) assert.ok(x.price >= band.min && x.price <= band.max, `${what} Fill ${x.price} außerhalb des Bands`);
  assert.equal(orderRow(outside.order.id).status, 'open');         // noch kein Flow: der Auftrag liegt noch
  assert.equal(fair(sec.id), F0);
  // Ausführung = Vorschau; der Spieler-Trade ist Flow
  if (takerSide === 'sell') engine.addHoldingPublic(taker.id, sec.id, ladder, Cr(20));
  const r = engine.placeOrder(fresh(taker), market(sec.id, takerSide, ladder));
  assert.equal(r.order.filled, ladder);
  assert.deepEqual(fillList(r.trades, 'amount'), fillList(pv.fills, 'qty'), `${what} Vorschau = Ausführung`);
  assert.notEqual(fair(sec.id), F0);
  // (2) Direkt nach dem Trade ist der Auftrag außerhalb des Bands automatisch storniert
  assert.equal(orderRow(outside.order.id).status, 'canceled', `${what} Auftrag außerhalb des Bands`);
  assert.equal(inBook(book, outside.order.id), false);
  if (makerSide === 'sell') assert.equal(engine.holdingOf(admin.id, sec.id), 500, `${what} Aktien zurück im Depot`);
  else assert.equal(fresh(admin).cash, cashAdmin0, `${what} Escrow zurück`);
  assert.throws(() => engine.placeOrder(fresh(taker), market(sec.id, takerSide, ladder + 1)), /Nicht genug Liquidität/, `${what} nur Band-Liquidität`);
}

test('Band im Matching (Kauf): Order über die Staffel hinaus füllt nur innerhalb ±15 %, Vorschau = Ausführung; Angebot außerhalb des Bands wird nach dem Trade storniert', () => fixed(() => checkBandSide('buy')));
test('Band im Matching (Verkauf): Order über die Staffel hinaus füllt nur innerhalb ±15 %, Vorschau = Ausführung; Gebot außerhalb des Bands wird nach dem Trade storniert', () => fixed(() => checkBandSide('sell')));

// ---------------------------------------------------------------------------
// Prüfmatrix: Determinismus
// ---------------------------------------------------------------------------
test('Determinismus: 2000 Orders à ±1…10 Stück mit festem Seed — Standardabweichung von Δln F je Order = λ · σ_q (±25 %)', () => withSettings({ mm_levels: 2 }, () => fixed(async () => {
  const { sec } = newStock({ float: 20_000 });                   // genug Bestand für alle Käufe
  const traders = [];
  for (let i = 0; i < 20; i++) {
    const u = await newUser(100_000_000);
    engine.addHoldingPublic(u.id, sec.id, 2000, Cr(20));         // genug Stück für alle Verkäufe
    traders.push(u);
  }
  const l = lambda(sec.id);
  const rnd = mulberry32(20261126);
  const qs = [], deltas = [];
  for (let i = 0; i < 2000; i++) {
    const qty = (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 10));   // ±1…10 Stück
    const F0 = fair(sec.id);
    const r = engine.placeOrder(fresh(traders[i % traders.length]), market(sec.id, qty > 0 ? 'buy' : 'sell', Math.abs(qty)));
    assert.equal(r.order.filled, Math.abs(qty), `Order ${i} muss vollständig füllen`);
    const d = Math.log(fair(sec.id) / F0);
    near(d, l * qty, 1e-6, `Order ${i}: Δln F`);                 // je Order genau λ · q — Monotonie inklusive
    qs.push(qty); deltas.push(d);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
  const ratio = sd(deltas) / (l * sd(qs));
  assert.ok(Math.abs(ratio - 1) <= 0.25, `σ(Δln F) / (λ · σ_q) = ${ratio}`);
  // Symmetrie in log: Kaufen und Verkaufen heben sich auf — kein Drift über 2000 Orders
  assert.ok(Math.abs(mean(deltas)) <= 4 * l * sd(qs) / Math.sqrt(2000), `mittleres Δln F: ${mean(deltas)}`);
})));

// ---------------------------------------------------------------------------
// Prüfmatrix: Kein risikofreier Round-Trip
// ---------------------------------------------------------------------------
// Ein Lauf: die ganze Ask-Staffel per Markt-Order kaufen (höchstens Q_max Stück), dieselbe
// Menge sofort per Markt-Order(n) in die neue Geld-Seite zurück. Kriterien je Tiefe:
// nach zwei Gebühren in keinem Lauf positiv (auch Läufe mit drei Orders: nur zwei Gebühren
// angerechnet), vor Gebühren im Mittel negativ. Zufallszustand: alle Jitter an.
async function roundTrips(depth, runs, fee) {
  const { sec, book } = newStock({ float: depth });
  const u = await newUser(100_000_000_000);                         // 1000 Mio. Cr: 4000 verlustbringende Läufe kosten bis rund 1 Mio. Cr
  const Q = qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct);
  assert.equal(engine.impactDepth(sec.id), depth);
  const F0 = fair(sec.id);
  let resultSum = 0, costSum = 0, qtySum = 0;
  // bester (wenigster) Verlust ohne Gebühren, getrennt nach Läufen mit einer und mit mehreren Orders
  const group = { one: { best: -Infinity, n: 0 }, many: { best: -Infinity, n: 0 } };
  for (let i = 0; i < runs; i++) {
    const qty = Math.min(engine.sideDepth(book, 'sell'), Q);        // die ganze Ask-Staffel; bei kleiner Tiefe kann sie mit Jitter über Q_max liegen
    assert.ok(qty > 0, `D = ${depth}, Lauf ${i}: keine Ask-Seite`);
    const Fstart = fair(sec.id);
    const cash0 = fresh(u).cash;
    const buy = engine.placeOrder(fresh(u), market(sec.id, 'buy', qty));
    assert.equal(buy.order.filled, qty);
    const cost = buy.trades.reduce((s, x) => s + x.price * x.amount, 0);
    // Ist die neue Geld-Seite flacher als die gekaufte Menge, geht der Rest mit einer weiteren
    // Markt-Order sofort in die nächste, tiefer zentrierte Geld-Seite.
    let held = qty, proceeds = 0, orders = 1;
    for (let k = 0; held > 0; k++) {
      assert.ok(k < 5, `D = ${depth}, Lauf ${i}: Rückverkauf kommt nicht durch`);
      const d = Math.min(held, engine.sideDepth(book, 'buy'), Q);
      assert.ok(d > 0, `D = ${depth}, Lauf ${i}: keine Geld-Seite`);
      const sell = engine.placeOrder(fresh(u), market(sec.id, 'sell', d));
      assert.equal(sell.order.filled, d);
      proceeds += sell.trades.reduce((s, x) => s + x.price * x.amount, 0);
      held -= d;
      orders++;
    }
    const cash1 = fresh(u).cash;
    assert.equal(cash1, cash0 - cost + proceeds - fee * orders);      // Gebühr je ausgeführter Order
    const result = proceeds - cost;                                  // > 0 wäre ein Gewinn ohne Gebühren
    assert.ok(result - 2 * fee <= 0, `D = ${depth}, Lauf ${i} (${orders} Orders): nach zwei Gebühren ${result - 2 * fee} Cent Gewinn`);
    assert.ok(result <= qty * 10, `D = ${depth}, Lauf ${i}: ohne Gebühren ${result} Cent Gewinn (Toleranz Q × 1 Tick = ${qty * 10})`);
    // Pfadunabhängigkeit: Hin- und Rückweg heben sich auf; jeder Rundungsschritt (Order gegen die
    // Staatskasse) darf ± 1 Mill-Cent lassen.
    near(fair(sec.id), Fstart, orders, `D = ${depth}, Lauf ${i}: F nach Hin- und Rückkauf (${orders} Rundungsschritte)`);
    const g = orders === 2 ? group.one : group.many;
    g.best = Math.max(g.best, result / cost);
    g.n++;
    resultSum += result; costSum += cost; qtySum += qty;
  }
  assert.ok(resultSum < 0, `D = ${depth}: mittlerer Round-Trip ohne Gebühren ${resultSum / runs} Cent`);
  assert.ok(fresh(u).cash > 90_000_000_000, 'der Testspieler muss weit über der Gebühr liegen — sonst würde die Gebühr geklemmt und die Prüfe weicher');
  return { runs, qty: qtySum / runs, meanPct: 100 * resultSum / costSum, group, drift: fair(sec.id) - F0 };
}
// Läufe je Tiefe. 4000 je Tiefe laufen ebenfalls grün, kosten aber rund 3 Minuten: Ein Lauf
// sind 2–3 Orders mit je einer Transaktion und einer Neubelegung der Staffel (rund 1,4 ms
// je Order, 0,65 ms je Recenter), dazu wächst die 24-h-Volumenabfrage des Tickers mit der
// Zahl der Trades des Werts. 500 je Tiefe halten die Datei unter 60 Sekunden.
const RUNS = 500;

const DEPTHS = [200, 400, 1000, 2000];
const pctOrDash = (g) => (g.n ? `${(100 * g.best).toFixed(2)} % (${g.n} Läufe)` : '– (0 Läufe)');
const roundTripReport = (t, label, r, depth) => t.diagnostic(
  `Round-Trip ${label}, D = ${depth}: ${r.runs} Läufe, Ø ${r.qty.toFixed(0)} Stück, Ergebnis ohne Gebühren im Mittel ${r.meanPct.toFixed(2)} % des Umsatzes; `
  + `bester (wenigster) Verlust vor Gebühren mit einer Order ${pctOrDash(r.group.one)}, mit mehreren Orders ${pctOrDash(r.group.many)}; Abweichung F am Ende ${r.drift} Mill-Cent`);

test('Kein risikofreier Round-Trip über die Engine: volle Ask-Staffel kaufen und sofort zurückverkaufen — nach zwei Gebühren nie positiv, vor Gebühren im Mittel negativ (500 Zufallsstaffeln je Tiefe D = 200/400/1000/2000)', (t) => withRandom(mulberry32(20261126))(async () => {
  const fee = getSettings().fee_cent;
  for (const depth of DEPTHS) {
    const r = await roundTrips(depth, RUNS, fee);
    assert.ok(r.group.many.n > 0, `D = ${depth}: der Fall „Geld-Seite flacher als die gekaufte Menge, Rest per zweiter Markt-Order" muss vorkommen`);
    roundTripReport(t, 'volles Jitter', r, depth);
  }
}));

test('Round-Trip mit zwei Rundungsschritten je Lauf (Größen-Jitter aus): F steht am Ende exakt wieder auf F0', (t) => withRandom(mulberry32(20261126))(async () => {
  const fee = getSettings().fee_cent;
  // Ohne Größen-Jitter haben Geld- und Brief-Seite dieselben Stufen: der Rückverkauf passt in eine Order,
  // jeder Lauf hat genau zwei Rundungsschritte — F kehrt je Lauf exakt zurück.
  await withSettings({ mm_size_jitter: 0 }, async () => {
    for (const depth of DEPTHS) {
      const r = await roundTrips(depth, RUNS, fee);
      assert.equal(r.group.many.n, 0, `D = ${depth}: Rückverkauf muss in eine Markt-Order passen`);
      near(r.drift, 0, 2, `D = ${depth}: F am Ende`);
      roundTripReport(t, 'zwei Schritte', r, depth);
    }
  });
}));

// ---------------------------------------------------------------------------
// V2: price_history; Prüfmatrix: Neustart und Migration
// ---------------------------------------------------------------------------
test('price_history: genau ein Punkt je Order mit Fills — (Wert, Zeitpunkt, K, Orderfüllmenge) statt je Fill', () => fixed(async () => {
  const { sec } = newStock();
  const u = await newUser();
  const rows = () => db.prepare('SELECT price, amount FROM price_history WHERE security_id = ? ORDER BY rowid').all(sec.id);
  assert.equal(rows().length, 0);
  const t0 = Date.now();
  const r = engine.placeOrder(fresh(u), market(sec.id, 'buy', 100));      // über mehrere Stufen der Leiste
  assert.ok(r.trades.length >= 2, 'Fixture: Order muss mehrere Fills haben');
  const K = engine.books.get(sec.id).last;
  assert.deepEqual(rows(), [{ price: K, amount: 100 }]);
  assert.equal(K, publicOf(fair(sec.id), 10));                             // K ist der faire Kurs auf Tick …
  assert.ok(r.trades.some((x) => x.price !== K), '… nicht der Fill-Preis');   // … und kein Fill-Preis der Leiste
  const ts = db.prepare('SELECT ts FROM price_history WHERE security_id = ?').get(sec.id).ts;
  assert.ok(ts >= t0 - 1000 && ts <= Date.now() + 1000);
  const book = engine.books.get(sec.id);
  engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: book.bids[book.bids.length - 1].price - 10, amount: 5 });
  assert.equal(rows().length, 1);                                         // Order ohne Fills: kein Punkt
}));

test('Neustart: loadEngine() übernimmt F exakt, K und Band bleiben; ohne Initialisierung wird keine Order storniert', () => fixed(async () => {
  const { sec } = newStock();
  const u = await newUser(100_000_000);
  engine.placeOrder(fresh(u), market(sec.id, 'buy', 37));
  engine.placeOrder(fresh(u), market(sec.id, 'sell', 12));
  const book = engine.books.get(sec.id);
  const resting = engine.placeOrder(fresh(u), { security_id: sec.id, side: 'buy', type: 'limit', price: book.bids[book.bids.length - 1].price - 10, amount: 5 });
  const stale = insertOpen(sec.id, u.id, 'buy', 10, 1);            // alte Zeile weit außerhalb des Bands; F ist überall gesetzt
  const stocks = () => db.prepare("SELECT id FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all().map((r) => r.id);
  const state = () => stocks().map((id) => [id, fair(id), engine.books.get(id).last]);
  const before = state();
  const band = engine.priceBand(book);
  engine.loadEngine();
  assert.deepEqual(state(), before);
  for (const [id, F] of before) assert.equal(q.secById.get(id).fair_price, F);
  const after = engine.books.get(sec.id);
  assert.deepEqual(engine.priceBand(after), band);
  assert.ok(inBook(after, resting.order.id));
  assert.equal(orderRow(stale).status, 'open');                     // Storno nur bei Initialisierung oder nach Flow
  // F wandert danach lückenlos weiter
  const F = fair(sec.id), l = lambda(sec.id);
  engine.placeOrder(fresh(u), market(sec.id, 'buy', 1));
  near(fair(sec.id), flowF(F, l, 1), 1, 'F nach dem Neustart');
  assert.equal(orderRow(stale).status, 'canceled');                // mit dem ersten Flow ist die Altzeile weg
}));

test('Migration (DB von vor V3): Startkurs = Median der letzten 25 Trades (gerade Anzahl: Mittel der beiden mittleren), sonst IPO; Aufträge außerhalb des Bands und alte Staatskassen-Orders storniert, voll erstattet', () => fixed(async () => {
  const a = newStock({ quote: false }).sec, b = newStock({ quote: false }).sec, c = newStock({ quote: false }).sec;
  const u0 = await newUser(), u1 = await newUser();
  const ins = db.prepare('INSERT INTO trades(security_id, price, amount, buyer_id, seller_id, created_at) VALUES(?,?,?,?,?,?)');
  const trade = (secId, price) => ins.run(secId, price, 1, u0.id, u1.id, Date.now());
  // (a) 24 Trades in gemischter Reihenfolge: 11 × 20,00, 1 × 20,60, 11 × 21,00 und ein absurder Fill (999,90 Cr)
  //     → Median = Mittel der beiden mittleren = (20,60 + 21,00) / 2 = 20,80 Cr; der Ausreißer zieht nicht
  const rnd = mulberry32(7);
  const last = [...Array(11).fill(Cr(20)), Cr(20.6), ...Array(11).fill(Cr(21)), Cr(999.9)];
  for (let i = last.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [last[i], last[j]] = [last[j], last[i]]; }
  for (const p of last) trade(a.id, p);
  // (b) sieben Trades → Median 21,00 Cr; (c) kein Trade → IPO-Preis
  for (const p of [Cr(15), Cr(21), Cr(18), Cr(24), Cr(12), Cr(30), Cr(27)]) trade(b.id, p);
  // Offene Orders wie in einer alten DB
  const p = await newUser(), p2 = await newUser(), t = engine.treasury();
  const outBuy = insertOpen(a.id, p.id, 'buy', Cr(50), 10);        // über dem Band; Escrow 500 Cr war abgezogen
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(50) * 10, p.id);
  const outSell = insertOpen(a.id, p.id, 'sell', Cr(1), 4, 2);     // unter dem Band; Restmenge 2 war im Escrow
  const inBand = insertOpen(a.id, p2.id, 'buy', Cr(20.8), 5);      // im Band: bleibt
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(20.8) * 5, p2.id);
  const legacy = insertOpen(a.id, t.id, 'buy', Cr(1), 3);          // alte AP-Order der Staatskasse (is_mm = 0), weit unter dem Band
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(1) * 3, t.id);
  const cashP = fresh(p).cash, cashP2 = fresh(p2).cash, cashT = fresh(t).cash;
  assert.equal(engine.holdingOf(p.id, a.id), 0);
  db.prepare('UPDATE securities SET fair_price = NULL').run();     // keine Spaltenwerte, wie vor V3
  engine.loadEngine();
  for (const [secId, median] of [[a.id, Cr(20.8)], [b.id, Cr(21)], [c.id, Cr(20)]]) {
    assert.equal(fair(secId), median * MILLI);
    assert.equal(q.secById.get(secId).fair_price, median * MILLI, 'Startkurs wird zurückgeschrieben');
    assert.equal(engine.books.get(secId).last, median);
  }
  // Außerhalb des Bands: storniert mit voller Rückbuchung (nach Neustart: avg_cost-Fallback auf den Orderpreis)
  assert.equal(orderRow(outBuy).status, 'canceled');
  assert.equal(fresh(p).cash, cashP + Cr(50) * 10);
  assert.equal(orderRow(outSell).status, 'canceled');
  assert.equal(engine.holdingOf(p.id, a.id), 2);                   // Restmenge (4 − 2 gefüllt)
  assert.equal(q.holding.get(p.id, a.id).avg_cost, Cr(1));
  // Alte Staatskassen-Order: storniert, Escrow zurück
  assert.equal(orderRow(legacy).status, 'canceled');
  assert.equal(fresh(t).cash, cashT + Cr(1) * 3);
  // Im Band: bleibt offen und liegt weiter im Buch
  assert.equal(orderRow(inBand).status, 'open');
  assert.equal(fresh(p2).cash, cashP2);
  const bookA = engine.books.get(a.id);
  assert.deepEqual(orderIds(bookA), [inBand]);
}));

// ---------------------------------------------------------------------------
// T5, Vertrag V4: Streubesitz — genug Angebot für eine große Order eines Schülers
// (Spiel-Default: Leiste bis mm_min_ask_shares, Streubesitz-Regeln über mm_min_depth)
// ---------------------------------------------------------------------------
// Die Werte, mit denen das Spiel startet (aus den Defaults, nicht hier abgetippt).
const SPIEL = { mm_min_ask_shares: DEFAULT_SETTINGS.mm_min_ask_shares, mm_min_depth: DEFAULT_SETTINGS.mm_min_depth };
const spiel = (fn) => withSettings(SPIEL, fn);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const askSizes = (book) => mmOpen(book, 'asks').map((o) => o.amount - o.filled);
const totalShares = (sec) => q.secById.get(sec.id).total_shares;
const ipoNews = (secId) => db.prepare("SELECT COUNT(*) c FROM news WHERE security_id = ? AND kind = 'ipo'").get(secId).c;
// Größte Menge, die ein frischer Schüler mit `cash` Cent in EINER Markt-Order kaufen kann
// (wie berichte/vorher/kaufbarkeit-messung.js: Ordergrenze, Angebot und Geld).
function groessterKauf(user, secId, cash) {
  const book = engine.books.get(secId);
  const cap = engine.previewOrder(user, market(secId, 'buy', 1)).cap ?? Infinity;
  let best = 0, gross = 0;
  for (let a = 1; a <= Math.min(cap, engine.sideDepth(book, 'sell')); a++) {
    const g = engine.walkBook(book, 'buy', a, { maxQty: cap }).gross;
    if (g + getSettings().fee_cent > cash) break;
    best = a; gross = g;
  }
  return { qty: best, gross };
}

test('Streubesitz (V4): mit Spiel-Default hält die Angebotsseite je Wert mindestens 700 Stück, alle Stufen im Band, F steht still — über 100 Jitter-Ziehungen', (t) => withRandom(mulberry32(20261127))(async () => {
  assert.ok(SPIEL.mm_min_ask_shares >= 700 && SPIEL.mm_min_depth >= 2000, `Spiel-Default: ${JSON.stringify(SPIEL)}`);
  let kleinstes = Infinity;
  for (const ipo of [51.5, 35.8, 20.6, 15.2]) {
    const { sec, book } = newStock({ ipo, float: 2000, founderShares: 1000, quote: false });
    await spiel(async () => {
      engine.mmRecenter(book);
      const F0 = fair(sec.id);
      for (let i = 0; i < 100; i++) {
        if (i % 2) engine.mmRecenter(book); else { book.mmNextAt = 0; engine.mmRefreshAll(); }
        const sizes = askSizes(book), b = engine.priceBand(book);
        const angebot = sum(sizes);
        kleinstes = Math.min(kleinstes, angebot);
        assert.ok(angebot >= 700, `${sec.ticker}, Ziehung ${i + 1}: nur ${angebot} Stück im Buch`);
        assert.ok(sizes.length > getSettings().mm_levels, `${sec.ticker}: keine Anschluss-Stufen (${sizes.length})`);
        for (const o of mmOpen(book, 'asks')) assert.ok(o.price >= b.min && o.price <= b.max, `${sec.ticker}: Ask ${o.price} außerhalb ${b.min}–${b.max}`);
        for (const o of mmOpen(book, 'bids')) assert.ok(o.price >= b.min && o.price <= b.max, `${sec.ticker}: Bid ${o.price} außerhalb ${b.min}–${b.max}`);
        assert.ok(book.bids[0].price < book.asks[0].price, `${sec.ticker}: Buch kreuzt`);
        assert.equal(fair(sec.id), F0, `${sec.ticker}, Ziehung ${i + 1}: F hat sich ohne Orderflow bewegt`);
      }
      // Der Streubesitz ist so weit gewachsen, bis das Band das Ziel fasst (bei Ziel 700: gar nicht); nichts ist verloren
      const wachstum = engine.impactDepth(sec.id) - 2000;
      assert.ok(wachstum >= 0 && totalShares(sec) === 3000 + wachstum, `${sec.ticker}: Umlauf ${totalShares(sec)}, Streubesitz ${engine.impactDepth(sec.id)}`);
      assert.equal(treasuryStock(sec.id), 2000 + wachstum);
      // Die Struktur-Auffüllung ist keine News: keine ipo-Zeile, sonst gälte die Aktie als „neu an der Börse"
      assert.equal(ipoNews(sec.id), 0, `${sec.ticker}: Struktur-Auffüllung hat eine News erzeugt`);
      assert.equal(engine.holdingOf(book.sec.founder_id, sec.id), 1000); // Gründeraktien bleiben unangetastet
      t.diagnostic(`${sec.ticker} (${ipo.toFixed(2)} Cr): Streubesitz ${engine.impactDepth(sec.id)}, kleinste Angebotsseite ${sum(askSizes(book))} Stück, Ordergrenze ${qMaxOf(engine.impactDepth(sec.id), getSettings().mm_impact_pct, getSettings().limit_band_pct)}`);
    });
  }
  assert.ok(Number.isFinite(kleinstes));
}));

// ANNAHME zur Zielzahl „kleinste kaufbare Menge ≥ 525“: Sie ist eine Angebotszahl. Bei Kursen über
// rund 19 Cr begrenzt das Startkapital (10 000 Cr) die Menge zuerst (MENSA 51,50 Cr → rund 190 Stück) —
// das ist kein Streubesitz-Problem. Geprüft wird deshalb: das Angebot ist nie der Engpass (≥ 525 Stück
// liegen im Buch, 500 Stück füllen in einer Order) und das Geld wird zu ≥ 95 % umgesetzt.
test('Streubesitz (V4): Schüler mit 10 000 Cr — Angebot ist nie der Engpass (≥ 525 Stück im Buch), Kaufkraft ≥ 95 %, 500 Stück in EINER Order, Kurs bewegt sich, aber um weniger als 15 %', () => fixed(async () => {
  const CASH = 1_000_000; // 10 000 Credits
  await spiel(async () => {
    let kaufkraft = Infinity, billig = 0;
    for (const ipo of [51.5, 35.8, 20.6, 15.2]) {
      const { sec, book } = newStock({ ipo, float: 2000, founderShares: 1000, quote: false });
      engine.mmRecenter(book);
      const u = await newUser(CASH), kaufen500 = await newUser(100_000_000); // der Schüler und ein vermögender Käufer für die 500 Stück
      const { qty, gross } = groessterKauf(fresh(u), sec.id, CASH);
      if (ipo === 15.2) billig = qty;
      kaufkraft = Math.min(kaufkraft, gross / (CASH - getSettings().fee_cent));
      assert.ok(engine.sideDepth(book, 'sell') >= 525, `${sec.ticker}: nur ${engine.sideDepth(book, 'sell')} Stück im Buch`);
      assert.ok(qty < engine.sideDepth(book, 'sell'), `${sec.ticker}: ${qty} von ${engine.sideDepth(book, 'sell')} — das Angebot müsste der Engpass sein`);
      assert.ok(engine.previewOrder(fresh(u), market(sec.id, 'buy', 500)).matched_qty === 500, `${sec.ticker}: 500 Stück nicht in einer Order`);
      // Der Kauf: 500 Stück vollständig, F steigt spürbar (Impact bleibt), deutlich unter dem Band
      const F0 = fair(sec.id), K0 = book.last, l = lambda(sec.id);
      const r = engine.placeOrder(fresh(kaufen500), market(sec.id, 'buy', 500));
      assert.equal(r.order.filled, 500);
      const bewegung = fair(sec.id) / F0 - 1;
      assert.ok(bewegung > 0.02 && bewegung < 0.15, `${sec.ticker}: 500 Stück bewegen den Kurs um ${(bewegung * 100).toFixed(2)} %`);
      near(fair(sec.id), flowF(F0, l, 500), 1, `${sec.ticker}: F = F0 · e^(λ·500)`);
      assert.equal(engine.holdingOf(kaufen500.id, sec.id), 500);
      assert.equal(fresh(kaufen500).cash, 100_000_000 - r.trades.reduce((s, x) => s + x.price * x.amount, 0) - getSettings().fee_cent);
      // Nach der Order ist wieder Angebot da: innerhalb von zwei Recentern ≥ 700 Stück, ohne dass die Staatskasse nachplatzieren muss
      const total0 = totalShares(sec);
      for (let i = 0; i < 2 && sum(askSizes(book)) < 700; i++) engine.mmRecenter(book);
      assert.ok(sum(askSizes(book)) >= 700, `${sec.ticker}: nach dem Kauf nur ${sum(askSizes(book))} Stück im Buch`);
      assert.equal(totalShares(sec), total0, `${sec.ticker}: Nachplatzierung, obwohl ${treasuryStock(sec.id)} Stück bei der Staatskasse liegen`);
      // K bleibt der auf Tick gerundete F — kein Fill muss den Kurs „kleben" lassen
      assert.equal(book.last, publicOf(fair(sec.id), 10));
      assert.notEqual(book.last, K0);
      // Die Ordergrenze folgt dem Streubesitz; 500 Stück sind weit darunter
      assert.ok(engine.previewOrder(fresh(kaufen500), market(sec.id, 'buy', 1)).cap >= 525);
      // der Schüler mit 10 000 Cr: 500 Stück passen nur, wenn das Geld reicht — sonst ist Geld der Engpass, nie das Angebot
      const pv = engine.previewOrder(fresh(u), market(sec.id, 'buy', 500));
      assert.ok(pv.matched_qty === 500, `${sec.ticker}: nur ${pv.matched_qty} von 500 Stück im Buch`);
    }
    assert.ok(kaufkraft >= 0.95, `Kaufkraft ${(kaufkraft * 100).toFixed(1)} %`);
    assert.ok(billig >= 525, `bei 15,20 Cr sind nur ${billig} Stück kaufbar (Vorher: 434)`);
  });
}));

test('Streubesitz (V4): Ordergrenze — über der Grenze abgelehnt wie bisher, genau an der Grenze vollständig; Band ±15 % wird von F nie überschritten', () => fixed(async () => {
  await spiel(async () => {
    const { sec, book } = newStock({ ipo: 15.2, float: 2000, founderShares: 1000, quote: false });
    engine.mmRecenter(book);
    const u = await newUser(100_000_000);
    const D = engine.impactDepth(sec.id);
    const Q = qMaxOf(D, getSettings().mm_impact_pct, getSettings().limit_band_pct);
    assert.ok(Q >= 525, `Ordergrenze ${Q}`);
    assert.equal(engine.previewOrder(fresh(u), market(sec.id, 'buy', 1)).cap, Q);
    assert.throws(() => engine.placeOrder(fresh(u), market(sec.id, 'buy', Q + 1)), sizeError(Q, 15));
    // Die Leiste hält genug für Q: eine Order an der Grenze füllt komplett und drückt F nie ans Band
    engine.mmCancelQuotes(book);
    await withSettings({ mm_levels: 1, mm_size: Q }, () => fixed(async () => engine.mmRecenter(book)));
    const F0 = fair(sec.id);
    const r = engine.placeOrder(fresh(u), market(sec.id, 'buy', Q));
    assert.equal(r.order.filled, Q);
    assert.ok(fair(sec.id) / F0 - 1 < 0.15, `F um ${((fair(sec.id) / F0 - 1) * 100).toFixed(2)} % gestiegen`);
    const b = engine.priceBand(engine.books.get(sec.id));
    assert.ok(engine.books.get(sec.id).last <= b.max);
  });
}));

test('Streubesitz (V4): kleine IPO wird handelbar — Depot 200, D = 200: nach dem Recenter D ≥ mm_min_depth, Ordergrenze ≥ 525', () => fixed(async () => {
  await withSettings({ mm_min_ask_shares: 0, mm_min_depth: 2000 }, async () => {
    const { sec, book } = newStock({ float: 200, founderShares: 800, quote: false });
    assert.equal(engine.impactDepth(sec.id), 200);
    const u = await newUser();
    assert.equal(engine.previewOrder(fresh(u), market(sec.id, 'buy', 1)).cap, 68);
    engine.mmRecenter(book);
    assert.ok(engine.impactDepth(sec.id) >= 2000, `D = ${engine.impactDepth(sec.id)}`);
    assert.ok(engine.previewOrder(fresh(u), market(sec.id, 'buy', 1)).cap >= 525);
    // die neuen Stücke liegen komplett bei der Staatskasse, der Gründer behält seine 800
    const zuwachs = engine.impactDepth(sec.id) - 200;
    assert.equal(treasuryStock(sec.id), 200 + zuwachs);
    assert.equal(engine.holdingOf(sec.founder_id, sec.id), 800);
    assert.equal(totalShares(sec), 1000 + zuwachs);
    assert.equal(ipoNews(sec.id), 0); // ohne News
    // ein zweiter Recenter platziert nicht noch einmal
    const D = engine.impactDepth(sec.id);
    engine.mmRecenter(book);
    assert.equal(engine.impactDepth(sec.id), D);
  });
}));

test('Streubesitz (V4): Nachplatzierungsschwelle = max(mm_replenish_min, 25 % von D) — nach Kauf von 500 Stück nicht erreicht; danach 50 % von D mit News, im Cooldown Auffüllung bis zur Schwelle des gewachsenen Streubesitzes ohne News', () => fixed(async () => {
  await withSettings({ mm_min_ask_shares: 0, mm_min_depth: 2000 }, async () => {
    const { sec, book } = newStock({ float: 2000, quote: false });
    const u = await newUser(100_000_000);
    const schwelle = () => Math.max(getSettings().mm_replenish_min, Math.floor(engine.impactDepth(sec.id) * 25 / 100));
    const kaufen = (qty) => assert.equal(engine.placeOrder(fresh(u), market(sec.id, 'buy', qty)).order.filled, qty);
    engine.mmRecenter(book);
    const news0 = ipoNews(sec.id);
    assert.equal(schwelle(), 500);                                    // 25 % von 2000 statt 120
    assert.ok(treasuryStock(sec.id) > 500, 'Fixture: 2000 Stück über der Schwelle');
    // 500 Stück: die alte Leiste (435) plus 65 aus der neuen → Bestand 1500 > 500, keine Nachplatzierung
    kaufen(engine.sideDepth(book, 'sell'));
    kaufen(500 - 435);
    assert.equal(treasuryStock(sec.id), 1500);
    assert.equal(totalShares(sec), 2000);
    assert.equal(ipoNews(sec.id), news0);
    // weiter kaufen, bis der Bestand unter die Schwelle fällt: dann 50 % von D = 1000 Stück, mit einer News
    for (let i = 0; i < 10 && totalShares(sec) === 2000; i++) kaufen(engine.sideDepth(book, 'sell'));
    assert.equal(totalShares(sec), 3000);
    assert.equal(ipoNews(sec.id), news0 + 1);
    assert.ok(engine.holdingOf(u.id, sec.id) + treasuryStock(sec.id) === 3000, 'kein Stück verloren');
    // Cooldown (30 Minuten): wieder unter die Schwelle → genau auf die Schwelle aufgefüllt, ohne weitere News.
    // Bilanz: der Umlauf wächst genau um (Schwelle − Bestand nach dem Kauf) = (Schwelle + gekauft − Bestand davor).
    const T = schwelle(), vor = treasuryStock(sec.id), totalVor = totalShares(sec), depotVor = engine.holdingOf(u.id, sec.id);
    // Drei Abverkäufe reichen (vorher bis zu 10): jeder hebt den Streubesitz um rund 16 %, ab dem
    // siebten stünde D am Deckel von 3 × Start-Streubesitz (2000 → 6000; T5, Risiko „D wächst") und
    // die Auffüllung bliebe aus. Was hier geprüft wird — im Cooldown genau bis zur Schwelle des
    // gewachsenen Streubesitzes, ohne News, ohne Stückverlust — gilt in jedem der drei Durchläufe.
    for (let i = 0; i < 3 && treasuryStock(sec.id) > T; i++) kaufen(engine.sideDepth(book, 'sell'));
    const gekauft = engine.holdingOf(u.id, sec.id) - depotVor;
    assert.ok(gekauft > 0 && gekauft >= vor - T, 'Fixture: der Bestand muss unter die Schwelle gefallen sein');
    // Die Auffüllung vergrößert D und damit den 25-%-Anteil: aufgefüllt wird bis zur Schwelle des NACH der Auffüllung geltenden Streubesitzes
    const T2 = schwelle();
    assert.ok(T2 >= T, `Schwelle ${T2} < ${T}`);
    assert.equal(treasuryStock(sec.id), T2);
    assert.equal(totalShares(sec), totalVor + T2 + gekauft - vor);
    assert.equal(ipoNews(sec.id), news0 + 1);
    // und steht dann: ein Recenter ohne Handel legt nichts mehr zu
    engine.mmRecenter(book);
    assert.equal(treasuryStock(sec.id), T2);
  });
}));

test('Streubesitz (V4): kein risikofreier Round-Trip auf der verlängerten Leiste — 500 Stück kaufen und sofort zurückverkaufen bringt nach zwei Gebühren nie Gewinn (100 Jitter-Staffeln)', (t) => withRandom(mulberry32(20261127))(async () => {
  await spiel(async () => {
    const fee = getSettings().fee_cent;
    let beste = -Infinity; // Cent vor Gebühren, über alle Läufe
    for (let i = 0; i < 100; i++) {
      const { sec, book } = newStock({ ipo: 15.2, float: 2000, founderShares: 1000 });
      const u = await newUser(100_000_000);
      const cash0 = fresh(u).cash;
      const kauf = engine.placeOrder(fresh(u), market(sec.id, 'buy', 500));
      assert.equal(kauf.order.filled, 500);
      let rest = 500, orders = 1;
      while (rest > 0) {
        assert.ok(orders < 5, 'Rückverkauf kommt nicht durch');
        const d = Math.min(rest, engine.sideDepth(book, 'buy'));
        assert.ok(d > 0);
        assert.equal(engine.placeOrder(fresh(u), market(sec.id, 'sell', d)).order.filled, d);
        rest -= d; orders++;
      }
      const ergebnis = fresh(u).cash - cash0 + fee * orders; // vor Gebühren
      assert.ok(ergebnis <= 500 * 10, `Lauf ${i + 1}: ${ergebnis} Cent Gewinn vor Gebühren`);
      assert.ok(ergebnis - fee * orders <= 0, `Lauf ${i + 1}: nach ${orders} Gebühren im Plus`);
      beste = Math.max(beste, ergebnis);
    }
    t.diagnostic(`bester Round-Trip vor Gebühren: ${(beste / 100).toFixed(2)} Cr`);
  });
}));

// ---------------------------------------------------------------------------
// T5 / E015: Die Nachplatzierungsschwelle liegt über dem Mindestangebot — das Buch
// fällt bei anhaltenden Käufen nie unter mm_min_ask_shares, und im Leerlauf wächst
// der Streubesitz nicht weiter.
// ---------------------------------------------------------------------------
test('Streubesitz (E015): drei große Käufe nacheinander und fünf gleichzeitige Käufer — Buch nie unter 900 Stück, niemand scheitert am Angebot, D konvergiert', (t) => fixed(async () => {
  await withSettings({ mm_min_ask_shares: 1000, mm_min_depth: 2000 }, async () => {
    const minAsk = 1000, CASH = 1_000_000;
    let kleinstes = Infinity;
    // ein Schüler mit 10 000 Cr kauft das Maximum, das Geld und Buch hergeben; false = am Angebot gescheitert
    const maximal = async (sec) => {
      const u = await newUser(CASH);
      let qty = engine.previewOrder(fresh(u), market(sec.id, 'buy', 1)).available;
      while (qty > 0 && engine.previewOrder(fresh(u), market(sec.id, 'buy', qty)).gross + getSettings().fee_cent > CASH) qty--;
      if (qty < 1) return { u, qty: 0 };
      const r = engine.placeOrder(fresh(u), market(sec.id, 'buy', qty));
      return { u, qty, filled: r.order.filled };
    };
    for (const ipo of [51.5, 15.2]) {
      const { sec, book } = newStock({ ipo, float: 2000, founderShares: 1000, quote: false });
      engine.mmRecenter(book);
      const d0 = engine.impactDepth(sec.id), Ds = [d0];
      for (let i = 0; i < 3; i++) {
        const r = await maximal(sec);
        assert.ok(r.qty > 0 && r.filled === r.qty, `${sec.ticker}, Kauf ${i + 1}: ${r.filled} von ${r.qty}`);
        kleinstes = Math.min(kleinstes, engine.sideDepth(book, 'sell'));
        Ds.push(engine.impactDepth(sec.id));
      }
      // fünf Schüler beschließen gleichzeitig auf demselben Buchstand und kaufen dann ohne Pause
      const wollen = engine.previewOrder(await newUser(CASH), market(sec.id, 'buy', 1)).available;
      for (let i = 0; i < 5; i++) {
        const r = await maximal(sec);
        assert.ok(r.qty > 0, `${sec.ticker}, Spieler ${i + 1}: nichts kaufbar (Angebot ${engine.sideDepth(book, 'sell')})`);
        assert.ok(r.qty >= Math.min(wollen, 1), `${sec.ticker}: Spieler ${i + 1} wollte ${wollen}, konnte ${r.qty}`);
        kleinstes = Math.min(kleinstes, engine.sideDepth(book, 'sell'));
        Ds.push(engine.impactDepth(sec.id));
      }
      for (let i = 1; i < Ds.length; i++) assert.ok(Ds[i] >= Ds[i - 1], `${sec.ticker}: Streubesitz schrumpft ${Ds[i - 1]} → ${Ds[i]}`);
      // Leerlauf: 60 Recenter ändern Bestand und Streubesitz nicht mehr
      const vor = treasuryStock(sec.id), D = Ds[Ds.length - 1];
      for (let i = 0; i < 60; i++) { book.mmNextAt = 0; engine.mmRefreshAll(); }
      assert.equal(treasuryStock(sec.id), vor, `${sec.ticker}: Bestand wandert im Leerlauf`);
      assert.equal(engine.impactDepth(sec.id), D);
      assert.ok(kleinstes >= 900, `kleinstes Buch ${kleinstes} Stück`);
      t.diagnostic(`${sec.ticker}: kleinste Angebotsseite ${kleinstes} Stück · Streubesitz ${Ds.join(' → ')} · Bestand der Staatskasse ${vor}`);
    }
  });
}));
