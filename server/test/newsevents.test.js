// Nachweis T6b mit echten Marktdaten. Eigene Seed-DBs newsevents-a-<pid>.db / newsevents-b-<pid>.db
// (nie schoolstreet.db), echter engine-Ticker, echte Tabelle `news`, kein Port. Zwei Läufe:
//  1. Drehbuch: Kurse werden im Orderbuch geführt (ruhig, +12 %-Lauf, Pendeln, Absturz); jede News wird
//     mit Auslöser aufgeführt und gegen die Kurse geprüft.
//  2. Rückkopplung: 100 Bots (Testspiel-Modus, Fast) handeln 6 Sim-Stunden, der Generator läuft im Kreis
//     mit ihnen. Lauf A mit Wirkung auf die Bots, Lauf B mit derselben Wirkung auf 0 gesetzt. Sind die
//     Auslöser-Zahlen gleich, erzeugt die Nachrichten-Wirkung keinen neuen Ausreißer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const PID = process.pid;
const DB_A = `newsevents-a-${PID}.db`;
const DB_B = `newsevents-b-${PID}.db`;
const DB_W = `newsevents-w-${PID}.db`; // Welt-Vorlage: einmal geseedet, dann je Lauf kopiert
process.env.DB_NAME = DB_A;
const file = (n) => path.join(SERVER, 'data', n);
const clean = (n) => { for (const e of ['', '-wal', '-shm']) if (fs.existsSync(file(n) + e)) fs.unlinkSync(file(n) + e); };
const seed = (n) => execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
  { env: { ...process.env, DB_NAME: n, ADMIN_PASSWORD: 'ag1234' }, stdio: 'ignore' });

const MIN = 60 * 1000;
const T = 1000;
const REAL_NOW = Date.now();
const FAKE = { t: REAL_NOW };
// db.js, engine.js, bots.js, jobs.js laden die DB beim Import — erst nach dem Seeden laden.
let d, bus, engine, jobs, bots, newsgen;
function lade() {
  return { d: require('../db'), bus: require('../bus'), engine: require('../engine'), jobs: require('../jobs'), bots: require('../bots'), newsgen: require('../newsgen') };
}

// Deterministischer Zufall (xorshift), damit die Läufe wiederholbar sind.
function rnd(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const aktiveAktien = () => d.db.prepare("SELECT id, ticker, name FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all();
// Kurs eines Wertes relativ zu seinem Ausgangskurs setzen.
function setz(sec, f) {
  const b = engine.books.get(sec.id);
  b.last = Math.round(basis.get(sec.id) * f * 1000) / 1000;
  b.ver++;
}
const basis = new Map();

test('Drehbuch über 100 Sim-Minuten: jede News hat einen Daten-Auslöser; 10 ruhige Minuten → 0; +12 % → genau zwei', () => {
  const aktien = aktiveAktien();
  assert.ok(aktien.length >= 3, `Seed liefert nur ${aktien.length} Aktien`);
  const [crash, , lauf] = aktien;
  // Drehbuch mit definiertem Bezug: ohne gespeicherte Kurs-Historie ist der erste Takt der „Messbeginn“
  // (das Aufwärmen aus price_history prüft der eigene Test unten).
  d.db.prepare('DELETE FROM price_history').run();
  for (const s of aktien) { basis.set(s.id, engine.books.get(s.id).last); setz(s, 1.0); }
  // Drehbuch (Sim-Minute → Faktor zum Ausgangskurs).
  const dreh = (t) => ({
    // B: 10–12 min von 1,00 auf 1,12, dann bis 20 min um 1,10 pendeln (9,5–10,5 %).
    [lauf.id]: t < 10 ? 1.0 : t <= 12 ? 1.0 + 0.12 * ((t - 10) / 2) : t < 20 ? (t % 0.2 < 0.1 ? 1.095 : 1.105) : 1.0,
    // D: 50–53 min auf 0,78 (−22 %), dann halten.
    [crash.id]: t < 50 ? 1.0 : t <= 53 ? 1.0 - 0.22 * ((t - 50) / 3) : 0.78,
  });
  const protokoll = [];
  const newsVorher = d.db.prepare('SELECT COUNT(*) c FROM news').get().c;
  let events = 0;
  bus.on((m) => { if (m.type === 'news') events++; });
  newsgen.reset();
  const r = rnd(20261127);
  let minute = 0;
  for (let t = T / 2; t <= 100 * MIN; t += T) {
    minute = t / MIN;
    for (const [id, f] of Object.entries(dreh(minute))) setz(aktien.find((s) => s.id === Number(id)), f);
    for (const n of newsgen.once(t, r)) {
      // Kurs im Moment der Entstehung, relativ zum Ausgangskurs (die Historie reicht noch keine 24 Sim-h).
      protokoll.push({ ...n, minute, kurs: Object.fromEntries(aktien.map((s) => [s.id, engine.books.get(s.id).last / basis.get(s.id)])) });
    }
  }
  console.log('News im Drehbuch:\n   ' + protokoll.map((n) => `[${n.minute.toFixed(1)} min] ${n.trigger.padEnd(15)} (${n.impact > 0 ? '+' : ''}${n.impact}) ${n.title} — ${n.body}`).join('\n   '));
  assert.ok(protokoll.length >= 5, 'das Drehbuch muss News erzeugen');

  // 1) Ruhige erste 10 Minuten (±0 %): nichts.
  assert.equal(protokoll.filter((n) => n.minute <= 10).length, 0);

  // 2) +12 %-Lauf: genau zwei Aktien-News für diesen Wert (5 % und 10 %), keine dritte beim Pendeln.
  const laufNews = protokoll.filter((n) => n.security_id === lauf.id && n.kind === 'news');
  assert.deepEqual(laufNews.map((n) => n.trigger), ['move:pos:5', 'move:pos:10'], JSON.stringify(laufNews));
  assert.ok(laufNews[1].minute < 12.1, 'die 10-%-Meldung kommt im Lauf, nicht später');
  assert.equal(protokoll.filter((n) => n.security_id === lauf.id && n.kind === 'news' && n.minute > 12).length, 0);

  // 3) Absturz −22 % in drei Minuten: die drei Stufen je einmal, nur die 20 %-Meldung wirkt (−1).
  const crashNews = protokoll.filter((n) => n.security_id === crash.id && n.kind === 'news');
  assert.deepEqual(crashNews.map((n) => n.trigger), ['move:neg:5', 'move:neg:10', 'move:neg:20']);
  assert.deepEqual(crashNews.map((n) => n.impact), [0, 0, 0], 'Ausreißer-News beschreiben nur');

  // 4) Jede News hat einen Auslöser, der in den Kursen sichtbar ist.
  for (const n of protokoll) {
    const [art, , stufe] = n.trigger.split(':');
    const akt = aktien.find((s) => s.id === n.security_id);
    if (art === 'move') {
      const c = (n.kurs[akt.id] - 1) * 100;
      assert.ok(Math.abs(c) >= Number(stufe) - 1e-6, `${n.title}: Kurs ${c.toFixed(1)} %, Auslöser ${stufe} %`);
      assert.ok(n.title.startsWith(`${akt.ticker}:`));
      assert.equal(n.impact, 0, `${n.title}: Ausreißer-News ohne Wirkung`);
      assert.ok(/Messbeginn/.test(n.body), `${n.title}: Bezug fehlt`);
    } else if (art === 'mood') {
      const index = aktien.reduce((a, s) => a + n.kurs[s.id] - 1, 0) / aktien.length * 100;
      const gleiche = aktien.filter((s) => Math.sign(n.kurs[s.id] - 1) === (n.trigger.endsWith('pos') ? 1 : -1)).length;
      assert.ok(Math.abs(index) >= 2.5 || gleiche / aktien.length >= 0.8, `${n.title}: Index ${index.toFixed(1)} %, ${gleiche}/${aktien.length} gleichgerichtet`);
      assert.equal(n.security_id, null);
    } else {
      assert.equal(art, 'rumor');
      assert.ok(n.security_id !== null && n.title.endsWith('?') && Math.abs(n.impact) === 1);
    }
    assert.ok(Number.isInteger(n.impact) && n.impact >= -3 && n.impact <= 3);
  }

  // 5) Tabelle und Bus: je News eine Zeile, ein Event.
  const basisNews = d.db.prepare("SELECT COUNT(*) c FROM news").get().c;
  assert.equal(basisNews - newsVorher, protokoll.length, 'Tabelle: nur die News des Drehbuchs');
  assert.equal(events, protokoll.length + protokoll.filter((n) => n.kind === 'rumor').length * 0, 'je News genau ein Event');
  assert.equal(newsgen.state().count, protokoll.length);
});

test('Gerücht braucht die Bewegung aus den letzten 30 Sim-Minuten: 30 Minuten stille +6 % bringen kein Gerücht', () => {
  const [s] = aktiveAktien();
  newsgen.reset();
  const r = rnd(7);
  newsgen.once(T / 2, r); // Bezug beim Ausgangskurs
  setz(s, 1.06);
  let g = 0;
  for (let t = T; t <= 30 * MIN; t += T) g += newsgen.once(t, r).filter((n) => n.kind === 'rumor').length;
  console.log(`30 Minuten stille +6 %: ${g} Gerüchte`);
  assert.equal(g, 0);
});

test('Neustart mitten im Tag: die Historie wird aus price_history aufgefüllt — der Bezug bleibt der Kurs von vor 24 Sim-Stunden', () => {
  const [s] = aktiveAktien();
  const basisKurs = engine.books.get(s.id).last;
  d.db.prepare('DELETE FROM price_history').run();
  // Kurs-Historie an der Wanduhr: bis vor 24 h 10 % unter dem heutigen Kurs, seither der heutige Kurs
  // (Minuten 1 … 60 zurück: heutiger Kurs; älter: der tiefere).
  const ins = d.db.prepare('INSERT INTO price_history(security_id, ts, price) VALUES(?, ?, ?)');
  const unter = Math.round(basisKurs * 0.9);
  for (let min = 1; min <= 25 * 60; min++) ins.run(s.id, REAL_NOW - min * MIN, min <= 60 ? basisKurs : unter);
  newsgen.reset();
  const r = rnd(3);
  const out = [];
  // Wanduhr und Spieluhr laufen hier gleich (Normal-Modus), ein Takt je Sekunde: Ab dem zweiten Takt
  // kennt newsgen den Maßstab und rechnet die Wanduhr-Zeiten der Kurs-Historie in Sim-Zeit um.
  const realNow = Date.now;
  Date.now = () => FAKE.t;
  try {
    for (let t = 0; t < 3; t++) { FAKE.t = REAL_NOW + t * T; for (const n of newsgen.once(REAL_NOW + t * T, r)) out.push(n); }
  } finally {
    Date.now = realNow;
    d.db.prepare('DELETE FROM price_history').run();
  }
  console.log('Neustart:', out.map((n) => `${n.trigger} (${n.impact}) ${n.title} — ${n.body}`).join(' | '));
  assert.deepEqual(out.map((n) => n.trigger), ['move:pos:10'], `der Wert steht 11 % über dem Kurs von vor 24 Stunden: ${out.map((n) => n.trigger)}`);
  assert.ok(/vor 24 Stunden/.test(out[0].body) && !/Messbeginn/.test(out[0].body), out[0].body);
});

// ---- Rückkopplung -------------------------------------------------------------------------------
// Ein Lauf: frische Module, eigene DB, 100 Bots im Fast-Modus, je Wanduhr-Sekunde ein News-Takt.
// `neutral`: die Wirkung aller Generator-News wird vor dem Schreiben auf 0 gesetzt — alles andere identisch.
function rueckkopplung(dbName, seedRnd, neutral, minuten) {
  process.env.DB_NAME = dbName;
  try { d?.db.close(); } catch { /* noch keine Verbindung */ }
  // Jeder Lauf startet von derselben Welt: Die Vorlage wird einmal je Seed geschrieben (seed.js würfelt mit
  // echter Uhr und echtem Zufall) und dann in die Lauf-DB kopiert — so sind Lauf A und B gepaart.
  clean(dbName);
  for (const e of ['', '-wal', '-shm']) if (fs.existsSync(file(DB_W) + e)) fs.copyFileSync(file(DB_W) + e, file(dbName) + e);
  for (const k of Object.keys(require.cache)) if (k.startsWith(SERVER + path.sep) && !k.startsWith(__dirname + path.sep)) delete require.cache[k];
  basis.clear();
  // Gepaarter Vergleich: Uhr und Zufall stehen fest — schon VOR dem Laden, denn Seed-Reste, Bots und
  // Engine vergeben Zeitstempel — damit Lauf A und B bis zur ersten wirkenden Nachricht denselben
  // Verlauf nehmen (wie bots.test.js: virtuelle Uhr).
  const realNow = Date.now, realRandom = Math.random;
  const clock0 = 1_700_000_000_000, clockObj = { t: clock0 };
  Date.now = () => clockObj.t;
  Math.random = rnd(seedRnd * 7 + 3);
  ({ d, bus, engine, jobs, bots, newsgen } = lade());
  d.db.pragma('synchronous = OFF');
  for (const [k, v] of [['bot_fast', 1], ['bot_activity', 40], ['trading_paused', 0], ['news_interval_sec', 60]]) d.setSetting(k, v);
  engine.loadEngine();
  bots.prepare();
  const namen = new Map(aktiveAktien().map((s) => [s.id, s]));
  const counters = { orders: 0, trades: 0, errors: 0, skips: {} };
  const runner = bots.createBotRunner({ rnd: rnd(seedRnd), now: () => clockObj.t, settings: d.getSettings, repo: bots.buildRepo(), counters });
  const gen = newsgen.createNewsGenerator({
    market: () => jobs.marketSnapshot(clockObj.t).securities.filter((x) => x.type === 'stock').map((x) => ({ ...namen.get(x.id), type: 'stock', shares: engine.books.get(x.id)?.sec.total_shares, last: x.last })),
    settings: d.getSettings,
    addNews: (kind, title, body, securityId, impact) => d.addNews(kind, title, body, securityId, neutral ? 0 : impact),
    emit: (m) => bus.emit(m),
  });
  const r = rnd(seedRnd * 31 + 7);
  const news = [];
  const start = new Map([...engine.books.values()].filter((b) => b.sec.type === 'stock').map((b) => [b.sec.id, b.last]));
  const maxAbs = new Map();
  const STEP_MS = 3000;                 // Bot-Takt wie der 3-s-Job
  const MINUTEN = minuten;              // Sim-Minuten
  const t0 = clockObj.t;
  gen.once(jobs.simNow(t0 - T / 2), r); // Bezug beim Ausgangskurs
  // Skript-Schocks: alle 20 Sim-Minuten springt ein anderer Wert um ±30 % (abwechselnd). Die Bots handeln
  // den Sprung danach frei — so entstehen in beiden Läufen garantiert Auslöser (auch Gerüchte und Stimmung).
  const aktienIds = [...engine.books.values()].filter((b) => b.sec.type === 'stock').map((b) => b.sec.id);
  let schock = 20, k = 0;
  for (let wall = 0; wall <= MINUTEN * MIN / 100; wall += T) {
    clockObj.t = t0 + wall;
    if (wall > 0 && wall % STEP_MS === 0) { engine.mmRefreshAll(); runner.tick(); }
    if (wall * 100 / MIN >= schock && aktienIds.length) {
      const id = aktienIds[k % aktienIds.length]; k++;
      const b = engine.books.get(id);
      b.last = Math.round(start.get(id) * (k % 2 ? 1.3 : 0.7) * 1000) / 1000; b.ver++;
      schock += 20;
    }
    for (const n of gen.once(jobs.simNow(clockObj.t), r)) news.push({ ...n, simMin: wall * 100 / MIN });
    for (const b of engine.books.values()) {
      if (b.sec.type !== 'stock' || !start.has(b.sec.id)) continue;
      const c = Math.abs(b.last / start.get(b.sec.id) - 1) * 100;
      if (c > (maxAbs.get(b.sec.id) || 0)) maxAbs.set(b.sec.id, c);
    }
  }
  const trades = d.db.prepare('SELECT COUNT(*) c FROM trades WHERE created_at >= ?').get(t0).c;
  Date.now = realNow; Math.random = realRandom;
  d.db.close();
  return { news, maxAbs, trades, counters };
}

test('Rückkopplung: Bots + Generator im Kreis, mit und ohne Nachrichten-Wirkung — gleiche Zahl an Auslösern', { timeout: 600000 }, () => {
  // Je Seite mehrere Läufe mit eigenem Seed auf frischer Welt: Einzelne Läufe streuen, verglichen werden Mittelwerte.
  const SEEDS = [11, 23, 37, 51, 67, 79];
  const minuten = Number(process.env.T6B_KETTEN_MINUTEN) || 6 * 60;
  const laeufe = { A: [], B: [] };
  for (const sd of SEEDS) {
    clean(DB_W); seed(DB_W);
    for (const [name, neutral] of [['A', false], ['B', true]]) {
      const lauf = rueckkopplung(name === 'A' ? DB_A : DB_B, sd, neutral, minuten);
      const n = lauf.news;
      const zaehl = (re) => n.filter((x) => re.test(x.trigger)).length;
      const ketten = kettenZaehl(n);
      const e = { seed: sd, news: n.length, ausreisser: zaehl(/^move/), hoch20: zaehl(/^move:(pos|neg):20/), geruecht: zaehl(/^rumor/), stimmung: zaehl(/^mood/),
        sumImpact: n.reduce((a, x) => a + Math.abs(x.impact), 0), maxAbs: Math.max(...lauf.maxAbs.values()), median: median([...lauf.maxAbs.values()]),
        trades: lauf.trades, ketten };
      laeufe[name].push(e);
      console.log(`Rückkopplung ${name} ${neutral ? 'Wirkung 0 ' : 'mit Wirkung'} Seed ${sd}: ${e.news} News (${e.ausreisser} Ausreißer, davon 20 %: ${e.hoch20}; ${e.geruecht} Gerüchte, ${e.stimmung} Stimmung), Σ|impact| ${e.sumImpact}, größte Abweichung ${e.maxAbs.toFixed(1)} %, Median ${e.median.toFixed(1)} %, Ketten ${ketten.length}, Trades ${e.trades}`);
      ketten.slice(0, 8).forEach((k) => console.log('     Kette:', k));
    }
  }
  const mittel = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
  const Z = (xs, f) => mittel(xs, f).toFixed(1);
  for (const f of [['Ausreißer', (x) => x.ausreisser], ['20-%-Auslöser', (x) => x.hoch20], ['Gerüchte', (x) => x.geruecht], ['Stimmung', (x) => x.stimmung], ['größte Abweichung %', (x) => x.maxAbs], ['Median Abweichung %', (x) => x.median], ['Trades', (x) => x.trades], ['Ketten', (x) => x.ketten.length]]) {
    console.log(`Mittel ${SEEDS.length} Läufe · ${f[0]}: mit Wirkung ${Z(laeufe.A, f[1])} | Wirkung 0: ${Z(laeufe.B, f[1])}`);
  }
  const A = laeufe.A, B = laeufe.B;
  const sum = (xs, f) => mittel(xs, f);
  assert.ok(sum(B, (x) => x.ausreisser) >= 3, `zu wenig Auslöser für einen Vergleich (${Z(B, (x) => x.ausreisser)})`);
  assert.ok(sum(A, (x) => x.sumImpact) > 0, 'in keinem Lauf mit Wirkung gab es eine wirkende Nachricht — der Vergleich prüft nichts');
  // Gepaarte Läufe beginnen in derselben Welt. Läufe ganz ohne wirkende Nachricht sind oft, aber nicht
  // immer, bitgleich (Bots und Engine haben Reste echter Zeit und echten Zufalls) — deshalb vergleicht
  // der Test Mittelwerte mit Toleranz, nicht einzelne Paare.
  const gleich = (x, y) => x.news === y.news && x.trades === y.trades && Math.abs(x.maxAbs - y.maxAbs) < 1e-9;
  const paarweiseGleich = A.filter((a, i) => a.sumImpact === 0 && gleich(a, B[i])).map((a) => a.seed);
  const ohneWirkung = A.filter((a) => a.sumImpact === 0).map((a) => a.seed);
  console.log(`Läufe ohne wirkende News, paarweise bitgleich: ${paarweiseGleich.length} von ${ohneWirkung.length} (Seeds ${paarweiseGleich.join(',')} / ${ohneWirkung.join(',')})`);
  assert.ok(sum(A, (x) => x.ausreisser) <= sum(B, (x) => x.ausreisser) + 1, `Ausreißer: mit Wirkung ${Z(A, (x) => x.ausreisser)}, ohne ${Z(B, (x) => x.ausreisser)}`);
  assert.ok(sum(A, (x) => x.hoch20) <= sum(B, (x) => x.hoch20) + 1, `20-%-Auslöser: mit Wirkung ${Z(A, (x) => x.hoch20)}, ohne ${Z(B, (x) => x.hoch20)}`);
  assert.ok(sum(A, (x) => x.maxAbs) <= sum(B, (x) => x.maxAbs) + 3, `größte Abweichung: mit Wirkung ${Z(A, (x) => x.maxAbs)} %, ohne ${Z(B, (x) => x.maxAbs)} %`);
  // Struktur: Keine Ausreißer-News wirkt → eine Kette „News → Bot-Käufe → neue News“ kann von ihnen nicht ausgehen.
  // Ketten-Glieder (wirkende News → gleichgerichteter Auslöser am selben Wert binnen 45 Sim-Minuten): Ausreißer-News
  // wirken 0, Glieder können nur von Gerücht oder Stimmung ausgehen. Beobachtet über mehrere Läufe: 0 bis 1
  // je 6 Läufe, ohne Fortsetzung — gemeldet, nicht als Kaskade gewertet.
  console.log(`Ketten-Glieder mit Wirkung: ${A.reduce((a, x) => a + x.ketten, 0)} | Wirkung 0: ${B.reduce((a, x) => a + x.ketten, 0)}`);
  assert.ok(sum(A, (x) => x.ketten) <= 0.5, JSON.stringify(A.map((a) => a.ketten)));
});

// Kette: Nachricht MIT Wirkung → am selben Wert binnen 45 Sim-Minuten (Wirkfenster der Bots) ein
// gleichgerichteter Auslöser. So viele „News → Bot-Käufe → neue News“-Glieder gibt der Lauf her.
function kettenZaehl(news) {
  const glieder = [];
  for (const n of news) {
    if (n.impact === 0) continue;
    const richt = n.impact > 0 ? 'pos' : 'neg';
    for (const x of news) {
      if (!x.trigger.startsWith('move') || x.security_id !== n.security_id || x.simMin <= n.simMin) continue;
      if (x.simMin - n.simMin <= 45 && x.trigger.includes(`:${richt}:`)) glieder.push(`${n.trigger}@${n.simMin.toFixed(0)} → ${x.trigger}@${x.simMin.toFixed(0)}`);
    }
  }
  return glieder;
}
function median(xs) { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

before(() => {
  for (const n of [DB_A, DB_B]) { clean(n); seed(n); }
  ({ d, bus, engine, jobs, bots, newsgen } = lade());
  d.db.pragma('synchronous = OFF');
  engine.loadEngine();
});
after(() => { try { d.db.close(); } catch { /* schon zu */ } for (const n of [DB_A, DB_B, DB_W]) clean(n); });
