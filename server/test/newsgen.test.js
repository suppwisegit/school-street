// Tests für den ereignisgetriebenen News-Generator (E018, T6b): Auto-News nur aus Marktdaten.
// Erwartungen stammen aus dem Auftrag (AUFTRAG.md / PLAN E018), nicht aus dem Code des Implementers.
// Der letzte Block lädt db.js im selben Prozess auf einer eigenen DB t6b-<pid>.db; schoolstreet.db
// wird nie geöffnet.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `t6b-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const newsgen = require('../newsgen');
const { createNewsGenerator, once, state, templateCounts, renderTemplates, reset } = newsgen;

const MIN = 60 * 1000;
const TICK = 1000;
const NAMEN = ['MENSA', 'HAUSA', 'EVENT', 'KLASS', 'PROJEKT', 'KIOSK', 'WERK', 'BUCH', 'MEDIA', 'SPORT'];
// Markt: 10 Aktien zu 10,-- €; `setz(id, kurs)` ändert den Kurs, `alle(f)` alle im Verhältnis.
const N = NAMEN.length;
function markt() {
  const rows = NAMEN.map((ticker, i) => ({ id: i + 1, ticker, name: `${ticker.charAt(0)}${ticker.slice(1).toLowerCase()} AG`, type: 'stock', last: 10, ref: 10, shares: 3000 }));
  return {
    rows,
    setz: (id, last) => { rows[id - 1].last = last; },
    alle: (f) => rows.forEach((r) => { r.last = 10 * f; }),
  };
}

// Deterministischer Zufall (LCG), damit Seed und Ergebnis zusammengehören.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function baue(m, cfg = {}, erfassen = true) {
  const rows = [];
  const events = [];
  const gen = createNewsGenerator({
    market: () => m.rows,
    settings: () => cfg,
    addNews: function (kind, title, body, securityId, impact) {
      assert.equal(arguments.length, 5);
      const row = { id: rows.length + 1, kind, title, body, security_id: securityId, impact };
      if (erfassen) rows.push(row);
      return row;
    },
    emit: (x) => events.push(x),
  });
  return { gen, events, rows };
}
// Takt je Sim-Sekunde wie jobs.js; `kurve(tMin)` liefert den Kurs von Aktie `id` zur Zeit.
function tick(gen, out, t, rnd) { for (const r of gen.once(t, rnd)) out.push({ ...r, sim: t }); }
function lauf(m, minuten, rnd, cfg, id, kurve) {
  const { gen, events, rows } = baue(m, cfg);
  // Erster Takt bei Ausgangskursen: Er ist der Bezug („Messbeginn“), solange die Historie < 24 Sim-h zurückreicht.
  const out = [];
  gen.once(TICK / 2, rnd); // Zeilen stehen auf ihren Ausgangskursen
  for (let t = TICK; t <= minuten * MIN; t += TICK) {
    if (kurve) m.setz(id, kurve(t / MIN));
    tick(gen, out, t, rnd);
  }
  return { out, events, rows, gen };
}

after(() => {
  const dir = path.join(__dirname, '..', 'data');
  for (const suffix of ['', '-wal', '-shm']) {
    const f = path.join(dir, DB_NAME + suffix);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('(a) 10 ruhige Sim-Minuten mit ±1 % Bewegung: 0 Auto-News, kein Event', () => {
  const m = markt();
  const { out, events } = lauf(m, 10, lcg(7), {}, 1, (t) => 10 * (1 + 0.01 * Math.sin(t)));
  for (let i = 2; i <= N; i++) m.setz(i, 10 * (1 + 0.008 * Math.cos(i)));
  assert.equal(out.length, 0);
  assert.equal(events.length, 0);
});

test('(a2) eine ruhige Stunde über 40 Seeds: keine einzige Auto-News', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const m = markt();
    m.rows.forEach((r, i) => { r.last = 10 * (1 + 0.01 * Math.sin(i + seed)); });
    assert.equal(lauf(m, 60, lcg(seed), {}, 1, (t) => 10 * (1 + 0.009 * Math.sin(t / 3))).out.length, 0, `Seed ${seed}`);
  }
});

test('(b) +12 %-Lauf: genau zwei News (5 % und 10 %), keine dritte beim Pendeln um 10 %, Wirkung 0', () => {
  const m = markt();
  // 0–1 min: 0 → 12 % (in Sprüngen, auch über mehrere Schwellen im selben Takt), 1–5 min: um 10 % pendeln.
  const { out } = lauf(m, 5, lcg(3), {}, 1, (t) => (t <= 1 ? 10 * (1 + 0.12 * Math.floor(t * 4) / 4) : 10 * (t % 0.2 < 0.1 ? 1.095 : 1.105)));
  assert.equal(out.length, 2, JSON.stringify(out.map((r) => r.title)));
  assert.ok(out.every((r) => r.kind === 'news' && r.security_id === 1 && r.impact === 0));
  assert.match(out[0].title, /^MENSA: /);
  assert.match(out[0].body, /6 %/);
  assert.match(out[1].body, /12 %/);
  assert.ok(out[1].sim > out[0].sim, 'die 10-%-Meldung kommt nach der 5-%-Meldung');
});

test('(b2) direkter Sprung auf +12 %: nur EINE Meldung (höchste Schwelle), danach Stille', () => {
  const m = markt();
  const { out } = lauf(m, 3, lcg(5), {}, 1, (t) => (t < 0.5 ? 10 : 11.2));
  assert.equal(out.length, 1);
  assert.match(out[0].body, /12 %/);
});

test('(b3) Hysterese: nach Rückfall unter die Hälfte sind die Schwellen wieder frei', () => {
  const m = markt();
  // 0-1: 0→22 %, 1-2: 22 %, 2-3: 22→6 %, 3-4: 6 %, 4-5: 6→12 %, 5-6: 12 %.
  // langsamer Lauf auf +22 %, Rückfall auf +1 % (bis Minute 12, damit der Dichte-Deckel frei ist), wieder hoch auf +12 %:
  // 5 und 10 sind wieder frei, 20 nicht.
  const kurve = (t) => t <= 1 ? 10 * (1 + 0.22 * t) : t <= 2 ? 12.2 : t <= 3 ? 12.2 - 2.1 * (t - 2) : t <= 12 ? 10.1 : 10.1 + 1.1 * (t - 12);
  const { out } = lauf(m, 13.5, lcg(11), {}, 1, kurve);
  const stufen = out.map((r) => (r.body.match(/(\d+) %/) || [])[1]);
  assert.deepEqual(stufen, ['5', '10', '20', '5', '10'], JSON.stringify(out.map((r) => [r.sim / MIN, r.title, r.body])));
  assert.ok(out[3].sim > 12 * MIN && out[4].sim > out[3].sim, JSON.stringify(out.map((r) => [r.sim / MIN, r.title])));
});

test('(b4) negative Ausreißer: −5, −10, −20 % je eine News, Text beschreibt den Fall, keine positiven Wörter', () => {
  const m = markt();
  const { out } = lauf(m, 6, lcg(13), {}, 2, (t) => 10 * (1 - 0.05 * Math.min(Math.floor(t) + 1, 4)));
  assert.equal(out.length, 3);
  for (const r of out) {
    assert.equal(r.security_id, 2);
    assert.ok(/^HAUSA: /.test(r.title), r.title);
    assert.ok(!/Plus|gestiegen|höher|rauf|gut/i.test(`${r.title} ${r.body}`), r.title);
  }
  assert.deepEqual(out.map((r) => r.impact), [0, 0, 0], 'Ausreißer-News wirken nicht auf die Bots');
});

test('(b5) Richtung getrennt: +5 % gemeldet, dann −5 % wird ebenfalls gemeldet', () => {
  const m = markt();
  const { out } = lauf(m, 4, lcg(17), {}, 3, (t) => (t < 2 ? 10.5 : 9.5));
  assert.equal(out.length, 2);
  assert.ok(/Plus|gestiegen|über dem|mehr/.test(out[0].body) && /Minus|gefallen|unter dem|weniger/.test(out[1].body), out.map((r) => r.body).join(' | '));
});

test('(c) alle Vorlagen: gefüllt, kurz, ohne Emoji und Amtston, Kürzel in jeder Firmen-Schlagzeile, Richtung eindeutig', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const POS = /Plus|legt|zieht|höher|gibt heute \d+ % her|vorn|hoch|steigen|gestiegen|empfehlen|Geheimtipp|läuft weiter|für günstig|mehr Plus|über dem|Kaum eine Aktie fällt/;
  const NEG = /Minus|gibt (heute \d+ % |stark |weiter )?nach|rutscht|tiefer|stürzt|bricht ein|fällt|fallen|gefallen|verkaufen|raten zum Verkauf|zu teuer|mehr Minus|unter dem|Kaum eine Aktie steigt/;
  const gegen = (richtung, text) => richtung === 'pos' ? NEG.test(text.replace(/Kaum eine Aktie fällt heute/g, '')) : POS.test(text.replace(/Kaum eine Aktie steigt heute/g, ''));
  const vorlagen = renderTemplates();
  assert.equal(Object.keys(vorlagen).length, 12);
  assert.ok(Object.values(templateCounts()).every((n) => n >= 4), 'je Auslöser mindestens vier Varianten');
  for (const [pool, liste] of Object.entries(vorlagen)) {
    const richtung = pool.split(':').pop(); // move:pos:5, mood:breite:pos, rumor:neg → Richtung ist das letzte Glied
    const mitAktie = pool.startsWith('move') || pool.startsWith('rumor');
    for (const v of liste) {
      const text = `${v.title} ${v.body}`;
      assert.ok(v.title.trim().length >= 8 && !v.title.endsWith('.') && v.title.length <= 60, `Schlagzeile ${v.title}`);
      assert.ok(v.body.trim().length >= 25 && v.body.length <= 170 && /[.?]$/.test(v.body), `Text ${v.body}`);
      assert.ok(!emoji.test(text), `Emoji in ${v.title}`);
      assert.ok(!/undefined|null|\[object|\{|\}|NaN/i.test(text), `Platzhalter in ${v.title}`);
      assert.ok(!/Behörde|Verordnung|Wartungsarbeiten|Handelszeiten|gemäß|zuvor/.test(text), `Amtston: ${v.title}`);
      // Keine Behauptung über Gründe.
      assert.ok(!/weil|deshalb|grund sei|aufgrund/.test(text), `Grund behauptet: ${v.body}`);
      // Nachrichten mit Prozentzahl sagen, worauf sie sich beziehen (bei Gerüchten: die halbe Stunde).
      if (pool.startsWith('rumor')) assert.ok(/halben Stunde/.test(v.body), `${v.title}: ohne Zeitangabe`);
      else if (/ %/.test(v.body)) assert.ok(/Messbeginn|24 Stunden/.test(v.body), `${v.title}: sagt nicht, worauf sich die Zahl bezieht`);
      if (mitAktie) assert.ok(v.title.includes('MENSA'), `${v.title} ohne Kürzel`);
      else assert.ok(!/Mensa/.test(text), `${v.title} nennt eine Firma`);
      // „Kaum eine Aktie fällt heute“ ist eine verneinte Gegenrichtung und darf im Plus-Text stehen.
      if (richtung === 'pos') assert.ok(POS.test(text) && !gegen('pos', text), `${pool}: Richtung unklar in ${text}`);
      if (richtung === 'neg') assert.ok(NEG.test(text) && !gegen('neg', text), `${pool}: Richtung unklar in ${text}`);
      if (pool.startsWith('rumor')) assert.ok(v.title.startsWith('Investment AG hört: ') && v.title.endsWith('?') && v.title.includes('?'), v.title);
    }
  }
  // Verschiedene Seeds → verschiedene Texte für denselben Auslöser an verschiedenen Tagen.
  const titel = new Set();
  for (let seed = 1; seed <= 12; seed++) titel.add(lauf(markt(), 1, lcg(seed * 7919), {}, 1, () => 10.5).out[0].title);
  assert.ok(titel.size >= 3, `nur ${titel.size} verschiedene Schlagzeilen`);
  // Gleicher Auslöser, gleicher Seed: identischer Text (Zufall nur für die Variante).
  const a = lauf(markt(), 1, lcg(4), {}, 1, () => 10.5).out[0];
  const b = lauf(markt(), 1, lcg(4), {}, 1, () => 10.5).out[0];
  assert.equal(`${a.title}|${a.body}`, `${b.title}|${b.body}`);
});

test('(d) Stimmung: Index +4 % → genau eine News ohne Aktie; bleibt die Lage extrem, kommt 30 Sim-Minuten lang keine zweite', () => {
  const m = markt();
  // 0–1 min auf +4 %, bis 20 min halten, 20–40 min ruhig (±0,5 %), ab 40 min wieder +4 %.
  const { out } = lauf(m, 60, lcg(19), {}, 1, (t) => {
    if (t < 20) m.alle(t < 1 ? 1 + 0.04 * t : 1.04);
    else if (t < 40) m.rows.forEach((r, i) => { r.last = 10 * (i % 2 ? 1.005 : 0.995); });
    else m.alle(1.04);
    return m.rows[0].last;
  });
  const stimmung = out.filter((r) => r.security_id === null);
  assert.equal(stimmung.length, 2, JSON.stringify(stimmung.map((r) => [r.sim / MIN, r.title])));
  assert.ok(/Plus|steigen|fällt/.test(stimmung[0].title) && / %/.test(stimmung[0].body), stimmung[0].title);
  assert.equal(stimmung[0].impact, 1);
  assert.ok(stimmung[1].sim - stimmung[0].sim >= 30 * MIN, `Abstand ${(stimmung[1].sim - stimmung[0].sim) / MIN}`);
  // Die Aktien stehen bei +4 %: keine Ausreißer-News, keine Gerüchte (4 % < 5 %).
  assert.ok(out.every((r) => r.security_id === null));
});

test('(d2) Stimmung aus Breite: Index nur +2 %, aber 9 von 10 im Plus → eine News mit „9 von 10 Aktien“; nach Beruhigung wieder frei', () => {
  const m = markt();
  const { out } = lauf(m, 70, lcg(23), {}, 1, (t) => {
    m.rows.forEach((r, i) => { r.last = 10 * (t < 30 || t >= 50 ? (i < 9 ? 1.025 : 0.98) : (i < 5 ? 1.025 : 0.98)); });
    return m.rows[0].last;
  });
  const stimmung = out.filter((r) => r.security_id === null);
  assert.equal(stimmung.length, 2, JSON.stringify(stimmung.map((r) => [r.sim / MIN, r.title])));
  assert.match(stimmung[0].body, /9 von 10 Aktien/);
  assert.ok(stimmung[1].sim >= 50 * MIN && stimmung[1].sim <= 56 * MIN, `wieder frei bei ${stimmung[1].sim / MIN}`);
});

test('(d3) keine Stimmungs-News aus einer einzelnen Aktie mit +2 %', () => {
  const m = markt();
  const { out } = lauf(m, 60, lcg(29), {}, 1, () => 10.2);
  assert.equal(out.length, 0);
});

test('(e) Gerücht: nur nach ≥ 5 % in 30 Sim-Minuten, mit Kürzel und „Investment AG hört“, Wirkung ±1', () => {
  const m = markt();
  // Aktie 4: 0–25 min still bei 10, dann in 5 min auf 10,8 (+8 %). Ein Gerücht braucht eine
  // Kursprobe von vor 30 Sim-Minuten: vor Minute 30 ist das unmöglich, danach meldet der Kurs 30 Min
  // zurück (10) gegen jetzt (10,8) eine Bewegung von 8 %.
  const { out } = lauf(m, 60, lcg(31), {}, 4, (t) => (t < 25 ? 10 : 10 + 0.8 * Math.min((t - 25) / 5, 1)));
  const g = out.filter((r) => r.kind === 'rumor');
  assert.equal(g.length, 1, JSON.stringify(out));
  assert.equal(g[0].security_id, 4);
  assert.ok(g[0].sim >= 30 * MIN, `Gerücht schon bei ${g[0].sim / MIN} min`);
  assert.equal(out.filter((r) => r.kind === 'rumor' && r.sim < 30 * MIN).length, 0);
  assert.ok(g[0].title.includes('KLASS') && g[0].title.startsWith('Investment AG hört:') && g[0].title.endsWith('?'), g[0].title);
  assert.match(g[0].body, /8 % gestiegen/);
  assert.ok(Math.abs(g[0].impact) === 1);
  // Ausreißer-News (5 %) zur selben Aktie kommt dazu.
  assert.ok(out.some((r) => r.kind === 'news' && r.security_id === 4));
});

test('(e3) Gerücht-Wirkung folgt der Bewegung und dem Text: Aufwärts-Lauf → +1, Abwärts-Lauf → −1', () => {
  for (const [hoch, f] of [[true, (t) => (t < 20 ? 10 : 10 + 0.8 * Math.min((t - 20) / 5, 1))], [false, (t) => (t < 20 ? 10 : 10 - 0.8 * Math.min((t - 20) / 5, 1))]]) {
    let gesehen = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = markt();
      const { out } = lauf(m, 60, lcg(seed * 7919), {}, 4, f);
      for (const g of out.filter((r) => r.kind === 'rumor')) {
        gesehen++;
        assert.equal(g.impact, hoch ? 1 : -1, g.title);
        assert.ok(hoch ? !/stürzt|verlassen|fällt weiter|mehr Minus|gibt .*nach|verkaufen/.test(g.title) : !/Geheimtipp|läuft weiter|viele wollen|mehr Plus/.test(g.title), g.title);
      }
    }
    assert.ok(gesehen >= 3, `zu wenige Gerüchte (${gesehen})`);
  }
});

test('(e2) Gerücht-Sperre: zwei Aktien bewegen sich, 100 Sim-Minuten mit ständigen Ausreißern → höchstens ein Gerücht je 45 Minuten, hier eins', () => {
  const m = markt();
  const { out } = lauf(m, 100, lcg(37), {}, 1, (t) => {
    m.rows.forEach((r, i) => { r.last = 10 * (1 + 0.15 * Math.sin(t / 7 + i)); });
    return m.rows[0].last;
  });
  const g = out.filter((r) => r.kind === 'rumor');
  assert.ok(g.length <= 2, `${g.length} Gerüchte`);
  for (let i = 1; i < g.length; i++) assert.ok(g[i].sim - g[i - 1].sim >= 45 * MIN);
  assert.ok(out.filter((r) => r.kind === 'news' && r.security_id !== null).length > 4, 'Ausreißer kamen vor');
});

test('(f) keine Aktie, ETFs, Kurs 0 oder NaN: kein Fehler, keine News', () => {
  assert.equal(lauf({ rows: [] }, 5, lcg(1)).out.length, 0);
  const m = markt();
  m.rows.push({ id: 11, ticker: 'SCHULETF', name: 'Schul ETF', type: 'etf', last: 15, ref: 10 });
  m.rows.push({ id: 12, ticker: 'NULLK', name: 'Nullkurs AG', type: 'stock', last: 0, ref: 10 });
  m.rows.push({ id: 13, ticker: 'KEINK', name: 'Kein Kurs AG', type: 'stock', last: NaN, ref: 10 });
  const { out } = lauf(m, 2, lcg(41), {}, 1, (t) => 10);
  assert.equal(out.length, 0);
  assert.equal(markt().rows.length, 10);
});

test('(g) frisch gelisteter Wert: erscheint mitten im Lauf mit Kurs 10, +6 % dagegen → eine News „am Messbeginn“', () => {
  const m = markt();
  const { gen, rows } = baue(m);
  const rnd = lcg(43);
  for (let t = TICK; t <= 10 * MIN; t += TICK) gen.once(t, rnd);
  assert.equal(rows.length, 0);
  m.rows.push({ id: 11, ticker: 'NEU', name: 'Neu AG', type: 'stock', last: 10, ref: 10, shares: 1000 });
  for (let t = 10 * MIN + TICK; t <= 15 * MIN; t += TICK) gen.once(t, rnd);
  assert.equal(rows.length, 0, 'am Listing-Kurs: still');
  m.rows[10].last = 10.6;
  const out = gen.once(15 * MIN + TICK, rnd);
  assert.equal(out.length, 1);
  assert.ok(out[0].title.startsWith('NEU: ') && /Messbeginn/.test(out[0].body), `${out[0].title} — ${out[0].body}`);
  assert.match(out[0].body, /6 %/);
});

test('(g2) nach 24 Sim-Stunden Historie vergleicht der Text mit „vor 24 Stunden“ (Zeitraffer-Uhr)', () => {
  const m = markt();
  const { gen, rows } = baue(m);
  const rnd = lcg(1);
  // Ein Takt je Sim-Minute: 24 Sim-Stunden still, dann +6 %.
  for (let t = TICK; t <= 24 * 60 * MIN; t += MIN) gen.once(t, rnd);
  assert.equal(rows.length, 0);
  m.setz(1, 10.6);
  gen.once(24 * 60 * MIN + MIN, rnd);
  const meldung = rows.filter((r) => r.kind === 'news');
  assert.equal(meldung.length, 1); // ein Gerücht zur selben Bewegung ist zulässig
  assert.match(meldung[0].body, /6 %/);
  assert.ok(!/Messbeginn/.test(meldung[0].body), meldung[0].body);
  assert.ok(/vor 24 Stunden/.test(meldung[0].body), meldung[0].body);
});

test('(h) Uhr: Sprung vor ohne Nachholen, Sprung zurück ohne Flut, NaN ohne Fehler', () => {
  const m = markt();
  const { gen, rows } = baue(m);
  const rnd = lcg(47);
  const meldungen = () => rows.filter((r) => r.kind === 'news');
  for (let t = TICK; t <= 30 * MIN; t += TICK) gen.once(t, rnd);
  assert.equal(rows.length, 0);
  m.setz(1, 10.6);
  gen.once(30 * MIN + TICK, rnd);
  gen.once(30 * MIN + 2 * TICK, rnd);
  // Ein Gerücht ist hier zulässig (6 % in 30 Minuten) — der Rückkopplungs-Lauf zeigt, dass es keinen Kreis gibt.
  gen.once(30 * MIN + 2 * TICK, rnd);
  assert.equal(meldungen().length, 1);
  const stich = rows.length;
  // 20 Sim-Stunden vor: nichts Neues (5 % bleibt gemeldet; der Kurs hat sich seit 30 Minuten nicht bewegt).
  assert.equal(gen.once(30 * MIN + TICK + 20 * 60 * MIN, rnd).length, 0);
  assert.equal(rows.length, stich);
  // Zurück: keine News und keine Flut; die Historie beginnt beim aktuellen Kurs neu, die Sperren aus
  // der alten Zeit gelten nicht, der Riegel (5 % war gemeldet) bleibt.
  assert.equal(gen.once(TICK, rnd).length, 0);
  assert.equal(rows.length, stich);
  assert.equal(gen.state().lastRumorAt, null, 'Sperren aus der alten Zeit gelten nicht');
  assert.deepEqual(gen.state().lastMoodAt, { pos: null, neg: null });
  gen.once(2 * TICK, rnd);
  gen.once(3 * TICK, rnd);
  // +13 % über dem neuen Bezug: nur die 10-%-Schwelle ist noch frei (5 % blieb gemeldet, 20 % nicht erreicht).
  m.setz(1, 11.98);
  assert.deepEqual(gen.once(4 * TICK, rnd).map((x) => x.trigger), ['move:pos:10']);
  assert.deepEqual(gen.once(NaN, rnd), []);
});

test('(i) trading_paused = 1 und news_interval_sec = 0: keine News; nach Weiterlauf keine Flut', () => {
  const m = markt();
  const cfg = { trading_paused: 1 };
  const { gen, rows } = baue(m, cfg);
  const rnd = lcg(53);
  for (let t = TICK; t <= 5 * MIN; t += TICK) gen.once(t, rnd);
  m.setz(1, 11.3);
  for (let t = 5 * MIN + TICK; t <= 10 * MIN; t += TICK) gen.once(t, rnd);
  assert.equal(rows.length, 0, 'Pause: still');
  cfg.trading_paused = 0;
  cfg.news_interval_sec = 0;
  gen.once(10 * MIN + TICK, rnd);
  assert.equal(rows.length, 0, 'Intervall 0: aus');
  cfg.news_interval_sec = 60;
  assert.equal(gen.once(10 * MIN + 2 * TICK, rnd).length, 1, 'beim Weiterlauf eine Meldung, keine Flut');
  assert.equal(gen.once(10 * MIN + 3 * TICK, rnd).length, 0);
});

test('(j) eigene Schwellen über news_move_steps: 7 % statt 5 % — +6 % bleibt still, +7,5 % meldet', () => {
  const still = lauf(markt(), 1, lcg(59), { news_move_steps: '7, 15' }, 1, () => 10.6);
  assert.equal(still.out.length, 0);
  const { out } = lauf(markt(), 1, lcg(59), { news_move_steps: '7, 15' }, 1, () => 10.75);
  assert.equal(out.length, 1);
  assert.match(out[0].body, /8 %/);
  assert.equal(lauf(markt(), 1, lcg(59), { news_move_steps: 'abc, -3' }, 1, () => 10.6).out.length, 1, 'ungültige Werte: Standard');
});

test('(k) Dichte-Deckel: 20 neue Aktien springen gleichzeitig → 4 Meldungen (die größten Bewegungen), je 10 Sim-Minuten nie mehr, keine nachgereicht', () => {
  const m = markt();
  m.rows.push(...Array.from({ length: 20 }, (_, i) => ({ id: 11 + i, ticker: `X${i}`, name: `X${i} AG`, type: 'stock', last: 10, ref: 10, shares: 1000 })));
  const { gen, rows } = baue(m);
  gen.once(TICK / 2, lcg(61)); // Bezug bei 10
  m.rows.slice(10).forEach((x, i) => { x.last = 10.1 + i * 0.03; }); // +10 % … +67 %
  const out = [];
  for (let t = TICK; t <= 30 * MIN; t += TICK) for (const r of gen.once(t, lcg(61))) out.push({ ...r, sim: t });
  assert.equal(out.length, 4, `${out.length} Meldungen: ${out.map((r) => r.title).join(' | ')}`);
  // Gemeldet wurden die vier größten Bewegungen; alle 20 gelten als erledigt.
  assert.deepEqual(out.map((r) => r.title.slice(0, 3)), ['X19', 'X18', 'X17', 'X16']);
  assert.equal(new Set(out.map((r) => Math.floor(r.sim / (10 * MIN)))).size, 1);
  assert.equal(rows.length, 4);
  // Nach 10 Minuten ist das Fenster frei: eine neue Bewegung wird wieder gemeldet.
  m.rows[10].last = 10.1 * 1.5;
  assert.equal(gen.once(30 * MIN + TICK, lcg(61)).length, 1);
});

test('(l) 10 000 Sim-Minuten mit Bewegung: state() wächst nicht, impact immer ganze Zahl -3…3, Gerücht nur mit Aktie', () => {
  const m = markt();
  const { gen, rows } = baue(m);
  const rnd = lcg(67);
  const keys0 = Object.keys(gen.state());
  for (let t = TICK; t <= 10000 * MIN; t += 5000) {
    m.rows.forEach((r, i) => { r.last = 10 * (1 + 0.3 * Math.sin(t / (13 * MIN) + i * 0.7)); });
    gen.once(t, rnd);
    if (t % (500 * MIN) === 0) assert.deepEqual(Object.keys(gen.state()), keys0);
  }
  assert.ok(rows.length > 100, `nur ${rows.length} News`);
  for (const r of rows) {
    assert.ok(Number.isInteger(r.impact) && r.impact >= -3 && r.impact <= 3);
    if (r.kind === 'rumor') assert.ok(r.security_id !== null && Math.abs(r.impact) === 1);
    else if (r.security_id !== null) assert.ok(Math.abs(r.impact) <= 1, `Aktien-News ${r.impact}`);
    else assert.equal(Math.abs(r.impact), 1);
    // Jede Aktien-News trägt das Kürzel.
    if (r.security_id !== null) assert.ok(r.title.includes(m.rows.find((x) => x.id === r.security_id).ticker), r.title);
  }
  assert.equal(gen.state().count, rows.length);
  assert.equal(gen.state().tracked, N);
});

test('(m) Plus, dann Crash: nach „Markt im Plus“ wird ein Absturz auf −8 % sofort gemeldet (Sperre je Richtung)', () => {
  const m = markt();
  // 0–1 min auf +5 % (Meldung „Plus“), 1–3 min halten, 3–4 min auf −8 % (Crash), dann halten.
  const { out } = lauf(m, 40, lcg(71), {}, 1, (t) => { m.alle(t < 1 ? 1 + 0.05 * t : t < 3 ? 1.05 : t < 4 ? 1.05 - 0.13 * (t - 3) : 0.92); return m.rows[0].last; });
  const s = out.filter((r) => r.security_id === null);
  console.log('(m):', out.map((r) => `${(r.sim / MIN).toFixed(1)} min ${r.trigger} (${r.impact}) ${r.title}`).join(' | '));
  assert.equal(s.length, 2, JSON.stringify(out.map((r) => [r.sim / MIN, r.title])));
  assert.equal(s[0].impact, 1);
  assert.equal(s[1].trigger, 'mood:breite:neg');
  assert.equal(s[1].impact, -1);
  assert.ok(s[1].sim < 4.5 * MIN && s[1].sim > 3 * MIN, `Crash-Meldung bei ${(s[1].sim / MIN).toFixed(1)} min`);
  // Danach bleibt der Markt bei −8 %: keine zweite Minus-Meldung (Riegel je Richtung).
  assert.equal(s.filter((r) => r.sim > 5 * MIN).length, 0);
});

test('(n) addNews wirft beim 2. von 3 Ausreißern: die dritte kommt im nächsten Takt, nichts geht verloren, keine Doppelte', () => {
  const m = markt();
  let kaputt = 2; // wirft beim 2. Schreibversuch
  const rows = [];
  const gen = createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, security_id, impact) => {
      if (--kaputt === 0) throw new TypeError('addNews: impact');
      const row = { id: rows.length + 1, kind, title, body, security_id, impact };
      rows.push(row);
      return row;
    },
    emit: () => {},
  });
  const rnd = lcg(73);
  gen.once(TICK / 2, rnd);
  for (const i of [1, 2, 3]) m.setz(i, 10.5);
  assert.throws(() => gen.once(TICK, rnd), /impact/);
  assert.equal(rows.length, 1, 'die erste Meldung steht');
  assert.deepEqual(gen.once(2 * TICK, rnd).map((r) => r.security_id), [2, 3], 'zweite und dritte im nächsten Takt');
  assert.equal(rows.length, 3);
  assert.equal(gen.once(3 * TICK, rnd).length, 0, 'nichts doppelt');
});

test('(o) Stimmung und Gerücht: Wirft addNews, bleibt die Sperre ungesetzt — die Meldung kommt im nächsten Takt', () => {
  const m = markt();
  let wirft = true;
  const rows = [];
  const gen = createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, security_id, impact) => {
      if (wirft && security_id === null) { wirft = false; throw new TypeError('addNews: impact'); }
      const row = { id: rows.length + 1, kind, title, body, security_id, impact };
      rows.push(row);
      return row;
    },
    emit: () => {},
  });
  const rnd = lcg(79);
  gen.once(TICK / 2, rnd);
  m.alle(1.05);
  assert.throws(() => gen.once(TICK, rnd), /impact/, 'Stimmung +5 % will geschrieben werden');
  assert.deepEqual(gen.state().lastMoodAt, { pos: null, neg: null });
  const out = gen.once(2 * TICK, rnd);
  assert.equal(out.filter((r) => r.security_id === null).length, 1);
  assert.equal(out.filter((r) => r.security_id === null)[0].impact, 1);
});

test('(p) news_move_steps wechselt zur Laufzeit: Riegel passt sich an, kein Fehler, +7,5 % meldet mit neuer Schwelle', () => {
  const m = markt();
  const cfg = {};
  const { gen, rows } = baue(m, cfg);
  const rnd = lcg(83);
  for (let t = TICK / 2; t <= 10 * MIN; t += TICK) gen.once(t, rnd);
  cfg.news_move_steps = '7, 15, 25, 30';
  m.setz(1, 10.75);
  assert.equal(gen.once(10 * MIN + TICK, rnd).length, 1);
  assert.equal(rows.length, 1);
});

test('Fehler im Push verbergt die geschriebene Zeile nicht; addNews-Fehler kommen durch', () => {
  const m = markt();
  const stumm = createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: (kind, title, body, security_id, impact) => ({ id: 1, kind, title, body, security_id, impact }),
    emit: () => { throw new Error('Verbindung zu'); },
  });
  const kaputt = createNewsGenerator({
    market: () => m.rows, settings: () => ({}),
    addNews: () => { throw new TypeError('addNews: impact'); },
    emit: () => {},
  });
  stumm.once(TICK / 2, lcg(71)); // Bezug bei 10
  kaputt.once(TICK / 2, lcg(71));
  const still = console.error;
  const protokoll = [];
  console.error = (x) => protokoll.push(x);
  try {
    m.setz(1, 10.5);
    assert.equal(stumm.once(TICK, lcg(71)).length, 1);
  } finally {
    console.error = still;
  }
  assert.ok(protokoll.length === 1 && protokoll[0].startsWith('[newsgen] Push fehlgeschlagen id=1'), protokoll[0]);
  assert.throws(() => kaputt.once(TICK, lcg(71)), /impact/);
});

test('(d4) echte Bindung: News landen in der Tabelle mit impact, je News genau ein news-Event; ruhiger Markt schreibt nichts', () => {
  const d = require('../db');
  const bus = require('../bus');
  const engine = require('../engine');
    const ins = d.db.prepare("INSERT INTO securities(type, ticker, name, total_shares, fair_price, created_at) VALUES('stock', ?, ?, ?, 10, ?)");
  for (const t of NAMEN) ins.run(t, `${t} AG`, 3000, Date.now());
  engine.loadEngine();
  let events = 0;
  const listener = (x) => { if (x.type === 'news') events++; };
  bus.on(listener);
  reset();
  const vor = d.db.prepare('SELECT COUNT(*) c FROM news').get().c;
  const rnd = lcg(7);
  // 2 Sim-Minuten still.
  let geschrieben = 0;
  for (let t = TICK; t <= 2 * MIN; t += TICK) geschrieben += once(t, rnd).length;
  assert.equal(geschrieben, 0);
  // Kurs von Aktie 1 (MENSA) auf +12 %: Buch-Last direkt setzen, Cache ungültig machen.
  const b = engine.books.get(1);
  b.last = 11.2; b.ver++;
  geschrieben += once(2 * MIN + TICK, rnd).length;
  geschrieben += once(2 * MIN + 2 * TICK, rnd).length;
  const zeilen = d.db.prepare('SELECT kind, title, body, security_id, impact FROM news ORDER BY id').all().slice(vor);
  assert.equal(zeilen.length, geschrieben);
  assert.equal(geschrieben, 1, JSON.stringify(zeilen));
  assert.equal(zeilen[0].security_id, 1);
  assert.ok(/^MENSA: /.test(zeilen[0].title), zeilen[0].title);
  assert.ok(zeilen[0].impact >= -3 && zeilen[0].impact <= 3 && zeilen[0].kind === 'news');
  assert.equal(events, geschrieben, 'je News genau ein Event');
  assert.equal(state().count, geschrieben);
  });

test('(r) Fast-Modus mit echter Uhr und jobs.tickNews(): nach zwei geworfenen Takten erholt sich der Tick, +12 % wird danach gemeldet', async () => {
  const d = require('../db');
  const engine = require('../engine');
  const jobs = require('../jobs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ins = d.db.prepare("INSERT INTO securities(type, ticker, name, total_shares, fair_price, created_at) VALUES('stock', ?, ?, 3000, 10000, ?)");
  for (const t of NAMEN) ins.run(`F${t}`, `${t} Fast AG`, Date.now());
  engine.loadEngine();
  const id = d.db.prepare("SELECT id FROM securities WHERE ticker = 'FMENSA'").get().id;
  const echtes = newsgen.once;
  d.setSetting('bot_fast', 1);
  d.setSetting('income_sim_scale', 1);
  reset();
  let boom = 2;
  newsgen.once = (...a) => { if (boom-- > 0) throw new Error('QA-News-Boom'); return echtes(...a); };
  // Ein Takt je echter Wanduhr-Sekunde wie der Timer in jobs.js (Fast: 100 Sim-Sekunden je Takt).
  const tick = async () => { await sleep(1000); jobs.tickNews(); };
  let sim0;
  try {
    await tick(); await tick(); await tick(); // zwei geworfene Takte, dann Erholung — bei ruhigem Markt
    assert.equal(state().count, 0);
    const b = engine.books.get(id);
    sim0 = jobs.simNow();
    b.last = Math.round(b.last * 1.12 * 1000) / 1000; b.ver++;
    for (let i = 0; i < 6; i++) await tick();
  } catch (e) {
    console.error('(r)', e.message);
    throw e;
  } finally {
    newsgen.once = echtes;
    d.setSetting('bot_fast', 0);
  }
  const zeilen = d.db.prepare("SELECT kind, title, body FROM news WHERE kind = 'news' AND security_id = ?").all(id);
  const tr = d.db.prepare("SELECT body FROM news WHERE kind IN ('news','rumor') AND security_id = ? ORDER BY id").all(id); console.log(`(r) Fast, echte Uhr: ${zeilen.length} Meldungen nach ${((jobs.simNow() - sim0) / MIN).toFixed(0)} Sim-Minuten: ${zeilen.map((z) => z.title).join(' | ')}`);
  assert.ok(zeilen.length >= 1, 'keine Meldung nach der Erholung');
  assert.ok(zeilen.every((z) => /1[0-9] %/.test(z.body)), JSON.stringify(zeilen));
});
