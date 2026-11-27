// Tests für T7a (PLAN v2): News-Grafik `newsArt` und die Kategorie-Ableitung `newsCategory`.
// Erwartungen stehen in DESIGN.md §9.1/§10.2 und PLAN.md, nicht im Code des Implementers.
// Reine Funktionen aus dem Client (ESM) — kein Server, keine DB, kein Port.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const NEWS_DIR = path.join(__dirname, '..', '..', 'client', 'src', 'news');
const load = (file) => import(pathToFileURL(path.join(NEWS_DIR, file)).href);

// Token-Werte aus DESIGN.md §10.2: Grundfarben der Formen und je Kategorie ein Akzent
// (#1e2225 = surface-2, nur die Fläche der Kachel).
const BASE = ['#394146', '#8f999e', '#b9c1c4'];
const ACCENT = {
  boerse: ['#ffffff'],
  firma: ['#3ee08a', '#ff6b7a'], // nach Wirkung, ohne Wirkung keiner
  wirtschaft: ['#b9c1c4'],
  geruecht: ['#ffb224'],
};
const PALETTE = new Set(['#15181a', '#1e2225', ...BASE, '#ffffff', '#3ee08a', '#ff6b7a', '#ffb224']);
const KEYS = Object.keys(ACCENT);
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const TICKERS = ['MENSA', 'SETF', 'E', 'X', undefined, '<script>alert(1)</script>', 'a&b"c'];
const IMPACTS = [-3, -1, 0, 2, 3];

const shapes = (svg) => (svg.match(/<(rect|circle|ellipse|line|polyline|polygon|path|text)\b/g) || []).length;
const colors = (svg) => new Set(svg.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
const OPEN = '<svg viewBox="0 0 320 180">';

test('newsArt ist deterministisch: gleiche Eingabe → identisches Markup', async () => {
  const { newsArt } = await load('newsArt.js');
  for (const key of KEYS) {
    for (const seed of SEEDS) {
      for (const ticker of TICKERS) {
        const once = newsArt(key, seed, ticker, 1);
        assert.equal(newsArt(key, seed, ticker, 1), once, `${key}/${seed}: Wiederholung`);
        assert.equal(newsArt(key, String(seed), ticker, 1), once, `${key}: Seed als Zahl und als Text`);
      }
    }
  }
  for (const key of KEYS) assert.equal(newsArt(key, 7, 'MENSA', 0), newsArt(key, 7, 'MENSA'), `${key}: impact 0 ist der Standard`);
  assert.equal(newsArt('Geruecht', 42), newsArt('geruecht', 42), 'Großschreibung der Kategorie');
  // Frisch geladenes Modul liefert dasselbe: kein Zustand, kein Math.random
  const again = await import(`${pathToFileURL(path.join(NEWS_DIR, 'newsArt.js')).href}?reload=1`);
  assert.equal(again.newsArt('boerse', 42), newsArt('boerse', 42));
});

test('newsArt: anderer Seed oder andere Kategorie → anderes Markup', async () => {
  const { newsArt } = await load('newsArt.js');
  for (const key of KEYS) {
    const all = new Set(SEEDS.map((seed) => newsArt(key, seed)));
    assert.ok(all.size >= SEEDS.length * 0.95, `${key}: ${all.size} von ${SEEDS.length} Seeds unterscheidbar`);
    assert.notEqual(newsArt(key, 1), newsArt(key, 2), `${key}: Seed 1 gegen 2`);
  }
  for (const seed of [1, 2, 3, 17, 99, 123456]) {
    const marks = KEYS.map((key) => newsArt(key, seed));
    assert.equal(new Set(marks).size, KEYS.length, `Seed ${seed}: Kategorien unterscheiden sich`);
  }
});

test('newsArt: Format — viewBox 320×180, unter 1 KB, höchstens 24 Formen, nur ASCII', async () => {
  const { newsArt } = await load('newsArt.js');
  let largest = 0;
  let smallest = Infinity;
  for (const key of KEYS) {
    for (const seed of SEEDS) {
      for (const ticker of TICKERS) {
        for (const impact of IMPACTS) {
          const svg = newsArt(key, seed, ticker, impact);
          largest = Math.max(largest, svg.length);
          smallest = Math.min(smallest, svg.length);
          assert.ok(svg.startsWith(OPEN) && svg.endsWith('</svg>'), 'ein svg mit viewBox 320×180');
          assert.ok(svg.length <= 1024, `${key}/${seed}: ${svg.length} Zeichen`);
          assert.ok(shapes(svg) > 1 && shapes(svg) <= 24, `${key}/${seed}: ${shapes(svg)} Formen`);
          assert.ok(/^[\x20-\x7e]*$/.test(svg), 'nur ASCII: Zeichen = Bytes');
        }
      }
    }
  }
  assert.ok(smallest > 150 && largest > 250, `Grafiken sind gezeichnet (${smallest} … ${largest} Zeichen)`);
});

test('newsArt: nur Token-Farben, ein Akzent je Kategorie, keine Effekte, keine Verweise', async () => {
  const { newsArt } = await load('newsArt.js');
  for (const key of KEYS) {
    const seen = new Set();
    let all = '';
    for (const seed of SEEDS) {
      for (const impact of IMPACTS) {
        const svg = newsArt(key, seed, 'MENSA', impact);
        all += svg;
        const used = colors(svg);
        for (const c of used) assert.ok(PALETTE.has(c), `${key}: ${c} ist kein Token`);
        const accents = [...used].filter((c) => ACCENT[key].includes(c));
        // Firma: Akzent nur nach Wirkung (positiv grün, negativ rot, ohne Wirkung keiner); sonst genau einer
        const want = key === 'firma' && impact === 0 ? 0 : 1;
        assert.equal(accents.length, want, `${key}/${seed}/${impact}: Akzent ${accents}, erwartet ${want}`);
        if (key === 'firma') { // Wirkung wählt den Akzent: positiv grün, negativ rot, sonst neutral
          assert.equal(used.has('#3ee08a'), impact > 0);
          assert.equal(used.has('#ff6b7a'), impact < 0);
        }
        for (const c of used) seen.add(c);
      }
    }
    assert.ok(seen.has('#8f999e'), `${key}: die Formfarbe text-3 fehlt nie ganz`);
    if (key !== 'firma') assert.ok(seen.has(ACCENT[key][0]), `${key}: Akzent ${ACCENT[key][0]} kommt vor`);
    for (const bad of ['<image', '<script', '<foreignObject', '<use', '<g', '<a', 'http', 'url(', 'Gradient',
      'filter', 'mask', 'opacity', 'rgba', 'hsl', '<style', '<!', ' on']) {
      assert.ok(!all.includes(bad), `${key}: Markup enthält ${JSON.stringify(bad)}`);
    }
  }
});

test('newsArt: Text nur als Monogramm aus dem Kürzel — nichts einspeisbar', async () => {
  const { newsArt } = await load('newsArt.js');
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(texts(newsArt('firma', 5, '<script>alert(1)</script>')), ['SC'], 'zwei Buchstaben, groß, nur A–Z/0–9');
  assert.deepEqual(texts(newsArt('firma', 5, 'men-sa')), ['ME']);
  assert.deepEqual(texts(newsArt('firma', 5, 'ÄÖÜ')), [], 'kein nutzbares Zeichen → kein Monogramm');
  assert.deepEqual(texts(newsArt('firma', 5)), []);
  assert.notEqual(newsArt('firma', 5, 'MENSA'), newsArt('firma', 5, 'SETF'), 'das Kürzel ändert die Grafik');
  for (const key of ['boerse', 'wirtschaft', 'geruecht']) {
    assert.deepEqual(texts(newsArt(key, 5, 'MENSA')), [], `${key}: kein Text`);
  }
});

test('newsArt: unbekannte oder fehlende Kategorie → Kachel-Fallback in gleicher Fläche', async () => {
  const { newsArt } = await load('newsArt.js');
  const tile = newsArt('unbekannt', 9);
  for (const key of [undefined, null, '', 42, 'constructor', '__proto__', 'toString', 'news', 'dividend']) {
    assert.equal(newsArt(key, 9), tile, `Kategorie ${String(key)}`);
    assert.equal(newsArt(key, 10), tile, 'die Kachel hängt nicht am Seed');
  }
  assert.ok(tile.startsWith(OPEN) && tile.endsWith('</svg>'));
  assert.match(tile, /^<svg viewBox="0 0 320 180"><rect width="320" height="180" fill="#1e2225"\/>/, 'Fläche surface-2');
  assert.ok(tile.length <= 1024 && shapes(tile) <= 24);
  for (const c of colors(tile)) assert.ok(PALETTE.has(c), `Kachel: ${c}`);
  for (const key of KEYS) assert.notEqual(newsArt(key, 9), tile);
});

test('newsCategory bildet die acht Arten ab (DESIGN 9.1)', async () => {
  const { newsCategory, newsSource, NEWS_CATEGORIES } = await load('category.js');
  const expect = (item, key) => assert.equal(newsCategory(item), NEWS_CATEGORIES[key], `${JSON.stringify(item)} → ${key}`);
  for (const kind of ['system', 'ipo', 'etf']) { expect({ kind }, 'boerse'); expect({ kind, security_id: 5 }, 'boerse'); }
  for (const kind of ['dividend', 'bafin', 'takeover']) { expect({ kind }, 'firma'); expect({ kind, security_id: 5 }, 'firma'); }
  expect({ kind: 'news', security_id: 5 }, 'firma');
  expect({ kind: 'news', security_id: null }, 'wirtschaft');
  expect({ kind: 'news' }, 'wirtschaft');
  expect({ kind: 'rumor', security_id: 5 }, 'geruecht');
  expect({ kind: 'rumor' }, 'geruecht');
  for (const item of [{}, { kind: 'unbekannt' }, null, undefined]) expect(item, 'wirtschaft');

  const table = { // Etikett · Chip-Ton · feste Quelle
    boerse: ['Börse', 'official', 'School Street'],
    firma: ['Firma', 'neutral', null],
    wirtschaft: ['Wirtschaft', 'neutral', 'Markt'],
    geruecht: ['Gerücht', 'warn', 'Flurfunk'],
  };
  assert.deepEqual(Object.keys(NEWS_CATEGORIES).sort(), Object.keys(table).sort());
  for (const [key, [label, tone, source]] of Object.entries(table)) {
    assert.deepEqual({ ...NEWS_CATEGORIES[key] }, { key, label, tone, source });
  }
  assert.equal(newsCategory({ kind: 'news', category: 'boerse' }), NEWS_CATEGORIES.wirtschaft,
    'kein zweiter Weg: nur kind und security_id entscheiden');

  // Quelle: Firma-News nennen die Firma, alle anderen die feste Quelle ihrer Kategorie
  assert.equal(newsSource({ kind: 'dividend', security_id: 5 }, { name: 'Mensa & Catering', ticker: 'MENSA' }), 'Mensa & Catering');
  assert.equal(newsSource({ kind: 'news', security_id: 5 }, { ticker: 'MENSA' }), 'MENSA');
  assert.equal(newsSource({ kind: 'news', security_id: 5 }, null), 'Firma');
  assert.equal(newsSource({ kind: 'system' }, null), 'School Street');
  assert.equal(newsSource({ kind: 'news' }, null), 'Markt');
  // Anlass statt Doppel: ohne geladene Firma steht der Anlass, nie nochmals „Firma“ (Chip sagt es schon).
  assert.equal(newsSource({ kind: 'dividend' }, null), 'Ausschüttung');
  assert.equal(newsSource({ kind: 'bafin' }, null), 'BaFin');
  assert.equal(newsSource({ kind: 'takeover' }, null), 'Übernahme');
  assert.equal(newsSource({ kind: 'bafin' }, { name: 'Mensa & Catering' }), 'Mensa & Catering');
  assert.equal(newsSource({ kind: 'rumor' }, null), 'Flurfunk');
});

// ---------------------------------------------------------------------------
// Zeile als Ganzes: Server-Rendering des echten JSX. Dafür wird client/src/news/NewsRow.jsx
// einmal mit esbuild (Abhängigkeit von Vite, bereits installiert) in ein temporäres Verzeichnis
// übersetzt; Pakete bleiben extern und werden über einen node_modules-Link gefunden. Der
// Ticker-Speicher (hooks.jsx) wird durch eine Tabelle ersetzt: er hat kein getServerSnapshot
// und kann nicht serverseitig rendern — geprüft wird hier die Zeile, nicht der Speicher.
// ANNAHME: `esbuild` bleibt als Abhängigkeit von Vite im installierten Bestand (root node_modules)
// verfügbar und darf im Test genutzt werden — es ist kein eigenes devDependency.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');

test('NewsRow rendert auch, wenn newsArt wirft oder die Kategorie fehlt (Kachel-Fallback)', async () => {
  const esbuild = require('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't7a-row-'));
  try {
    fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // Doppel des Ticker-Speichers: useTickerRow liest nur diese Tabelle
    fs.writeFileSync(path.join(dir, 'ticker.mjs'),
      'export const quotes = new Map();\nexport const useTickerRow = (id) => quotes.get(id) || null;\n');
    await esbuild.build({
      entryPoints: [path.join(NEWS_DIR, 'NewsRow.jsx')],
      bundle: true, splitting: false, format: 'esm', platform: 'node', jsx: 'automatic',
      external: ['react', 'react-dom', 'react-router-dom', '@tabler/icons-react', 'lightweight-charts'],
      loader: { '.css': 'empty' },
      plugins: [{
        name: 'ticker-tabelle',
        setup: (b) => b.onResolve({ filter: /hooks\.jsx$/ }, () => ({ path: path.join(dir, 'ticker.mjs'), external: true })),
      }],
      outfile: path.join(dir, 'NewsRow.mjs'), logLevel: 'silent',
    });
    const { NewsRow, NewsMeta } = await import(pathToFileURL(path.join(dir, 'NewsRow.mjs')).href);
    const { renderToStaticMarkup } = require(path.join(dir, 'node_modules', 'react-dom', 'server'));
    const { createElement: h } = require(path.join(dir, 'node_modules', 'react'));
    const render = (props) => renderToStaticMarkup(h(NewsRow, props));

    const base = { id: 7, kind: 'system', title: 'Börse verlängert', body: 'Text', created_at: Date.now() - 300000 };
    const ok = render({ item: base, onOpen: () => {} });
    assert.match(ok, /^<article class="news-item is-link">/, 'Wurzel ist der Artikel, mit onOpen verlinkt');
    assert.match(render({ item: base }), /^<article class="news-item">/, 'ohne onOpen statisch');
    assert.match(ok, /<h2 class="news-title"><button type="button" class="news-btn-hit"[^>]*>Börse verlängert<\/button><\/h2>/,
      'article > h2 > button: der Titel ist die Schaltfläche');
    assert.doesNotMatch(ok, /<(div|p|h2)[^>]*>[^<]*<\/button>/, 'keine Blöcke in der Schaltfläche');
    assert.match(ok, /<svg viewBox="0 0 320 180"/, 'Grafik steht sofort im Markup');
    assert.match(ok, /<span class="chip official">/, 'Börse trägt den Chip official');
    assert.match(ok, /<p class="news-text">Text<\/p>/, 'Text ist Absatz');
    assert.doesNotMatch(ok, /<button[^>]*class="news-btn"/, 'der ehemalige Zeilen-Button ist weg');

    // newsArt wirft (Seed lässt sich nicht in Text wandeln) → Kachel statt Absturz
    const thrown = render({ item: { ...base, id: Symbol('wirft') }, onOpen: () => {} });
    assert.match(thrown, /<span class="news-art-tile"><svg[^>]*>.*?<\/svg><\/span>/, 'Kachel mit Kategorie-Icon');
    assert.match(thrown, /<h2 class="news-title">.*Börse verlängert/, 'Titel bleibt');
    assert.match(thrown, /<span class="news-art-tile"><svg[^>]*stroke-width="1.8"/, 'Kachel-Icon aus der Kategorie');
    assert.doesNotMatch(thrown, /<svg viewBox="0 0 320 180"/, 'keine Grafik neben der Kachel');
    assert.equal(render({ item: undefined }), '', 'ohne Item nichts');
    assert.equal(renderToStaticMarkup(h(NewsMeta, { item: undefined })), '', 'NewsMeta ohne Item nichts');

    // Ungelesen: versteckter Text vor dem Titel, Marke an, Artikel markiert
    const unread = render({ item: base, unread: true });
    assert.match(unread, /<article class="news-item is-unread">/);
    assert.match(unread, /<h2 class="news-title"><span class="news-sr">Ungelesen: <\/span>Börse verlängert<\/h2>/);
    assert.match(unread, /<span class="news-mark on"/);
    // ohne onOpen: statischer Artikel ohne Schaltfläche
    assert.doesNotMatch(unread, /<button/);
    // ohne Wert keine Wirkungszeile
    assert.doesNotMatch(ok, /news-fx/);
    // mit Wert: Wirkungszeile — Wirkung der Nachricht (Farbe nach impact) und der Tageskurs
    // aus dem Ticker-Speicher, gekennzeichnet mit „heute“ und ungefärbt. Die Firma steht nur
    // in der Metazeile. Tageskurs +3,77 % unter einer Nachricht mit Wirkung −3: das Plus darf
    // nicht als „die Nachricht war gut“ lesbar sein.
    const { quotes } = await import(pathToFileURL(path.join(dir, 'ticker.mjs')).href);
    quotes.set(3, { id: 3, ticker: 'EIS', name: 'Eiswerk Schulhof AG', chg: 3.77, last: 1520 });
    const withValue = { ...base, kind: 'dividend', security_id: 3, impact: -3 };
    const fx = render({ item: withValue });
    assert.match(fx, /<div class="news-fx"><span class="chip down news-fx-impact"><span class="news-fx-cap">Wirkung:<\/span>stark negativ<\/span>/,
      'Wirkung der Nachricht als Wort, Farbe nach impact');
    assert.match(fx, /<span class="chip neutral news-fx-chip"><span class="news-fx-cap">heute<\/span><span class="num">.*\+3,77%/, 'Tageskurs gekennzeichnet und ungefärbt');
    assert.doesNotMatch(fx, /chip (up|down) news-fx-chip/, 'der Tageskurs ist nie gefärbt');
    assert.equal((fx.match(/Eiswerk Schulhof AG/g) || []).length, 1, 'die Firma steht nur einmal (Metazeile)');
    assert.match(fx, /chip down news-fx-impact/, 'ohne Lesen der Farbe: Ton folgt der Wirkung');
    // Stufen und Neutral: 0 und fehlend = ohne Wirkung, 1 = leicht positiv, 3 = stark positiv
    const effect = (impact) => render({ item: { ...withValue, impact } }).match(/<span class="chip (\w+) news-fx-impact"><span class="news-fx-cap">Wirkung:<\/span>([^<]+)<\/span>/);
    assert.deepEqual(effect(0).slice(1), ['neutral', 'ohne Wirkung'], 'impact 0');
    assert.deepEqual(effect(undefined).slice(1), ['neutral', 'ohne Wirkung'], 'impact fehlt');
    assert.deepEqual(effect(1).slice(1), ['up', 'leicht positiv'], 'impact 1');
    assert.deepEqual(effect(3).slice(1), ['up', 'stark positiv'], 'impact 3');
    assert.deepEqual(effect(-2).slice(1), ['down', 'negativ'], 'impact −2');
    // ohne Ticker-Zeile: die Wirkung steht, die Kurszeile fehlt (kein ewiges „Kurs lädt …“)
    quotes.clear();
    const noQuote = render({ item: withValue });
    assert.match(noQuote, /<div class="news-fx"><span class="chip down news-fx-impact">/, 'Wirkung bleibt ohne Kurs');
    assert.doesNotMatch(noQuote, /news-fx-chip|Kurs lädt/, 'keine Kurszeile ohne Ticker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
