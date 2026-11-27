// QA-Tests für server/mmath.js (T5). Alle Fälle sind aus PLAN.md abgeleitet — V1 (Vertrag) und
// Abschnitt 7 (Prüfmatrix) — nicht aus dem Code des Implementers.
// Reine Mathematik, keine DB nötig. DB_NAME wird trotzdem gesetzt: Ein versehentlich in
// mmath.js eingebauter Verweis auf db.js kann so nie die echte Börse öffnen.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `mmath-test-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);
const SRC = path.join(__dirname, '..', 'mmath.js');

const mmath = require('../mmath');
const { MILLI, depthOf, impactLambda, maxOrderSize, applyFlow, publicPrice, band, inBand, ladder, flatQuotes } = mmath;

after(() => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
});

// Helfer nur für diese Datei: deterministischer Zufall, Raster- und Näherungsprüfung.
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const onTick = (price, tick) => Number.isInteger(price) && price % tick === 0;
const ln = Math.log;
const near = (ist, soll, tol, msg = '') => assert.ok(Math.abs(ist - soll) <= tol, `${msg} |${ist} − ${soll}| > ${tol}`);
const preise = (liste) => liste.map((e) => e.price);
const menge = (liste) => liste.reduce((a, e) => a + e.size, 0);

// Staffel nach den V3-Defaults (Spread 100 bp → 50 bp je Seite, Jitter 20 bp, mm_size 10, Stufenzuwachs 25,
// 6 Stufen, Band 15 %) bei Tick 10 Cent und λ = 0,0002.
const STD = { tick: 10, lambda: 0.0002, halfSpreadBp: 50, levels: 6, size: 10, sizeStep: 25, bandPct: 15, jitterBp: 20, sizeJitter: 0.35 };
const mitte = () => 0.5; // rnd ohne Jitter

describe('Vertrag: Exporte und Reinheit', () => {
  test('Exportliste genau wie V1, MILLI = 1000', () => {
    assert.equal(MILLI, 1000);
    const names = ['MILLI', 'depthOf', 'impactLambda', 'maxOrderSize', 'applyFlow', 'publicPrice', 'band', 'inBand', 'ladder', 'flatQuotes'];
    assert.deepEqual(Object.keys(mmath).sort(), [...names].sort());
    for (const n of names.slice(1)) assert.equal(typeof mmath[n], 'function', n);
  });

  test('Quelltext: kein Math.random, require nur mit node:-Modulen, beim Laden keine DB-Datei', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.doesNotMatch(src, /Math\s*\.\s*random/);
    const specs = [...src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const s of specs) assert.ok(s.startsWith('node:'), `require('${s}') — V1: kein DB, keine Abhängigkeiten`);
    assert.ok(!fs.existsSync(DBFILE), 'mmath.js darf beim Laden keine DB anlegen');
  });

  test('Math.random wird nie aufgerufen — Zufall kommt ausschließlich über rnd', () => {
    const orig = Math.random;
    Math.random = () => { throw new Error('Math.random aufgerufen'); };
    try {
      ladder({ fair: 2_000_000, ...STD, rnd: mulberry32(7) });
      flatQuotes({ fair: 2_000_000, tick: 10, halfSpreadBp: 50 });
      applyFlow(2_000_000, 4e-4, 3);
    } finally { Math.random = orig; }
  });

  test('Prüfmatrix MM-Anteil: Staffeln lassen fair und alle Argumente unverändert, rnd bekommt je Stufe zwei Aufrufe', () => {
    const opts = { fair: 2_000_000, ...STD }, kopie = JSON.stringify(opts);
    let aufrufe = 0;
    const l = ladder({ ...opts, rnd: () => (aufrufe++, 0.5) });
    assert.deepEqual([l.asks.length + l.bids.length, aufrufe], [12, 12]); // 6 Stufen: erst Größe, dann Abstand
    const rnd = mulberry32(7), erst = ladder({ ...opts, rnd }), weitere = ladder({ ...opts, rnd });
    assert.notDeepEqual(erst, weitere); // der Zufallszustand gehört rnd, nicht dem Modul
    assert.equal(JSON.stringify(opts), kopie);
    assert.equal(opts.fair, 2_000_000);
  });
});

describe('Ungültige Argumente und Stufenzahl (V1)', () => {
  // V1: eine nicht endliche Zahl oder tick ≤ 0 wirft in jeder Funktion RangeError mit kurzem deutschen Text —
  // kein stiller Unsinn wie NaN oder eine leere Staffel.
  const ungültig = (name, fn, worin) => {
    assert.throws(fn, (e) => e instanceof RangeError && typeof e.message === 'string' && /[a-zäöü]/i.test(e.message), `${name}: ${worin} muss RangeError mit Text werfen`);
  };
  // Je Argument eine Zeile: so wird mit x ersetzt. Nicht endliche Zahlen und tick ≤ 0 sind ungültig.
  const LEITER = ['fair', 'tick', 'lambda', 'halfSpreadBp', 'size', 'sizeStep', 'bandPct', 'jitterBp', 'sizeJitter'];
  const TABELLE = [
    ['depthOf', 'totalShares', (x) => depthOf(x, 0)], ['depthOf', 'founderHolding', (x) => depthOf(1000, x)],
    ['impactLambda', 'depth', (x) => impactLambda(x, 50)], ['impactLambda', 'impactPct', (x) => impactLambda(1000, x)],
    ['maxOrderSize', 'depth', (x) => maxOrderSize(x, 50, 15)], ['maxOrderSize', 'impactPct', (x) => maxOrderSize(2000, x, 15)],
    ['maxOrderSize', 'bandPct', (x) => maxOrderSize(2000, 50, x)],
    ['applyFlow', 'fair', (x) => applyFlow(x, 4e-4, 1)], ['applyFlow', 'lambda', (x) => applyFlow(2_000_000, x, 1)],
    ['applyFlow', 'signedQty', (x) => applyFlow(2_000_000, 4e-4, x)],
    ['publicPrice', 'fair', (x) => publicPrice(x, 10)], ['publicPrice', 'tick', (x) => publicPrice(2_000_000, x)],
    ['band', 'fair', (x) => band(x, 10, 15)], ['band', 'tick', (x) => band(2_000_000, x, 15)], ['band', 'bandPct', (x) => band(2_000_000, 10, x)],
    ...LEITER.map((k) => ['ladder', k, (x) => ladder({ fair: 2_000_000, ...STD, [k]: x, rnd: mitte })]),
    ...['fair', 'tick', 'halfSpreadBp'].map((k) => ['flatQuotes', k, (x) => flatQuotes({ fair: 2_000_000, tick: 10, halfSpreadBp: 50, [k]: x })]),
  ];
  test('NaN, ±Infinity in jedem Zahlenargument: RangeError mit Text', () => {
    for (const x of [NaN, Infinity, -Infinity]) for (const [fn, worin, aufruf] of TABELLE) ungültig(fn, () => aufruf(x), `${worin} = ${x}`);
  });
  test('tick ≤ 0: RangeError mit Text', () => {
    for (const t of [0, -10]) for (const [fn, worin, aufruf] of TABELLE.filter((z) => z[1] === 'tick')) ungültig(fn, () => aufruf(t), `tick = ${t}`);
  });
  test('rnd liefert etwas anderes als eine Zahl in [0, 1): RangeError — beim ersten wie beim zweiten Aufruf einer Stufe', () => {
    for (const wert of [NaN, Infinity, -Infinity, 1, 1.5, -0.1]) {
      ungültig('ladder', () => ladder({ fair: 2_000_000, ...STD, levels: 1, rnd: () => wert }), `rnd() = ${wert} (Größe)`);
      const skript = [0.5, wert]; // erster Aufruf (Größe) in Ordnung, zweiter (Abstand) nicht
      ungültig('ladder', () => ladder({ fair: 2_000_000, ...STD, levels: 1, rnd: () => (skript.shift() ?? 0.5) }), `rnd() = ${wert} (Abstand)`);
    }
    assert.doesNotThrow(() => ladder({ fair: 2_000_000, ...STD, rnd: () => 0 })); // genau 0 ist erlaubt
    const knapp = ladder({ fair: 2_000_000, ...STD, rnd: () => 0.9999999999999999 }); // Jitter voll nach oben: Größen × 1,35
    assert.deepEqual([knapp.asks.length, knapp.bids.length], [6, 6]);
    for (let k = 0; k < 6; k++) { // Größe 10 + 25·k, um höchstens 35 % nach oben, auf ganze Stücke gerundet
      const basis = 10 + 25 * k;
      for (const e of [knapp.asks[k], knapp.bids[k]]) assert.ok(e.size >= basis && e.size <= Math.round(basis * 1.35), `Stufe ${k}: ${e.size}`);
    }
  });
  test('negatives bandPct (über die Einstellungen möglich): Band bleibt mindestens 2 Ticks je Seite, min < max', () => {
    for (const pct of [-0.1, -1, -50, -1e6]) {
      const b = band(2_000_000, 10, pct);
      assert.deepEqual(b, { ref: 2000, min: 1980, max: 2020 }, `bandPct = ${pct}`);
      assert.ok(b.max - b.min >= 40 && b.min < b.max, `bandPct = ${pct}`);
    }
    const ohneBand = ladder({ fair: 2_000_000, ...STD, bandPct: 0, rnd: mitte }); // Band ± 2 Ticks: nur Stufe 0 passt
    assert.deepEqual([preise(ohneBand.asks), preise(ohneBand.bids)], [[2020], [1980]]);
    for (const pct of [-0.1, -1, -50, -1e6]) assert.deepEqual(ladder({ fair: 2_000_000, ...STD, bandPct: pct, rnd: mitte }), ohneBand, `bandPct = ${pct}`);
  });
  test('gültige Grenzfälle werfen nicht: kein Streubesitz, negativer Impact, Kurs 0, Band 0 %, 0 Stufen', () => {
    assert.deepEqual([depthOf(0, 0), depthOf(-7, -5), maxOrderSize(0, -5, 0), maxOrderSize(2000, 0, 15)], [1, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    assert.equal(applyFlow(0, 0, 0), 1);
    assert.deepEqual(band(0, 10, 0), { ref: 10, min: 10, max: 20 });
    assert.deepEqual(ladder({ fair: 2_000_000, ...STD, levels: 0, rnd: mitte }), { bids: [], asks: [] });
    assert.deepEqual(flatQuotes({ fair: 0, tick: 10, halfSpreadBp: 0 }), { bid: 10, ask: 20 });
  });
  test('levels wird abgerundet: 6,5 Stufen → 6 je Seite, 2,9 → 2, 0,9 → leer', () => {
    const voll = ladder({ fair: 2_000_000, ...STD, rnd: mitte });
    const halbe = ladder({ fair: 2_000_000, ...STD, levels: 6.5, rnd: mitte });
    assert.deepEqual(halbe, voll);
    let aufrufe = 0;
    const zwei = ladder({ fair: 2_000_000, ...STD, levels: 2.9, rnd: () => (aufrufe++, 0.5) });
    assert.deepEqual([zwei.asks.length, zwei.bids.length, aufrufe], [2, 2, 4]);
    assert.deepEqual(ladder({ fair: 2_000_000, ...STD, levels: 0.9, rnd: mitte }), { bids: [], asks: [] });
  });
});

describe('depthOf — Streubesitz (2.1)', () => {
  test('Normalfall: Streubesitz = totalShares − Gründerbestand', () => {
    assert.equal(depthOf(1000, 250), 750);
    assert.equal(depthOf(1000, 0), 1000);
  });
  test('Grenzfall: Aktie vollständig in Gründerhand → 1, nie 0', () => {
    assert.equal(depthOf(100, 100), 1);
    assert.equal(depthOf(1, 1), 1);
  });
  test('Fehlerfall: Gründerbestand größer als Gesamtzahl, keine Aktien, negativer Bestand', () => {
    assert.equal(depthOf(100, 150), 1);
    assert.equal(depthOf(0, 0), 1);
    assert.equal(depthOf(100, -5), 100);
  });
  test('immer ganze Zahl ≥ 1', () => {
    for (const t of [0, 1, 7, 1000, 1e6]) for (const g of [-1, 0, 1, 7, 1000, 1e6]) {
      const d = depthOf(t, g);
      assert.ok(Number.isInteger(d) && d >= 1, `depthOf(${t}, ${g}) = ${d}`);
    }
  });
});

describe('impactLambda — Kurswirkung je Stück (2.1)', () => {
  test('Normalfall: λ = ln(1 + p/100) / D', () => {
    near(impactLambda(800, 50), ln(1.5) / 800, 1e-15);
    near(impactLambda(1, 50), ln(1.5), 1e-15);
  });
  test('p = 0 → keine Kurswirkung; p = 100 → Kauf des ganzen Streubesitzes verdoppelt den Kurs', () => {
    assert.equal(impactLambda(800, 0), 0);
    near(impactLambda(800, 100), ln(2) / 800, 1e-15);
  });
  test('Grenzfall: D ≤ 0 zählt wie 1 — keine Division durch 0', () => {
    near(impactLambda(0, 50), ln(1.5), 1e-15);
    near(impactLambda(-3, 50), ln(1.5), 1e-15);
  });
  test('skalenfrei: λ · D hängt nur von p ab', () => {
    for (const p of [10, 50, 100]) {
      const ld = impactLambda(1000, p) * 1000;
      for (const k of [0.5, 2, 10]) near(impactLambda(1000 * k, p) * 1000 * k, ld, 1e-12);
    }
  });
});

describe('maxOrderSize — Ordergrößen-Grenze Q_max (2.4, V1)', () => {
  test('Normalfall: D = 2000, p = 50, B = 15 → 689 Stück; D = 400 → 137 (Zahlen aus 2.4)', () => {
    assert.equal(maxOrderSize(2000, 50, 15), 689);
    assert.equal(maxOrderSize(400, 50, 15), 137);
  });

  test('Prüfmatrix Bewegungsgrenze: mit Q_max Stücken bewegt sich F um höchstens ±15 %, mit einem Stück mehr um mehr als 15 %', () => {
    for (const D of [2000, 400]) {
      const F = 2_000_000, lam = impactLambda(D, 50), n = maxOrderSize(D, 50, 15);
      assert.ok(applyFlow(F, lam, n) <= F * 1.15 + 0.5, `D=${D}: ${applyFlow(F, lam, n)}`); // Rundung auf ganze Milli-Cent
      assert.ok(applyFlow(F, lam, -n) >= F / 1.15 - 0.5, `D=${D}: ${applyFlow(F, lam, -n)}`);
      assert.ok(applyFlow(F, lam, n + 1) > F * 1.15, `D=${D}: ${applyFlow(F, lam, n + 1)}`);
      // zwei Orders à Q_max: F = F0 · e^(2·λ·Q_max)
      assert.ok(Math.abs(applyFlow(applyFlow(F, lam, n), lam, n) - F * Math.exp(2 * lam * n)) <= 2, `D=${D}`);
    }
  });

  test('über 900 Kombinationen: Q_max ist die größte Stückzahl mit λ · Q_max ≤ ln(1 + B/100), immer ganze Zahl ≥ 1', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 900; i++) {
      const D = 1 + Math.floor(rnd() * 100_000), p = [10, 50, 100][i % 3], B = [1, 5, 15][Math.floor(i / 3) % 3];
      const n = maxOrderSize(D, p, B), ziel = ln(1 + B / 100), lam = impactLambda(D, p);
      assert.ok(Number.isInteger(n) && n >= 1, `D=${D}, p=${p}, B=${B}: ${n}`);
      assert.ok(n * lam <= ziel + 1e-12 && (n + 1) * lam > ziel, `D=${D}, p=${p}, B=${B}: ${n} bei ${ziel / lam}`);
    }
  });

  test('Grenzfall: sehr kleiner Streubesitz → 1 Stück; D ≤ 0 zählt wie 1', () => {
    for (const D of [-7, 0, 1, 5]) assert.equal(maxOrderSize(D, 50, 15), 1, `D=${D}`);
    assert.equal(maxOrderSize(6, 50, 15), 2);
  });

  test('Grenzfall B = p: der ganze Streubesitz passt in eine Order — Q_max = D, für depth 1 … 20000 ohne Float-Ausreißer', () => {
    assert.deepEqual([maxOrderSize(400, 50, 50), maxOrderSize(2000, 50, 50), maxOrderSize(2000, 100, 100)], [400, 2000, 2000]);
    let abweichungen = 0;
    for (let depth = 1; depth <= 20000; depth++) if (maxOrderSize(depth, 50, 50) !== depth) abweichungen++;
    assert.equal(abweichungen, 0);
  });

  test('Grenzfall B = 0 → 1 (kleinste mögliche Grenze)', () => {
    for (const D of [1, 400, 2000]) assert.equal(maxOrderSize(D, 50, 0), 1, `D=${D}`);
  });

  test('Fehlerfall: negatives Band bis −1 000 000 % → 1, nie NaN und nie 0 (log ist dort undefiniert)', () => {
    for (const B of [-0.1, -1, -50, -99, -100, -101, -1e6]) {
      for (const D of [1, 400, 2000]) assert.equal(maxOrderSize(D, 50, B), 1, `D=${D}, B=${B}`);
    }
  });

  test('Fehlerfall: p ≤ 0 → keine Kurswirkung → Number.MAX_SAFE_INTEGER (keine Grenze wirksam)', () => {
    for (const p of [0, -5, -50]) for (const D of [0, 1, 2000]) for (const B of [0, 1, 15, 50]) {
      assert.equal(maxOrderSize(D, p, B), Number.MAX_SAFE_INTEGER, `D=${D}, p=${p}, B=${B}`);
    }
  });
});

describe('applyFlow — Kursupdate (2.2, Garantien 1–5)', () => {
  const F0 = 2_000_000;      // 20 Credits in Milli-Cent
  const D = 1000;            // Streubesitz
  const lam = ln(1.5) / D;   // p = 50 %: kauft netto der ganze Streubesitz, steigt F um 50 %
  const dln = (a, b) => ln(b / a); // Kursbewegung in log

  test('Normalfall: +D Stück hebt F um 50 %, −D Stück senkt es auf F / 1,5', () => {
    assert.ok(Math.abs(applyFlow(F0, lam, D) - 3_000_000) <= 1, String(applyFlow(F0, lam, D)));
    assert.ok(Math.abs(applyFlow(F0, lam, -D) - F0 / 1.5) <= 1, String(applyFlow(F0, lam, -D)));
  });

  test('Garantie 4: ohne Flow bleibt F exakt — q = 0 und λ = 0', () => {
    for (const f of [1, 999, F0, 123_456_789_012]) {
      assert.equal(applyFlow(f, lam, 0), f);
      assert.equal(applyFlow(f, 0, 77), f);
    }
  });

  test('Prüfmatrix Proportionalität: 1 vs. 10 vs. 100 Stück → Δln F wie 1 : 10 : 100 (±5 %), Kauf und Verkauf', () => {
    for (const s of [1, -1]) {
      const eins = dln(F0, applyFlow(F0, lam, s));
      near(dln(F0, applyFlow(F0, lam, 10 * s)) / eins, 10, 0.5);
      near(dln(F0, applyFlow(F0, lam, 100 * s)) / eins, 100, 5);
    }
  });

  test('Prüfmatrix Pfadunabhängigkeit: 20 × 1 Stück = 1 × 20 Stück; Kauf 500 dann Verkauf 500 = Ausgangskurs', () => {
    let f = F0;
    for (let i = 0; i < 20; i++) f = applyFlow(f, lam, 1);
    assert.ok(Math.abs(f - applyFlow(F0, lam, 20)) <= 20, `${f} vs. ${applyFlow(F0, lam, 20)}`); // ± 1 Mill-Cent je Schritt
    const zurueck = applyFlow(applyFlow(F0, lam, 500), lam, -500);
    assert.ok(Math.abs(zurueck - F0) <= 2, `Rückkehr bei ${zurueck}`);
  });

  test('Garantie 2: Reihenfolge der Orders ändert F nicht — F_T = F_0 · e^(λ·Σq)', () => {
    const rnd = mulberry32(2026);
    for (let runde = 0; runde < 20; runde++) {
      const qs = Array.from({ length: 40 }, () => Math.floor(rnd() * 41) - 20); // −20 … +20 Stück
      const laufe = (liste) => liste.reduce((f, q) => applyFlow(f, lam, q), F0);
      const ideal = F0 * Math.exp(lam * qs.reduce((a, q) => a + q, 0));
      for (const pfad of [qs, [...qs].reverse(), [...qs].sort((a, b) => a - b)]) {
        assert.ok(Math.abs(laufe(pfad) - ideal) <= 40, `${pfad[0]}…: ${laufe(pfad)} vs. ${ideal}`);
      }
    }
  });

  test('Garantie 3: in log symmetrisch und monoton', () => {
    for (const q of [1, 7, 100, 500]) near(dln(F0, applyFlow(F0, lam, q)), -dln(F0, applyFlow(F0, lam, -q)), 1.2 / F0, `q=${q}`);
    let vorige = 0;
    for (const q of [-1000, -999, -500, -1, 0, 1, 500, 999, 1000]) {
      const f = applyFlow(F0, lam, q);
      assert.ok(f >= vorige, `q=${q}: ${f} < ${vorige}`);
      vorige = f;
    }
  });

  test('Garantie 5: skalenfrei — gleiche Stückzahl, gleiche prozentuale Bewegung bei doppeltem Streubesitz und Wert', () => {
    near(applyFlow(40_000_000, lam, 5) / 40_000_000, applyFlow(F0, lam, 5) / F0, 1e-6);
    near(dln(F0, applyFlow(F0, ln(1.5) / (2 * D), 20)), dln(F0, applyFlow(F0, lam, 10)), 1e-6);
  });

  test('Prüfmatrix Determinismus: 2000 Orders à ±1…10 Stück mit festem Seed — Δln F je Order = λ · q', () => {
    const rnd = mulberry32(7);
    let f = F0, summeQ = 0, summeQ2 = 0;
    const schritte = [];
    for (let i = 0; i < 2000; i++) {
      const q = (1 + Math.floor(rnd() * 10)) * (rnd() < 0.5 ? -1 : 1);
      const next = applyFlow(f, lam, q);
      // Je Order: höchstens die Rundung auf ganze Milli-Cent abweichend
      near(dln(f, next), lam * q, 0.6 / f, `Order ${i}, q=${q}`);
      schritte.push(dln(f, next));
      summeQ += q; summeQ2 += q * q;
      f = next;
    }
    // Über alle Orders: Streuung wie λ · σ_q (± 25 %), Mittel wie λ · Mittel(q)
    const n = schritte.length, mittelQ = summeQ / n;
    const sdQ = Math.sqrt(summeQ2 / n - mittelQ * mittelQ);
    const mittel = schritte.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(schritte.reduce((a, b) => a + (b - mittel) ** 2, 0) / n);
    near(mittel, lam * mittelQ, 1e-6);
    near(sd, lam * sdQ, 0.25 * lam * sdQ);
  });

  test('Ganzzahligkeit: Ergebnis ist immer ganze Milli-Cent ≥ 1', () => {
    for (const fair of [1, 999, F0, 1e9]) for (const l of [0, 1e-6, lam]) for (const q of [-1e4, -7, 0, 1, 7, 1e4]) {
      const f = applyFlow(fair, l, q);
      assert.ok(Number.isInteger(f) && f >= 1, `applyFlow(${fair}, ${l}, ${q}) = ${f}`);
    }
  });

  test('Grenzfall: noch so großer Verkauf treibt F nie auf 0 — Boden 1 Milli-Cent', () => {
    assert.equal(applyFlow(F0, lam, -1e9), 1);
    assert.equal(applyFlow(F0, 1, -1e4), 1);
    assert.equal(applyFlow(2, 1, -3), 1);
  });

  test('Fehlerfall: alter Kurs 0, gebrochen oder negativ → trotzdem ganze Milli-Cent ≥ 1', () => {
    assert.equal(applyFlow(0, lam, 0), 1);
    assert.equal(applyFlow(-5, lam, 0), 1);
    assert.ok(Number.isInteger(applyFlow(0.4, lam, 0)) && applyFlow(0.4, lam, 0) >= 1);
  });
});

describe('publicPrice — öffentlicher Kurs K (2.3)', () => {
  test('Normalfall: F auf Tick gerundet', () => {
    assert.equal(publicPrice(2_000_000, 10), 2000);
    assert.equal(publicPrice(20_000_000, 10), 20_000);
    assert.equal(publicPrice(2_043_210, 10), 2040);
    assert.equal(publicPrice(2_046_210, 10), 2050);
  });
  test('Grenzfall: genau halber Tick rundet auf', () => {
    assert.equal(publicPrice(2_004_999, 10), 2000);
    assert.equal(publicPrice(2_005_000, 10), 2010);
  });
  test('Fehlerfall: Kurs nie unter einem Tick', () => {
    for (const fair of [0, 1, 3000, 4999]) assert.equal(publicPrice(fair, 10), 10, String(fair));
    assert.equal(publicPrice(0, 1), 1);
  });
  test('immer Vielfach des Ticks, monoton, höchstens halber Tick von F entfernt (Prüfmatrix ETF-Kurs: ≤ 1 Tick)', () => {
    for (const tick of [1, 5, 10, 100]) {
      let vorige = 0;
      for (let i = 0; i < 2000; i++) {
        const fair = Math.floor(i * 250_000.37), k = publicPrice(fair, tick);
        assert.ok(onTick(k, tick) && k >= tick && k >= vorige, `fair=${fair}, tick=${tick}: ${k}`);
        assert.ok(k === tick || Math.abs(k - fair / 1000) <= tick / 2 + 1e-9, `fair=${fair}, tick=${tick}: ${k}`);
        vorige = k;
      }
    }
  });
});

describe('band / inBand — Preisband (2.4)', () => {
  test('Normalfall: 20-Cr-Aktie, 15 % → 17,00 bis 23,00 Credits, Kurs in der Mitte', () => {
    assert.deepEqual(band(2_000_000, 10, 15), { ref: 2000, min: 1700, max: 2300 });
    assert.deepEqual(band(20_000_000, 10, 15), { ref: 20_000, min: 17_000, max: 23_000 });
  });
  test('Prüfmatrix „Absurdes Limit": 10 000 Cr bei Kurs 20 außerhalb; +14,9 % und die Bandkanten innerhalb', () => {
    const b = band(2_000_000, 10, 15);
    assert.equal(inBand(b, 1_000_000), false);
    assert.equal(inBand(b, 2290), true); // 14,9 % über Kurs = 22,98 Cr, auf den Tick: 22,90
    assert.equal(inBand(b, 2310), false);
    for (const kante of [1700, 2300]) assert.equal(inBand(b, kante), true);
    assert.equal(inBand(b, 1690), false);
  });
  test('Grenzfall Mindestbreite: mindestens 2 Ticks je Seite, auch wenn der Prozentsatz weniger ergibt', () => {
    assert.deepEqual(band(50_000, 10, 15), { ref: 50, min: 30, max: 70 }); // 0,50 Cr: 15 % = 0,075 Cr < 2 Ticks
    assert.deepEqual(band(50_000, 10, 0), { ref: 50, min: 30, max: 70 });
    assert.deepEqual(band(50_000, 1, 0), { ref: 50, min: 48, max: 52 });
  });
  test('Fehlerfall: Band nie unter einem Tick', () => {
    assert.deepEqual(band(5_000, 10, 15), { ref: 10, min: 10, max: 30 });
    assert.deepEqual(band(0, 10, 15), { ref: 10, min: 10, max: 20 });
  });
  test('Prüfmatrix Bewegungsgrenze: Band enthält F ± 15 % und reicht höchstens einen Tick weiter', () => {
    for (const fc of [100, 333, 2000, 2000.5, 17_777, 123_456]) {
      const b = band(Math.round(fc * 1000), 10, 15);
      assert.ok(b.min <= fc * 0.85 + 0.5 && b.max >= fc * 1.15 - 0.5, `fc=${fc}: ${b.min}–${b.max}`);
      assert.ok(b.min > fc * 0.85 - 10.5 && b.max < fc * 1.15 + 10.5, `fc=${fc}: ${b.min}–${b.max}`);
    }
  });
  test('über 2400 Kombinationen: stimmt mit der Formel aus V1 überein, alle Werte am Raster, ref = publicPrice', () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 2400; i++) {
      const tick = [1, 5, 10, 100][i % 4], bandPct = [0, 0.5, 1, 5, 15, 50][i % 6];
      const fair = Math.floor(rnd() * 500_000_000), fc = fair / 1000;
      const span = Math.max(Math.round(fc * bandPct / 100), 2 * tick);
      const b = band(fair, tick, bandPct);
      assert.deepEqual(b, {
        ref: Math.max(tick, Math.round(fc / tick) * tick),
        min: Math.max(tick, Math.floor((fc - span) / tick) * tick),
        max: Math.ceil((fc + span) / tick) * tick,
      }, `fair=${fair}, tick=${tick}, bandPct=${bandPct}`);
      for (const v of Object.values(b)) assert.ok(onTick(v, tick) && v >= tick);
      assert.equal(b.ref, publicPrice(fair, tick));
      assert.ok(b.min <= b.ref && b.ref <= b.max);
      if (fc >= 3 * tick) assert.ok(b.max - b.min >= 4 * tick, `fair=${fair}: Breite ${b.max - b.min}`);
    }
  });
  test('Fehlerfall inBand: kein Zahlwert gilt nie als im Band', () => {
    const b = band(2_000_000, 10, 15);
    for (const p of [NaN, undefined, Infinity, -Infinity]) assert.equal(inBand(b, p), false, String(p));
    assert.equal(inBand({}, 2000), false);
  });
});

describe('ladder — Staffel (Abschnitt 2, V1)', () => {
  // V1 in Ganzzahl-Arithmetik nachgebildet — nur für den Rundungstest. h = 1/200, λ = L/1 000 000, kein Jitter,
  // ganze Größen, m2 = 2 · Mitte: dist = (10 000 + L·m2) / 2 000 000, also 1 + dist = (2 010 000 + L·m2) / 2 000 000.
  function staffelExakt(f, tick, size, step, levels, bandPct, L) {
    const span = Math.max(Math.round((f * bandPct) / 100), 2 * tick);
    const min = Math.max(tick, Math.floor((f - span) / tick) * tick), max = Math.ceil((f + span) / tick) * tick;
    const asks = [], bids = [];
    let X = 0;
    for (let i = 0; i < levels; i++) {
      const s = size + i * step, m2 = 2 * X + s;
      let ask = Math.ceil((f * (2_010_000 + L * m2)) / (2e6 * tick)) * tick;
      let gebot = Math.floor((f * (1_990_000 - L * m2)) / (2e6 * tick)) * tick;
      if (asks.length) ask = Math.max(ask, asks[asks.length - 1] + tick);
      if (bids.length) gebot = Math.min(gebot, bids[bids.length - 1] - tick);
      if (ask <= max && ask >= min) asks.push(ask);
      if (gebot >= Math.max(tick, min) && gebot <= max) bids.push(gebot);
      X += s;
    }
    if (asks.length && bids.length && asks[0] <= bids[0]) {
      const delta = bids[0] + tick - asks[0];
      for (let k = 0; k < asks.length; k++) asks[k] += delta;
      while (asks.length && asks[asks.length - 1] > max) asks.pop();
    }
    return { asks, bids };
  }

  test('Normalfall (V3-Defaults, Kurs 20 Cr, rnd = 0,5): jede Stufe preist die Mitte ihrer eigenen Menge', () => {
    const l = ladder({ fair: 2_000_000, ...STD, rnd: mitte });
    assert.deepEqual(Object.keys(l).sort(), ['asks', 'bids']);
    // vor der Tick-Rundung: 2012 / 2021 / 2040 / 2069 / 2108 / 2157 und 1988 / 1979 / 1960 / 1931 / 1892 / 1843
    assert.deepEqual(preise(l.asks), [2020, 2030, 2040, 2070, 2110, 2160]);
    assert.deepEqual(preise(l.bids), [1980, 1970, 1960, 1930, 1890, 1840]);
    assert.deepEqual(l.asks.map((e) => e.size), [10, 35, 60, 85, 110, 135]);
    assert.deepEqual(l.bids.map((e) => e.size), [10, 35, 60, 85, 110, 135]);
    assert.deepEqual(l.asks[0], { price: 2020, size: 10 });
    assert.deepEqual(l.bids[0], { price: 1980, size: 10 });
  });

  test('Float-sichere Tick-Rundung: 20 × 0,98 = 19,60 bleibt 19,60; alle 12 Preise des T1-Beispiels (200 Cr) liegen exakt auf dem Tick', () => {
    assert.equal(ladder({ fair: 2_000_000, ...STD, rnd: mitte }).bids[2].price, 1960); // drittes Gebot, nicht 19,50
    const l = ladder({ fair: 20_000_000, ...STD, size: 40, rnd: mitte }); // Größen 40 / 65 / 90 / 115 / 140 / 165
    assert.deepEqual(preise(l.asks), [20_180, 20_390, 20_700, 21_110, 21_620, 22_230]);
    assert.deepEqual(preise(l.bids), [19_820, 19_610, 19_300, 18_890, 18_380, 17_770]);
  });

  test('Float-sichere Tick-Rundung: drei weitere Staffeln, deren Rohpreise sämtlich exakt auf dem Tick liegen', () => {
    const keinJitter = { ...STD, jitterBp: 0, sizeJitter: 0, rnd: mitte };
    // 20 Cr, λ = 0,0004, Größen 40 / 65 / 90 / 115: Gebot der dritten Stufe = 2000 · (1 − 0,005 − 0,0004 · 150) = 1870
    const r1 = ladder({ ...keinJitter, fair: 2_000_000, size: 40, lambda: 4e-4 });
    assert.deepEqual(preise(r1.asks), [2030, 2070, 2130, 2220]);
    assert.deepEqual(preise(r1.bids), [1970, 1930, 1870, 1780]);
    // 20 Cr, λ = 0,0005, Band 50 %: fünftes Gebot = 2000 · (1 − 0,195) = 1610
    const r2 = ladder({ ...keinJitter, fair: 2_000_000, size: 40, lambda: 5e-4, bandPct: 50 });
    assert.deepEqual(preise(r2.asks), [2030, 2090, 2160, 2270, 2390, 2550]);
    assert.deepEqual(preise(r2.bids), [1970, 1910, 1840, 1730, 1610, 1450]);
    // 100 Cr, λ = 0,0016, Band 60 %: sechstes Gebot = 10 000 · (1 − 0,593) = 4070
    const r3 = ladder({ ...keinJitter, fair: 10_000_000, lambda: 1.6e-3, bandPct: 60 });
    assert.deepEqual(preise(r3.asks), [10_130, 10_490, 11_250, 12_410, 13_970, 15_930]);
    assert.deepEqual(preise(r3.bids), [9870, 9510, 8750, 7590, 6030, 4070]);
  });

  test('Float-sichere Tick-Rundung über 36 000 Staffeln: identisch mit der Ganzzahl-Nachbildung von V1', () => {
    for (const [L, bandPct] of [[200, 15], [500, 50], [1600, 60]]) for (const tick of [1, 10]) for (const [size, sizeStep] of [[10, 25], [40, 25]]) {
      for (let f = 1; f <= 3000; f++) { // f in Cent: 0,01 bis 30,00 Cr
        const l = ladder({ fair: f * 1000, tick, lambda: L / 1e6, halfSpreadBp: 50, levels: 6, size, sizeStep, bandPct, jitterBp: 0, sizeJitter: 0, rnd: mitte });
        const soll = staffelExakt(f, tick, size, sizeStep, 6, bandPct, L);
        assert.deepEqual(preise(l.asks), soll.asks, `λ=${L / 1e6}, tick=${tick}, size=${size}, f=${f}`);
        assert.deepEqual(preise(l.bids), soll.bids, `λ=${L / 1e6}, tick=${tick}, size=${size}, f=${f}`);
      }
    }
  });

  test('rnd: je Stufe erst Größe, dann Abstand — genau zwei Aufrufe je Stufe', () => {
    const skript = [0, 0.9];
    let aufrufe = 0;
    const rnd = () => (aufrufe++, skript.shift() ?? 0.5);
    // Größe 40 · (1 − 0,35) = 26, Mitte 13; Abstand 0,5 % + 0,26 % + 0,8 · 0,2 % = 0,92 % → 201,84 / 198,16
    const l = ladder({ fair: 20_000_000, ...STD, size: 40, levels: 1, rnd });
    assert.equal(aufrufe, 2);
    assert.deepEqual(l.asks, [{ price: 20_190, size: 26 }]);
    assert.deepEqual(l.bids, [{ price: 19_810, size: 26 }]);
    aufrufe = 0;
    ladder({ fair: 20_000_000, ...STD, rnd: () => (aufrufe++, 0.5) });
    assert.equal(aufrufe, 12);
  });

  test('rnd-Extrema: Jitter nach unten und nach oben wird tatsächlich angewendet', () => {
    const unten = ladder({ fair: 20_030_000, ...STD, size: 40, rnd: () => 0 });
    assert.deepEqual(unten.asks[0], { price: 20_150, size: 26 }); // Größe 40 · 0,65 = 26, Mitte 13: Abstand 0,5 % + 0,26 % − 0,2 % = 0,56 %
    const oben = ladder({ fair: 20_030_000, ...STD, size: 40, rnd: () => 0.999999 });
    assert.deepEqual(oben.asks[0], { price: 20_280, size: 54 }); // Größe 40 · 1,35 = 54, Mitte 27: Abstand 0,5 % + 0,54 % + 0,2 % = 1,24 %
  });

  test('Grenzfall: das Band schneidet die Staffel ab — was nicht hineinpasst, wird nicht quotiert', () => {
    const l = ladder({ fair: 2_003_000, ...STD, lambda: 0, bandPct: 0, rnd: mitte }); // Band ± 2 Ticks: 19,80 – 20,30
    assert.deepEqual(preise(l.asks), [2020, 2030]);
    assert.deepEqual(preise(l.bids), [1990, 1980]);
  });

  test('Grenzfall: Aktie unter einem Tick — Gebote enden am Tick, Angebotsseite läuft weiter', () => {
    const l = ladder({ fair: 15_000, ...STD, levels: 3, sizeJitter: 0, jitterBp: 0, rnd: mitte }); // 0,15 Cr
    assert.deepEqual(preise(l.asks), [20, 30, 40]);
    assert.deepEqual(preise(l.bids), [10]);
  });

  test('Fehlerfall: Größe nie 0, selbst mit Size-Jitter 90 % nach unten', () => {
    const l = ladder({ fair: 2_000_000, ...STD, size: 1, sizeStep: 0, sizeJitter: 0.9, jitterBp: 0, rnd: () => 0 });
    assert.ok(l.asks.length > 0 && l.bids.length > 0);
    for (const e of [...l.asks, ...l.bids]) assert.equal(e.size, 1);
  });

  test('Fehlerfall Kreuzungsschutz: ohne Spread auf dem Rasterkurs liegt jede Ask über jedem Bid, die Ordnung bleibt', () => {
    const nur = { ...STD, halfSpreadBp: 0, jitterBp: 0, lambda: 0, rnd: mitte };
    assert.deepEqual(ladder({ ...nur, fair: 2_000_000, levels: 1 }), { bids: [{ price: 2000, size: 10 }], asks: [{ price: 2010, size: 10 }] });
    // drei Stufen: Roh-Asks 2000 / 2010 / 2020 → alle um einen Tick verschoben
    assert.deepEqual(preise(ladder({ ...nur, fair: 2_000_000, levels: 3 }).asks), [2010, 2020, 2030]);
    assert.deepEqual(preise(ladder({ ...nur, fair: 2_000_000, levels: 3 }).bids), [2000, 1990, 1980]);
    // vierte Stufe (20,40) fällt nach der Verschiebung aus dem Band ± 30 Cent und wird von oben entfernt
    const eng = ladder({ ...nur, fair: 2_000_000, levels: 4, bandPct: 1.5 });
    assert.deepEqual(preise(eng.asks), [2010, 2020, 2030]);
    assert.deepEqual(preise(eng.bids), [2000, 1990, 1980, 1970]);
  });

  test('Red-Team: ladder endet, sobald keine Seite mehr eine Stufe im Band bekommt — unabhängig von levels', () => {
    const eng = { fair: 2_000_000, ...STD, bandPct: 1, rnd: mitte }; // Band 19,80 – 20,20: nur Stufe 0 passt
    const sechs = ladder({ ...eng, levels: 6 });
    assert.deepEqual([preise(sechs.asks), preise(sechs.bids)], [[2020], [1980]]);
    for (const levels of [1e6, 1e8]) {
      let aufrufe = 0;
      const t0 = performance.now();
      const l = ladder({ ...eng, levels, rnd: () => (aufrufe++, 0.5) });
      const dauer = performance.now() - t0;
      assert.deepEqual(l, sechs, `levels = ${levels}`);
      assert.equal(aufrufe, 4, `levels = ${levels}: rnd-Aufrufe`); // Stufe 0 und der erste Versuch darüber, je zwei Ziehungen
      assert.ok(dauer < 50, `levels = ${levels}: ${dauer.toFixed(1)} ms`);
    }
    // eine Seite im Band (Asks bis 0,40), die andere am Tick-Boden: endet nach drei Stufen, auch mit riesigem levels
    const boden = { fair: 15_000, ...STD, levels: 4, sizeJitter: 0, jitterBp: 0, rnd: mitte };
    const vier = ladder(boden);
    assert.deepEqual([preise(vier.asks), preise(vier.bids)], [[20, 30, 40], [10]]);
    let aufrufe = 0;
    const t0 = performance.now();
    assert.deepEqual(ladder({ ...boden, levels: 1e6, rnd: () => (aufrufe++, 0.5) }), vier);
    assert.ok(performance.now() - t0 < 50);
    assert.equal(aufrufe, 8); // drei Stufen und der vierte Versuch
  });

  test('Grenzfall: 0 Stufen → leere Staffel, kein Fehler', () => {
    assert.deepEqual(ladder({ fair: 2_000_000, ...STD, levels: 0, rnd: mitte }), { bids: [], asks: [] });
  });

  test('deterministisch mit festem rnd: gleicher Seed → identische Staffel', () => {
    const lauf = (seed) => ladder({ fair: 2_000_000, ...STD, rnd: mulberry32(seed) });
    assert.deepEqual(lauf(7), lauf(7));
  });

  test('Stufe nie innerhalb des halben Spreads: ask ≥ ceilTick(F · (1 + h)), bid ≤ floorTick(F · (1 − h))', () => {
    // Jitter voll nach unten (−200 bp) bei λ = 0: ohne max(h, …) läge der Abstand bei −1,5 %
    const l = ladder({ fair: 200_000_000, ...STD, lambda: 0, levels: 3, sizeJitter: 0, jitterBp: 200, rnd: () => 0 });
    assert.deepEqual(preise(l.asks), [201_000, 201_010, 201_020]);
    assert.deepEqual(preise(l.bids), [199_000, 198_990, 198_980]);
  });

  test('Prüfmatrix: mengengewichteter Mittelpreis einer vollen Staffel ohne Jitter je Stück = F · (1 ± (h + λ·Q/2)) ± 1 Tick', () => {
    const mittel = (liste) => liste.reduce((a, e) => a + e.price * e.size, 0) / menge(liste);
    const l = ladder({ fair: 2_000_000, ...STD, rnd: mitte }); // Q = 435 → exakt 2097,00 bzw. 1903,00
    near(mittel(l.asks), 2000 * (1 + 0.005 + 0.0002 * 435 / 2), 10, 'Asks');
    near(mittel(l.bids), 2000 * (1 - 0.005 - 0.0002 * 435 / 2), 10, 'Bids');
    for (const lam of [5e-4, 1e-3, 2e-3]) for (const [size, sizeStep] of [[10, 25], [20, 10], [40, 25]]) {
      const s = ladder({ fair: 2_000_000, ...STD, lambda: lam, size, sizeStep, rnd: mitte });
      for (const seite of [s.asks, s.bids]) {
        const vorzeichen = seite === s.asks ? 1 : -1;
        near(mittel(seite), 2000 * (1 + vorzeichen * (0.005 + lam * menge(seite) / 2)), 10, `λ=${lam}, size=${size}`);
      }
    }
  });

  test('Prüfmatrix „Kein risikofreier Round-Trip": volle Ask-Staffel kaufen, dieselbe Menge in die neue Bid-Staffel zurück', (t) => {
    const F = 2_000_000, gebuehr = 2 * 2000; // fee_cent 2000 = 20 Cr je Order, zwei Orders
    for (const D of [200, 400, 1000, 2000]) {
      const lam = impactLambda(D, 50), rnd = mulberry32(9000 + D);
      let laeufe = 0, uebersprungen = 0, summe = 0, bester = -Infinity;
      for (let n = 0; n < 4000; n++) {
        const opts = { tick: 10, lambda: lam, halfSpreadBp: 50, levels: 6, size: 10, sizeStep: 25, bandPct: 15, jitterBp: 20, sizeJitter: 0.35 };
        const kauf = ladder({ ...opts, fair: F, rnd }); // erste Ziehung: Größen 10/35/60/85/110/135 ± 35 %
        if (!kauf.asks.length) { uebersprungen++; continue; }
        const Q = menge(kauf.asks), kosten = kauf.asks.reduce((a, e) => a + e.price * e.size, 0);
        const neu = ladder({ ...opts, fair: applyFlow(F, lam, Q), rnd }); // F' = F · e^(λ·Q), zweite unabhängige Ziehung
        let rest = Q, erloes = 0;
        for (const b of neu.bids) { const stueck = Math.min(rest, b.size); erloes += stueck * b.price; rest -= stueck; }
        if (rest > 0) { uebersprungen++; continue; } // nimmt die neue Staffel Q nicht in einer Order auf: nicht ausführbar
        const delta = (erloes - kosten) / kosten;
        assert.ok(delta < 0, `D=${D}, Lauf ${n}: ${(100 * delta).toFixed(2)} % vor Gebühren`);
        assert.ok(erloes - kosten - gebuehr < 0, `D=${D}, Lauf ${n}: nach zwei Gebühren positiv`);
        summe += delta; laeufe++; bester = Math.max(bester, delta);
      }
      assert.ok(laeufe >= 1500, `D=${D}: nur ${laeufe} gewertete Läufe`);
      assert.ok(summe / laeufe < 0, `D=${D}: im Mittel positiv vor Gebühren`);
      t.diagnostic(`Round-Trip D=${D}: ${laeufe} Läufe gewertet, ${uebersprungen} übersprungen (${(100 * uebersprungen / 4000).toFixed(1)} %), `
        + `im Mittel ${(100 * summe / laeufe).toFixed(2)} % vor Gebühren, bester Lauf ${(100 * bester).toFixed(2)} %`);
    }
  });

  test('Invarianten über 10 000 Ziehungen: je Seite streng monoton im Tick-Abstand, am Raster, im Band, bid < ask, Größe ≥ 1', () => {
    const rnd = mulberry32(2026);
    let beidseitig = 0, stufen = 0, tief = 0, ohneSpread = 0, geschuetzt = 0;
    for (let i = 0; i < 10000; i++) {
      const tick = [1, 10, 100][i % 3], jitterBp = [0, 20, 200][i % 3];
      const halfSpreadBp = [0, 25, 50, 100][Math.floor(rnd() * 4)];
      const o = {
        fair: 500_000 + Math.floor(rnd() * 499_500_000), tick, halfSpreadBp, jitterBp, // 0,50 bis 500,00 Cr
        lambda: rnd() * 0.001, levels: 1 + Math.floor(rnd() * 10), size: 1 + Math.floor(rnd() * 200),
        sizeStep: Math.floor(rnd() * 50), bandPct: [0, 1, 5, 15][i % 4], sizeJitter: rnd() * 0.9, rnd: mulberry32(100_000 + i),
      };
      const zwang = i % 10 === 0; // Rasterkurs, kein Spread, λ = 0: läuft zwingend durch den Kreuzungsschutz
      if (zwang) { o.fair = Math.round(o.fair / (tick * 1000)) * tick * 1000; o.halfSpreadBp = 0; o.lambda = 0; }
      const werte = JSON.stringify({ ...o, rnd: undefined });
      const l = ladder(o), b = band(o.fair, tick, o.bandPct), f = o.fair / MILLI;
      stufen += l.asks.length + l.bids.length;
      if (o.halfSpreadBp === 0) ohneSpread++;
      for (const seite of [l.asks, l.bids]) {
        assert.ok(seite.length <= o.levels, werte);
        for (const e of seite) {
          assert.ok(onTick(e.price, tick) && e.price >= tick && e.price >= b.min && e.price <= b.max, werte);
          assert.ok(Number.isInteger(e.size) && e.size >= 1, werte);
        }
      }
      for (let k = 1; k < l.asks.length; k++) assert.ok(l.asks[k].price - l.asks[k - 1].price >= tick, werte);
      for (let k = 1; k < l.bids.length; k++) assert.ok(l.bids[k - 1].price - l.bids[k].price >= tick, werte);
      const spread = o.halfSpreadBp / 1e4; // nie innerhalb des halben Spreads
      for (const a of l.asks) assert.ok(a.price >= Math.ceil((f * (1 + spread)) / tick - 1e-9) * tick, werte);
      for (const gebot of l.bids) assert.ok(gebot.price <= Math.floor((f * (1 - spread)) / tick + 1e-9) * tick, werte);
      if (!l.asks.length || !l.bids.length) continue;
      beidseitig++;
      if (o.halfSpreadBp === 0 && zwang && jitterBp === 0) { geschuetzt++; assert.equal(l.asks[0].price, l.bids[0].price + tick, werte); }
      if (l.asks.length >= 3 && l.bids.length >= 3) tief++;
      assert.ok(l.bids[0].price < l.asks[0].price, werte);
      // Abstand folgt dem Flow: Stufe k liegt mindestens bei h + λ · mitte_k − j (mitte_k = X_k + s_k/2)
      const j = jitterBp / 1e4;
      let X = 0;
      for (let k = 0; k < l.asks.length && k < l.bids.length; k++) {
        const mitte_k = X + l.asks[k].size / 2;
        assert.ok(l.asks[k].price >= f * (1 + spread + o.lambda * mitte_k - j) - 1e-6, werte);
        assert.ok(l.bids[k].price <= f * (1 - spread - o.lambda * mitte_k + j) + 1e-6, werte);
        X += l.asks[k].size;
      }
    }
    // Referenzlauf eines vertragstreuen Moduls: 5805 beidseitig, 30937 Stufen, 2022 mit ≥ 3 Stufen je Seite,
    // 334 erzwungene Kreuzungen, 3200 Fälle ohne Spread
    assert.ok(beidseitig >= 4000 && stufen >= 20000 && tief >= 1200 && geschuetzt >= 300 && ohneSpread >= 3000,
      `nur ${beidseitig} beidseitig, ${stufen} Stufen, ${tief} tief, ${geschuetzt} Kreuzungen, ${ohneSpread} ohne Spread`);
  });
});

describe('flatQuotes — ETF-Quotes (2.5)', () => {
  test('Normalfall: 20 Cr, halber Spread 50 bp → Gebot 19,90, Angebot 20,10', () => {
    assert.deepEqual(flatQuotes({ fair: 2_000_000, tick: 10, halfSpreadBp: 50 }), { bid: 1990, ask: 2010 });
  });
  test('Grenzfall ohne Spread: Angebot liegt trotzdem einen Tick über dem Gebot', () => {
    assert.deepEqual(flatQuotes({ fair: 2_000_000, tick: 10, halfSpreadBp: 0 }), { bid: 2000, ask: 2010 });
    assert.deepEqual(flatQuotes({ fair: 2_000_500, tick: 10, halfSpreadBp: 0 }), { bid: 2000, ask: 2010 });
  });
  test('Fehlerfall: Kurs unter einem Tick → Gebot = Tick, Angebot = Tick + 1', () => {
    assert.deepEqual(flatQuotes({ fair: 5_000, tick: 10, halfSpreadBp: 50 }), { bid: 10, ask: 20 }); // 0,05 Cr
  });
  test('Float-sichere Tick-Rundung: exakt auf dem Tick liegende Preise bleiben dort', () => {
    for (const [fair, halfSpreadBp, soll] of [
      [20_000_000, 50, { bid: 19_900, ask: 20_100 }], // 200 Cr ± 0,5 % = 199,00 / 201,00
      [4_000_000, 250, { bid: 3900, ask: 4100 }],     // 40 Cr ± 2,5 % = 39,00 / 41,00
      [4_000_000, 75, { bid: 3970, ask: 4030 }],      // 40 Cr ± 0,75 % = 39,70 / 40,30
      [8_000_000, 125, { bid: 7900, ask: 8100 }],     // 80 Cr ± 1,25 % = 79,00 / 81,00
      [2_000_000, 200, { bid: 1960, ask: 2040 }],     // 20 Cr ± 2 % = 19,60 / 20,40
    ]) assert.deepEqual(flatQuotes({ fair, tick: 10, halfSpreadBp }), soll, `fair=${fair}, h=${halfSpreadBp}`);
  });
  test('über 4951 Kurse: Gebot abgerundet, Angebot aufgerundet (exakt), ask > bid, beide am Raster', () => {
    for (let f = 50; f <= 5000; f++) { // f in Cent; ± 50 bp = × 199/200 bzw. × 201/200, ganzrationell geprüft
      const { bid, ask } = flatQuotes({ fair: f * 1000, tick: 10, halfSpreadBp: 50 });
      const sollBid = Math.max(10, Math.floor((f * 199) / 2000) * 10);
      let sollAsk = Math.ceil((f * 201) / 2000) * 10;
      if (sollAsk <= sollBid) sollAsk = sollBid + 10; // Kreuzungsschutz aus V1
      assert.deepEqual({ bid, ask }, { bid: sollBid, ask: sollAsk }, `f=${f}`);
      assert.ok(bid >= 10 && ask > bid, `f=${f}: ${bid}/${ask}`);
    }
  });
});

// ---------------------------------------------------------------------------
// V4 (T5): minTotal — Anschluss-Stufen, bis die Angebotsseite minTotal Stück hält oder das Band endet
// ---------------------------------------------------------------------------
describe('ladder mit minTotal (V4, Streubesitz)', () => {
  const LEITER_435 = { // feste Leiste ohne minTotal und ohne Jitter: Vergleichswert aus 10/35/60/85/110/135
    bids: [{ price: 1980, size: 10 }, { price: 1970, size: 35 }, { price: 1960, size: 60 }, { price: 1930, size: 85 }, { price: 1890, size: 110 }, { price: 1840, size: 135 }],
    asks: [{ price: 2020, size: 10 }, { price: 2030, size: 35 }, { price: 2040, size: 60 }, { price: 2070, size: 85 }, { price: 2110, size: 110 }, { price: 2160, size: 135 }]
  };
  const mitte = () => 0.5;
  const summe = (liste) => liste.reduce((a, e) => a + e.size, 0);
  const bandVon = (l, fair, bandPct) => {
    const b = band(fair, 10, bandPct);
    for (const e of [...l.bids, ...l.asks]) assert.ok(e.price >= b.min && e.price <= b.max, `Stufe ${e.price} außerhalb ${b.min}–${b.max}`);
    for (const seite of [l.asks, l.bids]) for (let i = 1; i < seite.length; i++) assert.notEqual(seite[i].price, seite[i - 1].price, 'Stufen müssen verschiedene Preise haben');
    if (l.asks.length && l.bids.length) assert.ok(l.asks[0].price > l.bids[0].price, 'Buch kreuzt');
  };

  test('ohne minTotal (0 oder weggelassen) identisch zur alten Leiste: gleiche Stufen, gleiche Zahl an rnd-Aufrufen', () => {
    for (const extra of [{}, { minTotal: 0 }]) {
      let aufrufe = 0;
      const l = ladder({ fair: 2_000_000, ...STD, ...extra, rnd: () => (aufrufe++, 0.5) });
      assert.deepEqual([l, aufrufe], [LEITER_435, 12]);
    }
    // mit Jitter: minTotal = 0 ändert nichts am Zufallsergebnis
    const a = ladder({ fair: 2_000_000, ...STD, minTotal: 0, rnd: mulberry32(7) }), b = ladder({ fair: 2_000_000, ...STD, rnd: mulberry32(7) });
    assert.deepEqual(a, b);
    // Ziel kleiner als die Leiste: keine Anschluss-Stufe
    assert.deepEqual(summe(ladder({ fair: 2_000_000, ...STD, minTotal: 435, rnd: mitte }).asks), 435);
  });

  test('mit minTotal: D = 2000 hält die Angebotsseite ohne Jitter 780 Stück (8 Stufen) statt 435, alle im Band', () => {
    const l = ladder({ fair: 2_000_000, ...STD, lambda: impactLambda(2000, 50), minTotal: 700, rnd: mitte });
    assert.deepEqual([summe(l.asks), l.asks.length], [780, 8]);
    assert.deepEqual(l.asks.slice(0, 6).map((e) => e.size), [10, 35, 60, 85, 110, 135]); // die eingestellten Stufen bleiben, nur ihre Abstände folgen λ
    assert.deepEqual(l.bids.map((e) => e.size), l.asks.map((e) => e.size)); // beide Seiten gleich tief
    assert.deepEqual(l.asks.slice(6).map((e) => e.size), [160, 185]); // Anschluss-Stufen 160 und 185 passen beide ganz unter die Bandkante
    assert.deepEqual(summe(l.bids), 780);
    bandVon(l, 2_000_000, 15);
    assert.equal(l.asks[7].price, 2290); // letzte Stufe direkt unter der Bandkante
  });

  test('mit minTotal: größeres Ziel braucht größeren Streubesitz — D = 3000 hält 1000 Stück (9 Stufen); die Staffel endet am Band, nie darüber', () => {
    const l = ladder({ fair: 2_000_000, ...STD, lambda: impactLambda(3000, 50), minTotal: 1000, rnd: mitte });
    // 990 + 165: die 10. Stufe hat nominell 10 + 9·25 = 235 Stück; es passen nur 165, sonst läge ihre Mitte über der Bandkante
    assert.deepEqual(l.asks.length, 10);
    assert.deepEqual(l.asks.slice(9), [{ price: 2300, size: 165 }]);
    assert.equal(summe(l.asks), 990 + 165);
    bandVon(l, 2_000_000, 15);
    // D = 2000 schafft das Ziel 1000 nicht: das Band endet vorher bei 780 — ehrlich begrenzt, keine Endlosschleife
    const klein = ladder({ fair: 2_000_000, ...STD, lambda: impactLambda(2000, 50), minTotal: 1000, rnd: mitte });
    assert.deepEqual([summe(klein.asks), klein.asks.length], [780, 8]);
    bandVon(klein, 2_000_000, 15);
  });

  test('Verkleinern der letzten Anschluss-Stufe wirklich erzwungen: ohne die Verkleinerung läge die Stufe außerhalb des Bands, mit ihr genau an der Kante', () => {
    const l = ladder({ fair: 2_000_000, ...STD, lambda: impactLambda(3000, 50), minTotal: 1000, sizeJitter: 0, jitterBp: 0, rnd: mitte });
    const x = summe(l.asks.slice(0, 9)); // 990 Stück liegen schon
    const mitteVoll = x + 235 / 2;       // Mitte der 10. Stufe mit nomineller Größe
    assert.ok(0.005 + impactLambda(3000, 50) * mitteVoll > 0.15, 'Fixture: die volle Stufe würde das Band verlassen');
    assert.equal(l.asks[9].price, band(2_000_000, 10, 15).max); // verkleinert: 165 Stück, Mitte genau an der Kante
    assert.equal(l.asks[9].size, 165);
    const letzte = 0.005 + impactLambda(3000, 50) * (x + 165 / 2); // so nah an der Kante wie möglich (ganze Stücke)
    assert.ok(letzte <= 0.15 && letzte > 0.15 - 2 * impactLambda(3000, 50), `${letzte}`);
  });

  test('mit minTotal und Jitter: 2000 Ziehungen je Streubesitz — jede Stufe im Band, keine kreuzt, Angebot nie kleiner als ohne minTotal', () => {
    for (const depth of [2000, 3000]) {
      let min = Infinity, max = 0;
      for (let seed = 0; seed < 2000; seed++) {
        const rnd = mulberry32(seed), lambda = impactLambda(depth, 50);
        const l = ladder({ fair: 2_000_000, ...STD, lambda, minTotal: 1000, rnd });
        const ohne = ladder({ fair: 2_000_000, ...STD, lambda, rnd: () => 0.5 });
        bandVon(l, 2_000_000, 15);
        assert.ok(summe(l.asks) >= summe(ohne.asks), `D = ${depth}, Ziehung ${seed}: ${summe(l.asks)} < ${summe(ohne.asks)}`);
        assert.ok(l.asks.length >= 6, `D = ${depth}, Ziehung ${seed}: nur ${l.asks.length} Stufen`);
        min = Math.min(min, summe(l.asks)); max = Math.max(max, summe(l.asks));
      }
      assert.ok(min > 500 && max < 1400, `D = ${depth}: Angebot zwischen ${min} und ${max}`);
    }
  });

  test('Grenzfälle: am Band endendes Ziel, unerreichbares Ziel ohne Anschluss-Stufe; NaN oder Infinity für minTotal wirft RangeError', () => {
    // λ = 0: jede Stufe einen Tick weiter — bei 20 Cr und ±15 % sind das 30 Stufen
    let aufrufe = 0;
    const l = ladder({ fair: 2_000_000, ...STD, lambda: 0, levels: 1, minTotal: 3000, sizeJitter: 0, rnd: () => (aufrufe++, 0.5) }); // Ziel erreichbar (50 Stufen reichen)
    assert.deepEqual([l.asks.length, l.bids.length, aufrufe, summe(l.asks)], [16, 16, 32, 3160]); // Ziel vor dem Band erreicht: nach der 16. Stufe ist Schluss
    // unerreichbares Ziel (Stufen von 1 Stück, auch mit Anschluss-Stufen nie 1e12): alte Leiste, keine Anschluss-Stufe
    const winzig = { fair: 2_000_000, ...STD, lambda: 0, levels: 3, size: 1, sizeStep: 0, bandPct: 1e6, sizeJitter: 0, minTotal: 1e12 };
    assert.deepEqual(ladder({ ...winzig, rnd: mitte }), ladder({ ...winzig, minTotal: 0, rnd: mitte }));
    assert.equal(ladder({ ...winzig, rnd: mitte }).asks.length, 3);
    // negatives Ziel: keine Anschluss-Stufe
    assert.deepEqual(summe(ladder({ fair: 2_000_000, ...STD, minTotal: -5, rnd: mitte }).asks), 435);
    assert.throws(() => ladder({ fair: 2_000_000, ...STD, minTotal: NaN, rnd: mitte }), RangeError);
    assert.throws(() => ladder({ fair: 2_000_000, ...STD, minTotal: Infinity, rnd: mitte }), RangeError);
  });
});

describe('ladder mit minTotal: Stufengrenze und Erreichbarkeit', () => {
  const mitte = () => 0.5, summe = (l) => l.reduce((a, e) => a + e.size, 0);
  test('Anschluss-Stufen hören auf die Admin-Einstellung mm_levels: höchstens 50 oder das Dreifache der eingestellten Stufen', () => {
    // mm_levels = 3 mit Stufen von 1 Stück: das Ziel 1000 ist mit 9 Stufen nicht erreichbar -> genau 3 Stufen
    const drei = { fair: 2_000_000, ...STD, lambda: 0, levels: 3, size: 1, sizeStep: 0, bandPct: 1e6, sizeJitter: 0, minTotal: 1000 };
    assert.equal(ladder({ ...drei, rnd: mitte }).asks.length, 3);
    // mm_levels = 4 (nominell 265 Stück): Anschluss-Stufen, bis die Angebotsseite 1000 Stück hält
    // (Stufe 10 erreicht es: 1028), nie mehr als 3 · 4 = 12. F = 20 Cr, Streubesitz 2822
    // (Spiel-Default nach dem Seed), Band ±15 % — dieselben Zahlen wie im Spiel.
    const vier = { fair: 2_000_000, ...STD, lambda: impactLambda(2822, 50), levels: 4, sizeJitter: 0, jitterBp: 0, minTotal: 1000 };
    const l = ladder({ ...vier, rnd: mitte });
    assert.ok(l.asks.length > 4 && l.asks.length <= 12, `Stufen ${l.asks.length}`);
    assert.equal(summe(l.asks), 1028);
    // mm_levels = 10: die zehn eingestellten Stufen reichen nicht (990 Stück), 3 · 10 = 30 wäre genug,
    // aber das Band endet vorher: die zehnte Stufe (235 Stück) passt nicht mehr hinein, Anschluss-Stufen
    // gibt es deshalb nicht — 9 Stufen mit 990 Stück, also etwas unter dem Ziel
    const zehn = ladder({ ...vier, levels: 10, rnd: mitte });
    assert.equal(zehn.asks.length, 9);
    assert.equal(summe(zehn.asks), 990);
    // mm_levels = 60 (weit über der alten harten Grenze 50, ohne Band-Limit): die eingestellten
    // Stufen gelten weiter, weil 60 Stufen das Ziel schon nominell erreichen
    assert.equal(ladder({ ...vier, levels: 60, bandPct: 1e6, minTotal: 6000, rnd: mitte }).asks.length, 60);
});
});
