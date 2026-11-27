// QA T5 — Streubesitz / Market-Maker-Angebot (unabhängig vom Implementer).
// Abgeleitet aus AUFTRAG.md („ein Schüler soll immer genug kaufen können … so viele Aktien
// am Markt, dass er sie gar nicht alle kaufen kann"), PLAN T5 (Zielzahlen, DoD) und
// KONTEXT2 §3 — nicht aus dem Implementierungscode. Gespielt wie ein echter Schüler:
// frischer Schüler mit 10 000 Cr, Market-Orders, Aktien direkt nach dem Seed.
//
// Isolation wie mm.test.js:14-43 — eigene, frisch geseedete DB (server/data/qa5-<pid>.db),
// am Ende gelöscht. Die echte DB (schoolstreet.db) wird nie geöffnet.
// Die Tests QA5-1…6 bilden EINEN Spielverlauf (jeder setzt auf dem vorigen Stand auf);
// node --test führt sie in Dateireihenfolge aus. QA5-7…8 sind eigene Fixture-Werte.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `qa5-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);
const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

let db, getSettings, setSetting, q, auth, engine;
// QA5_MIN_ASK / QA5_MIN_DEPTH (optional): andere Werte für mm_min_ask_shares / mm_min_depth —
// in der eigenen DB gesetzt, BEVOR der Seed läuft (db.js bleibt unverändert). Default: db.js.
const SERVER = path.join(__dirname, '..');
const WANT = {};
if (process.env.QA5_MIN_ASK) WANT.mm_min_ask_shares = Number(process.env.QA5_MIN_ASK);
if (process.env.QA5_MIN_DEPTH) WANT.mm_min_depth = Number(process.env.QA5_MIN_DEPTH);
const SEED = `const fs = require('fs'); const d = require(${JSON.stringify(path.join(SERVER, 'db'))});
for (const [k, v] of Object.entries(${JSON.stringify(WANT)})) d.setSetting(k, v);
// seed.js löscht seine DB-Datei beim Start (Zeile 6) — hier ist sie schon offen (Einstellung gesetzt); das Löschen
// nur für diese eine Datei während des Seeds unterdrücken, damit die Einstellung und die Daten bleiben.
const f = ${JSON.stringify(DBFILE)}; const ex = fs.existsSync, un = fs.unlinkSync;
fs.existsSync = (x) => (String(x).startsWith(f) ? false : ex(x)); fs.unlinkSync = (x, ...r) => (String(x).startsWith(f) ? undefined : un(x, ...r));
try { require(${JSON.stringify(path.join(SERVER, 'seed.js'))}); } finally { fs.existsSync = ex; fs.unlinkSync = un; }
try { d.db.close(); } catch (_) { /* der Seed schließt selbst */ }`;
before(() => {
  clean();
  execFileSync(process.execPath, Object.keys(WANT).length ? ['-e', SEED] : [path.join(SERVER, 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
  ({ db, getSettings, setSetting, q } = require('../db'));
  if (path.basename(String(db.name)) !== DB_NAME) throw new Error(`offen ist "${db.name}", erwartet eigene ${DB_NAME}`);
  db.pragma('synchronous = OFF');                 // wegwerfbare DB, viele Recenter
  auth = require('../auth');
  engine = require('../engine');
  engine.loadEngine();
});
after(() => { try { db.close(); } catch (_) { /* egal */ } clean(); });

// ---------------------------------------------------------------------------
// Maßstäbe (aus Auftrag/Plan/Nutzerwille, nicht aus dem Code)
// ---------------------------------------------------------------------------
const CASH_CR = 10_000;                              // Startkapital eines Schülers
const CASH = CASH_CR * 100;                          // Cent
const FEE = getSettings().fee_cent;
const KP_MIN_PCT = 95;                               // PLAN T5: Kaufkraft ≥ 95 % je Aktie
const OFFER_MIN = 700;                               // PLAN T5: nach einem Großkauf wieder ≥ 700 Stück im Buch
// Die Zahl „kleinste kaufbare Menge ≥ 525 Stück" gilt nicht mehr: ersetzt durch E015 (siehe QA5-7)
const MIN_MOVE_50_PCT = 0.2;                         // Auftrag QA: 50 Stück müssen den Kurs messbar (> 0,2 %) bewegen
const IDLE_MIN = 60;                                 // Auftrag QA: 60 Minuten nichts tun
const REFRESH_SEC = getSettings().mm_refresh_sec;    // MM-Takt in Spielsekunden (Wanduhr)

let n = 0;
const student = async () => { const u = await auth.createUser(`qa5-${++n}`, 'pw1234', 'user', CASH); return q.userById.get(u.id); };
const market = (secId, side, amount) => ({ security_id: secId, side, type: 'market', amount });
const stocks = () => db.prepare("SELECT * FROM securities WHERE status = 'active' AND type = 'stock' ORDER BY id").all();
const pct = (a, b) => (a / b - 1) * 100;
const fmt = (x, d = 2) => Number(x).toFixed(d);
const log = (t, ...a) => t.diagnostic(a.join(' '));
const founderHeld = (sec) => { const h = q.holding.get(sec.founder_id, sec.id); return h ? h.amount : 0; };
const info = (sec) => {
  const book = engine.books.get(sec.id);
  const mmAsks = book.asks.filter((o) => o.is_mm && o.status === 'open' && o.amount - o.filled > 0);
  const escrow = mmAsks.reduce((s, o) => s + o.amount - o.filled, 0);
  const depo = engine.holdingOf(engine.treasury().id, sec.id);
  return { book, float: q.secById.get(sec.id).total_shares - founderHeld(sec), asks: engine.sideDepth(book, 'sell'), treasury: depo + escrow, depo, escrow,
    k: book.last, f: engine.fairPrice(sec.id) / 1000 };  // k: öffentlicher Kurs, f: F — beide in Cent
};
// Größte mit 10 000 Cr ausführbare Menge in EINER Market-Order — nur über die Vorschau
// (bucht nichts), Binärsuche; liefert zugleich den Engpass (Geld / Ordergrenze / Angebot).
function biggest(sec, u) {
  const one = engine.previewOrder(u, market(sec.id, 'buy', 1));
  if (one.gross + FEE > CASH) return { qty: 0, gross: 0, cap: one.cap, avail: one.available, by: 'Geld (10 000 Cr)' };
  let lo = 1, hi = Math.min(one.cap ?? 1e9, one.available);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const p = engine.previewOrder(u, market(sec.id, 'buy', mid));
    if (p.matched_qty === mid && p.gross + FEE <= CASH) lo = mid; else hi = mid - 1;
  }
  const p = engine.previewOrder(u, market(sec.id, 'buy', lo));
  const by = lo >= one.available ? 'Angebot (Ask-Seite)' : lo >= (one.cap ?? Infinity) ? 'Ordergrößen-Grenze' : 'Geld (10 000 Cr)';
  return { qty: lo, gross: p.gross, cap: one.cap, avail: one.available, by };
}
// Ein Schüler kauft `qty` Stück per Market-Order; liefert Ausführung, Kursbewegung und Buch danach.
function buy(sec, u, qty) {
  const i0 = info(sec);
  const r = engine.placeOrder(q.userById.get(u.id), market(sec.id, 'buy', qty));
  const i1 = info(sec);
  return { filled: r.order.filled, status: r.order.status, error: null, spent: CASH - q.userById.get(u.id).cash,
    dK: pct(i1.k, i0.k), dF: pct(i1.f, i0.f), before: i0, after: i1 };
}
function sell(sec, u, qty) {
  const i0 = info(sec);
  const r = engine.placeOrder(q.userById.get(u.id), market(sec.id, 'sell', qty));
  const i1 = info(sec);
  return { filled: r.order.filled, got: q.userById.get(u.id).cash, dK: pct(i1.k, i0.k), dF: pct(i1.f, i0.f), before: i0, after: i1 };
}
// „Nichts tun": nur der MM-Takt läuft — ein Recenter je mm_refresh_sec.
function idle(sec, minutes) {
  const i0 = info(sec);
  const ks = [], fs = [], asks = [];
  const steps = Math.round(minutes * 60 / REFRESH_SEC);
  for (let i = 0; i < steps; i++) {
    engine.books.get(sec.id).mmNextAt = 0;
    engine.mmRefreshAll();
    const x = info(sec);
    ks.push(x.k); fs.push(x.f); asks.push(x.asks);
  }
  return { steps, k0: i0.k, k1: ks[steps - 1], f0: i0.f, f1: fs[steps - 1], minAsks: Math.min(...asks), maxAsks: Math.max(...asks), treasury1: info(sec).treasury, treasury0: i0.treasury };
}
// Prüfung je Aktie sammeln (statt am ersten Fehler abzubrechen), damit der Spielverlauf gleich bleibt
const collect = () => { const bad = []; return { check: (ok, msg) => { if (!ok) bad.push(msg); }, bad }; };
const rows = {};                 // Kennzahlen je Aktie für den Bericht
const buyers = {};               // letzter großer Käufer je Aktie (für den Round-Trip)
const rowOf = (sec) => (rows[sec.ticker] = rows[sec.ticker] || { ticker: sec.ticker });

// ---------------------------------------------------------------------------
// QA5-1 Größte Order je Aktie, direkt nach dem Seed (Normalfall)
// ---------------------------------------------------------------------------
test('QA5-1 je Aktie: größte ausführbare Market-Kauf-Order eines Schülers (10 000 Cr) — Angebot nie der Engpass, Kaufkraft ≥ 95 %, danach ≥ 700 Stück im Buch', async (t) => {
  const s = getSettings();
  log(t, `Lauf QA5_MIN_ASK=${process.env.QA5_MIN_ASK || '(db.js-Default)'} QA5_MIN_DEPTH=${process.env.QA5_MIN_DEPTH || '(db.js-Default)'} · Settings: mm_min_ask_shares=${s.mm_min_ask_shares} mm_min_depth=${s.mm_min_depth} mm_impact_pct=${s.mm_impact_pct} Band ±${s.limit_band_pct} % · Gebühr ${fmt(FEE / 100)} Cr · mm_refresh_sec ${REFRESH_SEC}`);
  for (const sec of stocks()) {
    const i0 = info(sec), u = await student(), b = biggest(sec, u), row = rowOf(sec);
    assert.ok(b.qty > 0, `${sec.ticker}: nichts kaufbar`);
    // Nutzerwille „Angebot nie der Engpass": das Geld begrenzt, nicht das Buch und nicht die Ordergrenze
    assert.equal(b.by, 'Geld (10 000 Cr)', `${sec.ticker}: Engpass ist „${b.by}" bei ${b.qty} Stück (Asks ${b.avail}, Grenze ${b.cap})`);
    assert.ok(i0.asks >= OFFER_MIN, `${sec.ticker}: nur ${i0.asks} Stück im Buch vor dem Kauf (< ${OFFER_MIN})`);
    const r = buy(sec, u, b.qty);
    assert.equal(r.status, 'filled', `${sec.ticker}: Order endet als ${r.status}`);
    assert.equal(r.filled, b.qty, `${sec.ticker}: nur ${r.filled} von ${b.qty} Stück ausgeführt`);
    const kp = r.spent / CASH * 100;
    assert.ok(kp >= KP_MIN_PCT, `${sec.ticker}: Kaufkraft ${fmt(kp, 1)} % < ${KP_MIN_PCT} %`);
    assert.ok(r.after.asks >= OFFER_MIN, `${sec.ticker}: nur ${r.after.asks} Stück im Buch nach dem Kauf (< ${OFFER_MIN})`);
    Object.assign(row, { k0: i0.k, f0: i0.f, float0: i0.float, otherAsks: engine.sideDepth(i0.book, 'sell', -1) - engine.sideDepth(i0.book, 'sell') + i0.asks - i0.escrow, asks0: i0.asks, cap: b.cap, qty: b.qty, spent: r.spent / 100, kp, rest: r.after.asks, dK: r.dK, dF: r.dF });
    buyers[sec.ticker] = u;
    log(t, `${sec.ticker} · K ${fmt(i0.k / 100)} · Float ${i0.float} · Asks ${i0.asks} · Grenze ${b.cap} · Order ${b.qty} Stück, ausgeführt ${r.filled} · ${fmt(r.spent / 100)} Cr = ${fmt(kp, 1)} % Kaufkraft · Rest Asks ${r.after.asks} · K ${fmt(r.after.k / 100)} (${fmt(r.dK, 2)} %), F ${fmt(r.dF, 3)} % · Engpass ${b.by}`);
  }
});

// ---------------------------------------------------------------------------
// QA5-2 Round-Trip: derselbe Schüler verkauft alles zurück (Normalfall).
// Maßstab PLAN 2.2: F ← F·e^(λ·q), λ = ln(1 + mm_impact_pct/100)/D; Flow zählt nur
// Ausführungen gegen MM-Quotes. Liegen Angebote anderer Teilnehmer im Buch (der Seed\n// hinterlässt welche), füllt der Kauf daraus ohne Flow, der Verkauf geht an die MM-Gebote.
// ---------------------------------------------------------------------------
test('QA5-2 je Aktie: Round-Trip — der große Kauf ist sofort wieder vollständig verkäuflich, F = F0·e^(−λ·[bei Teilnehmern gekauft]), kein risikofreier Gewinn', async (t) => {
  const cfg = getSettings();
  for (const sec of stocks()) {
    const row = rowOf(sec), u = buyers[sec.ticker], qty = engine.holdingOf(u.id, sec.id);
    assert.ok(qty > 0, `${sec.ticker}: kein Käufer aus QA5-1`);
    // vor dem Kauf im Buch liegende Angebote von Teilnehmern (kein Flow, PLAN 2.2) — aus QA5-1 mitnehmen
    const other = row.otherAsks, d0 = row.float0;
    const s = sell(sec, u, qty), i1 = s.after;
    assert.equal(s.filled, qty, `${sec.ticker}: nur ${s.filled} von ${qty} Stück verkauft`);
    const expectF = row.f0 * Math.exp(-Math.log(1 + cfg.mm_impact_pct / 100) / d0 * Math.min(qty, other));
    assert.ok(Math.abs(pct(i1.f, expectF)) <= 0.05, `${sec.ticker}: F nach Round-Trip ${fmt(i1.f / 100)} statt ${fmt(expectF / 100)} (${fmt(pct(i1.f, expectF), 3)} %)`);
    const cost = CASH - s.got;                       // Round-Trip-Kosten (2 Gebühren + Spread), kein Gewinn
    assert.ok(cost >= 2 * FEE, `${sec.ticker}: Round-Trip kostet ${fmt(cost / 100)} Cr — weniger als zwei Gebühren (risikofreier Gewinn)`);
    assert.ok(i1.asks >= OFFER_MIN, `${sec.ticker}: nur ${i1.asks} Stück im Buch nach dem Verkauf`);
    Object.assign(row, { rtCost: cost / 100, asksAfterSell: i1.asks, dKrt: pct(i1.k, row.k0) });
    log(t, `${sec.ticker} · Verkauf ${s.filled} Stück vollständig · Teilnehmer-Angebote beim Kauf ${Math.min(qty, other)} von ${qty} · Kurs nach Round-Trip ${fmt(i1.k / 100)} (${fmt(pct(i1.k, row.k0), 2)} % gegen Ausgang) · Kosten ${fmt(cost / 100)} Cr (${fmt(cost / 100 / row.spent * 100, 2)} % des Umsatzes, davon 2 × Gebühr ${fmt(2 * FEE / 100)} Cr) · Asks ${i1.asks}`);
  }
});

// QA5-3 Grenzfall: drei große Käufe nacheinander — bleibt das Angebot da?
// ---------------------------------------------------------------------------
test('QA5-3 je Aktie: drei große Käufe nacheinander (je ein Schüler mit 10 000 Cr) — jede Order füllt vollständig, danach stehen wieder ≥ 700 Stück im Buch', async (t) => {
  for (const sec of stocks()) {
    const row = rowOf(sec), start = info(sec), out = [], c = collect();
    for (let i = 1; i <= 3; i++) {
      const u = await student(), b = biggest(sec, u), i0 = info(sec);
      c.check(b.by === 'Geld (10 000 Cr)', `${sec.ticker}, Kauf ${i}: Engpass „${b.by}"`);
      const r = buy(sec, u, b.qty);
      c.check(r.status === 'filled', `${sec.ticker}, Kauf ${i}: endet als ${r.status}`);
      c.check(r.filled === b.qty, `${sec.ticker}, Kauf ${i}: ${r.filled} von ${b.qty}`);
      // Nachplatzierung/Neulegen: direkt nach der Order und nach einem weiteren Recenter
      const direct = r.after.asks;
      engine.mmRecenter(engine.books.get(sec.id));
      const later = info(sec).asks;
      c.check(direct >= OFFER_MIN, `${sec.ticker}, Kauf ${i}: nur ${direct} Stück im Buch danach (< ${OFFER_MIN}, Staatskasse ${r.after.treasury} Stück)`);
      c.check(later >= OFFER_MIN, `${sec.ticker}, Kauf ${i}: nur ${later} Stück im Buch nach einem Recenter`);
      // Für den nächsten Schüler ist weiter Geld der Engpass
      c.check(biggest(sec, await student()).by === 'Geld (10 000 Cr)', `${sec.ticker}, Kauf ${i}: danach ist das Angebot der Engpass`);
      out.push(`${b.qty} Stück → Asks ${i0.asks}→${direct}, D ${i0.float}→${r.after.float}, Staatskasse ${i0.treasury}→${r.after.treasury}, K +${fmt(r.dK, 2)} %`);
    }
    const end = info(sec);
    Object.assign(row, { three: out, dK3: pct(end.k, start.k), float3: end.float, asks3: end.asks });
    assert.deepEqual(c.bad, [], 'drei Käufe nacheinander');
    log(t, `${sec.ticker} · Start K ${fmt(start.k / 100)}, D ${start.float} · ${out.join(' | ')} · Kurs nach drei Käufen ${fmt(end.k / 100)} (${fmt(pct(end.k, start.k), 2)} %)`);
  }
});

// ---------------------------------------------------------------------------
// QA5-4 mehrere Spieler kaufen dieselbe Aktie gleichzeitig
// ---------------------------------------------------------------------------
test('QA5-4 je Aktie: fünf Schüler entscheiden gleichzeitig (dasselbe Buch) und kaufen dann ohne Pause dieselbe Aktie — wer zu viel verlangt, muss nur die Menge (Geld) anpassen, nie am Angebot scheitern', async (t) => {
  const N = 5;
  for (const sec of stocks()) {
    const five = [];
    for (let i = 0; i < N; i++) five.push(await student());
    const wants = five.map(() => biggest(sec, five[0]).qty);      // alle entscheiden auf demselben Buchstand
    const i0 = info(sec), res = [], c = collect();
    for (let i = 0; i < N; i++) {
      let qty = wants[i], r = null, tries = 0;
      for (;;) {                                                    // wie ein echter Spieler: bei Ablehnung Menge neu wählen
        try { r = buy(sec, five[i], qty); break; }
        catch (e) {
          assert.ok(/Credits/.test(e.message), `${sec.ticker}, Spieler ${i + 1}: am Angebot gescheitert — ${e.message}`);
          const again = biggest(sec, five[i]);
          assert.ok(again.qty >= 1 && again.qty < qty, `${sec.ticker}, Spieler ${i + 1}: keine kleinere Menge kaufbar`);
          qty = again.qty; tries++;
        }
      }
      c.check(r.status === 'filled', `${sec.ticker}, Spieler ${i + 1}: endet als ${r.status}`);
      c.check(r.filled === qty, `${sec.ticker}, Spieler ${i + 1}: ${r.filled} von ${qty}`);
      assert.ok(r.spent / CASH * 100 >= KP_MIN_PCT, `${sec.ticker}, Spieler ${i + 1}: nur ${fmt(r.spent / CASH * 100, 1)} % Kaufkraft eingesetzt`);
      res.push(`${qty}${tries ? ' (von ' + wants[i] + ' reduziert)' : ''}`);
    }
    const i1 = info(sec);
    c.check(i1.asks >= OFFER_MIN, `${sec.ticker}: nur ${i1.asks} Stück im Buch danach (< ${OFFER_MIN}, Staatskasse ${i1.treasury} Stück)`);
    Object.assign(rowOf(sec), { five: res.join(' + '), dK5: pct(i1.k, i0.k) });
    assert.deepEqual(c.bad, [], 'fünf Spieler gleichzeitig');
    log(t, `${sec.ticker} · 5 Spieler wollen je ${wants[0]} Stück · gekauft: ${res.join(' + ')} · K ${fmt(i0.k / 100)} → ${fmt(i1.k / 100)} (${fmt(pct(i1.k, i0.k), 2)} %) · Asks ${i0.asks} → ${i1.asks} · D ${i0.float} → ${i1.float} · Staatskasse ${i0.treasury} → ${i1.treasury}`);
  }
});

// ---------------------------------------------------------------------------
// QA5-5 60 Minuten nichts
// ---------------------------------------------------------------------------
test('QA5-5 je Aktie: 60 Minuten ohne Handel (nur der MM-Takt) — Kurs bleibt auf dem erreichten Niveau, Angebot bleibt ≥ 700, Staatskasse ändert sich nicht', (t) => {
  for (const sec of stocks()) {
    const r = idle(sec, IDLE_MIN), c = collect();
    c.check(r.k1 === r.k0, `${sec.ticker}: Kurs wandert ohne Handel ${fmt(r.k0 / 100)} → ${fmt(r.k1 / 100)}`);
    c.check(r.f1 === r.f0, `${sec.ticker}: F wandert ohne Handel`);
    c.check(r.minAsks >= OFFER_MIN, `${sec.ticker}: Angebot fällt auf ${r.minAsks} Stück`);
    c.check(r.treasury1 === r.treasury0, `${sec.ticker}: Bestand der Staatskasse ändert sich ohne Handel`);
    Object.assign(rowOf(sec), { idleK: r.k0 / 100, idleAsks: `${r.minAsks}–${r.maxAsks}`, treasury: r.treasury0 });
    log(t, `${sec.ticker} · ${r.steps} Recenter à ${REFRESH_SEC} s · K ${fmt(r.k0 / 100)} → ${fmt(r.k1 / 100)} · Asks ${r.minAsks}–${r.maxAsks} · Staatskasse ${r.treasury0} Stück`);
    assert.deepEqual(c.bad, [], '60 Minuten ohne Handel');
  }
});

// ---------------------------------------------------------------------------
// QA5-6 Vorzeichen: Kurs bewegt sich noch; kleine Order über den Spread
// ---------------------------------------------------------------------------
test('QA5-6 je Aktie: Kauf von 50 und 100 Stück hebt den Kurs messbar (> 0,2 %), Verkauf senkt ihn — kleine Order (10 Stück) kostet den Spread', async (t) => {
  for (const sec of stocks()) {
    const row = rowOf(sec);
    const samples = [];
    for (const qty of [50, 50, 50, 100]) {                            // drei einzelne 50er wie ein Schüler sie tippt
      const u = await student(), b = buy(sec, u, qty), s = sell(sec, u, qty);
      assert.equal(b.filled, qty); assert.equal(s.filled, qty);
      assert.ok(b.dF > MIN_MOVE_50_PCT, `${sec.ticker}: ${qty} Stück bewegen F nur ${fmt(b.dF, 3)} % (≤ ${MIN_MOVE_50_PCT} %)`);
      assert.ok(s.dF < 0, `${sec.ticker}: Verkauf von ${qty} Stück senkt F nicht`);
      samples.push({ qty, dK: b.dK, dF: b.dF });
      if (qty === 100) Object.assign(row, { move100: b.dF });
    }
    const f50 = samples.slice(0, 3).map((x) => x.dF), k50 = samples.slice(0, 3).map((x) => x.dK);
    Object.assign(row, { move50: f50.reduce((x, y) => x + y) / 3, move50K: k50, visible50: k50.filter((x) => x > 0).length });
    // öffentlicher Kurs: mindestens die Hälfte der 50er-Käufe muss ihn sichtbar (ein Tick) bewegen
    assert.ok(k50.filter((x) => x > 0).length >= 2, `${sec.ticker}: öffentlicher Kurs bewegt sich bei 50 Stück in ${k50.filter((x) => x > 0).length} von 3 Käufen nicht (${k50.map((x) => fmt(x, 2)).join('/')} %)`);
    const out = [`50 Stück (3 Käufe): K ${k50.map((x) => fmt(x, 2)).join('/')} % / F Ø ${fmt(row.move50, 3)} %`, `100 Stück: K ${fmt(samples[3].dK, 2)} % / F ${fmt(samples[3].dF, 3)} %`];
    // kleine Order: 10 Stück kaufen und sofort verkaufen, mit echtem Schüler
    const i0 = info(sec), pv = engine.previewOrder(await student(), market(sec.id, 'buy', 10));
    const bid = i0.book.bids[0].price, ask = i0.book.asks[0].price, mid = (bid + ask) / 2;
    const u = await student();
    engine.placeOrder(q.userById.get(u.id), market(sec.id, 'buy', 10));
    engine.placeOrder(q.userById.get(u.id), market(sec.id, 'sell', 10));
    const loss = CASH - q.userById.get(u.id).cash;                 // Round-Trip 10 Stück inkl. 2 Gebühren
    const half = pv.avg_price - mid;                               // Spread-Kosten je Stück (Kauf über der Mitte)
    assert.ok(half > 0, `${sec.ticker}: Kauf 10 Stück kostet nicht über der Mitte`);
    assert.ok(loss < 2 * FEE + 0.03 * pv.gross, `${sec.ticker}: Round-Trip 10 Stück kostet ${fmt(loss / 100)} Cr (${fmt(loss / pv.gross * 100, 2)} % des Umsatzes)`);
    Object.assign(row, { spread: ask - bid, spreadPct: pct(ask, bid), small10: Math.round(10 * half), small10Rt: loss / 100, smallPct: (loss - 2 * FEE) / pv.gross * 100 });
    log(t, `${sec.ticker} · ${out.join(' · ')} · Spread ${fmt((ask - bid) / 100)} Cr (${fmt(pct(ask, bid), 2)} %) · 10 Stück: Ø ${fmt(pv.avg_price / 100)} gegen Mitte ${fmt(mid / 100)} = ${Math.round(10 * half)} Cent über Mitte; Kauf+Verkauf 10 Stück kostet ${fmt(loss / 100)} Cr (davon ${fmt((loss - 2 * FEE) / 100)} Cr Markt = ${fmt((loss - 2 * FEE) / pv.gross * 100, 2)} %)`);
  }
  log(t, 'TABLE ' + JSON.stringify(rows));
});

// ---------------------------------------------------------------------------
// QA5-6b Grenzfall Abschöpfen: Schüler kaufen so lange das Maximum, bis die Nachplatzierung kommen muss
// ---------------------------------------------------------------------------
test('QA5-6b je Aktie: Schüler kaufen nacheinander jeweils das Maximum, bis die Nachplatzierung kommt — das Angebot im Buch fällt nie unter 700 Stück, kein Schüler scheitert am Angebot, die Nachplatzierung vergrößert den Streubesitz', async (t) => {
  for (const sec of stocks()) {
    const i0 = info(sec), c = collect(), lows = [];
    let n = 0, repl = null;
    for (; n < 30; n++) {
      const u = await student(), b = biggest(sec, u);
      if (b.by !== 'Geld (10 000 Cr)') { c.check(false, `${sec.ticker}, Kauf ${n + 1}: ENGPASS ${b.by} — Schüler will ${b.qty} Stück, im Buch ${b.avail}, Staatskasse ${info(sec).treasury}`); break; }
      const r = buy(sec, u, b.qty);
      assert.equal(r.status, 'filled', `${sec.ticker}, Kauf ${n + 1}: ${r.status}`);
      lows.push(r.after.asks);
      if (r.after.float !== r.before.float) { repl = { at: n + 1, plus: r.after.float - r.before.float, stockBefore: r.before.treasury }; break; }
    }
    c.check(!!repl, `${sec.ticker}: nach ${n} Maximal-Käufen keine Nachplatzierung (Staatskasse ${info(sec).treasury}, D ${info(sec).float})`);
    c.check(Math.min(...lows) >= OFFER_MIN, `${sec.ticker}: Angebot im Buch fällt auf ${Math.min(...lows)} Stück (< ${OFFER_MIN}) vor der Nachplatzierung`);
    Object.assign(rowOf(sec), { drainMin: Math.min(...lows), drain: repl ? `${repl.at} Käufe bis Nachplatzierung (+${repl.plus} Stück, D ${i0.float} → ${i0.float + repl.plus}, Bestand davor ${repl.stockBefore})` : 'keine', dKdrain: pct(info(sec).k, i0.k) });
    log(t, `${sec.ticker} · ${repl ? repl.at : n} Maximal-Käufe (K ${fmt(i0.k / 100)} → ${fmt(info(sec).k / 100)}, ${fmt(pct(info(sec).k, i0.k), 1)} %) · kleinste Asks unterwegs ${Math.min(...lows)} (Staatskasse-Bestand ${info(sec).treasury}) · ${repl ? `Nachplatzierung +${repl.plus}: D ${i0.float} → ${info(sec).float}` : 'keine Nachplatzierung'}`);
    assert.deepEqual(c.bad, [], 'Abschöpfen bis zur Nachplatzierung');
  }
});

// ---------------------------------------------------------------------------
// QA5-7 Zielzahl aus PLAN T5. Die ursprüngliche Zahl „≥ 525 Stück" ist durch E015 ersetzt:
// 525 Stück kosten je Aktie 26 565 Cr und sind mit 10 000 Credits unerfüllbar. Neues DoD:
// „Angebot ist nie der Engpass; Kaufkraft ≥ 95 % je Aktie". Frisch gemessen je Aktie (eigener
// Schüler, Leiste neu gelegt), nicht aus den Zeilen von QA5-1 abgelesen.
// ---------------------------------------------------------------------------
test('QA5-7 PLAN T5 Zielzahl (E015): Angebot ist nie der Engpass, Kaufkraft ≥ 95 % je Aktie', async (t) => {
  const out = [];
  for (const sec of stocks()) {
    engine.books.get(sec.id).mmNextAt = 0;
    engine.mmRefreshAll();
    const i0 = info(sec), b = biggest(sec, await student());
    const kp = (b.gross + FEE) / CASH * 100;
    out.push(`${sec.ticker}: ${b.qty} Stück für ${fmt(b.gross / 100)} Cr = ${fmt(kp, 1)} % Kaufkraft, Engpass ${b.by} (Asks ${i0.asks}, Grenze ${b.cap})`);
    assert.equal(b.by, 'Geld (10 000 Cr)', `${sec.ticker}: Engpass ist „${b.by}" bei ${b.qty} Stück — das Angebot (${i0.asks} Stück) oder die Ordergrenze (${b.cap}) begrenzt, nicht das Geld`);
    assert.ok(kp >= KP_MIN_PCT, `${sec.ticker}: Kaufkraft ${fmt(kp, 1)} % < ${KP_MIN_PCT} %`);
  }
  log(t, `QA5-7 (E015): ${out.join(' · ')}`);
});

// ---------------------------------------------------------------------------
// QA5-8 Kalibrierung (eigene Werte wie im Seed: 1 000 Gründer + 2 000 Float):
// wie viel Angebot und wie viel Kursbewegung ergibt mm_min_ask_shares = 700 / 1000 / 1500?
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test('QA5-8 Kalibrierung: mm_min_ask_shares 700 / 1000 / 1500 — Streubesitz, Angebot im Buch (60 Jitter-Leitern), Kursbewegung einzelner Orders 50 / 100 / 200 / 500 Stück (nur Messung, Fixture wie Seed)', async (t) => {
  const s0 = getSettings();
  const Cr = (x) => Math.round(x * 100);
  const res = [];
  try {
    for (const minAsk of [700, 1000, 1500]) {
      setSetting('mm_min_ask_shares', minAsk); setSetting('mm_min_depth', 2000);
      const tr = engine.treasury();
      const founder = auth.createUser(`qa5-kal-${minAsk}`, 'pw1234', 'user', 10_000_000);
      const sec = engine.listSecurity({ type: 'stock', ticker: `K${minAsk}A`, name: `QA5 Kalibrierung ${minAsk}`, founder_id: founder.id,
        ipo_price: Cr(20), total_shares: 3000 });
      engine.addHoldingPublic(tr.id, sec.id, 2000, Cr(20));
      engine.addHoldingPublic(founder.id, sec.id, 1000, Cr(20));
      db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(Cr(20) * 2000, tr.id);
      const book = engine.books.get(sec.id);
      const orig = Math.random, asks = [];
      Math.random = mulberry32(20261127);
      try { for (let i = 0; i < 60; i++) { engine.mmRecenter(book); asks.push(engine.sideDepth(book, 'sell')); } } finally { Math.random = orig; }
      const i0 = info(sec);
      const u = q.userById.get((await auth.createUser(`qa5-kal-buy-${minAsk}`, 'pw1234', 'user', 100_000_000)).id);
      const cap = engine.previewOrder(u, market(sec.id, 'buy', 1)).cap;
      const moves = {};
      for (const qty of [50, 100, 200, 500]) {
        const f0 = info(sec).f, k0 = info(sec).k, r = buy(sec, u, qty);
        assert.equal(r.filled, qty);
        moves[qty] = { dF: pct(r.after.f, f0), dK: pct(r.after.k, k0), asks: r.after.asks };
        let held = engine.holdingOf(u.id, sec.id);
        while (held > 0) { const c = Math.min(held, cap); assert.equal(engine.placeOrder(q.userById.get(u.id), market(sec.id, 'sell', c)).order.filled, c); held -= c; }
      }
      const under = asks.filter((x) => x < 700).length;
      res.push({ minAsk, float: i0.float, asksMin: Math.min(...asks), asksAvg: Math.round(asks.reduce((x, y) => x + y) / asks.length), asksMax: Math.max(...asks), under700: under, cap, moves });
      log(t, `mm_min_ask_shares=${minAsk}: D ${i0.float} · Asks über 60 Leitern min/Ø/max ${Math.min(...asks)}/${Math.round(asks.reduce((x, y) => x + y) / asks.length)}/${Math.max(...asks)} (${under} unter 700) · Ordergrenze ${cap} · Kursbewegung je EINER Order (F / öffentlicher K): ${[50, 100, 200, 500].map((q) => `${q} Stück ${fmt(moves[q].dF, 2)} % / ${fmt(moves[q].dK, 2)} %`).join(' · ')}`);
    }
  } finally { setSetting('mm_min_ask_shares', s0.mm_min_ask_shares); setSetting('mm_min_depth', s0.mm_min_depth); }
  log(t, 'TABLE8 ' + JSON.stringify(res));
});
