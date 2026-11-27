// Tests Cash-Kreislauf (T4, Vertrag V3): Einkommen über die Spieluhr, Gebühren der Bots,
// Gebühren-Recycling über den persistenten Pool, News-Timer, Admin-News mit Wirkung.
// Eigene, frisch geseedete DB server/data/cashflow-<pid>.db (am Ende gelöscht); die echte DB
// (schoolstreet.db) und Port 3000 werden nie berührt. Die Wanduhr ist eine steuerbare Fake-Uhr.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const DB_NAME = `cashflow-${process.pid}.db`;
process.env.DB_NAME = DB_NAME; // vor dem ersten require('../db')
const DBFILE = path.join(SERVER, 'data', DB_NAME);
const PORT = 3252;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'admin', password: 'ag1234' };

const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

let db, getSettings, setSetting, q, auth, bus, engine, jobs, bots, newsgen;
const realNow = Date.now;
const clock = { t: 0 }; // Wanduhr der Tests in ms
Date.now = () => clock.t;

before(() => {
  clean();
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
  clock.t = realNow(); // Gegenwart: newsgen braucht eine Tagesreferenz
});
after(() => { Date.now = realNow; clean(); });

let n = 0;
const newUser = (cash = 1_000_000, isBot = false) => {
  const u = auth.createUser(`cash-test-${++n}`, 'pw1234', 'user', cash);
  if (isBot) db.prepare('UPDATE users SET is_bot = 1 WHERE id = ?').run(u.id);
  return q.userById.get(u.id);
};
const cashOf = (id) => q.userById.get(id).cash;
const firstSec = () => engine.books.keys().next().value;
const activeCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='user' AND frozen=0").get().c;
const settingsOf = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'fee_pool_cent'").get().value);
// Eine Sekunde Wanduhr vergeht: Job-ticks, wie es die 1000-ms-Timer tun — und ein Bot-Takt, falls gegeben.
function second(botTick) {
  clock.t += 1000;
  if (botTick) botTick();
  jobs.tickIncome();
  jobs.tickNews();
}
// Zählt die Nachrichten, die der Bus während fn() verschickt (der Bus kennt kein Abmelden).
function newsEvents(fn) {
  const seen = [];
  bus.on((m) => { if (m.type === 'news') seen.push(m.news); });
  fn();
  return seen;
}
// Festes Zufall für den News-Generator: Läufe wiederholbar.
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Bots, die keine Firma gegründet haben (Gründer bekommen beim IPO Cash in die Kasse).
const plainBots = () => db.prepare('SELECT id FROM users WHERE is_bot = 1 AND NOT EXISTS (SELECT 1 FROM securities s WHERE s.founder_id = users.id) ORDER BY id').all().map((r) => r.id);
// Bot-Modus gestartet wie im Betrieb (Modus läuft, Takt weit weg), aber ohne Handel
// (activity 0), mit gezählter Selbstzahlung und der Fake-Uhr. Rückgabe: Zahlzähler und tick().
function startedBotsWithoutTrades() {
  SET({ bot_activity: 0, bot_count: 3, bot_tick_sec: 3600 });
  const self = { pays: 0, last: 0 };
  // Selbstzahlung des Runners echt ausführen und mitzählen.
  const base = bots.buildRepo();
  const repo = { ...base, pay: (ids, amount) => { self.pays++; self.last = amount; base.pay(ids, amount); } };
  bots.start(true, { now: () => clock.t, repo });
  return { self, tick: () => bots.tick(), stop: () => bots.stop(true) };
}
const SET = (o) => { for (const [k, v] of Object.entries(o)) setSetting(k, v); };

beforeEach(() => {
  jobs.stopJobs();
  jobs.state.timers = [];
  SET({ bot_fast: 0, income_sim_scale: 1, income_sec: 300, income_cent: 100000, fee_cent: 2000, bot_fee_cent: 0,
    fee_recycle_pct: 100, fee_pool_cent: 0, news_interval_sec: 0 });
  db.prepare("UPDATE users SET frozen = 0 WHERE role = 'user'").run();
  jobs.state.last_income = clock.t;
  jobs.state.incomeScale = undefined;
  jobs.state.incomeFirstTick = false;
});

// (a) Wanduhr: eine Zahlung je income_sec — nicht früher, nicht zwei.
test('(a) Wanduhr: genau eine Zahlung je income_sec', () => {
  const u = newUser();
  const c0 = cashOf(u.id);
  for (let s = 1; s < 299; s++) second();
  assert.equal(cashOf(u.id), c0, 'vor Ablauf von income_sec wird nichts gezahlt');
  second(); // s = 299 → 299 000 ms
  second(); // s = 300
  assert.equal(cashOf(u.id), c0 + 100000, 'eine Zahlung bei 300 s');
  for (let s = 301; s < 599; s++) second();
  assert.equal(cashOf(u.id), c0 + 100000, 'innerhalb der zweiten Periode kommt nichts');
  second(); second();
  assert.equal(cashOf(u.id), c0 + 200000, 'zweite Zahlung bei 600 s');
});

// (b) Fast + income_sim_scale = 1: das Einkommen kommt im Spielrhythmus (×100).
test('(b) Fast + income_sim_scale = 1: Zahlungen im Spielrhythmus (×100)', () => {
  const u = newUser();
  const c0 = cashOf(u.id);
  SET({ bot_fast: 1, income_sec: 3600 });
  assert.equal(jobs.simScale(), 100, 'Spieluhr läuft ×100');
  assert.equal(jobs.incomeIntervalMs(), 36000, 'effektives Intervall 36 s Wanduhr');
  for (let s = 1; s < 36; s++) second();
  assert.equal(cashOf(u.id), c0, 'vor 36 s kommt nichts');
  second();
  assert.equal(cashOf(u.id), c0 + 100000, 'erste Zahlung nach 36 s = 1 Spielstunde');
  for (let s = 37; s < 72; s++) second();
  second();
  assert.equal(cashOf(u.id), c0 + 200000, 'zweite Zahlung nach 72 s');
  assert.equal(jobs.incomeNextAt(), jobs.state.last_income + 36000, 'incomeNextAt rechnet mit dem effektiven Intervall');
});

// (c) income_sim_scale = 0: Fast bleibt für das Einkommen auf der Wanduhr — für Spieler und Bots
// gleichermaßen. Der Runner (bots.js, seit der Bot-Kalibrierung) zahlt die Bots dann an der WANDUHR,
// nicht mehr auf Spielzeit; dieser Job zahlt den Spielern. Zusammen darf je Konto nicht mehr als
// eine Zahlung je income_sec Wanduhr ankommen.
test('(c) income_sim_scale = 0: Fast bleibt Wanduhr; keine Doppelzahlung mit dem Bot-Runner', () => {
  const u = newUser();
  const c0 = cashOf(u.id);
  SET({ bot_fast: 1, income_sim_scale: 0, income_sec: 300 });
  assert.equal(jobs.simScale(), 1);
  assert.equal(jobs.incomeIntervalMs(), 300000);
  for (let s = 1; s < 299; s++) second();
  assert.equal(cashOf(u.id), c0, '299 s Fast ohne Sim-Skalierung: nichts gezahlt');
  second(); second();
  assert.equal(cashOf(u.id), c0 + 100000, 'Zahlung erst nach 300 s Wanduhr');

  // Läuft der Bot-Runner, zahlt er den Bots selbst — an der Wanduhr (300 s), wie dieser Job den Spielern.
  jobs.state.timers = [1]; // „Jobs laufen“ — sonst lässt der Runner dem Einkommens-Job den Vortritt
  const run = startedBotsWithoutTrades();
  try {
    const botIds = plainBots();
    assert.ok(botIds.length >= 1, 'mindestens ein Bot ohne eigene Firma');
    const b0 = botIds.map(cashOf);
    const p0 = cashOf(u.id);
    const base = jobs.state.last_income; // Periode des Jobs: nächste Zahlung 300 s später
    for (let s = 0; s < 300 * 3 + 5; s++) second(run.tick); // drei Wanduhr-Perioden (+900 Spielminuten)
    const pl = (cashOf(u.id) - p0) / 100000;
    const botPays = botIds.map((id, i) => (cashOf(id) - b0[i]) / 100000);
    assert.equal(run.self.last, 100000, 'der Runner zahlt income_cent');
    assert.ok(pl >= 3 && pl <= 3, `Spieler: drei Zahlungen in 15 min Wanduhr (tatsächlich ${pl})`);
    for (let i = 0; i < botIds.length; i++) {
      assert.ok(Math.abs(botPays[i] - pl) <= 1, `Bot ${i}: ${botPays[i]} Zahlungen, Spieler ${pl} — gleiche Anzahl ±1`);
      assert.ok(botPays[i] <= 4, `Bot ${i}: nicht mehr als eine Zahlung je Periode (${botPays[i]})`);
    }
    assert.ok(run.self.pays >= 3 && run.self.pays <= 4, `Runner: ${run.self.pays} Zahlungen (eine je Wanduhr-Periode)`);
    assert.ok(jobs.state.last_income - base >= 3 * 300000, 'Job-Raster: drei Perioden Wanduhr');
  } finally {
    run.stop();
    jobs.state.timers = [];
  }
});

// (c2) Fast + income_sim_scale = 1 mit laufendem Runner: nur dieser Job zahlt — der Runner nicht zusätzlich.
test('(c2) Fast + income_sim_scale = 1 mit laufendem Runner: zahlt nur der Job', () => {
  const u = newUser();
  SET({ bot_fast: 1, income_sim_scale: 1, income_sec: 300 });
  jobs.state.timers = [1];
  const run = startedBotsWithoutTrades();
  try {
    const botIds = plainBots();
    const b0 = botIds.map(cashOf);
    const p0 = cashOf(u.id);
    for (let s = 0; s < 301; s++) second(run.tick); // 301 Wanduhr-s = 8,4 Spielstunden
    assert.equal(run.self.pays, 0, 'der Runner zahlt nicht selbst');
    assert.equal(cashOf(u.id), p0 + 100 * 100000, 'Spieler: 100 Zahlungen (alle 300 Spiel-s = 3 Wanduhr-s)');
    for (let i = 0; i < botIds.length; i++) {
      assert.equal(cashOf(botIds[i]), b0[i] + 100 * 100000, `Bot ${i}: dieselben 100 Zahlungen vom Job — der Runner hat nicht zusätzlich gezahlt`);
    }
  } finally {
    run.stop();
    jobs.state.timers = [];
  }
});

// (b3) Verspäteter Takt: der Periodenbeginn bleibt im Raster, keine Zahlung geht verloren, keine Doppelzahlung.
test('(b3) Takt alle 2,5 s bei 3-s-Intervall: genau die fälligen Zahlungen, Raster bleibt', () => {
  const u = newUser();
  const c0 = cashOf(u.id);
  const start0 = clock.t;
  SET({ income_sec: 3 });
  let gezahlt = 0;
  for (let t = 2500; t <= 30000; t += 2500) {
    clock.t += 2500;
    jobs.tickIncome();
    gezahlt = (cashOf(u.id) - c0) / 100000;
    // fällig: jeder Rasterpunkt vor dem Takt; höchstens einer je Takt, ein zweiter folgt im nächsten Takt
    assert.equal(gezahlt, Math.min(Math.floor(t / 3000), t / 2500), `bei ${t} ms: ${gezahlt} Zahlungen`);
  }
  assert.equal(gezahlt, 10, 'nach 30 s: zehn Perioden von je 3 s, keine verloren, keine doppelt');
  assert.equal(jobs.state.last_income, start0 + 10 * 3000, 'Periodenbeginn steht im Raster (t = 30 s), nicht auf dem Takt');
});

// (c3) Wechsel des Zeitmaßstabs (0 → 1): Ist unter der neuen Uhr sofort etwas fällig, bekommen die Spieler
// ihre Zahlung (Abstand zur letzten ≥ neues Intervall), die Bots erst nach einer vollen Spielstunde — der
// Runner hat sie womöglich gerade gezahlt. Danach gilt für alle der neue Rhythmus.
test('(c3) income_sim_scale 0 → 1: Spieler sofort wenn fällig, Bots nach einer vollen Spielstunde', () => {
  const u = newUser(), bot = newUser(1_000_000, true);
  const c0 = cashOf(u.id), b0 = cashOf(bot.id);
  SET({ bot_fast: 1, income_sim_scale: 0, income_sec: 3600 });
  const start = clock.t;
  clock.t += 1000; jobs.tickIncome();
  clock.t = start + 3600 * 1000; jobs.tickIncome(); // eine Wanduhr-Stunde: eine Zahlung an alle
  assert.deepEqual([cashOf(u.id), cashOf(bot.id)], [c0 + 100000, b0 + 100000]);
  SET({ income_sim_scale: 1 }); // ab jetzt zählt die Spieluhr: eine Stunde = 36 s
  const w = clock.t + 40 * 1000; // 40 s nach der letzten Zahlung: unter der Spieluhr ist sofort etwas fällig
  clock.t = w; jobs.tickIncome();
  assert.deepEqual([cashOf(u.id), cashOf(bot.id)], [c0 + 200000, b0 + 100000], 'Spieler sofort, Bots halten eine Periode');
  for (let s = 1; s <= 35; s++) { clock.t = w + s * 1000; jobs.tickIncome(); }
  assert.deepEqual([cashOf(u.id), cashOf(bot.id)], [c0 + 200000, b0 + 100000], '35 s später: nichts');
  clock.t = w + 36000; jobs.tickIncome();
  assert.deepEqual([cashOf(u.id), cashOf(bot.id)], [c0 + 300000, b0 + 200000], 'nach einer vollen Spielstunde: alle');
  assert.equal(jobs.state.last_income, w + 36000, 'Periodenbeginn steht auf der neuen Uhr');
});

// (d) Die Einkommens-News entfällt, wenn das Zahlungsintervall unter 60 s Wanduhr liegt, sonst steht sie im Feed.
test('(d) Einkommens-News: entfällt unter 60 s Wanduhr, erscheint sonst und bei manueller Auszahlung', () => {
  const u = newUser();
  const incomeNews = () => newsEvents(() => jobs.payIncome()).filter((x) => x.kind === 'system' && /Wocheneinkommen/.test(x.title));
  SET({ bot_fast: 1, income_sim_scale: 1, income_sec: 3600 }); // 36 s
  assert.deepEqual(incomeNews(), [], 'keine Einkommens-News bei 36 s Intervall');
  SET({ income_sec: 6000 }); // genau 60 s
  assert.equal(incomeNews().length, 1, 'bei genau 60 s erscheint sie');
  SET({ bot_fast: 0, income_sec: 600 }); // 600 s Wanduhr
  const [x] = incomeNews();
  assert.ok(x && x.id > 0, 'bei 600 s Wanduhr erscheint sie');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM news WHERE id = ? AND kind = ?').get(x.id, 'system').c, 1, 'und liegt in der Tabelle');
  SET({ income_sec: 0 }); // Einkommen aus: der Admin zahlt von Hand
  assert.equal(incomeNews().length, 1, 'manuelle Auszahlung meldet sich');
});

// (e) chargeFee: Bots zahlen bot_fee_cent (Default 0 = wie fee_cent), Spieler fee_cent.
test('(e) chargeFee: bot_fee_cent für Bots, fee_cent für Spieler', () => {
  const secId = firstSec();
  const buy = (u) => engine.placeOrder(q.userById.get(u.id), { security_id: secId, side: 'buy', type: 'market', amount: 5 });
  const cost = (u) => { const c = cashOf(u.id); const r = buy(u); return c - cashOf(u.id) - r.trades.reduce((s, t) => s + t.price * t.amount, 0); };
  const spieler = newUser(), bot = newUser(1_000_000, true);
  assert.equal(cost(spieler), 2000, 'Spieler zahlt fee_cent');
  assert.equal(cost(bot), 2000, 'bot_fee_cent = 0: Bot zahlt fee_cent');
  SET({ bot_fee_cent: 500 });
  assert.equal(cost(bot), 500, 'bot_fee_cent = 500: Bot zahlt 500');
  assert.equal(cost(spieler), 2000, 'Spieler zahlt weiter fee_cent');
});

// (f) Der Pool wächst um die TATSÄCHLICH abgebuchte Gebühr × Prozentsatz — nach dem Clamp.
test('(f) fee_pool_cent wächst um die tatsächlich abgebuchte Gebühr, auch wenn sie geklemmt ist', () => {
  const secId = firstSec();
  const pool0 = settingsOf();
  // Verkäufer mit 5,80 Cr Restcash: die Gebühr kommt aus dem Brutto-Erlös, voll, nicht auf das Restcash geklemmt.
  const verkäufer = newUser(580, true);
  engine.addHoldingPublic(verkäufer.id, secId, 5);
  const r = engine.placeOrder(q.userById.get(verkäufer.id), { security_id: secId, side: 'sell', type: 'market', amount: 5 });
  const erloes = r.trades.reduce((s, t) => s + t.price * t.amount, 0);
  assert.ok(erloes >= 2000, `Vorbedingung: Erlös ${erloes} deckt die Gebühr`);
  assert.equal(cashOf(verkäufer.id), 580 + erloes - 2000, 'Cash: Rest + Erlös − volle Gebühr, nie negativ');
  assert.ok(cashOf(verkäufer.id) >= 0);
  assert.equal(settingsOf(), pool0 + 2000, 'Pool = volle Gebühr');
  assert.equal(getSettings().fee_pool_cent, pool0 + 2000);
  // Erlös kleiner als die Gebühr: geklemmt auf das, was da ist — der Rest ist echte Buchung, nie negativ.
  const poolK = settingsOf();
  const klein = newUser(0, true);
  engine.addHoldingPublic(klein.id, secId, 1);
  const r1 = engine.placeOrder(q.userById.get(klein.id), { security_id: secId, side: 'sell', type: 'market', amount: 1 });
  const e1 = r1.trades.reduce((s, t) => s + t.price * t.amount, 0);
  assert.equal(cashOf(klein.id), Math.max(0, e1 - 2000), 'Konto nie negativ');
  assert.equal(settingsOf(), poolK + Math.min(2000, e1), 'Pool wächst um den tatsächlich abgebuchten Betrag');

  // bot_fee_cent über dem Cash: alle Stellen rechnen mit demselben Satz — der Kauf wird abgelehnt.
  const bot = newUser(1_000_000, true);
  const pool1 = settingsOf();
  SET({ bot_fee_cent: 1_000_000_000 });
  assert.throws(() => engine.placeOrder(q.userById.get(bot.id), { security_id: secId, side: 'buy', type: 'market', amount: 5 }), /Credits/, 'Marktkauf mit zu hoher Bot-Gebühr abgelehnt');
  const ask = engine.books.get(secId).asks[0].price;
  assert.throws(() => engine.placeOrder(q.userById.get(bot.id), { security_id: secId, side: 'buy', type: 'limit', price: ask, amount: 1 }), /Credits/, 'Limitkauf ebenso');
  assert.equal(cashOf(bot.id), 1_000_000, 'Cash unverändert und nicht negativ');
  assert.equal(cashOf(bot.id) >= 0, true);
  assert.equal(settingsOf(), pool1, 'keine Gebühr gebucht, Pool unverändert');
  assert.equal(engine.previewOrder(q.userById.get(bot.id), { security_id: secId, side: 'buy', type: 'market', amount: 1 }).fee, 1_000_000_000, 'Preview zeigt die Bot-Gebühr');
  SET({ bot_fee_cent: 500 });
  assert.equal(engine.previewOrder(q.userById.get(bot.id), { security_id: secId, side: 'buy', type: 'market', amount: 1 }).fee, 500);
});

// (f2) Rollt die äußere Transaktion nach einer gebuchten Gebühr zurück, bleibt kein Phantom-Pool.
test('(f2) Rollback nach chargeFee: kein Pool in Tabelle und Auszahlung', () => {
  const secId = firstSec();
  const u = newUser();
  const c0 = cashOf(u.id);
  SET({ fee_pool_cent: 0 });
  const pool0 = settingsOf();
  assert.throws(() => db.transaction(() => {
    engine.placeOrder(q.userById.get(u.id), { security_id: secId, side: 'buy', type: 'market', amount: 5 });
    throw new Error('Abbruch danach');
  })(), /Abbruch danach/, 'die äußere Transaktion rollt zurück');
  assert.equal(cashOf(u.id), c0, 'Cash der Order weg');
  assert.equal(settingsOf(), pool0, 'Pool in der Tabelle unverändert');
  SET({ fee_pool_cent: 0 });
  const p0 = cashOf(u.id);
  jobs.payIncome();
  assert.equal(cashOf(u.id), p0 + 100000, 'es wird nur das Einkommen gezahlt, kein Pool-Anteil');
  assert.equal(settingsOf(), 0);
});

// (g) Die Auszahlung ist eine Transaktion, übersteht einen Neustart ohne Doppelzahlung, der Pool wird nie negativ.
test('(g) Auszahlung: eine Transaktion, nach Neustart keine Doppelzahlung, Pool nie negativ', () => {
  const u = newUser();
  const ids = db.prepare("SELECT id FROM users WHERE role='user' AND frozen=0").all().map((x) => x.id);
  const nActive = ids.length;
  SET({ fee_pool_cent: 3000 * nActive, fee_recycle_pct: 100 });
  const sperre = `CREATE TRIGGER zahl_sperre BEFORE UPDATE ON users WHEN NEW.id = ${Number(ids.at(-1))} BEGIN SELECT RAISE(ABORT, 'Sperre'); END`;
  db.prepare(sperre).run();
  const vor = ids.map(cashOf);
  assert.throws(() => jobs.payIncome(), /Sperre/, 'Zahlung schlägt fehl');
  assert.deepEqual(ids.map(cashOf), vor, 'nach dem Fehler: kein Konto hat etwas bekommen');
  assert.equal(getSettings().fee_pool_cent, 3000 * nActive, 'und der Pool steht unverändert');
  db.prepare('DROP TRIGGER zahl_sperre').run();

  jobs.payIncome();
  assert.deepEqual(ids.map(cashOf), vor.map((c) => c + 100000 + 3000), 'jedes aktive Konto: Einkommen + gleicher Pool-Anteil');
  assert.equal(getSettings().fee_pool_cent, 0, 'Pool geleert');

  // Neustart: jobs.js frisch laden — kein Zähler im RAM, der nochmal auszahlen könnte.
  const c1 = ids.map(cashOf);
  delete require.cache[require.resolve('../jobs')];
  const jobs2 = require('../jobs');
  jobs2.state.last_income = clock.t;
  jobs2.payIncome();
  assert.deepEqual(ids.map(cashOf), c1.map((c) => c + 100000), 'nach Neustart kommt nur das Einkommen, kein Pool-Anteil');
  assert.equal(getSettings().fee_pool_cent, 0);
  assert.equal(settingsOf(), 0, 'Pool-Neustand steht in der Tabelle, nicht nur im Cache');

  SET({ fee_pool_cent: 1, fee_recycle_pct: 100 });
  jobs2.payIncome();
  assert.equal(getSettings().fee_pool_cent, 1, 'Pool 1 Cent unter vielen Konten: bleibt stehen, wird nie negativ');
  SET({ fee_pool_cent: 1000 * nActive, fee_recycle_pct: 50 });
  const c2 = ids.map(cashOf);
  jobs2.payIncome();
  assert.deepEqual(ids.map(cashOf), c2.map((c) => c + 100000 + 500), '50 % des Pools: halber Anteil je Konto');
  assert.equal(getSettings().fee_pool_cent, 500 * nActive, 'die anderen 50 % bleiben im Pool');
  // Eingefrorene Konten erhalten nichts.
  SET({ fee_pool_cent: 0 });
  db.prepare('UPDATE users SET frozen = 1 WHERE id = ?').run(u.id);
  const c3 = cashOf(u.id);
  jobs2.payIncome();
  assert.equal(cashOf(u.id), c3, 'eingefrorenes Konto ohne Zahlung');
});

// (h0) Der News-Tick liefert das Marktbild: je Wertpapier Kurs, Bezug und Änderung, dazu Index und Breite —
// und reicht es an einen Generator, der setMarket kennt; einer ohne setMarket läuft weiter mit der Uhr.
test('(h0) News-Tick: Marktbild an newsgen (setMarket), je Wert {id, ticker, type, last, ref, chgPct} + {indexChgPct, breadth}', () => {
  const snap = jobs.marketSnapshot();
  assert.ok(snap.securities.length >= 4, 'jedes gehandelte Wertpapier ist dabei');
  for (const r of snap.securities) {
    assert.deepEqual(Object.keys(r).sort(), ['chgPct', 'id', 'last', 'ref', 'ticker', 'type'], `Felder von ${r.ticker}`);
    assert.ok(r.last > 0 && r.ref > 0 && Number.isFinite(r.chgPct), `Kurs, Bezug, Änderung von ${r.ticker}`);
  }
  assert.ok(Number.isFinite(snap.indexChgPct) && snap.breadth >= 0 && snap.breadth <= 1, 'Index-Änderung und Breite 0…1');
  // Einheit: Bewegung eines einzigen Kurses schlägt in Änderung, Index und Breite durch.
  const erste = snap.securities.find((r) => r.type === 'stock');
  const book = engine.books.get(erste.id);
  const orig = book.last;
  try { book.last = orig * 2; book.ver++; } finally { /* unten zurück */ }
  const hoch = jobs.marketSnapshot();
  book.last = orig; book.ver++;
  assert.ok(hoch.securities.find((r) => r.id === erste.id).chgPct > erste.chgPct, 'Änderung der Aktie steigt');
  assert.ok(hoch.indexChgPct > snap.indexChgPct, 'Index folgt');
  assert.ok(hoch.breadth >= snap.breadth, 'Breite folgt');

  // Übergabe: ein Generator mit setMarket bekommt das Marktbild vor once(simNow); einer ohne läuft weiter.
  const pfad = require.resolve('../newsgen');
  const echt = require.cache[pfad];
  const frisch = () => { delete require.cache[require.resolve('../jobs')]; jobs = require('../jobs'); }; // lädt den Generator beim nächsten Takt
  frisch();
  const gesehen = [];
  const alt = require.cache[pfad] = { loaded: true, exports: { once: (t) => gesehen.push(['alt', t]) } };
  try {
    jobs.tickNews();
    assert.deepEqual(gesehen.map((g) => g[0]), ['alt'], 'ohne setMarket: nur der Uhr-Takt, kein Fehler');
    frisch();
    require.cache[pfad] = { loaded: true, exports: {
      setMarket: (m) => gesehen.push(['markt', m.securities.length, Number.isFinite(m.indexChgPct)]),
      once: (t) => gesehen.push(['neu', t]) } };
    jobs.tickNews();
    assert.deepEqual(gesehen.slice(1).map((g) => g[0]), ['markt', 'neu'], 'mit setMarket: erst das Marktbild, dann der Takt');
    assert.equal(gesehen[1][1], jobs.marketSnapshot().securities.length, 'das Marktbild trägt alle Wertpapiere');
    assert.equal(gesehen[1][2], true);
  } finally { require.cache[pfad] = echt; frisch(); }
});

// (h) News-Tick mit dem ereignisgetriebenen Generator (E018): ruhiger Markt → nichts; ein Ausreißer →
// genau seine News, je Zeile ein Event, am richtigen Wert.
test('(h) News-Tick: ruhiger Markt → 0 News; Ausreißer über 5 % und 10 % → genau diese zwei, Wirkung 0', () => {
  SET({ news_interval_sec: 60, bot_fast: 0, trading_paused: 0 });
  const aktien = db.prepare("SELECT id, ticker FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all();
  assert.ok(aktien.length >= 3, `Seed liefert nur ${aktien.length} Aktien`);
  // Kurs eines Wertes relativ zu seiner Tagesreferenz setzen (so rechnet auch `chg` im Ticker).
  const setz = (sec, f) => { const b = engine.books.get(sec.id); b.last = Math.round(engine.tickerRow(sec.id).ref * f * 1000) / 1000; b.ver++; };
  const seit = (id) => db.prepare("SELECT * FROM news WHERE id > ? AND kind IN ('news','rumor') ORDER BY id").all(id);
  const naechste = () => db.prepare('SELECT MAX(id) m FROM news').get().m || 0;
  const events = [];
  bus.on((m) => { if (m.type === 'news') events.push(m.news); });
  const realRandom = Math.random;
  Math.random = () => 0.5; // nur Textvariante; das seltene Gerücht (1 % je Takt) wird so nie gewürfelt
  try {
    aktien.forEach((x) => setz(x, 1.0));
    newsgen.reset();
    let id0 = naechste();
    for (let t = 0; t < 600; t++) { clock.t += 1000; jobs.tickNews(); } // 10 ruhige Sim-Minuten
    assert.deepEqual(seit(id0), [], 'ruhiger Markt: keine News');
    assert.equal(events.length, 0, 'ruhiger Markt: kein news-Event');

    // Rampe: erst 5 %, dann 10 % — jede Schwelle eine News, beide am richtigen Wert, Wirkung 0.
    const lauf = aktien[aktien.length - 1];
    setz(lauf, 1.05);
    clock.t += 1000; jobs.tickNews();
    setz(lauf, 1.10);
    clock.t += 1000; jobs.tickNews();
    const rows = seit(id0);
    assert.deepEqual(rows.map((r) => r.body.match(/(5|10) %/)?.[1]), ['5', '10'], 'genau zwei News: Schwellen 5 % und 10 %');
    assert.deepEqual(rows.map((r) => r.kind), ['news', 'news']);
    assert.deepEqual(rows.map((r) => r.impact), [0, 0], 'Wirkung 0 (erst ab 20 % Gleichlauf)');
    assert.ok(rows.every((r) => r.security_id === lauf.id), 'beide an der Ausreißer-Aktie');
    assert.ok(rows.every((r) => r.title.startsWith(lauf.ticker + ':')), 'Schlagzeile nennt das Kürzel');
    assert.equal(events.length, 2, 'je News genau ein Event');
    assert.equal(newsgen.state().count, 2);

    id0 = naechste();
    for (let t = 0; t < 30; t++) { clock.t += 1000; jobs.tickNews(); } // gehalten: Hysterese
    assert.deepEqual(seit(id0), [], 'gehaltener Kurs meldet nicht erneut');
    // Direktsprung über zwei Schwellen: nur die höchste erreichte wird gemeldet (kein Dreifach).
    setz(lauf, 1.0);
    clock.t += 1000; jobs.tickNews(); // zurück unter die Hälfte: Schwellen wieder frei
    id0 = naechste();
    setz(lauf, 1.10);
    clock.t += 1000; jobs.tickNews();
    const sprung = seit(id0);
    assert.equal(sprung.length, 1, 'Direktsprung auf +10 %: eine News');
    assert.ok(sprung[0].body.includes('10 %'), `Text nennt 10 %: ${sprung[0].body}`);
  } finally { Math.random = realRandom; aktien.forEach((x) => setz(x, 1.0)); }
});

// (h2) Mit echtem Timer: 2,5 s Fast ohne Ausreißer bleiben still (kein Zufalls-Ticker), ein Ausreißer kommt an.
// Bezug der Änderung ist die eigene Sim-Zeit-Historie des Generators, nicht `ref` im Marktbild.
test('(h2) startJobs: der echte Timer meldet nur Ereignisse', async () => {
  SET({ news_interval_sec: 60, bot_fast: 1, income_sim_scale: 1, trading_paused: 0 });
  const aktien = db.prepare("SELECT id, ticker FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all();
  const setz = (sec, f) => { const b = engine.books.get(sec.id); b.last = Math.round(engine.tickerRow(sec.id).ref * f * 1000) / 1000; b.ver++; };
  const count = () => db.prepare("SELECT COUNT(*) c FROM news WHERE kind IN ('news','rumor')").get().c;
  const vor = db.prepare('SELECT MAX(id) m FROM news').get().m || 0;
  const realRandom = Math.random;
  Math.random = () => 0.5;
  aktien.forEach((x) => setz(x, 1.0));
  newsgen.reset();
  const basis = count(); // die Seed-Demo-News stehen schon in der Tabelle
  Date.now = realNow;
  jobs.startJobs();
  try {
    await sleep(2500);
    assert.equal(count() - basis, 0, '2,5 s Fast (4 Sim-Stunden) ruhiger Markt: keine News');
    setz(aktien[0], 1.10);
    await sleep(2300);
    // Der Generator führt seinen Bezug selbst (Sim-Zeit-Historie): hier zählt, was sicher gilt — nur diese
    // Aktie, Wirkung 0, und keine Werte unter der kleinsten Schwelle.
    const rows = db.prepare("SELECT security_id, impact FROM news WHERE kind IN ('news','rumor') AND id > ? ORDER BY id").all(vor);
    assert.ok(rows.length >= 1 && rows.length <= 2, `eine bis zwei News (Schwellen 5 % und 10 %), got ${rows.length}`);
    assert.ok(rows.every((r) => r.security_id === aktien[0].id), 'alle an der Ausreißer-Aktie');
    assert.ok(rows.every((r) => r.impact === 0), 'Wirkung 0');
  } finally {
    jobs.stopJobs(); Math.random = realRandom; Date.now = () => clock.t;
    aktien.forEach((x) => setz(x, 1.0));
  }
});

// (i) POST /admin/news nimmt impact und rumor an und lehnt ungültiges impact ab (HTTP, eigener Server).
test('(i) POST /admin/news: impact und rumor werden angenommen, ungültiges impact abgelehnt', async (t) => {
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    cwd: SERVER, env: { ...process.env, PORT: String(PORT), DB_NAME: `${DB_NAME}-http`, ADMIN_PASSWORD: ADMIN.password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode === null) { const ex = once(child, 'exit'); child.kill('SIGINT'); await ex; }
    for (const e of ['', '-wal', '-shm']) fs.rmSync(path.join(SERVER, 'data', `${DB_NAME}-http${e}`), { force: true });
  });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/api/securities`)).ok) break; } catch { /* noch nicht da */ }
    if (child.exitCode !== null) throw new Error(`Server beendet: ${output}`);
    await sleep(100);
  }
  const api = async (method, p, { token, body } = {}) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const token = (await api('POST', '/auth/login', { body: ADMIN })).json.token;
  const ok = await api('POST', '/admin/news', { token, body: { title: 'Gerücht: KICK vor Übernahme?', body: 'Man munkelt.', kind: 'rumor', impact: 2 } });
  assert.deepEqual([ok.status, ok.json.news.kind, ok.json.news.impact], [200, 'rumor', 2]);
  for (const impact of [-3, 3, 0, undefined, null]) {
    const r = await api('POST', '/admin/news', { token, body: { title: 'Wirkungstest', impact } });
    assert.equal(r.status, 200, `impact ${impact} ist gültig`);
  }
  for (const impact of [4, -4, 1.5, '2', 'abc', {}, [], true]) {
    const r = await api('POST', '/admin/news', { token, body: { title: 'Wirkungstest', impact } });
    assert.deepEqual([r.status, r.json?.news], [400, undefined], `impact ${JSON.stringify(impact)} wird abgelehnt`);
  }
  const feed = await api('GET', '/news');
  assert.equal(feed.status, 200);
  assert.ok(feed.json.news.some((x) => x.kind === 'rumor' && x.impact === 2), 'die Rumor-News liegt im Feed');
  // etf_autobuy ist keine Admin-Einstellung mehr.
  const weg = await api('PUT', '/admin/settings', { token, body: { etf_autobuy: 0 } });
  assert.equal(weg.status, 400, 'etf_autobuy ist nicht mehr setzbar');
  // income_sim_scale ist ein Schalter: nur 0 oder 1.
  for (const v of [0.5, 2, 100, -1, 'x']) {
    const r = await api('PUT', '/admin/settings', { token, body: { income_sim_scale: v } });
    assert.equal(r.status, 400, `income_sim_scale ${v} abgelehnt`);
  }
  for (const v of [0, 1]) assert.equal((await api('PUT', '/admin/settings', { token, body: { income_sim_scale: v } })).status, 200);
  // next_income_in folgt der Spieluhr und ist null, wenn das Einkommen aus ist.
  await api('PUT', '/admin/settings', { token, body: { income_sec: 300, income_sim_scale: 1 } });
  await api('PUT', '/admin/bots/settings', { token, body: { bot_fast: 1 } });
  const fast = (await api('GET', '/admin/overview', { token })).json;
  assert.ok(fast.next_income_in > 0 && fast.next_income_in <= 3000, `Fast: nächste Zahlung in ≤ 3 s (${fast.next_income_in} ms)`);
  await api('PUT', '/admin/bots/settings', { token, body: { bot_fast: 0 } });
  const normal = (await api('GET', '/admin/overview', { token })).json;
  assert.ok(normal.next_income_in > 290000 && normal.next_income_in <= 300000, `Normal: ≤ 300 s (${normal.next_income_in})`);
  await api('PUT', '/admin/settings', { token, body: { income_sec: 0 } });
  assert.equal((await api('GET', '/admin/overview', { token })).json.next_income_in, null, 'Einkommen aus: null');
});
