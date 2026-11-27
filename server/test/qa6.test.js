// QA T6b (News-Generator, E018) — unabhängig aus dem Auftrag abgeleitet, nicht aus dem Code des Implementers.
// UMGESTELLT: Der alte qa6 prüfte den Zufalls-Ticker (45–75 News je Stunde, Poisson-Lücken, Wirkungs-
// Verteilung). Der Nutzer hat das Konzept geändert (PLAN E018): Es gibt keinen Ticker mehr. Auto-News
// entstehen nur aus Marktdaten. Deshalb prüft diese Datei jetzt: 0 News ohne Ereignis, Schwellen je
// Schwelle/Richtung einmal, Hysterese, Sim-Zeit-Sperrungen für Stimmung (30 Min) und Gerücht (45 Min),
// kleine gleichgerichtete Wirkung, Robustheit (keine Aktie, nur ETFs, Uhrsprünge, Pause).
// Eigene Zufallsfunktion (mulberry32), eigene Kurven. Eigene DB qa6-<pid>.db, nie schoolstreet.db, kein Port.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `qa6-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DATA = path.join(__dirname, '..', 'data');
const DBFILE = path.join(DATA, DB_NAME);
const clean = () => { for (const e of ['', '-wal', '-shm']) if (fs.existsSync(DBFILE + e)) fs.unlinkSync(DBFILE + e); };

const MIN = 60 * 1000;
const T = 1000;
const NAMEN = ['MENSA', 'HAUSA', 'EVENT', 'KLASS', 'PROJEKT', 'KIOSK', 'WERK', 'BUCH', 'MEDIA', 'SPORT'];

// Markt mit n Aktien à 10,--; `plan[ticker] = (min) => Kurs`.
function markt(n = 10) {
  const rows = Array.from({ length: n }, (_, i) => {
    const t = NAMEN[i % 10] + (i >= 10 ? i : '');
    return { id: i + 1, ticker: t, name: t.charAt(0) + t.slice(1).toLowerCase() + ' AG', type: 'stock', last: 10, ref: 10, shares: 3000 };
  });
  return { rows, plan: {}, setz(id, kurs) { rows[id - 1].last = kurs; } };
}
const still = () => 10;

// Eigener deterministischer Zufall (mulberry32) — absichtlich ein anderer Generator als im Implementer-Test.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `plan`: { tickerKürzel: (minute) => Kurs | Zahl }. Läuft `minuten` Sim-Minuten, ein Takt je Sim-Sekunde.
function spiel(minuten, seed, m = markt(), cfg = {}, uebrig = () => {}) {
  const rows = [], events = [];
  const gen = require('../newsgen').createNewsGenerator({
    market: () => m.rows,
    settings: () => cfg,
    addNews: (kind, title, body, securityId, impact) => { const row = { id: rows.length + 1, kind, title, body, security_id: securityId, impact }; rows.push(row); return row; },
    emit: (e) => events.push(e),
  });
  const out = [];
  const r = rng(seed);
  (m.rows || []).forEach((x) => { x.last = 10; });
  gen.once(T / 2, r); // Bezug: Ausgangskurs 10
  for (let t = T; t <= minuten * MIN; t += T) {
    for (const [k, f] of Object.entries(m.plan)) {
      const row = m.rows.find((x) => x.ticker === k);
      row.last = typeof f === 'number' ? f : f(t / MIN);
    }
    uebrig(t / MIN);
    for (const n of gen.once(t, r)) out.push({ ...n, sim: t });
  }
  return { out, events, gen };
}
const ruhig = (m) => m.rows.forEach((x, i) => { x.last = 10 * (1 + 0.01 * Math.sin(i + 1)); });

const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2600-\u27BF\uFE0F\u200D]/u;
const platzhalter = /\{|\}|\bundefined\b|\bnull\b|\bNaN\b|\[object|TODO|Lorem|\$\{|<\w+>|XX+/i;
const stimmung = (out) => out.filter((n) => n.security_id === null);
const geruecht = (out) => out.filter((n) => n.kind === 'rumor');
const aktien = (out) => out.filter((n) => n.kind === 'news' && n.security_id !== null);

test('QA1 10 ruhige Sim-Minuten, ±1 % Bewegung, 20 Seeds: 0 Auto-News, 0 Events', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const m = markt();
    m.plan = { MENSA: (t) => 10 * (1 + 0.01 * Math.sin(t)), HAUSA: 9.9, KLASS: 10.1 };
    const { out, events } = spiel(10, seed, m);
    assert.equal(out.length, 0, `Seed ${seed}: ${out.map((n) => n.title).join(' | ')}`);
    assert.equal(events.length, 0);
  }
});

test('QA2 +12 %-Lauf (in Sekunden) und Pendeln 9,5–10,5 % fünf Minuten lang: genau 2 News (5 %, 10 %)', () => {
  const m = markt();
  // Minute 0–0,1: 0 → 12 % in 6 Sprüngen (überschreitet 5 % und 10 % zu verschiedenen Takten), danach Pendeln.
  m.plan = { MENSA: (t) => (t <= 0.1 ? 10 * (1 + 0.024 * Math.ceil(t * 60)) : t % 0.1 < 0.05 ? 10.95 : 11.05) };
  for (const seed of [7, 88, 4001]) {
    const { out } = spiel(5, seed, m);
    const titel = out.map((n) => `${n.sim / 1000} s ${n.title} — ${n.body}`).join('\n      ');
    assert.equal(out.length, 2, `Seed ${seed}:\n      ${titel}`);
    assert.ok(out.every((n) => n.kind === 'news' && n.security_id === 1 && n.impact === 0));
    assert.match(out[0].body, /[5-9] % (über|mehr|gestiegen|Plus|höher)/);
    assert.match(out[1].body, /1[0-2] %/);
  }
});

test('QA3 je Schwelle und Richtung einmal — und Dichte-Deckel: 6 Aktien springen gleichzeitig (+5, +10, +20, −5, −10, −20 %) → die 4 größten werden gemeldet, ±5 % nicht', () => {
  const m = markt();
  const f = [1.05, 1.10, 1.20, 0.95, 0.90, 0.80];
  m.plan = Object.fromEntries(['MENSA', 'HAUSA', 'EVENT', 'KLASS', 'PROJEKT', 'KIOSK'].map((k, i) => [k, 10 * f[i]]));
  const { out } = spiel(30, 5, m);
  console.log('QA3:', out.map((n) => `[${(n.sim / MIN).toFixed(1)} min] ${n.trigger} ${n.title}`).join(' | '));
  const a = aktien(out);
  assert.deepEqual(a.map((n) => n.trigger).sort(), ['move:neg:20', 'move:neg:10', 'move:pos:10', 'move:pos:20'].sort(), 'höchstens 4 Ausreißer-News je 10 Sim-Minuten, die größten zuerst');
  assert.deepEqual(new Set(a.map((n) => n.security_id)).size, 4);
  for (const n of a) assert.ok(n.impact === 0, `${n.title}: Wirkung ${n.impact} (Ausreißer-News beschreiben nur)`);
  assert.equal(stimmung(out).length, 0, 'Index unverändert: keine Markt-News');
});

test('QA3b Dichte-Deckel: in 10 Sim-Minuten nie mehr als 4 Ausreißer-News über alle Aktien; danach ist das Fenster wieder frei', () => {
  const m = markt(12);
  const rows = [];
  const { gen } = (() => {
    const events = [];
    const gen = require('../newsgen').createNewsGenerator({
      market: () => m.rows, settings: () => ({}),
      addNews: (kind, title, body, securityId, impact) => { const row = { kind, title, body, security_id: securityId, impact }; rows.push(row); return row; },
      emit: (e) => events.push(e),
    });
    return { gen };
  })();
  const r = rng(6);
  m.rows.forEach((x) => { x.last = 10; });
  gen.once(T / 2, r);
  const out = [];
  for (let t = T; t <= 120 * MIN; t += T) {
    // Jede Minute springen drei weitere Aktien auf einen neuen Ausreißer (erst hoch, dann runter, wieder hoch …).
    // Jede Minute stehen alle 12 Aktien auf einem neuen Ausreißer: 6 … 20 % hoch oder runter, wechselnd je Aktie.
    if (t % MIN === 0) m.rows.forEach((x, i) => { x.last = 10 * (1 + (0.06 + 0.02 * ((Math.floor(t / MIN) + i) % 8)) * ((Math.floor(t / MIN) + i) % 2 ? 1 : -1)); });
    for (const n of gen.once(t, r)) out.push({ ...n, sim: t });
  }
  const je10 = new Map();
  for (const n of out.filter((x) => x.trigger.startsWith('move'))) je10.set(Math.floor(n.sim / (10 * MIN)), (je10.get(Math.floor(n.sim / (10 * MIN))) || 0) + 1);
  console.log(`QA3b: ${out.length} News in 2 h, Ausreißer je 10 min [${[...je10.values()].join(', ')}]`);
  assert.ok(je10.size >= 4, `zu wenig passiert (${je10.size} Fenster)`);
  for (const [fenster, n] of je10) assert.ok(n <= 4, `${n} Ausreißer-News im Fenster ${fenster}`);
});

test('QA4 Hysterese im selben Generator: Pendeln um 5 % bleibt still; erst nach Rückfall unter 2,5 % ist die Schwelle wieder frei', () => {
  const m = markt();
  const rows = [];
  const gen = require('../newsgen').createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, securityId, impact) => { const row = { kind, title, body, security_id: securityId, impact }; rows.push(row); return row; },
    emit: () => {},
  });
  const r = rng(11);
  // Kurs je Sim-Minute: 0–1 auf +9 %, 1–10 zwischen 4,6 % und 5,4 % pendeln, 10–12 auf +1 %, 12–13 auf +6 %.
  const plan = (t) => (t <= 1 ? 1 + 0.09 * t : t < 10 ? (t % 0.2 < 0.1 ? 1.046 : 1.054) : t <= 12 ? 1.01 : 1.01 + 0.05 * (t - 12));
  const out = [];
  m.setz(1, 10);
  gen.once(T / 2, r);
  for (let t = T; t <= 13 * MIN; t += T) { m.setz(1, 10 * plan(t / MIN)); for (const n of gen.once(t, r)) out.push({ ...n, sim: t }); }
  console.log('QA4:', out.map((n) => `[${(n.sim / MIN).toFixed(1)} min] ${n.trigger} ${n.title}`).join(' | '));
  assert.equal(out.length, 2, 'einmal auf dem Anstieg, einmal nach dem Rückfall unter die Hälfte');
  assert.ok(out[0].sim < 1.1 * MIN && out[1].sim > 12 * MIN);
});

test('QA5 Stimmung: Index +4 % → eine marktweite News; dieselbe Lage bleibt 60 Minuten ohne zweite; nach Beruhigung erneut', () => {
  const m = markt();
  m.plan = Object.fromEntries(m.rows.map((x) => [x.ticker, (t) => 10 * (t < 40 ? 1.04 : 1.004)]));
  const { out } = spiel(60, 21, m);
  console.log('QA5:', out.map((n) => `[${(n.sim / MIN).toFixed(1)} min] (${n.impact}) ${n.title} — ${n.body}`).join(' | '));
  assert.equal(out.length, 1, 'bei +4 % die ganze Stunde: genau eine Meldung');
  assert.equal(out[0].security_id, null);
  assert.ok(out[0].impact === 0 || out[0].impact === 1);
  assert.ok(!/Mensa|MENSA/.test(out[0].title + out[0].body), 'Markt-News ohne einzelne Firma');
  // Ab Minute 40 Beruhigung (+0,4 %), ab Minute 70 wieder +4 %: zweite Meldung, frühestens 30 Min nach der ersten.
  const m2 = markt();
  m2.plan = Object.fromEntries(m2.rows.map((x) => [x.ticker, (t) => 10 * (t < 20 ? 1.04 : t < 50 ? 1.004 : 1.04)]));
  const { out: out2 } = spiel(80, 21, m2);
  const s2 = stimmung(out2);
  console.log('QA5b:', out2.map((n) => `[${(n.sim / MIN).toFixed(1)} min] ${n.title}`).join(' | '));
  assert.equal(s2.length, 2, JSON.stringify(s2.map((n) => n.sim / MIN)));
  assert.ok(s2[1].sim - s2[0].sim >= 30 * MIN, `Abstand ${(s2[1].sim - s2[0].sim) / MIN} min`);
});

test('QA6 Gerücht: nur nach ≥ 5 % in 30 Sim-Minuten; stille Aktie bekommt nie eines; Sperre 45 Sim-Minuten marktweit', () => {
  // Aktie MENSA: 30 Minuten still, dann +8 % in 5 Minuten. Alle anderen still.
  const m = markt();
  ruhig(m);
  m.plan = { MENSA: (t) => (t < 30 ? 10 : 10 + 0.8 * Math.min((t - 30) / 5, 1)) };
  const { out } = spiel(40, 31, m);
  const g = geruecht(out);
  console.log('QA6:', out.map((n) => `[${(n.sim / MIN).toFixed(1)} min] (${n.impact}) ${n.title}`).join(' | '));
  assert.ok(g.length <= 1, `${g.length} Gerüchte`);
  assert.ok(out.filter((n) => n.sim < 30 * MIN).length === 0, 'vor der Bewegung: nichts');
  // Dauerbewegung überall: höchstens ein Gerücht je 45 Minuten.
  const m2 = markt();
  m2.plan = Object.fromEntries(m2.rows.map((x, i) => [x.ticker, (t) => 10 * (1 + 0.12 * Math.sin(t / 4 + i))]));
  const g2 = geruecht(spiel(200, 77, m2).out);
  console.log(`QA6b: ${g2.length} Gerüchte in 200 Minuten`);
  assert.ok(g2.length <= 5, `${g2.length} Gerüchte`);
  for (let i = 1; i < g2.length; i++) assert.ok(g2[i].sim - g2[i - 1].sim >= 45 * MIN, `Abstand ${(g2[i].sim - g2[i - 1].sim) / MIN} min`);
});

test('QA7 Wirkung: ganze Zahl −3…+3; beschreibende Aktien-News |impact| ≤ 1 und im Gleichlauf; Gerücht genau ±1 mit Aktie', () => {
  const m = markt(20);
  m.plan = Object.fromEntries(m.rows.map((x, i) => [x.ticker, (t) => 10 * (1 + 0.25 * Math.sin(t / 9 + i * 0.9))]));
  const { out } = spiel(300, 12, m);
  console.log(`QA7: ${out.length} News (${aktien(out).length} Aktien, ${stimmung(out).length} Markt, ${geruecht(out).length} Gerüchte)`);
  assert.ok(out.length > 30, `nur ${out.length} News in 300 Minuten mit ±25 % Bewegung`);
  for (const n of out) {
    assert.ok(Number.isInteger(n.impact) && n.impact >= -3 && n.impact <= 3, `${n.title}: ${n.impact}`);
    assert.ok(n.kind === 'news' || n.kind === 'rumor', n.kind);
    if (n.kind === 'rumor') assert.ok(n.security_id !== null && Math.abs(n.impact) === 1, `${n.title}: ${n.impact}`);
    else assert.ok(Math.abs(n.impact) <= 1, `${n.title}: ${n.impact}`);
  }
});

test('QA8 Schlagzeile passt zur Richtung und nennt das Kürzel; Gerüchte als Frage von der Investment AG, Wirkung in Richtung der Bewegung', () => {
  const m = markt();
  m.plan = { MENSA: 12, HAUSA: 8.5, EVENT: 10.6, KLASS: 9.4 };
  const { out } = spiel(1, 55, m);
  assert.equal(aktien(out).length, 4);
  const HOCH = /plus|legt|zieht|höher|her\.|vorn|hoch|steigen|gestiegen|empfehlen|geheimtipp|läuft weiter|günstig|mehr plus|über dem/;
  const RUNTER = /minus|gibt (heute \d+ % |stark |weiter )?nach|rutscht|tiefer|stürzt|bricht ein|fällt|fallen|gefallen|verkaufen|raten zum verkauf|zu teuer|mehr minus|unter dem/;
  for (const n of aktien(out)) {
    const s = m.rows.find((x) => x.id === n.security_id);
    assert.ok(n.title.startsWith(`${s.ticker}:`), n.title);
    const steigt = s.last > s.ref;
    const text = `${n.title} ${n.body}`.toLowerCase();
    assert.equal(HOCH.test(text), steigt, text);
    assert.equal(RUNTER.test(text), !steigt, text);
    assert.equal(n.impact, 0, `${n.title}: Ausreißer-News ohne Wirkung`);
    assert.ok(!/weil|deshalb|grund:|aufgrund|niemand|im spiel/.test(text), `Grund behauptet oder Spielfigur gebrochen: ${text}`);
    assert.ok(/messbeginn|24 stunden/.test(text), `${n.title}: ohne Bezug`);
  }
  // Gerücht über einen gestiegenen Wert: positiver Text, Wirkung +1; über einen gefallenen: negativer Text, −1.
  for (const [hoch, ziel] of [[true, 10.8], [false, 9.2]]) {
    const x = markt();
    x.plan = { MENSA: (t) => (t < 30 ? 10 : ziel) };
    const g = geruecht(spiel(90, 77, x).out);
    assert.equal(g.length, 1, `${g.length} Gerüchte`);
    assert.ok(g[0].title.startsWith('Investment AG hört:') && g[0].title.endsWith('?') && g[0].title.includes('MENSA'), g[0].title);
    assert.equal(g[0].impact, hoch ? 1 : -1, g[0].title);
    assert.equal(/gestiegen/.test(g[0].body), hoch, g[0].body);
    assert.equal(/gefallen/.test(g[0].body), !hoch, g[0].body);
  }
});

test('QA9 Kein Emoji, keine Platzhalter, kein Amtston, kurze Texte; gleicher Seed → identische News', () => {
  const m = markt(12);
  m.plan = Object.fromEntries(m.rows.map((x, i) => [x.ticker, (t) => 10 * (1 + 0.3 * Math.sin(t / 6 + i))]));
  const a = spiel(60, 99, m).out, b = spiel(60, 99, m).out, c = spiel(60, 100, m).out;
  assert.deepEqual(a.map((n) => [n.kind, n.title, n.body, n.security_id, n.impact]), b.map((n) => [n.kind, n.title, n.body, n.security_id, n.impact]));
  assert.notDeepEqual(a.map((n) => n.title), c.map((n) => n.title), 'anderer Seed → andere Textvarianten');
  for (const n of a) {
    const text = `${n.title} ${n.body}`;
    assert.ok(!emoji.test(text), `Emoji in ${n.title}`);
    assert.ok(!platzhalter.test(text), `Platzhalter in ${n.title}`);
    assert.ok(!/Behörde|Verordnung|Wartungsarbeiten|Handelszeiten|gemäß|zuvor|Hiermit/.test(text), `Amtston: ${n.title}`);
    assert.ok(n.title.length <= 90 && n.body.length <= 200, text);
  }
});

test('QA10 ohne Aktien oder nur ETFs: 0 News, kein Fehler', () => {
  assert.equal(spiel(30, 3, { rows: [], plan: {} }).out.length, 0);
  const etf = { rows: [{ id: 1, ticker: 'SCHULETF', name: 'Schul-ETF', type: 'etf', last: 15, ref: 10 }], plan: {} };
  assert.equal(spiel(30, 3, etf).out.length, 0);
  assert.equal(spiel(30, 3, { rows: null, plan: {} }).out.length, 0);
});

test('QA11 Uhrsprünge: 10 h vor ohne Flut und Nachholen, zurück ohne Flut und ohne Sperren aus der Zukunft; NaN ohne Fehler', () => {
  const m = markt();
  ruhig(m);
  const rows = [];
  const gen = require('../newsgen').createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, securityId, impact) => { const row = { kind, title, body, security_id: securityId, impact }; rows.push(row); return row; },
    emit: () => {},
  });
  const r = rng(4);
  m.setz(1, 10);
  gen.once(T / 2, r);
  for (let t = T; t <= 30 * MIN; t += T) gen.once(t, r);
  m.setz(1, 10.6);
  assert.equal(gen.once(30 * MIN + T, r).length, 1);
  const stich = rows.length;
  assert.equal(gen.once(30 * MIN + T + 10 * 3600 * 1000, r).length, 0, 'Sprung vor: nichts nachgeholt');
  assert.equal(rows.length, stich);
  assert.equal(gen.once(T, r).length, 0, 'Sprung zurück: nichts');
  assert.deepEqual(gen.state().lastMoodAt, { pos: null, neg: null });
  assert.equal(gen.state().lastRumorAt, null);
  gen.once(2 * T, r);
  // Nach dem Sprung ist der aktuelle Kurs der neue Bezug: +13 % dagegen meldet nur die 10-%-Schwelle (5 % war schon dran, 20 % nicht erreicht).
  m.setz(1, 11.98);
  assert.deepEqual(gen.once(3 * T, r).map((x) => x.trigger), ['move:pos:10']);
  assert.equal(gen.once(4 * T, r).length, 0);
  assert.deepEqual(gen.once(NaN, r), []);
  assert.equal(rows.length, stich + 1);
});

test('QA12 Dichte-Deckel: 50 Aktien springen gleichzeitig auf +25 % → 4 Meldungen im ersten Takt, keine nachgereicht', () => {
  const m = markt(50);
  const rows = [];
  const gen = require('../newsgen').createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, securityId, impact) => { const row = { kind, title, body, security_id: securityId, impact }; rows.push(row); return row; },
    emit: () => {},
  });
  const r = rng(8);
  m.rows.forEach((x) => { x.last = 10; });
  gen.once(T / 2, r); // Bezug: Ausgangskurs 10
  m.rows.forEach((x) => { x.last = 12.5; });
  assert.equal(gen.once(T, r).filter((x) => x.trigger.startsWith('move')).length, 4);
  for (let t = 2 * T; t <= 9 * MIN; t += T) assert.equal(gen.once(t, r).filter((x) => x.trigger.startsWith('move')).length, 0, `${t / T} s: nachgereicht`);
  assert.equal(rows.filter((x) => x.kind === 'news' && x.security_id !== null).length, 4);
});

test('QA13 echte Bindung (Seed-DB): ruhiger Markt schreibt nichts; +12 % an einem Wert → eine Zeile in `news`, ein Event; trading_paused = 1 → nichts', () => {
  const newsgen = require('../newsgen');
  const d = require('../db');
  const bus = require('../bus');
  const engine = require('../engine');
  engine.loadEngine();
  const stocks = d.db.prepare("SELECT id, ticker FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id").all();
  assert.ok(stocks.length >= 3, `Seed liefert nur ${stocks.length} Aktien`);
  const stille = d.db.prepare('SELECT COUNT(*) c FROM news').get().c;
  let events = 0;
  const on = (m) => { if (m.type === 'news') events++; };
  bus.on(on);
  const r = rng(17);
  newsgen.reset();
  for (let t = T; t <= 5 * MIN; t += T) newsgen.once(t, r);
  assert.equal(events, 0, 'ruhiger Markt: kein Event');
  // Kurs im Orderbuch auf +12 %; der Ticker rechnet daraus chg = 12 %.
  const ziel = engine.books.get(stocks[0].id);
  const ref = engine.tickerRow(stocks[0].id).ref;
  ziel.last = Math.round(ref * 1.12 * 1000) / 1000; ziel.ver++;
  // Zulässig dazu: ein Gerücht (der Wert hat sich in 30 Minuten ≥ 5 % bewegt) und höchstens eine
  // Markt-News (mit wenigen Seed-Aktien geht der Index über 3 %) — beides hat denselben Auslöser.
  const geschrieben = [...newsgen.once(5 * MIN + T, r), ...newsgen.once(5 * MIN + 2 * T, r)];
  const meldungen = geschrieben.filter((x) => x.kind === 'news' && x.security_id !== null);
  console.log(`QA13 ${stocks[0].ticker} auf +12 %: ${geschrieben.length} News (${geschrieben.map((x) => x.title).join(' | ')}), Ticker chg ${engine.tickerRow(stocks[0].id).chg}`);
  assert.equal(meldungen.length, 1);
  assert.ok(geschrieben.every((x) => x.kind === 'news' || x.kind === 'rumor'));
  assert.ok(stimmung(geschrieben).length <= 1 && geruecht(geschrieben).length <= 1);
  const z = d.db.prepare("SELECT kind, title, security_id, impact FROM news WHERE kind = 'news' AND security_id = ? ORDER BY id DESC LIMIT 1").get(stocks[0].id);
  assert.ok(z.title.startsWith(`${stocks[0].ticker}:`), z.title);
  assert.equal(events, geschrieben.length);
  assert.equal(d.db.prepare('SELECT COUNT(*) c FROM news').get().c - stille, geschrieben.length);
  d.setSetting('trading_paused', 1);
  ziel.last = Math.round(ref * 1.25 * 1000) / 1000; ziel.ver++;
  assert.equal(newsgen.once(5 * MIN + 3 * T, r).length, 0, 'Pause: still');
  d.setSetting('trading_paused', 0);
  const danach = newsgen.once(5 * MIN + 4 * T, r);
  assert.equal(danach.filter((x) => x.kind === 'news' && x.security_id !== null).length, 1, 'nach der Pause: die 20-%-Meldung');
  assert.ok(danach.every((x) => x.kind === 'news' && x.security_id !== null), JSON.stringify(danach));
  assert.equal(newsgen.state().count, geschrieben.length + danach.length);
});

before(() => {
  clean();
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag1234' }, stdio: 'ignore' });
  require('../db').db.pragma('synchronous = OFF');
});
after(clean);
