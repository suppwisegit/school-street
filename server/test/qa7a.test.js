// QA T7a — unabhängige Testfälle aus dem DoD (PLAN.md T7a), DESIGN.md §9.1/9.2/10.2 und V7.
// Nicht aus dem Code des Implementers abgeleitet. Kein Server, keine DB, kein Port.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const NEWS_DIR = path.join(ROOT, 'client', 'src', 'news');
const load = (file) => import(pathToFileURL(path.join(NEWS_DIR, file)).href);

const CATS = ['boerse', 'firma', 'wirtschaft', 'geruecht'];
const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

// Tokens aus styles.css (einzige erlaubte Quelle von Farbwerten)
const stylesCss = fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles.css'), 'utf8');
const TOKENS = new Map();
for (const m of stylesCss.matchAll(/(--ss-[a-z0-9-]+)\s*:\s*([^;]+);/g)) TOKENS.set(m[1], m[2].trim().toLowerCase());
const TOKEN_COLORS = new Set([...TOKENS.values()].map((v) => v.match(/^#[0-9a-f]{6}$/i)?.[0]).filter(Boolean));
const hex = (s) => [...s.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());

// Wohlgeformtheit: ein Wurzelelement, jede Klammer zu, Attribute Name="Wert", im Text kein <, &, keine Entität
function wellFormed(svg) {
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*|!|\?)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let last = 0;
  let m;
  let root = 0;
  while ((m = tag.exec(svg))) {
    const between = svg.slice(last, m.index);
    assert.ok(!/[<&]/.test(between), `unaufgelöstes Zeichen zwischen Tags: ${JSON.stringify(between)}`);
    const attrs = m[3];
    const selfClose = /\/\s*$/.test(attrs);
    const body = attrs.replace(/\//g, '');
    for (const a of body.matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'))?/g)) {
      assert.ok(a[2], `Attribut ${a[1]} ohne Wert in ${m[0].slice(0, 40)}`);
    }
    assert.equal(body.trim(), (body.match(/[\w:-]+\s*=\s*("[^"]*"|'[^']*')/g) || []).join(' '),
      `Attribut ohne Anführungszeichen: ${m[0].slice(0, 50)}`);
    if (m[1]) { // schließend
      assert.equal(stack.pop(), m[2], `</${m[2]}> schließt nicht das letzte Element`);
    } else if (!selfClose) {
      if (stack.length === 0) root++;
      stack.push(m[2]);
    }
    last = tag.lastIndex;
  }
  assert.ok(!/[<&]/.test(svg.slice(last)), 'unaufgelöstes Zeichen nach dem letzten Tag');
  assert.equal(stack.length, 0, 'nicht geschlossene Elemente');
  assert.equal(root, 1, 'genau ein Wurzelelement');
}

test('QA T7a: Determinismus — gleiche Kategorie und Seed → identisch, anderer Seed / andere Kategorie → anders', async () => {
  const { newsArt } = await load('newsArt.js');
  for (const cat of CATS) {
    // DESIGN 10.2 „Ruhe“: nichts wiederholt sich in einer Liste nebeneinander — Liste = 20 aufeinanderfolgende Ids
    const seen = new Map();
    let collisions = 0;
    for (const seed of SEEDS) {
      const a = newsArt(cat, seed, 'MENSA', 1);
      assert.equal(newsArt(cat, seed, 'MENSA', 1), a, `${cat}/${seed}: zweiter Aufruf weicht ab`);
      assert.equal(newsArt(cat, String(seed), 'MENSA', 1), a, `${cat}/${seed}: Seed als Text weicht ab`);
      for (const other of SEEDS.slice(0, 6).filter((x) => x !== seed)) {
        assert.notEqual(newsArt(cat, other, 'MENSA', 1), a, `${cat}: Seed ${seed} und ${other} ergeben dieselbe Grafik`);
      }
      for (const o of CATS.filter((c) => c !== cat)) assert.notEqual(newsArt(o, seed, 'MENSA', 1), a, `${cat} vs ${o} bei Seed ${seed}`);
      const first = seen.get(a);
      if (first !== undefined) {
        collisions++;
        assert.ok(seed - first > 20, `${cat}: Seed ${first} und ${seed} (nahe beieinander) ergeben dieselbe Grafik`);
      }
      seen.set(a, seed);
    }
    assert.ok(seen.size >= 450, `${cat}: nur ${seen.size} verschiedene Grafiken bei 500 Seeds`);
  }
});

test('QA T7a: Größe — jede Grafik unter 1 KB (Bytes), viewBox 0 0 320 180, genau ein svg', async () => {
  const { newsArt } = await load('newsArt.js');
  const tickers = ['MENSA', 'SETF', 'AB', undefined, 'ÄÖÜ', '<script>alert(1)</script>', 'a&b"c<d'];
  let max = 0;
  let n = 0;
  for (const cat of CATS) for (const seed of SEEDS) for (const t of tickers) for (const impact of [-3, -1, 0, 1, 3]) {
    const svg = newsArt(cat, seed, t, impact);
    const bytes = Buffer.byteLength(svg, 'utf8');
    max = Math.max(max, bytes);
    n++;
    assert.ok(bytes < 1024, `${cat}/${seed}: ${bytes} Bytes`);
    assert.match(svg, /^<svg viewBox="0 0 320 180">/, 'Anfang');
    assert.ok(svg.endsWith('</svg>') && (svg.match(/<svg\b/g) || []).length === 1, 'genau ein svg-Element');
  }
  assert.ok(n === 4 * 500 * 7 * 5 && max > 200, `${n} Grafiken, größte ${max} Bytes`);
});

test('QA T7a: Sicherheit und Selbstgenügsamkeit — kein image/script/Event/externer Verweis, gültiges Markup', async () => {
  const { newsArt } = await load('newsArt.js');
  const tickers = ['MENSA', '"><image href="http://x/y" onload="alert(1)">', '<script>x</script>', "a' onload='1", 'javascript:alert(1)', 'A&B<C>', undefined, 42];
  const forbidden = [/<image/i, /<script/i, /<foreignObject/i, /<use/i, /<a[\s>]/i, /<iframe/i, /<style/i, /<!/, /<\?/,
    /\bon[a-z]+\s*=/i, /\sonload/i, /href/i, /xlink/i, /http/i, /\/\/[a-z0-9.-]+\.[a-z]/i, /url\s*\(/i, /javascript:/i,
    /<style/i, /@(import|font)/i, /style\s*=/i, /<g[\s>]/i, /data:/i];
  for (const cat of CATS) for (const seed of SEEDS) for (const t of tickers) for (const impact of [-3, 0, 2]) {
    const svg = newsArt(cat, seed, t, impact);
    for (const re of forbidden) assert.ok(!re.test(svg), `${cat}: Markup enthält ${re}`);
    wellFormed(svg);
    // kein unaufgelöstes < : jedes < leitet ein Tag ein (obiger Scanner), Ticker erscheint nie roh
    if (typeof t === 'string' && /[<>&"']/.test(t)) assert.ok(!svg.includes(t.slice(0, 4)) || /^MENS/.test(t), `${cat}: Ticker unverändert übernommen`);
  }
  for (const bad of [undefined, null, '', 'constructor', '__proto__', 'toString', 'news', 'dividend', 'BÖRSE', 42, {}]) {
    const svg = newsArt(bad, 7);
    wellFormed(svg);
    assert.match(svg, /^<svg viewBox="0 0 320 180">/, `Kategorie ${String(bad)}: Fallback mit Format`);
  }
});

test('QA T7a: 500 Seeds — keine IDs im Markup, daher keine Kollision zwischen zwei Grafiken auf einer Seite', async () => {
  const { newsArt } = await load('newsArt.js');
  const ids = new Map();
  let withId = 0;
  for (const cat of CATS) for (const seed of SEEDS) {
    const svg = newsArt(cat, seed, 'MENSA', 1);
    for (const m of svg.matchAll(/\sid\s*=\s*"([^"]*)"/gi)) {
      withId++;
      const k = `${cat}|${m[1]}`;
      if (ids.has(m[1])) assert.fail(`id ${m[1]} doppelt (${ids.get(m[1])} und ${k})`);
      ids.set(m[1], k);
    }
    assert.ok(!/url\s*\(\s*#|href\s*=\s*"#/.test(svg), 'kein Verweis auf eine id');
  }
  assert.equal(withId, 0, `Markup trägt ${withId} id-Attribute — zwei Inline-SVGs auf einer Seite könnten kollidieren`);
});

// Akzente nach DESIGN 10.2: höchstens ein Akzent je Kategorie
const ACCENT = { boerse: ['#ffffff'], firma: ['#3ee08a', '#ff6b7a', '#b9c1c4'], wirtschaft: ['#b9c1c4'], geruecht: ['#ffb224'] };
const BASE = ['#394146', '#8f999e', '#b9c1c4'];

test('QA T7a: Farben — nur Token-Werte aus styles.css, ein Akzent je Kategorie, kein new color', async () => {
  const { newsArt } = await load('newsArt.js');
  const cssHex = hex(stylesCss);
  for (const c of ['#394146', '#8f999e', '#b9c1c4', '#ffffff', '#3ee08a', '#ff6b7a', '#ffb224', '#1e2225']) {
    assert.ok(TOKEN_COLORS.has(c) && cssHex.includes(c), `${c} ist kein Token in styles.css`);
  }
  for (const cat of CATS) {
    const seen = new Set();
    for (const seed of SEEDS) for (const impact of [-3, -1, 0, 1, 3]) {
      const used = new Set(hex(newsArt(cat, seed, 'MENSA', impact)));
      for (const c of used) assert.ok(TOKEN_COLORS.has(c), `${cat}/${seed}: ${c} ist kein Token aus styles.css`);
      if (cat === 'firma') {
        assert.equal(used.has('#3ee08a'), impact > 0, `Firma/${impact}: grün nur bei positiver Wirkung`);
        assert.equal(used.has('#ff6b7a'), impact < 0, `Firma/${impact}: rot nur bei negativer Wirkung`);
      } else {
        assert.ok(!used.has('#3ee08a') && !used.has('#ff6b7a'), `${cat}: kein Geld-Farbton`);
      }
      const accents = [...used].filter((c) => !BASE.includes(c) && c !== '#1e2225');
      assert.ok(accents.length <= 1, `${cat}: mehrere Akzente ${accents}`);
      for (const c of accents) assert.ok(ACCENT[cat].includes(c), `${cat}: ${c} ist nicht der Kategorie-Akzent`);
      used.forEach((c) => seen.add(c));
    }
    for (const c of ACCENT[cat]) if (cat !== 'firma' || c === '#b9c1c4') {
      assert.ok(seen.has(c) || cat === 'firma', `${cat}: Akzent ${c} kommt in 500 Seeds nie vor`);
    }
    assert.ok(seen.has('#8f999e'), `${cat}: Formfarbe fehlt nie`);
  }
});

test('QA T7a: newsCategory — acht Arten auf vier Kategorien (Gerücht / Firma / Wirtschaft / Börse)', async () => {
  const { newsCategory, newsSource } = await load('category.js');
  const want = { rumor: 'geruecht', system: 'boerse', ipo: 'boerse', etf: 'boerse', dividend: 'firma', bafin: 'firma', takeover: 'firma' };
  const label = { geruecht: 'Gerücht', firma: 'Firma', wirtschaft: 'Wirtschaft', boerse: 'Börse' };
  for (const [kind, key] of Object.entries(want)) {
    for (const item of [{ kind }, { kind, security_id: 5 }, { kind, security_id: null }]) {
      assert.equal(newsCategory(item).key, key, `${JSON.stringify(item)} → ${key}`);
      assert.equal(newsCategory(item).label, label[key]);
    }
  }
  assert.equal(newsCategory({ kind: 'news', security_id: 5 }).key, 'firma', 'news mit Wert → Firma');
  assert.equal(newsCategory({ kind: 'news', security_id: 0 }).key, 'firma', 'security_id 0 gilt als Wert');
  for (const item of [{ kind: 'news' }, { kind: 'news', security_id: null }, {}, { kind: 'unbekannt' }, null, undefined]) {
    assert.equal(newsCategory(item).key, 'wirtschaft', `${JSON.stringify(item)} → Wirtschaft`);
  }
  // Reihenfolge der Regeln: rumor und die offiziellen Arten gewinnen auch mit Wert; dividend ohne Wert bleibt Firma
  assert.equal(newsCategory({ kind: 'rumor', security_id: 5 }).key, 'geruecht');
  assert.equal(newsCategory({ kind: 'ipo', security_id: 5 }).key, 'boerse');
  const keys = new Set();
  for (const item of [{ kind: 'rumor' }, { kind: 'system' }, { kind: 'dividend' }, { kind: 'news' }]) keys.add(newsCategory(item).key);
  assert.deepEqual([...keys].sort(), ['boerse', 'firma', 'geruecht', 'wirtschaft'], 'alle vier Kategorien werden erreicht');
  assert.deepEqual([newsSource({ kind: 'system' }), newsSource({ kind: 'rumor' }), newsSource({ kind: 'news' })], ['School Street', 'Flurfunk', 'Markt']);
});

test('QA T7a: news.css — keine Farbwerte außer Tokens, jede benutzte Variable existiert in styles.css', () => {
  const css = fs.readFileSync(path.join(NEWS_DIR, 'news.css'), 'utf8');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(hex(noComments), [], 'keine Hex-Farben in news.css');
  const bare = noComments.replace(/var\(--ss-[a-z0-9-]+\)/g, '');
  assert.ok(!/rgba?\(|hsla?\(|#[0-9a-f]{3,8}\b|(?<![-\w])(white|black|red|transparent)\s*[;,)]/.test(bare), 'keine Farbwerte außer über Variablen');
  const used = new Set([...noComments.matchAll(/var\((--ss-[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, `news.css benutzt ${used.size} Variablen`);
  for (const v of used) assert.ok(TOKENS.has(v), `${v} ist in styles.css nicht definiert`);
  // Die für die Zeile festgeschriebenen Maße (DESIGN 9.2/9.3)
  assert.match(noComments, /\.news-art\s*\{[^}]*width:\s*112px;\s*height:\s*63px/, 'Grafik 112×63');
  assert.match(noComments, /\.news-art\s*\{[^}]*width:\s*160px;\s*height:\s*90px/, 'Grafik 160×90 ab 720 px');
  assert.match(noComments, /\.news-btn\s*\{[^}]*gap:\s*12px/, 'Abstand 12');
  assert.match(noComments, /\.news-title\s*\{[^}]*-webkit-line-clamp:\s*2/, 'Schlagzeile zwei Zeilen');
  assert.match(noComments, /\.news-text\s*\{[^}]*-webkit-line-clamp:\s*3/, 'Text drei Zeilen');
});
