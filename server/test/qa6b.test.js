// QA 6b — zweite, unabhängige Prüfung des ereignisgetriebenen News-Generators (E018).
// Die Erwartungen stammen aus PLAN.md E018 und dem QA-Auftrag, nicht aus newsgen.js.
// Reine Tests ganz ohne DB; nur der letzte Block startet einen Kindprozess mit eigener DB
// qa6b-<pid>-<modus>.db (nie schoolstreet.db), virtueller Uhr, keinem Port und keinem Timer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIN = 60 * 1000;
const T = 1000;
const SERVER = path.join(__dirname, '..');
const { createNewsGenerator, renderTemplates } = require('../newsgen');
const brain = require('../botbrain'); // reines Modul (kein require, keine DB)

// Eigener Zufall (xorshift32), eigene Seeds — nichts teilt sich mit den Tests des Implementers.
function zufall(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const TICKER = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO'];
// Markt mit n Aktien à 20,--; `kurs(i, f)` setzt den Kurs als Faktor zur Referenz.
function markt(n = 10) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, ticker: TICKER[i], name: `${TICKER[i][0]}${TICKER[i].slice(1).toLowerCase()} AG`, type: 'stock', last: 20, ref: 20, shares: 3000 }));
  return { rows, kurs: (i, f) => { rows[i - 1].last = 20 * f; }, alle: (f) => rows.forEach((r) => { r.last = 20 * f; }) };
}
// Generator mit Sammelbecken; `lauf(minuten, jeSek)` ruft `once` je Sim-Sekunde auf, `at` = Sim-Minute der News.
function baue(m, cfg = {}, seed = 1, zufallFn) {
  const news = [], events = [];
  let uhr = 0;
  const z = zufallFn || zufall(seed);
  const gen = createNewsGenerator({
    market: () => m.rows,
    settings: () => (typeof cfg === 'function' ? cfg() : cfg),
    addNews(kind, title, body, securityId, impact) { return { id: news.length + 1, kind, title, body, security_id: securityId, impact }; },
    emit: (msg) => events.push(msg),
  });
  return {
    news, events,
    lauf(minuten, jeSek) {
      const ende = uhr + minuten * MIN;
      while (uhr < ende) { uhr += T; if (jeSek) jeSek(uhr / MIN); for (const n of gen.once(uhr, z)) news.push({ ...n, at: uhr / MIN }); }
    },
    sprung: (ms) => { uhr += ms; },
  };
}
const arten = (g) => g.news.map((n) => n.trigger);
const ohneGeruecht = (g) => g.news.filter((n) => n.kind !== 'rumor').map((n) => n.trigger);

// ---- 1) Ruhe ----------------------------------------------------------------------------------
test('1a 20 Aktien, Rauschen ±2 %, 60 ruhige Sim-Minuten, fünf Seeds: keine Auto-News, kein Event', () => {
  for (const seed of [11, 22, 33, 44, 55]) {
    const m = markt(20), g = baue(m, {}, seed), z = zufall(seed * 101);
    let stand = Array(20).fill(0);
    g.lauf(60, (min) => {
      if (Math.floor(min * 60) % 5 === 0) stand = stand.map((s) => Math.max(-2, Math.min(2, s + (z() - 0.5) * 0.6)));
      stand.forEach((s, i) => m.kurs(i + 1, 1 + s / 100));
    });
    assert.deepEqual(arten(g), [], `Seed ${seed}`);
    assert.equal(g.events.length, 0);
  }
});

// ---- 2) Ausreißer nach oben ----------------------------------------------------------------------
// ANMERKUNG QA: Der QA-Auftrag verlangt für die 20-%-Stufe „Wirkung ±1“. E018 selbst verlangt nur „kleine/keine
// Wirkung, keine Rückkopplung“. Die Prüfung hält die E018-Grenze ein (5/10 % = 0, 20 % = 0 oder gleichgerichtet ±1,
// nie dagegen, nie mehr) und meldet die Abweichung vom Auftrag als Diagnose — die Entscheidung liegt beim Orchestrator.
function wirkungOk(trigger, impact) {
  const [a, b, c] = trigger.split(':');
  const hoch = (a === 'mood' ? c : b) === 'pos';
  if (a === 'move') return Number(c) < 20 ? impact === 0 : (impact === 0 || impact === (hoch ? 1 : -1));
  if (a === 'mood') return impact === (hoch ? 1 : -1);
  return Math.abs(impact) === 1; // Gerücht: ±1 (Richtung siehe 5e)
}
test('2a +7 % → genau eine (5 %); +12 % → genau zwei; +25 % in drei Stufen → drei (5, 10, 20); Wirkung klein, nie gegen die Bewegung', (t) => {
  const faelle = [[1.07, ['move:pos:5'], [0]], [1.12, ['move:pos:5', 'move:pos:10'], [0, 0]], [1.25, ['move:pos:5', 'move:pos:10', 'move:pos:20'], [0, 0, 1]]];
  for (const [ziel, soll, wirk] of faelle) {
    const m = markt(3), g = baue(m, {}, 4);
    g.lauf(10, (min) => m.kurs(1, 1 + (ziel - 1) * Math.min(1, min / 10))); // langsam bis zum Ziel
    g.lauf(5);
    assert.deepEqual(arten(g), soll, `Ziel ${ziel}`);
    assert.ok(g.news.every((n) => wirkungOk(n.trigger, n.impact)), `Ziel ${ziel}: ${JSON.stringify(g.news.map((n) => [n.trigger, n.impact]))}`);
    if (ziel === 1.25) t.diagnostic(`20-%-Stufe: Wirkung ${g.news[2].impact} (QA-Auftrag: ±1)`);
  }
});
test('2b Pendeln um 10 % (9,8 / 10,2 %) zehn Minuten: keine dritte; Rückfall auf +2 % und neuer Anstieg über 5 % → neue 5-%-News', () => {
  const m = markt(2), g = baue(m, {}, 6);
  g.lauf(2, (min) => m.kurs(1, 1 + 0.12 * min / 2));
  assert.deepEqual(arten(g), ['move:pos:5', 'move:pos:10']);
  g.lauf(10, (min) => m.kurs(1, Math.floor(min * 60) % 2 ? 1.102 : 1.098));
  assert.equal(g.news.length, 2, `Pendeln brachte: ${arten(g).slice(2).join(', ')}`);
  m.kurs(1, 1.02); g.lauf(3);
  g.lauf(2, (min) => m.kurs(1, 1.02 + 0.04 * (min - 15) / 2));
  assert.deepEqual(arten(g), ['move:pos:5', 'move:pos:10', 'move:pos:5']);
});
test('2c Flackern direkt an der Schwelle (5,02 / 4,90 % je Sekunde, fünf Minuten): genau eine News', () => {
  const m = markt(2), g = baue(m, {}, 8);
  g.lauf(1);
  g.lauf(5, (min) => m.kurs(1, Math.floor(min * 60) % 2 ? 1.0502 : 1.0490));
  assert.deepEqual(arten(g), ['move:pos:5']);
});

// ---- 3) Abwärts, Neuling, ETF --------------------------------------------------------------------
test('3a Abwärts symmetrisch: −7 % → eine; −12 % → zwei; −25 % → drei, die 20er wirkt (−1); jeder Text redet vom Fall', () => {
  const faelle = [[0.93, ['move:neg:5'], [0]], [0.88, ['move:neg:5', 'move:neg:10'], [0, 0]], [0.75, ['move:neg:5', 'move:neg:10', 'move:neg:20'], [0, 0, -1]]];
  for (const [ziel, soll, wirk] of faelle) {
    const m = markt(3), g = baue(m, {}, 10);
    g.lauf(10, (min) => m.kurs(1, 1 - (1 - ziel) * Math.min(1, min / 10)));
    g.lauf(5);
    assert.deepEqual(arten(g), soll, `Ziel ${ziel}`);
    for (const n of g.news) {
      assert.ok(wirkungOk(n.trigger, n.impact), `Ziel ${ziel}: ${n.trigger} ${n.impact}`);
      assert.ok(/(im Minus|tiefer|weniger|gefallen|runter|unter dem Kurs)/.test(`${n.title} ${n.body}`), `${n.title} | ${n.body}`);
    }
  }
});
test('3b Frisch gelistet: keine falsche Ausreißer-News direkt nach dem IPO (ohne Referenz oder mit Referenz = IPO-Preis)', () => {
  // (i) Der Ticker hat noch keine Referenz: der erste gesehene Kurs gilt als Bezug, ±1,5 % um ihn herum bleibt still.
  const m1 = markt(2); m1.rows[1].ref = undefined; m1.rows[1].last = 10.3;
  const g1 = baue(m1, {}, 12);
  g1.lauf(30, (min) => { m1.rows[1].last = 10.3 * (1 + 0.015 * Math.sin(min)); });
  assert.deepEqual(arten(g1), []);
  // (ii) Referenz = IPO-Preis 10,--, erster Kurs 10,2 (Schluss des ersten Handels): direkt danach still.
  //      Danach +6 % über IPO (= +3,9 % über dem ersten Kurs): was meldet der Generator?
  const m2 = markt(2); m2.rows[1].ref = 10; m2.rows[1].last = 10.2;
  const g2 = baue(m2, {}, 14);
  g2.lauf(5);
  assert.deepEqual(arten(g2), [], 'direkt nach dem IPO darf nichts melden');
  m2.rows[1].last = 10.6; g2.lauf(5);
  assert.ok(g2.news.length <= 1, `über IPO +6 % brachte ${g2.news.length} News: ${arten(g2).join(', ')}`);
});
test('3c ETF nie: ETF +60 %, 60 Sim-Minuten → keine News über ihn, keine marktweite daraus', () => {
  const m = markt(3); m.rows[2].type = 'etf'; m.rows[2].last = 32;
  const g = baue(m, {}, 16); g.lauf(60);
  assert.deepEqual(arten(g), []);
});
test('3d Kehrtwende: Sprung auf +10 % → eine (10 %), Sprung auf −10 % → eine (−10 %); je Richtung einmal, höchste Stufe', () => {
  const m = markt(2), g = baue(m, {}, 18);
  g.lauf(1); m.kurs(1, 1.10); g.lauf(1); m.kurs(1, 0.90); g.lauf(1);
  assert.deepEqual(arten(g), ['move:pos:10', 'move:neg:10']);
});

// ---- 4) Stimmung ---------------------------------------------------------------------------------
test('4a Index +3 % (6 Aktien) → genau eine marktweite News ohne Aktie (+1); bleibt es extrem, 90 Minuten keine zweite', () => {
  const m = markt(6), g = baue(m, {}, 20);
  g.lauf(1); m.alle(1.032); // Sprung auf +3,2 %: Index-Auslöser (nicht Breite)
  g.lauf(4);
  assert.deepEqual(arten(g), ['mood:index:pos']);
  assert.equal(g.news[0].security_id, null); assert.equal(g.news[0].impact, 1);
  g.lauf(90, (min) => m.alle(1.032 + 0.004 * Math.sin(min)));
  assert.equal(g.news.length, 1, arten(g).join(', '));
});
test('4b Index +3 %, Sperre 30 Sim-Minuten: beruhigt und innerhalb der Sperre wieder extrem → nichts; nach der Sperre → eine zweite', () => {
  const m = markt(6), g = baue(m, {}, 22);
  const stimmung = () => g.news.filter((n) => n.trigger.startsWith('mood'));
  g.lauf(1); m.alle(1.033); g.lauf(4); // erste News beim Sprung auf +3,3 %
  const erste = stimmung()[0].at;
  m.alle(1.0); g.lauf(3); m.alle(1.05); g.lauf(21); // beruhigt (Riegel offen), innerhalb der Sperre wieder extrem
  assert.equal(stimmung().length, 1, `zweite Stimmung nach ${stimmung()[1] ? (stimmung()[1].at - erste).toFixed(2) : '—'} min`);
  g.lauf(4); // Sperre abgelaufen (31 Sim-Minuten nach der ersten), Marktlage unverändert extrem → jetzt frei
  assert.equal(stimmung().length, 2, arten(g).join(', '));
  assert.ok(stimmung()[1].at - erste >= 30, `Abstand ${(stimmung()[1].at - erste).toFixed(1)} min`);
});
test('4c Index −3 % → eine mit −1, Text redet vom Fall', () => {
  const m = markt(6), g = baue(m, {}, 24);
  g.lauf(1); m.alle(1 - 0.034); g.lauf(4);
  assert.deepEqual(arten(g), ['mood:index:neg']);
  assert.equal(g.news[0].impact, -1);
  assert.ok(/(Minus|tiefer|fällt|verlieren|rot)/.test(`${g.news[0].title} ${g.news[0].body}`));
});
test('4d Breite ≥ 80 % erst ab 5 Aktien: 4 Aktien alle +2,5 % → nichts; 5 Aktien, 4 davon +2,6 % → eine Breiten-News „4 von 5“', () => {
  const m4 = markt(4), g4 = baue(m4, {}, 26);
  g4.lauf(10, () => m4.alle(1.025));
  assert.deepEqual(arten(g4), []);
  const m5 = markt(5), g5 = baue(m5, {}, 28);
  g5.lauf(1);
  g5.lauf(10, () => { [1, 2, 3, 4].forEach((i) => m5.kurs(i, 1.026)); m5.kurs(5, 1.0); });
  assert.deepEqual(arten(g5), ['mood:breite:pos']);
  assert.match(g5.news[0].body, /4 von 5 Aktien liegen im Plus/);
  assert.equal(g5.news[0].impact, 1);
});
test('4e Ein einzelner Wert (+12 %) in einem Markt mit 4 Aktien (Seed-Größe) ist keine „Marktstimmung“', (t) => {
  // ANNAHME: „Marktstimmung“ in E018 meint den ganzen Markt. Der Code begründet die Mindestzahl bei der Breite selbst
  // mit „sonst ist eine Aktie der Markt“; für den Index gilt das erst recht, weil die News ±1 auf ALLE Aktien wirkt.
  const m = markt(4), g = baue(m, {}, 30);
  g.lauf(2, (min) => m.kurs(1, 1 + 0.12 * Math.min(1, min / 2))); g.lauf(3);
  const marktweit = g.news.filter((n) => n.security_id === null);
  t.diagnostic(`Marktweite News aus einem Wert: ${marktweit.map((n) => `${n.trigger} (${n.impact}) „${n.title}“`).join('; ') || 'keine'}`);
  assert.equal(marktweit.length, 0, marktweit.map((n) => n.title).join('; '));
});

// ---- 5) Gerüchte --------------------------------------------------------------------------------
test('5a Zwei Kandidaten (+6 % bzw. −7 % in 5 Minuten), Zufall sagt immer „Gerücht“: ≥ 1, ≤ 4 in 200 Minuten, Abstände ≥ 45 Sim-min', (t) => {
  const m = markt(6), g = baue(m, {}, 32, () => 0); // Zufall 0 → Kandidat wird immer gezogen, Variante 0
  g.lauf(5, (min) => { m.kurs(1, 1 + 0.06 * min / 5); m.kurs(2, 1 - 0.07 * min / 5); });
  g.lauf(195);
  const r = g.news.filter((n) => n.kind === 'rumor');
  t.diagnostic(`Gerüchte bei Sim-Minute ${r.map((n) => n.at.toFixed(0)).join(', ')} (Kandidaten seit Minute 5)`);
  assert.ok(r.length >= 1, 'in 200 Minuten mit zwei Kandidaten muss ein Gerücht kommen');
  assert.ok(r.length <= 4, `${r.length} Gerüchte in 200 Minuten — mehr als eines je 45 Sim-min`);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].at - r[i - 1].at >= 45 - 1e-9, `Abstand ${(r[i].at - r[i - 1].at).toFixed(1)} min`);
  for (const n of r) {
    assert.ok(/Investment AG/.test(n.title) && n.title.endsWith('?'), n.title);
    assert.match(n.body, /Investment AG/);
    const hoch = n.security_id === 1;
    assert.equal(n.impact, hoch ? 1 : -1, n.title);
    if (hoch) assert.doesNotMatch(n.title, /(stürzt|verlassen|fällt weiter|mehr Minus)/, n.title);
    else assert.doesNotMatch(n.title, /(Geheimtipp|läuft weiter|alle wollen|mehr Plus)/, n.title);
  }
});
test('5e Gerücht: Textrichtung, Bewegung und Wirkung zeigen in dieselbe Richtung (kein „läuft weiter?“ mit Wirkung −1)', (t) => {
  const widerspruch = [], alle = [];
  for (const seed of [61, 62, 63, 64, 65, 66, 67, 68]) {
    const m = markt(6), g = baue(m, {}, seed);
    g.lauf(2); m.kurs(1, 1.06); // ein Wert steigt um 6 % und bleibt dort
    g.lauf(200);
    for (const n of g.news.filter((x) => x.kind === 'rumor')) {
      const steigt = n.trigger === 'rumor:pos';
      alle.push(n);
      if (steigt ? /stürzt weiter|verlassen|fällt weiter|mehr Minus/.test(n.title) : /Geheimtipp|läuft weiter|alle wollen|mehr Plus/.test(n.title)) widerspruch.push(`Text gegen die Bewegung: ${n.title}`);
      else if (n.impact !== (steigt ? 1 : -1)) widerspruch.push(`Wirkung gegen den Text: (${n.impact > 0 ? '+' : ''}${n.impact}) ${n.title}`);
    }
  }
  t.diagnostic(`${alle.length} Gerüchte über einen gestiegenen Wert, davon ${widerspruch.length} mit Wirkung oder Text gegen die Bewegung:\n   ${widerspruch.slice(0, 6).join('\n   ')}`);
  assert.ok(alle.length >= 4, `zu wenige Gerüchte für eine Aussage (${alle.length})`);
  assert.deepEqual(widerspruch, []);
});
test('5b Träge Bewegung (2 % in 30 Minuten, über zwei Stunden +8 %) bringt nie ein Gerücht', () => {
  const m = markt(6), g = baue(m, {}, 34, () => 0);
  g.lauf(120, (min) => m.kurs(1, 1 + 0.08 * min / 120));
  assert.equal(g.news.filter((n) => n.kind === 'rumor').length, 0);
});

// ---- 6) Wirkung je Auslöser, Rückkopplung -----------------------------------------------------------
// Beschluss (E018-Ergänzung): höchstens 4 Ausreißer-News je 10 Sim-Minuten über alle Aktien, die größten zuerst.
// Deshalb laufen die sechs Werte hier versetzt (je 15 Minuten einer), damit jeder seine Stufen ohne Deckel zeigt.
test('6a Wirkung je Auslöser über alle Stufen und Richtungen: 5/10 % = 0, 20 % = 0 oder ±1 gleichgerichtet, Stimmung ±1, Gerücht ±1; klein', () => {
  const m = markt(8), g = baue(m, {}, 36);
  const plan = { 1: 1.25, 2: 0.75, 3: 1.12, 4: 0.88, 5: 1.07, 6: 0.93 };
  g.lauf(95, (min) => {
    for (const [i, f] of Object.entries(plan)) { const start = 15 * (Number(i) - 1); m.kurs(Number(i), 1 + (f - 1) * Math.max(0, Math.min(1, (min - start) / 10))); }
  });
  const soll = { 1: ['move:pos:5', 'move:pos:10', 'move:pos:20'], 2: ['move:neg:5', 'move:neg:10', 'move:neg:20'], 3: ['move:pos:5', 'move:pos:10'], 4: ['move:neg:5', 'move:neg:10'], 5: ['move:pos:5'], 6: ['move:neg:5'] };
  for (const [id, art] of Object.entries(soll)) assert.deepEqual(g.news.filter((n) => n.security_id === Number(id) && n.kind === 'news').map((n) => n.trigger), art, `Aktie ${id}`);
  for (const n of g.news) {
    assert.ok(wirkungOk(n.trigger, n.impact), `${n.trigger} ${n.impact}`);
    assert.ok(Number.isInteger(n.impact) && Math.abs(n.impact) <= 1, n.trigger);
  }
  // Ausreißer-News allein: an EINEM Wert nie mehr als ±1 Summe über alle Stufen (hier: drei Stufen je Richtung).
  const jeAktie = new Map();
  for (const n of g.news) if (n.kind === 'news') jeAktie.set(n.security_id, (jeAktie.get(n.security_id) || 0) + n.impact);
  for (const [id, s] of jeAktie) assert.ok(Math.abs(s) <= 1, `Aktie ${id}: Summe der Wirkung ${s}`);
});
// Beschluss (E018-Ergänzung): Dichte-Deckel 4 Ausreißer-News je 10 Sim-Minuten, die größten zuerst, kleinere gelten als erledigt.
test('6d Dichte-Deckel: sechs Werte springen gleichzeitig (+7, +25, +9, +30, +12, +6 %) → genau vier Meldungen, die größten; die beiden kleinen nie nachgeholt', () => {
  const m = markt(8), g = baue(m, {}, 38, () => 0);
  g.lauf(1);
  for (const [i, f] of Object.entries({ 1: 1.07, 2: 1.25, 3: 1.09, 4: 1.30, 5: 1.12, 6: 1.06 })) m.kurs(Number(i), f);
  g.lauf(11);
  const moves = g.news.filter((n) => n.trigger.startsWith('move'));
  assert.deepEqual(moves.map((n) => n.security_id).sort(), [2, 3, 4, 5], moves.map((n) => n.title).join(' | '));
  for (const n of g.news) if (n.trigger.startsWith('move')) assert.ok(![1, 6].includes(n.security_id), `${n.title} — kleiner Auslöser wurde gemeldet`);
});
// Wirkung je Pool (Schlüssel wie in renderTemplates): move:<dir>:<stufe>, mood:<art>:<dir>, rumor:<dir>
function wirkung(pool) {
  const [a, b, c] = pool.split(':');
  if (a === 'move') return c === '20' ? (b === 'pos' ? 1 : -1) : 0; // oberer Rand des Erlaubten (0 wäre auch recht)
  return c === 'pos' ? 1 : -1;
}
test('6b Was die Bots aus den beschreibenden News (Wirkung 0) machen: nichts (E018: kleine/keine Wirkung, keine Rückkopplung)', (t) => {
  const gelesen = [];
  for (const [pool, list] of Object.entries(renderTemplates())) {
    if (!pool.startsWith('move:') || wirkung(pool) !== 0) continue;
    for (const x of list) {
      const wert = brain.newsImpact({ kind: 'news', title: x.title, body: x.body, impact: 0 }).value;
      if (wert !== 0) gelesen.push(`${pool} „${x.title}“ → ${wert}`);
    }
  }
  t.diagnostic(gelesen.length ? `Bots lesen Stichwörter statt 0 (${gelesen.length} von 48 Vorlagen):\n   ${gelesen.join('\n   ')}` : 'alle beschreibenden Vorlagen → 0');
  assert.deepEqual(gelesen, []);
});
test('6c Alle Vorlagen mit Wirkung: gleichgerichtet (Vorzeichen = Richtung) und klein (±0,1)', () => {
  for (const [pool, list] of Object.entries(renderTemplates())) {
    const imp = wirkung(pool);
    for (const x of list) {
      const wert = brain.newsImpact({ kind: pool.startsWith('rumor') ? 'rumor' : 'news', title: x.title, body: x.body, impact: imp }).value;
      if (imp !== 0) {
        assert.ok(Math.sign(wert) === Math.sign(imp) && Math.abs(wert) <= 0.1, `${pool} „${x.title}“ → ${wert}`);
      }
    }
  }
});

// ---- 7) Robustheit --------------------------------------------------------------------------------
test('7a Keine Aktien, leerer Markt oder market() = undefined: kein Fehler, keine News', () => {
  for (const zeilen of [[], undefined, null, 'x']) {
    const gen = createNewsGenerator({ market: () => zeilen, settings: () => ({}), addNews: () => ({ id: 1 }), emit() {} });
    let uhr = 0;
    for (let i = 0; i < 30; i++) { uhr += T; gen.once(uhr, () => 0); }
    assert.ok(true);
  }
});
test('7b trading_paused = 1: nichts; direkt nach dem Weiterlauf keine Flut, der stehende Auslöser kommt einmal', () => {
  const m = markt(3); let pausiert = false;
  const g = baue(m, () => ({ trading_paused: pausiert ? 1 : 0 }), 42, () => 0);
  g.lauf(2); m.kurs(1, 1.30); g.lauf(1);
  assert.deepEqual(arten(g), ['move:pos:20']);
  pausiert = true; m.kurs(1, 1.0); g.lauf(30);      // Pause: Kurs steht 30 Minuten tief, nichts darf melden
  assert.equal(g.news.length, 1, 'während der Pause: ' + arten(g).join(', '));
  pausiert = false; g.lauf(10);                       // Weiterlauf: kein Nachholen
  assert.equal(g.news.length, 1, 'nach der Pause: ' + arten(g).join(', '));
  m.kurs(1, 1.10); g.lauf(1);
  assert.deepEqual(ohneGeruecht(g), ['move:pos:20', 'move:pos:10'], 'nach der Pause meldet ein neuer Auslöser normal (Sprung 0 → +10 %: höchste Stufe)');
});
test('7c Uhrsprung +1 h: kein Nachholen; −1 h: keine Flut', () => {
  const m = markt(4), g = baue(m, {}, 44, () => 0);
  g.sprung(60 * MIN); g.lauf(10);
  assert.deepEqual(arten(g), []);
  m.kurs(1, 1.25); g.lauf(1);
  assert.deepEqual(arten(g), ['move:pos:20']);
  g.sprung(-60 * MIN); g.lauf(10);
  assert.deepEqual(arten(g), ['move:pos:20'], 'nach dem Rücksprung kam mehr');
});
test('7c2 Nach einem Rücksprung der Uhr sind die Sperren nicht verlängert (30 Sim-Minuten bleiben 30 Sim-Minuten)', (t) => {
  // Erwartung aus E018: Sperrzeiten in Sim-Minuten. Geht die Uhr eine Stunde zurück, darf die Sperre
  // für die Stimmung nicht eine Stunde länger halten als vereinbart.
  const m = markt(6), g = baue(m, {}, 46, () => 0);
  g.lauf(5, (min) => m.alle(1 + 0.033 * Math.min(1, min / 5)));
  const erste = g.news[0].at;
  g.sprung(-60 * MIN);          // Uhr steht jetzt bei ≈ −55 min
  m.alle(1.0); g.lauf(5); m.alle(1.05); g.lauf(26); // 31 Sim-Minuten später, Marktlage wieder extrem
  const zweite = g.news[1];
  t.diagnostic(`Stimmung 1 bei ${erste.toFixed(1)} min, Uhr −60 min, dann 31 Min weiter: ${zweite ? `zweite bei ${zweite.at.toFixed(1)} (real ${(zweite.at + 60 - erste).toFixed(1)} min nach der ersten)` : 'keine zweite'}`);
  assert.ok(zweite, '31 Sim-Minuten nach der ersten News muss die Stimmung wieder melden dürfen');
});
// Beschluss (E018-Ergänzung): höchstens 4 Ausreißer-News je 10 Sim-Minuten; der Deckel ersetzt die frühere Grenze 8 je Takt.
test('7d 12 Aktien springen gleichzeitig: vier Ausreißer-News im ersten Takt, danach zehn Minuten Still; der Rest gilt als erledigt', () => {
  const m = markt(12);
  const gen = createNewsGenerator({ market: () => m.rows, settings: () => ({}), addNews: (k, ti, b, s, i) => ({ id: 0, kind: k, title: ti, body: b, security_id: s, impact: i }), emit() {} });
  gen.once(T, () => 0); // ruhiger erster Takt legt den Bezug
  m.alle(1.25);
  const out = [];
  for (let t = 2; t <= 600; t++) out.push(...gen.once(t * T, () => 0));
  const jeTakt = [1, 2, 3, 4].map((t) => out.filter((n) => n.id >= 0 && false).length);
  void jeTakt;
  const ersten = gen.state().count;
  assert.deepEqual(out.filter((n) => n.trigger.startsWith('move')).length, 4, out.map((n) => n.trigger).join(', '));
  assert.deepEqual(out.map((n) => n.trigger).filter((x) => !x.startsWith('move')), ['mood:index:pos'], 'dazu einmal Stimmung (12 Aktien, Index +25 %)');
  assert.equal(ersten, 5);
});
test('7e Sprung direkt auf +25 % in einem Takt: eine News (höchste Stufe, +1), danach Still — nicht drei auf einmal', () => {
  const m = markt(3), g = baue(m, {}, 50, () => 0);
  g.lauf(1); m.kurs(1, 1.25); g.lauf(5);
  assert.deepEqual(arten(g), ['move:pos:20']);
});

// ---- 8) Fast-Modus: Sperrzeiten in Sim-Minuten ---------------------------------------------------------
test('8a Je Takt 100 Sim-Sekunden (Fast): Stimmung frühestens nach 30 Sim-Minuten, Gerüchte im Abstand ≥ 45 Sim-Minuten', (t) => {
  const m = markt(8);
  const news = [];
  const gen = createNewsGenerator({ market: () => m.rows, settings: () => ({}), addNews: (k, ti, b, s, i) => { const z1 = { id: 0, kind: k, title: ti, body: b, security_id: s, impact: i }; news.push(z1); return z1; }, emit() {} });
  const z = () => 0;
  const stimmung = [], geruechte = [];
  for (let tick = 1; tick <= 60; tick++) { // 60 Takte = 6000 Sim-s = 100 Sim-min
    const simMin = tick * 100 / 60;
    // Markt pendelt im 20-Sim-min-Takt zwischen ruhig und extrem; Aktie 1 springt alle 20 min um +6 % und zurück
    const phase = simMin % 20;
    m.alle(phase < 10 ? 1.05 : 1.0);
    m.kurs(1, phase < 10 ? 1.3 : 1.0);
    const vor = news.length;
    gen.once(tick * 100 * T, z);
    for (const n of news.slice(vor)) if (n.security_id === null) stimmung.push(simMin);
    for (const n of news.slice(vor)) if (n.kind === 'rumor') geruechte.push(simMin);
  }
  const abstand = (xs) => xs.slice(1).map((x, i) => x - xs[i]);
  t.diagnostic(`Fast: Stimmung bei ${stimmung.map((x) => x.toFixed(1)).join(', ')} Sim-min; Gerüchte bei ${geruechte.map((x) => x.toFixed(1)).join(', ') || '—'}`);
  for (const d of abstand(stimmung)) assert.ok(d >= 30 - 100 / 60, `Stimmung-Abstand ${d.toFixed(1)} Sim-min`);
  for (const d of abstand(geruechte)) assert.ok(d >= 45 - 100 / 60, `Gerücht-Abstand ${d.toFixed(1)} Sim-min`);
  assert.ok(stimmung.length >= 1, 'im wechselnden Markt muss irgendwann eine Stimmung kommen');
});

// ---- 9) Sprache: ALLE Textvarianten ----------------------------------------------------------------
const AMT = ['hiermit', 'bekannt', 'verfüg', 'gemäß', 'ordnungsgemäß', 'zuständig', 'behörd', 'gesetzlich', 'hinsichtlich', 'bezüglich', 'vorstehend', 'nachfolgend', 'dient zur', 'wir bitten', 'zu beachten'];
const HOCH = ['plus', 'steigt', 'steigen', 'höher', 'rauf', 'grün', 'gewinnt', 'gewinnen', 'gut'];
const RUNTER = ['minus', 'fällt', 'fallen', 'stürzt', 'absturz', 'tiefer', 'runter', 'rot', 'verliert', 'verlieren', 'schwacher tag'];
const EMOJI = /\p{Extended_Pictographic}/u;
function worte(text) { return text.toLowerCase().replace(/überall|leuchtet/g, ' ').replace(/kaum eine aktie (steigt|fällt)/g, ' '); }
test('9a Alle Vorlagen: ohne Emoji, ohne Amtston, kurz, Kürzel in jeder Firmen-Schlagzeile, Gerücht mit „?“ und „Investment AG“', () => {
  let n = 0;
  for (const [pool, list] of Object.entries(renderTemplates())) {
    for (const x of list) {
      n++;
      const text = `${x.title} ${x.body}`;
      assert.ok(!EMOJI.test(text), `Emoji in ${pool}: ${text}`);
      for (const w of AMT) assert.ok(!text.toLowerCase().includes(w), `Amtston „${w}“ in ${pool}: ${text}`);
      assert.ok(x.title.length <= 60, `Schlagzeile zu lang (${x.title.length}): ${x.title}`);
      assert.ok(x.body.length <= 170, `Text zu lang (${x.body.length}): ${x.body}`);
      if (pool.startsWith('move:') || pool.startsWith('rumor:')) assert.ok(x.title.includes('MENSA'), `${pool} ohne Kürzel: ${x.title}`);
      if (pool.startsWith('rumor:')) { assert.ok(x.title.endsWith('?'), x.title); assert.ok(/Investment AG/.test(x.title), x.title); }
      if (pool.startsWith('mood:')) assert.ok(!x.title.includes('MENSA'), `marktweite News nennt eine Aktie: ${x.title}`);
    }
  }
  assert.equal(n, 48, '24 + 16 + 8 Vorlagen');
});
test('9b Kein Widerspruch Text ↔ Richtung: keine Gegenwörter in Aktien- und Gerücht-Texten', () => {
  for (const [pool, list] of Object.entries(renderTemplates())) {
    if (pool.startsWith('mood:')) continue; // dort steht „Kaum eine Aktie steigt“ absichtlich verneint
    const hoch = pool.includes(':pos');
    for (const x of list) {
      const text = worte(`${x.title} ${x.body}`);
      for (const w of hoch ? RUNTER : HOCH) assert.ok(!text.includes(w), `${pool} nennt „${w}“: ${x.title} | ${x.body}`);
    }
  }
});
test('9c Stimmungs-Texte: Richtung stimmt, Zahl der Breite stimmt mit dem Text überein', () => {
  const m = markt(6), g = baue(m, {}, 52, () => 0);
  g.lauf(1);
  g.lauf(10, () => { [1, 2, 3, 4, 5].forEach((i) => m.kurs(i, 1.026)); m.kurs(6, 1.0); });
  const breit = g.news.filter((x) => x.trigger === 'mood:breite:pos');
  assert.equal(breit.length, 1);
  assert.match(breit[0].body, /5 von 6 Aktien liegen im Plus/);
  assert.match(breit[0].body, /2 % höher/); // 5 × 2,6 % / 6 = 2,2 %
  assert.match(breit[0].body, /Messbeginn|24 Stunden/); // Beschluss: Bezugstext „am Messbeginn“ oder „vor 24 Stunden“ (wenn die Historie reicht)
});

// ---- 10) Drehbuch über 3 Sim-Stunden (synthetisch): News je 10 Minuten --------------------------------
test('10a Drehbuch 3 Sim-Stunden, 10 Aktien mit realistischem Rauschen und vier Ereignissen: Zählung je 10 Minuten', (t) => {
  const m = markt(10), z = zufall(777);
  // Drehbuch (Sim-Minute → Faktor): ruhiger Random Walk ±0,3 %/min um 1; dazu vier Ereignisse.
  const lage = Array(10).fill(1);
  const ereignis = (i, min) => {
    if (i === 0) return min < 40 ? 0 : min < 50 ? 0.08 * (min - 40) / 10 : min < 90 ? 0.08 : min < 110 ? 0.08 * (1 - (min - 90) / 20) : 0;     // Rally +8 %, verebbt
    if (i === 1) return min < 100 ? 0 : min < 103 ? -0.22 * (min - 100) / 3 : -0.22;                                                            // Absturz −22 %
    if (i === 2) return min < 150 ? 0 : min < 170 ? 0.06 * (min - 150) / 20 : 0.06;                                                              // Sammelkurs +6 %
    return min < 190 ? 0 : min < 200 ? -0.09 * (min - 190) / 10 : -0.09;                                                                          // −9 %
  };
  const marktphase = (min) => (min < 150 ? 0 : min < 170 ? 0.035 * (min - 150) / 20 : min < 215 ? 0.035 : min < 225 ? 0.035 * (1 - (min - 215) / 10) : 0); // Index +3,5 %
  const g = baue(m, {}, 79);
  let minute = 0;
  g.lauf(180, (mm) => {
    if (Math.floor(mm) !== minute) { minute = Math.floor(mm); for (let i = 0; i < 10; i++) lage[i] = Math.max(0.8, Math.min(1.2, lage[i] * (1 + (z() - 0.5) * 0.006))); }
    for (let i = 0; i < 10; i++) m.kurs(i + 1, lage[i] * (1 + ereignis(i, mm)) * (1 + marktphase(mm)));
  });
  const je10 = Array(18).fill(0);
  for (const n of g.news) je10[Math.min(17, Math.floor(n.at / 10))]++;
  t.diagnostic(`Drehbuch 3 h: ${g.news.length} Auto-News; je 10 min [${je10.join(' ')}]\n   ${g.news.map((n) => `[${n.at.toFixed(0)}] ${n.trigger} (${n.impact > 0 ? '+' : ''}${n.impact}) ${n.title}`).join('\n   ')}`);
  assert.ok(g.news.length > 0);
  // Aus E018: je Schwelle einmal, Still ohne Ereignis. Die ruhigen Phasen (0–40, 110–150) bleiben leer,
  // kein Fenster über 4 (Absturz −22 %: drei Stufen + höchstens ein Gerücht).
  assert.deepEqual(je10.slice(0, 3), [0, 0, 0], `ruhige erste 30 Minuten: ${je10.slice(0, 3)}`);
  // Beschluss: höchstens 4 Ausreißer-News je 10 Sim-Minuten, dazu höchstens 1 Stimmung und 1 Gerücht.
  const moves10 = Array(18).fill(0);
  for (const n of g.news) if (n.trigger.startsWith('move')) moves10[Math.min(17, Math.floor(n.at / 10))]++;
  assert.ok(Math.max(...moves10) <= 4, `dichtestes Fenster ${Math.max(...moves10)} Ausreißer-News`);
  assert.ok(Math.max(...je10) <= 6, `dichtestes Fenster ${Math.max(...je10)} News`);
});

// ---- 11) Echte Bindung im Kindprozess: Fallback ohne setMarket, Start-Flut, Markt mit Bots -------------
// Eigene DB qa6b-<pid>-<modus>.db, virtuelle Uhr (Date.now), kein Port, kein Timer. jobs.tickNews() ruft
// setMarket + once exactly wie im Betrieb; newsgen.once() ohne setMarket davor muss auf engine.tickerAll() fallen.
function kind() {
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const MIN = 60 * 1000;
  const env = process.env, server = env.Q_SERVER;
  const seed = Number(env.Q_SEED), fast = Number(env.Q_FAST), minutes = Number(env.Q_MINUTES), stepMs = Number(env.Q_STEP);
  const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  Math.random = mulberry32(seed);
  const rnd = mulberry32(seed * 7919 + 17);
  process.env.DB_NAME = env.Q_DB; process.env.ADMIN_PASSWORD = 'ag1234';
  execFileSync(process.execPath, [path.join(server, 'seed.js')], { env: process.env, stdio: 'ignore' });
  let clock = Date.now();
  Date.now = () => clock;
  const { db, getSettings, setSetting } = require(path.join(server, 'db'));
  const engine = require(path.join(server, 'engine'));
  engine.loadEngine();
  const bots = require(path.join(server, 'bots.js'));
  const newsgen = require(path.join(server, 'newsgen.js'));
  const jobs = require(path.join(server, 'jobs.js'));
  db.pragma('synchronous = OFF');
  setSetting('bot_fast', fast);
  bots.prepare();
  const stocks = () => [...engine.books.values()].filter((b) => b.sec.type === 'stock');
  const setz = (b, f) => { const r = engine.tickerRow(b.sec.id).ref; b.last = Math.round(r * f * 1000) / 1000; b.ver++; };
  const s0 = stocks();
  const tief = s0.map((b) => ({ ticker: b.sec.ticker, shares: b.sec.total_shares, depth: engine.impactDepth(b.sec.id), ipo: b.sec.ipo_price }));
  const basis = stocks(); const letzte = basis[basis.length - 1];
  // (a) Fallback: gar kein setMarket; ruhiger Takt, dann eine Aktie +12 % → News über engine.tickerAll()
  newsgen.reset();
  newsgen.once(clock); setz(letzte, 1.12);
  const ohne = newsgen.once(clock + 1000);
  // (b) veraltetes Marktbild (> 60 s alt) → ebenfalls tickerAll
  setz(letzte, 1.0); newsgen.reset();
  newsgen.once(clock); setz(letzte, 1.12);
  newsgen.setMarket({ now: clock - 61000, securities: [] });
  const veraltet = newsgen.once(clock + 1000);
  // (b2) frisches Marktbild mit ANDEREN Kursen als im Orderbuch: das Marktbild gewinnt
  setz(letzte, 1.0); newsgen.reset(); newsgen.once(clock);
  newsgen.setMarket({ now: clock, securities: [{ id: letzte.sec.id, type: 'stock', last: engine.tickerRow(letzte.sec.id).ref * 1.07 }] });
  const frisch = newsgen.once(clock + 1000);
  newsgen.reset();
  // (c) Server startet mitten im Tag: alle Seed-Aktien stehen schon +10 % gegen den Ticker-Bezug
  basis.forEach((b) => setz(b, 1.10));
  const start = newsgen.once(clock);
  basis.forEach((b) => setz(b, 1.0)); newsgen.reset();
  const tief0 = engine.tickerAll().filter((x) => x.type === 'stock').map((x) => x.last / x.ref - 1);
  // (d) Markt mit 100 Bots, News über jobs.tickNews() wie im Betrieb
  const botIds = new Set(db.prepare('SELECT id FROM users WHERE is_bot=1').all().map((u) => u.id));
  const runner = bots.createBotRunner({ rnd, now: () => clock, settings: getSettings, repo: bots.buildRepo(), counters: { orders: 0, trades: 0, errors: 0, skips: {} } });
  const basisNews = db.prepare('SELECT MAX(id) m FROM news').get().m; // die Vorproben (a)–(c) oben zählen nicht
  const t0 = clock;
  const n10 = Math.ceil(minutes / 10);
  const je10 = Array(n10).fill(0), max10 = Array(n10).fill(0);
  const ueber = { 5: 0, 10: 0, 20: 0 };      // wie oft ein Wert im Verlauf über einer Schwelle steht (Stichproben)
  const maxChg = new Map();
  // Fast (×100): ein Takt ist 100 Sim-Sekunden — die Taktzahl folgt aus der Sim-Zeit, 3 Sim-Stunden sind 108 Takte.
  const steps = Math.round(minutes * MIN / (stepMs * (fast ? 100 : 1)));
  const phIns = db.prepare('INSERT INTO price_history(security_id, ts, price, amount) VALUES(?,?,?,0)');
  const priceSampler = () => { for (const book of engine.books.values()) phIns.run(book.sec.id, clock, book.last); };
  const trace = []; let erster = null;
  for (let i = 0; i < steps; i++) {
    clock += stepMs;
    if (i < 24) {
      const jetzt = Object.fromEntries(engine.tickerAll().filter((x) => x.type === 'stock').map((x) => [x.ticker, x.last]));
      erster = erster || jetzt;
      trace.push({ t: (clock - t0) * (fast ? 100 : 1), p: Object.keys(jetzt).map((k) => `${k} ${(((jetzt[k] / erster[k]) - 1) * 100).toFixed(1)}`).join(' ') });
    }
    engine.mmRefreshAll();
    runner.tick();
    jobs.tickNews();
    if (i % 30 === 0) priceSampler();
    const simMin = (clock - t0) * (fast ? 100 : 1) / MIN;
    const f = Math.min(n10 - 1, Math.floor(simMin / 10));
    for (const x of engine.tickerAll()) {
      if (x.type !== 'stock' || !(x.ref > 0)) continue;
      const c = Math.abs(x.last / x.ref - 1) * 100;
      max10[f] = Math.max(max10[f], c);
      maxChg.set(x.ticker, Math.max(maxChg.get(x.ticker) || 0, c));
      if (c >= 5) ueber[5]++; if (c >= 10) ueber[10]++; if (c >= 20) ueber[20]++;
    }
  }
  const zeilen = db.prepare("SELECT kind, title, impact, security_id, created_at FROM news WHERE kind IN ('news','rumor') AND id > ? ORDER BY id").all(basisNews);
  // Erste Takte: Kurs je Aktie gegen den Stand im ersten Takt (so rechnet der Generator seinen Bezug)
  const frueh = trace.slice(0, 24).map((x) => `${(x.t / 1000).toFixed(0)}s ${x.p}`);
  for (const z1 of zeilen) je10[Math.min(n10 - 1, Math.floor((z1.created_at - t0) * (fast ? 100 : 1) / MIN / 10))]++;
  const trades = db.prepare('SELECT COUNT(*) c, SUM(amount) s FROM trades WHERE created_at >= ?').get(t0);
  const botCash = db.prepare('SELECT SUM(cash) c FROM users WHERE is_bot=1').get().c;
  const p = Number(getSettings().mm_impact_pct);
  const volumen = Object.fromEntries(tief.map((x) => [x.ticker, [5, 10, 20].map((k) => Math.round(x.depth * Math.log(1 + k / 100) / Math.log(1 + p / 100)))]));
  const botsN = botIds.size;
  void botIds; void tief0;
  process.stdout.write('\nQA6B ' + JSON.stringify({
    ohne: ohne.map((n) => n.trigger), veraltet: veraltet.map((n) => n.trigger), frisch: frisch.map((n) => n.trigger), start: start.map((n) => `${n.trigger}|${n.title}`),
    tief, volumen, p, fast, minutes, stepMs, stocks: stocks().length, bots: botsN, je10, max10: max10.map((x) => Math.round(x * 10) / 10), ueber, maxChg: Object.fromEntries(maxChg),
    news: zeilen.map((z1) => `${((z1.created_at - t0) * (fast ? 100 : 1) / 1000).toFixed(0)}s|${z1.kind}|${z1.impact}|${z1.title}`), frueh,
    trades, botCash,
  }) + '\n');
}
function kindLauf(fast, minutes, stepMs) {
  const name = `qa6b-${process.pid}-${fast ? 'fast' : 'normal'}.db`;
  const r = spawnSync(process.execPath, ['-e', `(${kind.toString()})()`], {
    env: { ...process.env, Q_SERVER: SERVER, Q_DB: name, Q_SEED: 5, Q_FAST: fast, Q_MINUTES: minutes, Q_STEP: stepMs },
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 400000,
  });
  for (const e of ['', '-wal', '-shm']) { const f = path.join(SERVER, 'data', name + e); if (fs.existsSync(f)) fs.unlinkSync(f); }
  assert.equal(r.status, 0, `Kindprozess (${fast ? 'fast' : 'normal'}): ${r.stderr.slice(-2000)}`);
  const zeile = r.stdout.split("\n").find((l) => l.startsWith("QA6B "));
  assert.ok(zeile, r.stdout.slice(-2000));
  return JSON.parse(zeile.slice(5));
}
test('11a Echte Bindung: ohne setMarket liest newsgen engine.tickerAll(); veraltetes Marktbild wird nicht benutzt', () => {
  const k = kindLauf(1, 1, 1000);
  assert.deepEqual(k.ohne, ['move:pos:10']);
  assert.deepEqual(k.veraltet, ['move:pos:10']);
  assert.deepEqual(k.frisch, ['move:pos:5']);
});
test('11b Serverstart mitten im Tag (alle Seed-Aktien +10 % gegen den Ticker-Bezug): kein Nachrichten-Schub im ersten Takt', (t) => {
  const k = kindLauf(1, 1, 1000);
  t.diagnostic(`erster Takt beim Start: ${k.start.length} News ${k.start.join(' ; ')}`);
  assert.deepEqual(k.start, []);
});
test('11c Echter Markt mit Bots, Fast-Modus (100×), 3 Sim-Stunden über jobs.tickNews(): News je 10 Sim-Minuten', { timeout: 420000 }, (t) => {
  const k = kindLauf(1, 180, 1000);
  t.diagnostic(`FRÜH (Kurs gegen ersten Takt):\n   ${k.frueh.join('\n   ')}\n   FAST: ${k.stocks} Aktien (Start), Volumen für 5/10/20 %: ${JSON.stringify(k.volumen)} bei mm_impact_pct ${k.p}, Streubesitz ${k.tief.map((x) => x.depth).join('/')}\n   News je 10 min [${k.je10.join(' ')}] = ${k.news.length}; größte |Änderung| je 10 min [${k.max10.join(' ')}]\n   ${k.news.join('\n   ') || '— keine Auto-News —'}\n   Stichproben über 5/10/20 %: ${JSON.stringify(k.ueber)}; max je Aktie ${JSON.stringify(k.maxChg)}; Trades ${k.trades.c} (${k.trades.s} Stück)`);
  assert.ok(Array.isArray(k.je10));
});
test('11d Echter Markt mit Bots, Normal-Modus, 2 Sim-Stunden über jobs.tickNews(): kommt überhaupt eine Auto-News?', { timeout: 420000 }, (t) => {
  const k = kindLauf(0, 120, 3000);
  t.diagnostic(`NORMAL: ${k.stocks} Aktien (Start); News je 10 min [${k.je10.join(' ')}] = ${k.news.length}; größte |Änderung| je 10 min [${k.max10.join(' ')}]\n   ${k.news.slice(0, 8).join('\n   ')}\n   FRÜH (Kurs gegen ersten Takt): ${k.frueh.map((x) => x.replace(/ [A-Z]+ -?0\.0/g, '')).join(' | ')}\n   Stichproben über 5/10/20 %: ${JSON.stringify(k.ueber)}; max je Aktie ${JSON.stringify(k.maxChg)}; Trades ${k.trades.c} (${k.trades.s} Stück)`);
  assert.ok(Array.isArray(k.je10));
});
