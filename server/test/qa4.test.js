// QA T4 — Cash-Kreislauf, unabhängig vom Implementer abgeleitet (DoD, V3/V5 in PLAN.md).
// Eigene, frisch geseedete DB server/data/qa4-<pid>.db (am Ende gelöscht); die echte DB und Port 3000
// werden nie berührt. DB_NAME steht vor dem ersten require('../db'). Wanduhr: steuerbare Fake-Uhr,
// echte Uhr nur in den Fällen, die „echte Uhr" heißen.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const DB_NAME = `qa4-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const PORT = 3286;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'admin', password: 'qa4pass' };

const rm = (name) => ['', '-wal', '-shm'].forEach((e) => fs.rmSync(path.join(SERVER, 'data', name + e), { force: true }));

let db, getSettings, setSetting, q, auth, bus, engine, jobs, bots, newsgen;
const realNow = Date.now;
const clock = { t: 0 };
Date.now = () => clock.t;

before(() => {
  rm(DB_NAME);
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: ADMIN.password }, stdio: 'ignore' });
  ({ db, getSettings, setSetting, q } = require('../db'));
  auth = require('../auth');
  bus = require('../bus');
  engine = require('../engine');
  jobs = require('../jobs');
  bots = require('../bots');
  newsgen = require('../newsgen');
  engine.loadEngine();
  // Fake-Uhr startet in der Gegenwart: price_history (Tagesreferenz der News, newsgen.js) trägt echte Zeitstempel.
  clock.t = realNow.call(Date);
});
after(() => { Date.now = realNow; rm(DB_NAME); rm(`${DB_NAME}-run`); rm(`${DB_NAME}-http`); });

const SET = (o) => { for (const [k, v] of Object.entries(o)) setSetting(k, v); };
let n = 0;
const newUser = (cash = 1_000_000, isBot = false) => {
  const u = auth.createUser(`qa4-${++n}`, 'pw1234', 'user', cash);
  if (isBot) db.prepare('UPDATE users SET is_bot = 1 WHERE id = ?').run(u.id);
  return q.userById.get(u.id);
};
const fresh = (u) => q.userById.get(u.id);
const cashOf = (id) => q.userById.get(id).cash;
const pool = () => Number(getSettings().fee_pool_cent || 0);
const firstSec = () => engine.books.values().next().value.sec.id;
const activeIds = () => db.prepare("SELECT id FROM users WHERE role='user' AND frozen=0").all().map((r) => r.id);
// Bots ohne eigene Firma und ohne offene Order (eine stornierte Order gäbe Escrow zurück — keine Zahlung).
// founder_id darf NULL sein: NOT IN über eine Spalte mit NULL liefert sonst gar keine Zeile.
const plainBots = () => db.prepare("SELECT id FROM users WHERE is_bot = 1 AND id NOT IN (SELECT founder_id FROM securities WHERE founder_id IS NOT NULL) AND id NOT IN (SELECT user_id FROM orders WHERE status = 'open') ORDER BY id").all().map((r) => r.id);
const newsCount = () => db.prepare("SELECT COUNT(*) c FROM news WHERE kind IN ('news','rumor')").get().c;
const value = (r) => r.trades.reduce((s, t) => s + t.price * t.amount, 0);

// Geldmenge: alle Konten (auch Staat, Admin, eingefrorene) + Pool + in offenen Kauf-Orders gebundenes Geld.
function money() {
  const cash = db.prepare('SELECT COALESCE(SUM(cash),0) c FROM users').get().c;
  const escrow = db.prepare("SELECT COALESCE(SUM(price*(amount-filled)),0) c FROM orders WHERE status='open' AND side='buy'").get().c;
  return { cash, escrow, pool: pool(), total: cash + escrow + pool() };
}

// Bots im Testspiel-Modus ohne Handel (activity 0) mit Fake-Uhr. selfPays = wie oft der Runner selbst gezahlt hat.
const self = { pays: 0 };
function startBots() {
  self.pays = 0;
  const repo = { ...bots.buildRepo(), pay: (ids, amount) => { self.pays++; for (const id of ids) db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(amount, id); } };
  bots.start(true, { now: () => clock.t, repo });
}
// Eine Wanduhr-Sekunde: Bot-Takt (alle bot_tick_sec), dann die Job-Takte wie die 1000-ms-Timer.
let wallSec = 0;
function second({ withBots = false, tickSec = 3, news = true } = {}) {
  clock.t += 1000; wallSec++;
  if (withBots && wallSec % tickSec === 0) bots.tick();
  jobs.tickIncome();
  if (news) jobs.tickNews();
}
const run = (sec, o) => { for (let i = 0; i < sec; i++) second(o); };
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Auf die echte Uhr umschalten: die Fake-Uhr steht durch frühere Tests vor der wirklichen Zeit — ohne Abgleich
// ginge die Sim-Zeit jedes Takt zurück und der Generator verlöre jede Tagesreferenz (Harness-Fehler, kein Produkt-Fehler).
const realClock = () => { clock.t = realNow.call(Date); Date.now = realNow; };
const fakeClock = () => { Date.now = () => clock.t; };

beforeEach(() => {
  jobs.stopJobs();
  jobs.state.timers = [];
  bots.stop(true);
  SET({ bot_fast: 0, income_sim_scale: 1, income_sec: 3600, income_cent: 100000, fee_cent: 2000, bot_fee_cent: 0,
    fee_recycle_pct: 100, fee_pool_cent: 0, news_interval_sec: 60, bot_activity: 0, bot_tick_sec: 3 });
  db.prepare("UPDATE users SET frozen = 0 WHERE role = 'user'").run();
  jobs.state.last_income = clock.t;
  newsgen.reset();
});

// ---------------------------------------------------------------- Geld-Erhaltung

test('Q1 Geld-Erhaltung: 200 Orders mit Gebühren + 20 Auszahlungen (0/50/100 %) lassen die Geldmenge konstant', () => {
  const rnd = mulberry32(20261127);
  const trader = [newUser(5_000_000), newUser(4_000_000), newUser(3_000_000), newUser(5_000_000, true), newUser(4_000_000, true), newUser(6_000_000)];
  const m0 = money();
  const nA = activeIds().length;
  assert.equal(m0.pool, 0, 'Pool zu Beginn leer');
  const pcts = [100, 0, 50];
  let placed = 0, fees = 0, executed = 0, rejected = 0, payouts = 0;
  while (placed < 200) {
    const u = trader[Math.floor(rnd() * trader.length)];
    const secId = firstSec();
    const last = engine.books.get(secId).last;
    const kind = rnd();
    const amount = 1 + Math.floor(rnd() * 12);
    const price = Math.max(10, Math.round(last * (0.9 + rnd() * 0.2) / 10) * 10);
    const open = db.prepare("SELECT id FROM orders WHERE user_id = ? AND status='open'").all(u.id);
    let r = null;
    placed++;
    try {
      if (kind < 0.30) r = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'market', amount });
      else if (kind < 0.55) r = engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'market', amount });
      else if (kind < 0.80) r = engine.placeOrder(fresh(u), { security_id: secId, side: 'buy', type: 'limit', amount, price });
      else r = engine.placeOrder(fresh(u), { security_id: secId, side: 'sell', type: 'limit', amount, price });
      if (r.order.status !== 'open' || r.trades.length) executed++;
    } catch (e) { rejected++; }
    if (r && r.order.status === 'open' && rnd() < 0.3) engine.cancelOrder(fresh(u), r.order.id);
    if (open.length && rnd() < 0.2) { try { engine.cancelOrder(fresh(u), open[0].id); } catch { /* schon weg */ } }
    if (placed % 10 === 0) {
      const pct = pcts[(placed / 10) % 3];
      SET({ fee_recycle_pct: pct });
      const before = pool(), ids = activeIds(), sum0 = ids.map(cashOf).reduce((a, b) => a + b, 0);
      fees += before;
      jobs.payIncome(); payouts++;
      const share = Math.floor(before * pct / 100 / ids.length);
      assert.equal(ids.map(cashOf).reduce((a, b) => a + b, 0) - sum0, 100000 * ids.length + share * ids.length, `Zahlung ${payouts} (${pct} %): Einkommen + gleicher Anteil an alle aktiven Konten`);
      assert.equal(pool(), before - share * ids.length, `Zahlung ${payouts}: Pool sinkt genau um die ausgezahlten Anteile`);
      assert.ok(pool() >= 0, 'Pool nie negativ');
    }
    const m = money();
    assert.equal(m.total, m0.total + 100000 * nA * payouts, `nach Order ${placed}: Geldmenge ${m.total} = Start ${m0.total} + ausgezahltes Einkommen ${100000 * nA * payouts} (Pool ${m.pool})`);
  }
  assert.ok(executed >= 60, `Vorbedingung: genug ausgeführte Orders (${executed}, abgelehnt ${rejected})`);
  assert.ok(fees > 0, `Vorbedingung: Gebühren sind geflossen (Pool vor den Auszahlungen, summiert ${fees} Cent)`);
});

test('Q2 Auszahlung: 100 % leert den Pool bis auf den unteilbaren Rest, 0 % lässt ihn stehen, 50 % die Hälfte', () => {
  newUser(); newUser();
  const ids = activeIds();
  SET({ fee_pool_cent: 123457, fee_recycle_pct: 100 });
  let b0 = ids.map(cashOf);
  jobs.payIncome();
  assert.ok(pool() >= 0 && pool() < ids.length, `100 %: Rest ${pool()} ist kleiner als die Zahl der Konten`);
  assert.deepEqual(ids.map(cashOf), b0.map((c) => c + 100000 + Math.floor(123457 / ids.length)), 'gleichmäßige Verteilung');
  SET({ fee_pool_cent: 123457, fee_recycle_pct: 0 });
  b0 = ids.map(cashOf);
  jobs.payIncome();
  assert.equal(pool(), 123457, '0 %: Pool unangetastet');
  assert.deepEqual(ids.map(cashOf), b0.map((c) => c + 100000), '0 %: nur Einkommen');
  SET({ fee_pool_cent: 123457, fee_recycle_pct: 50 });
  b0 = ids.map(cashOf);
  jobs.payIncome();
  const half = Math.floor(123457 * 50 / 100 / ids.length);
  assert.equal(pool(), 123457 - half * ids.length, '50 %: Pool minus die ausgezahlten Anteile');
  assert.deepEqual(ids.map(cashOf), b0.map((c) => c + 100000 + half), '50 %: Einkommen + halber Anteil');
  SET({ fee_pool_cent: 3, fee_recycle_pct: 100 });
  jobs.payIncome();
  assert.equal(pool(), 3, 'Pool 3 Cent: bleibt liegen, wird nie negativ');
});

// ---------------------------------------------------------------- Timing (Fake-Uhr)

test('Q3 Wanduhr: genau eine Zahlung je income_sec, income_sec = 0 ist aus', () => {
  const u = newUser();
  const c0 = cashOf(u.id);
  SET({ income_sec: 7 });
  run(6);
  assert.equal(cashOf(u.id), c0, '6 s: nichts');
  second();
  assert.equal(cashOf(u.id), c0 + 100000, '7 s: erste');
  run(6);
  assert.equal(cashOf(u.id), c0 + 100000, '13 s: weiter eine');
  second();
  assert.equal(cashOf(u.id), c0 + 200000, '14 s: zweite');
  assert.equal(jobs.incomeNextAt(), jobs.state.last_income + 7000);
  SET({ income_sec: 0 });
  run(30);
  assert.equal(cashOf(u.id), c0 + 200000, 'aus: nichts mehr');
  assert.equal(jobs.incomeIntervalMs(), null);
  assert.equal(jobs.incomeNextAt(), null);
});

test('Q4 Fast, income_sim_scale = 1: Spielrhythmus ×100, ohne Runner zahlt der Job auch den Bots', () => {
  const p = newUser(), b = newUser(1000, true);
  SET({ bot_fast: 1, income_sim_scale: 1 });
  assert.equal(jobs.simScale(), 100);
  assert.equal(jobs.incomeIntervalMs(), 36000);
  run(35, { news: false });
  assert.equal(cashOf(p.id), 1_000_000, '35 s: nichts');
  second({ news: false });
  assert.equal(cashOf(p.id), 1_100_000, '36 s = 1 Spielstunde');
  assert.equal(cashOf(b.id), 101000, 'Bot: dieselbe Zahlung');
});

test('Q5 Fast, income_sim_scale = 0: Einkommen bleibt auf der Wanduhr', () => {
  const p = newUser(), b = newUser(1000, true);
  SET({ bot_fast: 1, income_sim_scale: 0, income_sec: 5 });
  assert.equal(jobs.simScale(), 1);
  run(4, { news: false });
  assert.equal(cashOf(p.id), 1_000_000);
  second({ news: false });
  assert.equal(cashOf(p.id), 1_100_000, 'nach 5 Wanduhr-s');
  assert.equal(cashOf(b.id), 101000, 'Bot: dito');
});

// Mit laufendem Bot-Runner. Erwartung aus dem Plan (E003/V3/V5): Fast = Faktor 100 auf die Spieluhr der Bots,
// income_sim_scale 0 = Wanduhr — und für alle Trader dieselbe Spieluhr: Bots und Spieler bekommen das Einkommen
// im selben Rhythmus. income_sec = 360 s → im Fast-Modus mit Faktor 100 alle 3,6 Wanduhr-s eine Zahlung.
// Nur 0 und 1: income_sim_scale ist seit dem T4-Review ein Schalter (PUT /admin/settings liefert für 0,5 → 400, Test (i) deckt das);
// 0,5 direkt per setSetting wäre ein Zustand, den kein Admin herstellen kann.
// scale 0: Bots laufen mit dem Job auf der WANDUHR (Entscheidung in bots.js 17:10: vorher bekamen Bots je 36 s, Schüler je Stunde);
// in 36 s mit income_sec 360 wird daher niemand gezahlt — der Rhythmus steht in Q8.
for (const [scale, expBot, expPlayer, label] of [[1, 10, 10, '1'], [0, 0, 0, '0']]) {
  test(`Q6 Fast × income_sim_scale ${label} × Bots laufen (36 Wanduhr-s = 10 Spielstunden): Bot ${expBot}, Spieler ${expPlayer} Zahlungen ±1, keine Doppelzahlung`, () => {
    const p = newUser(), own = newUser(1000, true);
    SET({ bot_fast: 1, income_sim_scale: scale, income_sec: 360 });
    jobs.state.timers = [1]; // der Einkommens-Job läuft, wie im Betrieb
    startBots();
    try {
      const ids = plainBots();
      assert.ok(ids.length >= 3, `Vorbedingung: ${ids.length} Bots ohne eigene Firma`);
      const b0 = ids.map(cashOf), p0 = cashOf(p.id), o0 = cashOf(own.id);
      run(36, { withBots: true, news: false });
      const pays = (id, c0) => (cashOf(id) - c0) / 100000;
      const botPays = pays(ids[0], b0[0]);
      const vert = {};
      for (let i = 0; i < ids.length; i++) { const k = pays(ids[i], b0[i]); vert[k] = (vert[k] || 0) + 1; }
      assert.ok(ids.every((id, i) => pays(id, b0[i]) === botPays), `alle Bots gleich (${botPays} Zahlungen), Verteilung ${JSON.stringify(vert)}`);
      const plPays = pays(p.id, p0);
      assert.ok(Math.abs(botPays - expBot) <= 1, `Bots: ${botPays} Zahlungen in 10 Spielstunden (erwartet ${expBot})`);
      assert.ok(Math.abs(plPays - expPlayer) <= 1, `Spieler: ${plPays} Zahlungen in 10 Spielstunden Fast (erwartet ${expPlayer})`);
      assert.equal(pays(own.id, o0), botPays, 'einzelnes Bot-Konto wie die Runner-Bots');
      // Der Pool-Anteil erreicht die Bots in jeder Kombination (zahlt der Runner das Einkommen, kommt nur der Anteil).
      SET({ fee_pool_cent: 3600 * activeIds().length });
      const sum0 = cashOf(ids[0]);
      jobs.payIncome();
      assert.equal(pool(), 0, 'Pool danach leer');
      // Keine Doppelzahlung: zahlt der Job (scale 1), zahlt der Runner gar nicht; zahlt der Runner (scale 0), kommt vom Job kein Einkommen dazu.
      if (scale === 1) assert.equal(self.pays, 0, 'scale 1: der Runner zahlt nichts zusätzlich, der Job hat alles gezahlt');
      else { assert.equal(botPays, plPays, 'scale 0: Bots (Runner, Wanduhr) und Spieler (Job, Wanduhr) im selben Rhythmus'); }
    } finally { bots.stop(true); jobs.state.timers = []; }
  });
}

test('Q7 Wechsel income_sim_scale 1 → 0 → 1 mit laufenden Bots: ein Rhythmus für alle, je Takt höchstens eine Zahlung, kein Nachhole-Schub', () => {
  // Der Job zahlt nach einem Raster (jobs.js: Anker rückt je Zahlung um genau ein Intervall). Mit 1,8 s Intervall auf 1-s-Takten
  // liegen Einzelabstände bei 1–2 s — gemessen wird daher die Zahl der Zahlungen je Phase, nicht jeder Abstand.
  const p = newUser();
  SET({ bot_fast: 1, income_sim_scale: 1, income_sec: 180 }); // scale 1: im Mittel alle 1,8 s; scale 0: alle 180 s Wanduhr
  jobs.state.timers = [1];
  startBots();
  try {
    const bot = plainBots()[0];
    const phase = [];
    let cB = cashOf(bot), cP = cashOf(p.id), pB = cB, pP = cP;
    const perSec = { bot: new Map(), player: new Map() };
    for (let sec = 0; sec < 300; sec++) {
      if (sec === 80 || sec === 200) { phase.push([cashOf(bot) - cB, cashOf(p.id) - cP]); cB = cashOf(bot); cP = cashOf(p.id); SET({ income_sim_scale: sec === 80 ? 0 : 1 }); }
      second({ withBots: true, news: false });
      for (const [k, now] of [['bot', cashOf(bot)], ['player', cashOf(p.id)]]) {
        const prev = k === 'bot' ? pB : pP;
        if (now !== prev) { perSec[k].set(sec, (perSec[k].get(sec) || 0) + (now - prev) / 100000); }
        if (k === 'bot') pB = now; else pP = now;
      }
    }
    phase.push([cashOf(bot) - cB, cashOf(p.id) - cP]);
    const [p1, p2, p3] = phase.map((x) => x.map((v) => v / 100000));
    assert.ok(Math.abs(p1[1] - 80 / 1.8) <= 1 && p1[0] === p1[1], `Phase 1 (80 s, scale 1): Spieler ${p1[1]} Zahlungen (erwartet 44), Bots ${p1[0]}`);
    // Beim Wechsel führt der Runner die angelaufene Bot-Periode auf der neuen Uhr fort (bots.js): höchstens EINE Zahlung je Bot am Anfang,
    // danach 180 s Ruhe — Spieler bekommen in der Phase nichts.
    assert.deepEqual([p2[0] <= 1, p2[1]], [true, 0], `Phase 2 (120 s, scale 0, Periode 180 s): Spieler nichts, Bots höchstens eine — Bots ${p2[0]}, Spieler ${p2[1]}`);
    // Beim Zurückschalten auf scale 1 zahlt der Job den Bots die fällige Zahlung bewusst nicht (jobs.js: „erst nach einer vollen Periode“) —
    // höchstens eine Zahlung Unterschied je Wechsel, keine Doppelzahlung.
    assert.ok(Math.abs(p3[1] - 100 / 1.8) <= 1 && Math.abs(p3[0] - p3[1]) <= 1, `Phase 3 (100 s, scale 1): Spieler ${p3[1]} (erwartet 56), Bots ${p3[0]}`);
    for (const [k, m] of Object.entries(perSec)) for (const [sec, n] of m) assert.equal(n, 1, `${k}: in Sekunde ${sec} ${n} Zahlungen — je Takt nur eine`);
  } finally { bots.stop(true); jobs.state.timers = []; }
});

test('Q8 Fast × income_sim_scale 0 mit laufenden Bots: Bots und Spieler zahlen im Wanduhr-Rhythmus des Jobs, niemand doppelt', () => {
  // scale 0 heißt Wanduhr für alle (bots.js 17:10): der Runner zahlt nicht selbst; income_sec 3 → alle 3 Wanduhr-s.
  const p = newUser();
  SET({ bot_fast: 1, income_sim_scale: 0, income_sec: 3 });
  jobs.state.timers = [1];
  startBots();
  try {
    const ids = plainBots();
    assert.ok(ids.length >= 3, `Vorbedingung: ${ids.length} Bots`);
    const b0 = ids.map(cashOf), p0 = cashOf(p.id);
    run(36, { withBots: true, news: false });
    const botPays = (cashOf(ids[0]) - b0[0]) / 100000, plPays = (cashOf(p.id) - p0) / 100000;
    // scale 0 mit laufenden Bots: der RUNNER zahlt den Bots auf der Wanduhr, der Job lässt ihnen das Einkommen (nur Pool-Anteil).
  assert.ok(self.pays >= 11, `der Runner hat ${self.pays} Mal gezahlt`);
    // Die Periode des Runners beginnt mit seinem ersten Takt, die des Jobs mit dem letzten Wechsel: höchstens eine Zahlung Versatz.
    assert.ok(Math.abs(botPays - plPays) <= 1, `Bots ${botPays} und Spieler ${plPays}: gleiche Zahl von Zahlungen ±1`);
    assert.ok(plPays >= 11 && plPays <= 12, `12 Wanduhr-Perioden à 3 s: ${plPays} Zahlungen`);
  } finally { bots.stop(true); jobs.state.timers = []; }
});

// ---------------------------------------------------------------- Timing (echte Uhr)

test('Q9 echte Uhr, Wanduhr, income_sec 3: Zahlungen alle 3 s ab dem ersten Takt; nach stopJobs()+startJobs() keine Doppelzahlung', { timeout: 60000 }, async () => {
  const u = newUser();
  SET({ income_sec: 3, news_interval_sec: 0 });
  realClock();
  jobs.startJobs();
  const count = () => (cashOf(u.id) - 1_000_000) / 100000;
  // Seit jobs.js (16:54) beginnt die erste Periode mit dem ERSTEN TAKT nach dem Start (Hochfahren blockiert sonst die Uhr);
  // gemessen wird deshalb ab diesem Takt. Er steht in state.last_income, bis die erste Zahlung den Anker weiterrückt.
  const firstTick = async () => { const l0 = jobs.state.last_income; while (jobs.state.last_income === l0) await sleep(50); return realNow(); };
  const waitPays = async (n, maxMs) => { const e = realNow() + maxMs; while (count() < n && realNow() < e) await sleep(100); return realNow(); };
  try {
    const tT = await firstTick();
    const t1 = await waitPays(1, 8000), t2 = await waitPays(2, 8000);
    assert.ok(t1 - tT >= 2900 && t1 - tT <= 4500, `1. Zahlung ${t1 - tT} ms nach dem ersten Takt`);
    assert.ok(t2 - t1 >= 2900 && t2 - t1 <= 4500, `2. Zahlung ${t2 - t1} ms nach der ersten`);
    // Neustart des Jobs: die Periode beginnt neu, es wird nichts nachgezahlt.
    jobs.stopJobs();
    jobs.startJobs();
    const tR = await firstTick(), c = count();
    await sleep(2500);
    assert.equal(count(), c, '2,5 s nach Neustart: keine Zahlung, kein Nachholen');
    const t3 = await waitPays(c + 1, 6000), t4 = await waitPays(c + 2, 6000);
    assert.ok(t3 - tR >= 2900 && t3 - tR <= 4500, `nach Neustart erste Zahlung ${t3 - tR} ms nach dem ersten Takt`);
    assert.ok(t4 - t3 >= 2900 && t4 - t3 <= 4500, `danach im Rhythmus (${t4 - t3} ms)`);
    assert.equal(count(), c + 2, 'insgesamt keine Doppelzahlung');
  } finally { jobs.stopJobs(); fakeClock(); }
});

test('Q10 echte Uhr, Fast × scale 1, income_sec 5: Zahlung jedes 1000-ms-Takt (Intervall 50 ms), ohne Doppelung je Takt', { timeout: 30000 }, async () => {
  const u = newUser();
  SET({ bot_fast: 1, income_sim_scale: 1, income_sec: 5, news_interval_sec: 0 });
  realClock();
  jobs.startJobs();
  try {
    await sleep(3450);
    const pays = (cashOf(u.id) - 1_000_000) / 100000;
    assert.ok(pays >= 2 && pays <= 3, `nach 3,45 s: 2–3 Zahlungen, eine je Takt (tatsächlich ${pays})`);
  } finally { jobs.stopJobs(); fakeClock(); }
});

// ---------------------------------------------------------------- chargeFee

test('Q11 chargeFee: Spieler fee_cent, Bot bot_fee_cent (0 → fee_cent); der Pool enthält genau das Abgebuchte', () => {
  const secId = firstSec();
  const one = (u, side = 'buy') => {
    const p0 = pool(), c = cashOf(u.id);
    const r = engine.placeOrder(fresh(u), { security_id: secId, side, type: 'market', amount: 1 });
    const fee = side === 'buy' ? c - cashOf(u.id) - value(r) : c + value(r) - cashOf(u.id);
    return { fee, pool: pool() - p0, filled: r.trades.length };
  };
  const s = newUser(), b = newUser(1_000_000, true);
  for (const x of [one(s), one(b)]) { assert.deepEqual([x.fee, x.filled >= 1], [2000, true], 'Default: fee_cent, Order ausgeführt'); assert.ok(x.pool >= x.fee && (x.pool - x.fee) % 2000 === 0, `Pool +${x.pool}: eigene Gebühr ${x.fee} + ggf. Gegenseite`); }
  SET({ bot_fee_cent: 700 });
  { const a = one(s), c = one(b); assert.deepEqual([a.fee, c.fee], [2000, 700], 'bot_fee_cent 700: nur der Bot'); assert.ok(c.pool >= 700, 'Bot-Gebühr im Pool'); }
  SET({ bot_fee_cent: 0 });
  assert.deepEqual([one(s, 'sell').fee, one(b, 'sell').fee], [2000, 2000], 'Verkauf: Gebühr ebenso');
});

test('Q12 chargeFee, Konto mit wenig Cash: Gebühr und Kaufpreis bringen das Konto nie unter null', () => {
  const secId = firstSec();
  const one = () => engine.walkBook(engine.books.get(secId), 'buy', 1, { ignoreUserId: -1 }).gross; // Preis für genau 1 Stück
  // (a) Spieler, exakt genug für 1 Stück + Gebühr: danach genau 0.
  const s = newUser(one() + 2000);
  engine.placeOrder(fresh(s), { security_id: secId, side: 'buy', type: 'market', amount: 1 });
  assert.equal(cashOf(s.id), 0, 'Spieler: Kontostand genau null');
  // (b) Bot mit eigenem Satz ÜBER fee_cent (50 Cr statt 20 Cr). Ob die Vorprüfung den höheren Satz kennt oder nicht:
  // das Konto darf nie ins Minus rutschen.
  SET({ bot_fee_cent: 5000 });
  for (const extra of [3000, 5000]) {
    const b = newUser(one() + extra, true);
    let executed = false;
    try { executed = engine.placeOrder(fresh(b), { security_id: secId, side: 'buy', type: 'market', amount: 1 }).trades.length > 0; } catch (e) { /* abgelehnt */ }
    assert.ok(cashOf(b.id) >= 0, `Bot mit ${extra} Cent über dem Stückpreis (Satz ${5000}, fee_cent 2000): ausgeführt ${executed}, Kontostand danach ${cashOf(b.id)}`);
  }
  // (c) Bot, Satz weit über dem Cash: Aufträge mit weniger Cash als Stück + Satz dürfen nicht ins Minus führen.
  SET({ bot_fee_cent: 100_000_000 });
  const b2 = newUser(200_000, true);
  const p0 = pool();
  let fee = 0;
  try { const r = engine.placeOrder(fresh(b2), { security_id: secId, side: 'buy', type: 'market', amount: 1 }); fee = 200_000 - cashOf(b2.id) - value(r); } catch (e) { /* abgelehnt */ }
  assert.equal(pool() - p0, fee, 'Pool = genau die abgebuchte Gebühr');
  assert.ok(cashOf(b2.id) >= 0, `Bot (Satz weit über Cash): Kontostand ${cashOf(b2.id)}`);
});

test('Q13 chargeFee: eine Order zahlt genau einmal — auch mit Teilfüllung über mehrere Gegenorder', () => {
  const secId = firstSec();
  SET({ fee_pool_cent: 0 });
  engine.mmRefreshAll();
  const depth = engine.books.get(secId).asks.reduce((a, o) => a + (o.amount - o.filled), 0);
  const amount = Math.min(12, depth);
  assert.ok(amount >= 2, `Vorbedingung: ${depth} Stück im Angebot`);
  const buyer = newUser(10_000_000);
  const p0 = pool();
  const r = engine.placeOrder(fresh(buyer), { security_id: secId, side: 'buy', type: 'market', amount });
  const buyerFee = 10_000_000 - cashOf(buyer.id) - value(r);
  assert.ok(r.trades.length >= 1, `Vorbedingung: ${r.trades.length} Füllungen`);
  assert.equal(buyerFee, 2000, `Käufer: eine Gebühr für ${r.trades.length} Füllungen`);
  // Pool: jede Gebühr ist 2000 (bot_fee_cent 0) — die Käufer-Gebühr plus je getroffener zahlpflichtiger Order genau eine.
  const delta = pool() - p0;
  assert.ok(delta >= buyerFee && (delta - buyerFee) % 2000 === 0, `Pool +${delta}: Käufer-Gebühr ${buyerFee}, dazu nur ganze Gegenseite-Gebühren`);
});

// ---------------------------------------------------------------- News (Fake-Uhr)

// E018 (PLAN, Nachtrag 27.11.) ersetzt V5: Auto-News sind EREIGNISGETRIEBEN, kein Zufalls-Ticker. Die Vorgabe
// „1 News je 60 Sim-Sekunden“ aus dem QA-Auftrag gilt damit nicht mehr; geprüft wird, was E018 verspricht:
// ruhender Markt → nichts; Kurs über Schwelle → eine News je Schwelle, im nächsten Takt; nie ein Schwarm.
// ANNAHME: Standardstufen der Kursmeldung sind 5 %, 10 %, 20 % (news_move_steps nicht gesetzt).
function pushStock(minPct) {
  const secId = firstSec();
  const rich = newUser(500_000_000);
  let chg = 0;
  for (let i = 0; i < 300 && chg * 100 < minPct; i++) {
    const row = engine.tickerAll().find((r) => r.id === secId);
    chg = row.last / row.ref - 1;
    if (chg * 100 >= minPct) break;
    try { engine.placeOrder(fresh(rich), { security_id: secId, side: 'buy', type: 'market', amount: 5 }); } catch { break; }
  }
  return { secId, chgPct: Math.round(chg * 10000) / 100 };
}

// E018 (PLAN, Nachtrag 27.11.) ersetzt V5: Auto-News sind EREIGNISGETRIEBEN, kein Zufalls-Ticker. Die Vorgabe
// „1 News je 60 Sim-Sekunden“ aus dem QA-Auftrag gilt damit nicht mehr (Hinweis des Orchestrators). Geprüft wird
// über den T4-News-Tick (jobs.tickNews / echter Timer), was E018 verspricht: ruhender Markt → nichts;
// Kurs über 5 % und 10 % → genau zwei News zu dieser Aktie; Pendeln um die Schwelle → keine dritte.
// Kurs eines Wertes auf `f` relativ zur Tagesreferenz setzen (so rechnet auch der Ticker; Vorbild newsevents.test.js).
function setz(secId, f) {
  const b = engine.books.get(secId);
  b.last = Math.round(engine.tickerRow(secId).ref * f * 1000) / 1000;
  b.ver++;
}
const stockIds = () => db.prepare("SELECT id FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all().map((r) => r.id);
const total0 = (sinceId) => db.prepare('SELECT COUNT(*) c FROM news WHERE id > ?').get(sinceId).c;
const newsFor = (secId, sinceId) => db.prepare("SELECT * FROM news WHERE id > ? AND kind = 'news' AND security_id = ? ORDER BY id").all(sinceId, secId);
const lastId = () => db.prepare('SELECT COALESCE(MAX(id),0) c FROM news').get().c;

test('Q14 News (E018): ruhender Markt bringt in 10 Minuten keine Auto-News — Normal und Fast (Fake-Uhr)', () => {
  for (const id of stockIds()) setz(id, 1.0); // alle Aktien auf der Tagesreferenz: frühere Tests haben Kurse bewegt
  let c = newsCount(), cId = lastId();
  run(600);
  assert.equal(newsCount(), c, `Normal, 10 Sim-Minuten ohne Kursbewegung: keine Auto-News — kam: ${JSON.stringify(db.prepare("SELECT kind, title, security_id, impact FROM news WHERE id > ? ORDER BY id").all(cId))}`);
  SET({ bot_fast: 1, income_sim_scale: 1 });
  c = newsCount();
  run(600); // 10 Wanduhr-Minuten = 1000 Sim-Minuten
  assert.equal(newsCount(), c, 'Fast, 10 Wanduhr-Minuten ohne Kursbewegung: keine Auto-News');
});

test('Q15 News (E018): Aktie auf +12 % → genau zwei News (Stufen 5 % und 10 %); Pendeln um 10 % → keine dritte', () => {
  const [id] = stockIds();
  const since = lastId();
  let f = 1.0;
  for (let tick = 0; tick < 10; tick++) { setz(id, f); second(); } // 10 ruhige Sekunden
  assert.equal(newsFor(id, since).length, 0, 'ruhig: nichts');
  for (const x of [1.03, 1.06, 1.09, 1.12]) { setz(id, x); second(); } // Lauf über beide Stufen
  let rows = newsFor(id, since);
  assert.equal(rows.length, 2, `genau zwei News für die Aktie (${rows.map((r) => r.title).join(' | ')})`);
  assert.ok(rows.every((r) => Number.isInteger(r.impact) && r.impact >= 0 && r.impact <= 1), `Wirkung 0…1: ${rows.map((r) => r.impact)}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM news WHERE id > ?').get(since).c, 2, 'keine anderen News daneben');
  for (let tick = 0; tick < 600; tick++) { setz(id, tick % 2 ? 1.095 : 1.105); second(); } // 10 Minuten um die 10-%-Schwelle pendeln
  assert.equal(newsFor(id, since).length, 2, 'Pendeln: keine dritte Meldung');
  for (const x of [1.06, 1.03, 1.0]) { setz(id, x); second(); } // zurück unter die Hälfte der Stufen: Sperren frei
  for (const x of [1.06, 1.12]) { setz(id, x); second(); }
  assert.equal(newsFor(id, since).length, 4, 'nach Rückfall unter 2,5 % meldet ein neuer Lauf wieder (zwei News)');
});

test('Q15b News (E018), Fast 6 Wanduhr-Minuten (= 10 Sim-Stunden) mit Drehbuch: News entstehen auf der Spieluhr, nie ein Schwarm je Takt, Ruhe → nichts', () => {
  const [a, b] = stockIds();
  const since = lastId();
  SET({ bot_fast: 1, income_sim_scale: 1 });
  let maxPerTick = 0, quietTail = 0;
  const trig = [], tailRumors = [];
  const origOnce = newsgen.once; // der Trigger steht nur auf dem Rückgabewert des Generators, nicht in der Tabelle
  newsgen.once = (...x) => { const rows = origOnce.apply(newsgen, x); trig.push(...rows); return rows; };
  try { for (let s = 0; s < 600; s++) {
    const min = s / 100; // Wanduhr-Sekunden in Sim-Minuten
    setz(a, min < 1 ? 1.0 : min <= 1.2 ? 1.0 + 0.12 * ((min - 1) / 0.2) : min < 5 ? (s % 2 ? 1.095 : 1.105) : 1.0);
    setz(b, min < 3 ? 1.0 : min <= 3.3 ? 1.0 - 0.22 * ((min - 3) / 0.3) : 0.78); // der Absturz bleibt stehen: eine Erholung um +28 % wäre selbst ein Ausreißer und rechtens eine News
    const x = newsCount(), id0 = lastId();
    second();
    const neu = newsCount() - x;
    maxPerTick = Math.max(maxPerTick, neu);
    if (min >= 5) { // Gerüchte dürfen auch später noch kommen (E018 d)
      quietTail += db.prepare("SELECT COUNT(*) c FROM news WHERE id > ? AND kind = 'news'").get(id0).c;
      tailRumors.push(...trig.filter((r) => r.id > id0 && r.kind === 'rumor'));
    }
  }
  } finally { newsgen.once = origOnce; }
  const TRIGGERS = /^(move:(pos|neg):(5|10|20)|mood:(index|breite):(pos|neg)|rumor:(pos|neg))$/;
  assert.ok(trig.length >= 5 && trig.every((r) => TRIGGERS.test(r.trigger)), `je News ein gültiger Trigger aus den Daten: ${trig.map((r) => r.trigger).join(',')}`);
  assert.equal(trig.length, total0(since), 'je Zeile in der Tabelle ein Trigger vom Generator');
  const total = db.prepare('SELECT COUNT(*) c FROM news WHERE id > ?').get(since).c;
  assert.ok(total >= 5 && total <= 12, `Drehbuch (ein Lauf +12 %, ein Absturz −22 %): ${total} News: ${trig.map((r) => r.trigger).join(',')}`);
  assert.equal(newsFor(a, since).length, 2, 'Lauf: zwei News');
  // E018/E019: ALLE Ausreißer-Stufen wirken 0 — gleichgerichtete Wirkung würde die Kette verstärken; nur das Gerücht trägt ±1.
  assert.deepEqual(newsFor(b, since).map((r) => r.impact), [0, 0, 0], 'Absturz: drei Stufen, alle ohne Wirkung');
  assert.ok(newsFor(a, since).every((r) => r.impact === 0), 'Lauf: beide Stufen ohne Wirkung');
  assert.ok(maxPerTick <= 10, `höchstens ${maxPerTick} News in einem Takt`);
  // Der Absturz bleibt stehen: der Markt ist danach nicht „ruhig“ — eine Stimmungs-News (Index) ist dann datengetrieben richtig.
  for (const r of trig.filter((x) => x.kind === 'news' && !x.trigger.startsWith('move:'))) { assert.equal(r.security_id, null, `Stimmungs-News ${r.trigger} ohne Aktie`); assert.equal(Math.abs(r.impact), 1); }
  for (const r of tailRumors) {
    assert.equal(r.kind, 'rumor', `in der Ruhe nur Gerüchte (${r.trigger})`);
    assert.ok([a, b].includes(r.security_id) && Math.abs(r.impact) === 1, `Gerücht ${r.trigger}: Wirkung ±1 in Text-Richtung, zu einem bewegten Wert`);
  }
});

test('Q15c News: Wechsel des Zeitmaßstabs im Lauf (Fast 1 → 0) — Sim-Zeit ohne Rücklauf, keine Lawine', () => {
  SET({ bot_fast: 1, income_sim_scale: 1 });
  run(30);
  SET({ income_sim_scale: 0 });
  const t1 = jobs.simNow(clock.t);
  clock.t += 1000;
  const t2 = jobs.simNow(clock.t);
  assert.ok(t2 >= t1, 'Sim-Zeit läuft nach dem Wechsel weiter, nicht rückwärts');
  assert.ok(t2 - t1 <= 1000 * 100 + 1, `Sprung der Sim-Zeit beim Wechsel: ${t2 - t1} ms`);
  const c = newsCount();
  run(60);
  assert.ok(newsCount() - c <= 10, `erste Minute nach dem Wechsel: ${newsCount() - c} News`);
});

test('Q16 News-Tick läuft nach einem Fehler weiter (echte Uhr, echter Timer)', { timeout: 60000 }, async () => {
  SET({ bot_fast: 1, income_sim_scale: 1, news_interval_sec: 60 });
  const [id] = stockIds();
  const since = lastId();
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let boom = 2;
  const origOnce = newsgen.once;
  newsgen.once = (...a) => { if (boom-- > 0) throw new Error('QA-News-Boom'); return origOnce.apply(newsgen, a); };
  try {
    realClock();
    jobs.startJobs();
    const until = async (n, maxMs) => { let w = 0; while (newsFor(id, since).length < n && w < maxMs) { await sleep(250); w += 250; } return w; };
    for (let w = 0; boom > 0 && w < 10000; w += 100) await sleep(100); // die beiden ersten Takte werfen
    assert.equal(boom, 0, 'zwei Takte sind geworfen');
    await sleep(1300); // der dritte Takt gelingt und nimmt die Anfangsprobe
    // Bezug des Generators ist seit E019 der Kurs von vor 24 SIM-Stunden (im Fast-Modus ~14 Wandminuten zurück), nicht der
    // Wanduhr-Bezug des Tickers. Deshalb wird die Historie in Ruhe gelassen und der Kurs erst danach vom aktuellen Stand
    // aus um 12 % gehoben: der Sprung über 5 % und 10 % in einem Takt meldet genau die höhere Stufe.
    const b = engine.books.get(id), basis = b.last;
    b.last = Math.round(basis * 1.12 * 1000) / 1000; b.ver++;
    const w1 = await until(1, 15000);
    jobs.stopJobs();
    assert.equal(newsFor(id, since).length, 1, `nach zwei geworfenen Takten kommt die News im nächsten guten Takt (${w1} ms); Log: ${errors.join(' | ')}`);
    assert.ok(errors.some((e) => /\[Job news\] Fehler.*QA-News-Boom/.test(e)), `Job-Fehler protokolliert: ${errors.join(' | ')}`);
    assert.ok(errors.length <= 4, `kein Dauerfeuer im Log (${errors.length} Zeilen für 2 geworfene Fehler)`);
  } finally { jobs.stopJobs(); newsgen.once = origOnce; console.error = origErr; fakeClock(); }
});

test('Q17 Einkommens-News: nie bei kurzem Wanduhr-Intervall, ja bei ≥ 60 s', () => {
  const newUser0 = newUser();
  const seen = [];
  bus.on((m) => { if (m.type === 'news' && /Wocheneinkommen/.test(m.news.title)) seen.push(m.news); });
  const n0 = db.prepare("SELECT COUNT(*) c FROM news WHERE title = 'Wocheneinkommen ausgezahlt'").get().c;
  SET({ bot_fast: 1, income_sim_scale: 1, income_sec: 3540 }); // 35,4 s
  run(200, { news: false });
  const short = db.prepare("SELECT COUNT(*) c FROM news WHERE title = 'Wocheneinkommen ausgezahlt'").get().c - n0;
  assert.equal(short, 0, 'Fast: 200 Takte, viele Zahlungen, keine Einkommens-News');
  assert.ok(cashOf(newUser0.id) > 1_000_000, 'Vorbedingung: es wurde gezahlt');
  SET({ bot_fast: 0, income_sec: 60 });
  jobs.state.last_income = clock.t;
  run(60, { news: false });
  assert.ok(db.prepare("SELECT COUNT(*) c FROM news WHERE title = 'Wocheneinkommen ausgezahlt'").get().c > n0, '60 s Wanduhr: News erscheint');
  SET({ income_sec: 0 });
  jobs.payIncome();
  assert.equal(seen.length, short + 1 + 1, 'Events zur manuellen Auszahlung');
});

// ---------------------------------------------------------------- HTTP: POST /admin/news

async function startServer(dbName, extraEnv = {}) {
  // Ein fremder Server auf dem Port würde „OK“ antworten und unser Kind bliebe ohne DB: vorher nachfragen, dann erst starten.
  const frei = await fetch(`${BASE}/api/securities`, { signal: AbortSignal.timeout(800) }).then((r) => false, () => true);
  assert.ok(frei, `Port ${PORT} ist schon belegt — ein anderer Test läuft gerade; kein Server gestartet.`);
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')],
    { cwd: SERVER, env: { ...process.env, PORT: String(PORT), DB_NAME: dbName, ADMIN_PASSWORD: ADMIN.password, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  const stop = async () => {
    if (child.exitCode === null) { const ex = once(child, 'exit'); child.kill('SIGINT'); await ex; }
    return out.join('');
  };
  const end = realNow() + 20000;
  while (realNow() < end) {
    try { if ((await fetch(`${BASE}/api/securities`)).ok) break; } catch { /* noch nicht da */ }
    if (child.exitCode !== null) throw new Error(`Server beendet: ${out.join('')}`);
    await sleep(100);
  }
  return { stop, out };
}
const api = async (method, p, { token, body } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const login = async (username, password) => (await api('POST', '/auth/login', { body: { username, password } })).json?.token;

test('Q18 POST /admin/news: impact −3…3 und rumor an, ungültiges 400, Spieler 403, ohne Login 401', { timeout: 60000 }, async (t) => {
  realClock();
  const srv = await startServer(`${DB_NAME}-http`);
  t.after(async () => { await srv.stop(); rm(`${DB_NAME}-http`); fakeClock(); });
  const admin = await login(ADMIN.username, ADMIN.password);
  assert.ok(admin, 'Admin-Login');
  const reg = await api('POST', '/auth/register', { body: { username: 'qa4spieler', password: 'spiel123' } });
  assert.equal(reg.status, 200, 'Spieler registriert');
  const player = reg.json.token;
  const sec = db.prepare("SELECT id FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id LIMIT 1").get().id;
  assert.ok(Number.isInteger(sec));
  // Spieler und anonym
  const asPlayer = await api('POST', '/admin/news', { token: player, body: { title: 'Spieler versucht News', impact: 3 } });
  assert.equal(asPlayer.status, 403, 'Spieler: 403');
  const anon = await api('POST', '/admin/news', { body: { title: 'Anonym versucht News', impact: 3 } });
  assert.equal(anon.status, 401, 'ohne Login: 401');
  const before = await api('GET', '/news');
  const beforeIds = new Set(before.json.news.map((x) => x.id));
  // gültig
  for (const [body, kind, impact] of [
    [{ title: 'QA Gerücht', body: 'Man munkelt.', kind: 'rumor', impact: -2, security_id: sec }, 'rumor', -2],
    [{ title: 'QA Stimmung stark negativ', impact: -3 }, 'news', -3],
    [{ title: 'QA Stimmung stark positiv', impact: 3 }, 'news', 3],
    [{ title: 'QA ohne Wirkung', impact: 0 }, 'news', 0],
    [{ title: 'QA ohne Feld', body: 'x' }, 'news', 0],
    [{ title: 'QA Bafin', kind: 'bafin', impact: -1 }, 'bafin', -1],
  ]) {
    const r = await api('POST', '/admin/news', { token: admin, body });
    assert.deepEqual([r.status, r.json?.news?.kind, r.json?.news?.impact], [200, kind, impact], JSON.stringify(body));
    assert.ok(Number.isInteger(r.json.news.id) && r.json.news.id > 0, 'News-ID');
  }
  const rumor = (await api('GET', '/news')).json.news.find((x) => x.title === 'QA Gerücht');
  assert.deepEqual([rumor.kind, rumor.impact, rumor.security_id], ['rumor', -2, sec], 'im Feed mit Art, Wirkung und Aktie');
  const board = await api('GET', '/board');
  assert.equal(board.status, 200);
  assert.ok(board.json.news.some((x) => x.title === 'QA Gerücht' && !beforeIds.has(x.id)), '/board liefert die neue News');
  // ungültig
  for (const impact of [4, -4, 10, 1.5, '2', 'abc', {}, [], true]) {
    const r = await api('POST', '/admin/news', { token: admin, body: { title: 'QA ungültig', impact } });
    assert.deepEqual([r.status, r.json?.news], [400, undefined], `impact ${JSON.stringify(impact)} → 400`);
  }
  for (const body of [{ title: 'ab' }, { title: '' }, { title: '   ' }, { body: 'ohne Titel' }, { title: 12 }]) {
    const r = await api('POST', '/admin/news', { token: admin, body });
    assert.equal(r.status, 400, `Titel ${JSON.stringify(body.title)} → 400`);
  }
  const anzahl = db.prepare('SELECT COUNT(*) c FROM news WHERE title LIKE ?').get('QA ungültig').c;
  assert.equal(anzahl, 0, 'abgelehnte News stehen nicht in der DB');
});

// ---------------------------------------------------------------- isolierter Lauf wie ein Admin (echte Uhr, 60 s)

test('Q19 isolierter Lauf 60 s wie ein Admin: Bots per POST /admin/bots/start, Fast an — Log sauber, News, Einkommen, /board', { timeout: 120000 }, async (t) => {
  realClock();
  const name = `${DB_NAME}-run`;
  const srv = await startServer(name);
  t.after(async () => { await srv.stop(); rm(name); fakeClock(); });
  const admin = await login(ADMIN.username, ADMIN.password);
  assert.ok(admin, 'Admin-Login');
  const reg = await api('POST', '/auth/register', { body: { username: 'qa4lauf', password: 'lauf1234' } });
  assert.equal(reg.status, 200);
  const settings = (await api('GET', '/admin/settings', { token: admin })).json.settings;
  assert.equal(settings.income_sim_scale, 0, 'Default income_sim_scale = 0 (Wanduhr, seit dem T4-Review empfohlen)');
  // Gemessen wird hier der Spielrhythmus: Der Admin schaltet income_sim_scale = 1 (Schnelltest mit ×100 Einkommen je Echtzeitstunde).
  const scaled = await api('PUT', '/admin/settings', { token: admin, body: { income_sim_scale: 1 } });
  assert.deepEqual([scaled.status, scaled.json?.settings?.income_sim_scale], [200, 1], 'income_sim_scale = 1 per Admin gesetzt');
  for (const v of [0.5, 2, -1]) assert.equal((await api('PUT', '/admin/settings', { token: admin, body: { income_sim_scale: v } })).status, 400, `income_sim_scale ${v} → 400 (Schalter)`);
  assert.equal((await api('GET', '/admin/settings', { token: admin })).json.settings.income_sim_scale, 1, 'abgelehnte Werte ändern nichts');
  settings.income_sim_scale = 1;
  assert.equal(settings.news_interval_sec, 60, 'Default news_interval_sec = 60');
  const fast = await api('PUT', '/admin/bots/settings', { token: admin, body: { bot_fast: true } });
  assert.equal(fast.status, 200);
  const started = await api('POST', '/admin/bots/start', { token: admin });
  assert.deepEqual([started.status, started.json.running, started.json.fast], [200, true, true], 'Bot-Modus läuft im Fast-Modus');
  const ro = () => new DatabaseSync(path.join(SERVER, 'data', name), { readOnly: true });
  const snap = () => {
    const d = ro();
    try {
      return {
        news: d.prepare("SELECT COUNT(*) c FROM news WHERE kind IN ('news','rumor')").get().c,
        newsId: d.prepare('SELECT COALESCE(MAX(id),0) c FROM news').get().c,
        player: d.prepare('SELECT cash FROM users WHERE username = ?').get('qa4lauf').cash,
        start: d.prepare('SELECT cash FROM users WHERE username = ?').get('qa4lauf').cash,
        bots: d.prepare("SELECT COUNT(*) c FROM users WHERE is_bot = 1").get().c,
        incomes: d.prepare("SELECT COUNT(*) c FROM news WHERE title = 'Wocheneinkommen ausgezahlt'").get().c,
      };
    } finally { d.close(); }
  };
  const s0 = snap();
  // Zahlungen zählen: der Spieler handelt nicht, sein Kontostand ändert sich nur durch Zahlungen (je Takt höchstens eine).
  let last = s0.player, pays = 0, maxJump = 0, lastAt = realNow();
  const gaps = [];
  const samples = [];
  const t0 = realNow();
  while (realNow() - t0 < 60000) {
    await sleep(250);
    const x = snap();
    if (x.player !== last) { if (x.player - last >= settings.income_cent) { pays++; gaps.push(Math.round(realNow() - lastAt)); } maxJump = Math.max(maxJump, x.player - last); last = x.player; lastAt = realNow(); }
    samples.push(x);
  }
  const board = await api('GET', '/board');
  const status = (await api('GET', '/admin/bots', { token: admin })).json;
  const feed = (await api('GET', '/news?limit=100')).json.news;
  const log = await srv.stop();
  const s1 = samples.at(-1);
  assert.ok(s1.bots >= 90, `${s1.bots} Bots angelegt`);
  // E018: News sind ereignisgetrieben — in 60 s sind je nach Kursbewegung 0 oder mehrere richtig; gezählt wird nur, nicht bewertet.
  assert.ok(s1.news - s0.news >= 0, `Generator-News in 60 s Fast: ${s1.news - s0.news}`);
  // Der Trigger steht nicht in der Tabelle; im fremden Server-Prozess ist er nur über die Ausprägung der Zeile prüfbar:
  // move → Aktie gesetzt, rumor → Art rumor; beides mit Wirkung −1…1 und ganzzahlig.
  { const d = ro(); try { const rows = d.prepare("SELECT kind, security_id, impact FROM news WHERE kind IN ('news','rumor') AND id > ?").all(s0.newsId);
    for (const r of rows) { const art = r.kind === 'rumor' ? 'rumor' : r.security_id === null ? 'mood' : 'move'; assert.ok(['move', 'mood', 'rumor'].includes(art), `Art ${art}`); assert.ok(Number.isInteger(r.impact) && Math.abs(r.impact) <= 1, `Wirkung ${r.impact} bei ${art}`); if (art !== 'mood') assert.ok(Number.isInteger(r.security_id) && r.security_id > 0, `${art} braucht die Aktie`); } } finally { d.close(); } }
  const abstaende = gaps.slice(1);
  assert.ok(pays >= 19 && pays <= 20, `Spieler-Einkommen in 60 s Fast: ${pays} Zahlungen je ${settings.income_cent} Cent (Intervall ${settings.income_sec / 100} s, erwartet 19–20; Abstände ms ${abstaende.join(',')})`);
  assert.equal(s1.incomes, s0.incomes, 'keine Einkommens-News im Fast-Modus');
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.json.news) && board.json.news.length > 0, '/api/board liefert News');
  assert.ok(Array.isArray(feed) && feed.length > 0, '/api/news liefert den Feed');
  assert.equal(status.errors, 0, `Bots ohne Fehler (Status ${JSON.stringify(status.skips_this_run)})`);
  assert.ok(status.sim_minutes > 80, `Bot-Spieluhr: ${status.sim_minutes} Spielminuten in 60 s`);
  const bad = log.split('\n').filter((l) => /Fehler|Error|Exception|Traceback|not start|nicht startbar|TypeError|ReferenceError|SQLITE/.test(l));
  assert.deepEqual(bad, [], `Log ohne Ausnahmen (${log.split('\n').filter(Boolean).length} Zeilen)`);
  // E018: kein News-Volumen mehr als Kriterium — stattdessen muss der News-Tick den ganzen Lauf durchlaufen sein.
  assert.ok(!log.includes('[Job news] Fehler'), 'News-Tick: im ganzen Lauf kein Fehltakt');
  assert.ok(status.sim_minutes > 60, `Lauf war lang genug, um den News-Takt zu prüfen (${status.sim_minutes} Spielminuten)`);
});
