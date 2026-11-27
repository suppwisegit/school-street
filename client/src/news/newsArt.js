// News-Grafik aus Code (DESIGN.md §10.2): reine Funktion, kein Request, keine Datei.
// newsArt(category, seed, ticker?, impact?) → SVG-Markup für eine Box im Verhältnis 16:9
// (viewBox 320×180; im DOM 112×63 bzw. 160×90). Gleiche Eingabe → identisches Markup.
// Farben sind ausschließlich Token-Werte; höchstens ein Akzent je Kategorie.
// `category` = key aus newsCategory; unbekannt → neutrale Kachel. Für Inline-SVG gebraucht
// (kein xmlns nötig). Nur ASCII, dadurch gilt: Zeichen = Bytes.

const W = 320;
const H = 180;
const C = { line: '#394146', dim: '#8f999e', mid: '#b9c1c4', white: '#ffffff',
  up: '#3ee08a', down: '#ff6b7a', warn: '#ffb224', tile: '#1e2225' };

// FNV-1a über die Zeichenkette → 32-Bit-Zahl
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: kleiner, deterministischer Zufallsgenerator
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Börse: 6–8 Kerzen und eine Kurslinie über die volle Breite; Akzent Weiß.
function boerse(r) {
  const count = 6 + Math.floor(r() * 3);
  const slot = W / count;
  const bodyW = 14 + Math.floor(r() * 7);
  let close = 70 + r() * 50;
  let prev = close;
  const candles = [];
  const line = [];
  for (let i = 0; i < count; i++) {
    const cx = (i + 0.5) * slot;
    const open = prev;
    close = Math.min(150, Math.max(32, close + (r() - 0.5) * 80));
    prev = close;
    const top = Math.min(open, close);
    const hi = Math.max(top - 6 - r() * 22, 14);
    const lo = Math.min(Math.max(open, close) + 6 + r() * 22, 164);
    candles.push({ x: Math.round(cx - bodyW / 2), y: Math.round(top), h: Math.max(4, Math.round(Math.abs(close - open))), cx: Math.round(cx), hi: Math.round(hi), lo: Math.round(lo) });
    line.push(`${Math.round(cx)},${Math.round(close)}`);
  }
  const lit = Math.floor(r() * count); // die eine Kerze in Weiß
  const wicks = candles.map((k) => `M${k.cx} ${k.hi}v${k.lo - k.hi}`).join('');
  const bodies = candles.map((k, i) => `<rect x="${k.x}" y="${k.y}" width="${bodyW}" height="${k.h}" fill="${i === lit ? C.white : C.dim}"/>`).join('');
  return `<path d="${wicks}" stroke="${C.line}" stroke-width="3"/>${bodies}<polyline points="${line.join(' ')}" fill="none" stroke="${C.mid}" stroke-width="3"/>`;
}

// Kachel-Fallback: neutrale Fläche mit Grundlinie (unbekannte Kategorie)
function tile() {
  return `<rect width="${W}" height="${H}" fill="${C.tile}"/><path d="M20 150h280" stroke="${C.line}" stroke-width="4"/>`;
}

// Firma: 2–4 Balken und das Kürzel-Monogramm rechts unten; Akzent nach Wirkung.
function firma(r, ticker, impact) {
  const mono = String(ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);
  const count = mono ? 2 + Math.floor(r() * 3) : 4;
  const accent = impact > 0 ? C.up : impact < 0 ? C.down : C.mid; // ohne Wirkung neutral
  const lit = Math.floor(r() * count);
  const bars = [];
  for (let i = 0; i < count; i++) {
    const h = 24 + Math.round(r() * 84);
    const fill = i === lit ? accent : C.dim;
    bars.push(`<rect x="${16 + i * 46}" y="${150 - h}" width="34" height="${h}" fill="${fill}"/>`);
  }
  const text = mono
    ? `<text x="304" y="160" text-anchor="end" font-family="Archivo Variable,Archivo,system-ui" font-weight="800" font-stretch="110%" font-size="44" fill="${C.mid}">${mono}</text>`
    : '';
  return `${bars.join('')}<path d="M12 150h296" stroke="${C.line}" stroke-width="3"/>${text}`;
}

// Wirtschaft: sechs Balken unterschiedlicher Höhe auf einer Grundlinie, einer hervorgehoben.
function wirtschaft(r) {
  const order = [0, 1, 2, 3, 4, 5];
  for (let i = order.length - 1; i > 0; i--) { // Fisher-Yates: jede Höhe genau einmal
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lit = Math.floor(r() * 6);
  const bars = order.map((rank, i) => {
    const h = 14 + rank * 18 + Math.round(r() * 8);
    return `<rect x="${22 + i * 48}" y="${150 - h}" width="28" height="${h}" fill="${i === lit ? C.mid : C.dim}"/>`;
  });
  return `${bars.join('')}<path d="M12 150h296" stroke="${C.line}" stroke-width="3"/>`;
}

// Gerücht: Punktraster 12 × 6 als gestrichelte Linien (ein Pfad je Farbe); ein Viertel fehlt,
// ein Viertel in Akzentfarbe, dazu einzelne Lücken und Akzentpunkte nach Seed.
function geruecht(r) {
  const cols = 12;
  const rows = 6;
  const step = 26;
  const x0 = 13;
  const quarter = () => ({ c: r() < 0.5 ? 0 : 6, r: r() < 0.5 ? 0 : 3 }); // 6 Spalten × 3 Zeilen
  const miss = quarter();
  const hot = quarter();
  if (hot.c === miss.c && hot.r === miss.r) hot.r = miss.r ? 0 : 3; // nie deckungsgleich
  const inQ = (q, row, c) => row >= q.r && row < q.r + 3 && c >= q.c && c < q.c + 6;
  const holes = new Set();
  let accent = '';
  const nMarks = 5 + Math.floor(r() * 4); // Lücken und einzelne Akzentpunkte, nur im gewöhnlichen Raster
  for (let i = 0; i < nMarks; i++) {
    const c = Math.floor(r() * cols);
    const row = Math.floor(r() * rows);
    if (inQ(miss, row, c) || inQ(hot, row, c)) continue;
    if (i < 3) accent += `M${x0 + c * step} ${15 + row * 30}h8`; // ein Punkt in Akzentfarbe
    else holes.add(`${c},${row}`);
  }
  // Zeile `row`, Spalten a (einschließlich) bis b (ausschließlich) → Teilpfad
  const seg = (row, a, b) => (b > a ? `M${x0 + a * step} ${15 + row * 30}h${(b - a) * step - 18}` : '');
  let plain = '';
  for (let row = 0; row < rows; row++) {
    const hotHere = hot.r <= row && row < hot.r + 3;
    const missHere = miss.r <= row && row < miss.r + 3;
    if (hotHere) accent += seg(row, hot.c, hot.c + 6);
    // Das gewöhnliche Raster lässt beide Viertel aus (Vereinigung ihrer Spalten); wo sie
    // überlappen, gewinnt das Akzent-Viertel.
    const from = missHere && hotHere ? Math.min(miss.c, hot.c) : missHere ? miss.c : hot.c;
    const to = missHere && hotHere ? Math.max(miss.c, hot.c) + 6 : missHere ? miss.c + 6 : hot.c + 6;
    for (const [a, b] of missHere || hotHere ? [[0, from], [to, cols]] : [[0, cols]]) {
      let start = a; // Lücken teilen den Lauf
      for (let c = a; c <= b; c++) {
        if (c === b || holes.has(`${c},${row}`)) {
          plain += seg(row, start, c);
          start = c + 1;
        }
      }
    }
  }
  const common = 'stroke-width="8" stroke-dasharray="8 18" fill="none"';
  return `<path d="${plain}" stroke="${C.dim}" ${common}/><path d="${accent}" stroke="${C.warn}" ${common}/>`;
}

const MOTIVE = { boerse, firma, wirtschaft, geruecht };

/**
 * @param {string} category key aus newsCategory ('boerse' | 'firma' | 'wirtschaft' | 'geruecht')
 * @param {string|number} seed News-Id — gleicher Seed, gleiches Bild
 * @param {string} [ticker] Kürzel (nur für das Monogramm der Firma)
 * @param {number} [impact] Wirkung −3…3 (Firma-Akzent: grün, rot oder ohne)
 * @returns {string} SVG-Markup (Inline, ohne xmlns), unter 1 KB
 */
export function newsArt(category, seed, ticker, impact = 0) {
  const key = category && typeof category === 'string' ? category.toLowerCase() : '';
  const head = `<svg viewBox="0 0 ${W} ${H}"`;
  if (!Object.hasOwn(MOTIVE, key)) return `${head}>${tile()}</svg>`; // auch 'constructor' & Co.
  const r = rng(hash(`${key}|${seed}`));
  const inner = key === 'firma' ? firma(r, ticker, Number(impact) || 0) : MOTIVE[key](r);
  return `${head}>${inner}</svg>`;
}

