#!/usr/bin/env node
// mm-sim — Vorher-nachher-Messung des Market Makers (T6, PLAN.md V6). Läuft gegen jeden
// Server-Stand (alt oder neu) und benutzt nur Schnittstellen, die beide haben:
// engine.books, etf.nav, bots.start/stop/status, jobs.startJobs, getSettings/setSetting
// und die Tabellen price_history/trades (gleicher Stand in beiden Versionen).
//
//   node server/test/mm-sim.js [--server <verzeichnis>] [--seconds 90] [--seed 7] [--label x]
//                              [--activity 0..100] [--tick <Sekunden>] [--reasons]
//
// Ablauf: eigene DB (<server>/data/mmsim-<pid>.db) → Seed per seed.js → Math.random global
// durch mulberry32(seed) ersetzt → jobs.startJobs() → bots.start(true) mit bot_tick_sec (--tick,
// Standard 1), bot_activity (--activity, Standard 100), bot_fast 0 → alle 500 ms je Wert
// book.last und je ETF last/nav − 1 abtasten → Tabelle → eigene DB-Dateien löschen →
// process.exit(0), weil jobs.js keine Stopp-Funktion hat. Die echte DB (schoolstreet.db)
// wird nie geöffnet.
//
// --reasons: Die Bots verschlucken ihre Absagen still (bots.js zählt nur Fehler). Der Schalter
// umhüllt engine.placeOrder im Sim-Prozess und zählt die Ablehnungen der Bot-Konten nach
// Meldungsart — gleich, ob der Motor alt oder neu ist.
//
// Grenze der Wiederholbarkeit: Der Zufall aus JavaScript ist hier fest getaktet. Die Bots
// wählen ihre Aktien aber teilweise per SQLite „ORDER BY RANDOM()" aus (bots.js), und dieser
// Zufall kommt aus SQLite, nicht aus Math.random. Gleicher Seed heißt daher gleicher Ablauf
// bis auf diese Wahlen — Zahlen sind zwischen Läufen vergleichbar, nicht identisch.
const fs = require('node:fs');
const path = require('node:path');

// ---------- Argumente ----------
const opts = { server: path.join(__dirname, '..'), seconds: 90, seed: 7, label: 'ohne-label', activity: 100, tick: 1, reasons: false };
const USAGE = 'Aufruf: node server/test/mm-sim.js [--server <verzeichnis>] [--seconds 90] [--seed 7] [--label x] [--activity 0..100] [--tick <Sekunden>] [--reasons]';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i], val = argv[i + 1];
  const needsValue = ['--server', '--seconds', '--seed', '--label', '--activity', '--tick'].includes(key);
  if (key === '--server' && val) opts.server = path.resolve(val);
  else if (key === '--seconds' && val) opts.seconds = Number(val);
  else if (key === '--seed' && val) opts.seed = Number(val);
  else if (key === '--label' && val) opts.label = val;
  else if (key === '--activity' && val) opts.activity = Number(val);
  else if (key === '--tick' && val) opts.tick = Number(val);
  else if (key === '--reasons') opts.reasons = true;
  else { console.error(`mm-sim: unbekanntes oder fehlendes Argument bei „${key}“\n${USAGE}`); process.exit(2); }
  if (needsValue) i++;
}
const usageError = (text) => { console.error(`mm-sim: ${text}\n${USAGE}`); process.exit(2); };
if (!Number.isInteger(opts.seconds) || opts.seconds < 5) usageError('--seconds muss eine ganze Zahl ≥ 5 sein');
if (!Number.isInteger(opts.seed) || opts.seed < 0) usageError('--seed muss eine ganze Zahl ≥ 0 sein');
if (!Number.isInteger(opts.activity) || opts.activity < 0 || opts.activity > 100) usageError('--activity muss eine ganze Zahl von 0 bis 100 sein');
if (!Number.isInteger(opts.tick) || opts.tick < 1) usageError('--tick muss eine ganze Zahl ≥ 1 sein');

// ---------- Zufall: Math.random global ersetzt — vor dem Seed, damit auch er wiederholbar ist ----------
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(opts.seed);

// ---------- eigene Datenbank ----------
const SERVER = opts.server;
const DB_NAME = `mmsim-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;            // VOR dem ersten require von db.js
process.env.ADMIN_PASSWORD = 'ag123';     // nur für den Seed der eigenen DB
const DATA_DIR = path.join(SERVER, 'data');
const dataDirExisted = fs.existsSync(DATA_DIR);
const DBFILE = path.join(DATA_DIR, DB_NAME);
let db = null, getSettings = null, setSetting = null, bots = null, sampleTimer = null, progressTimer = null;

function cleanup() {
  if (bots && typeof bots.stop === 'function') { try { bots.stop(true); } catch (e) { /* läuft ohnehin nicht mehr */ } }
  if (sampleTimer) clearInterval(sampleTimer);
  if (progressTimer) clearInterval(progressTimer);
  if (db && db.open) { try { db.close(); } catch (e) { /* Dateien werden trotzdem gelöscht */ } }
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  // Ein Datenordner, den dieser Lauf selbst angelegt hat, wird wieder entfernt, wenn er leer ist.
  if (!dataDirExisted && fs.existsSync(DATA_DIR)) { try { fs.rmdirSync(DATA_DIR); } catch (e) { /* nicht leer */ } }
}
function finish(code) {
  cleanup();
  process.exit(code);
}
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));

// ---------- Kennzahlen ----------
const SAMPLE_MS = 500;
function stddev(xs) {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const maxOf = (xs) => (xs.length ? Math.max(...xs) : NaN);
const cr = (cent) => (Number.isFinite(cent) ? (cent / 100).toFixed(2) : '–');
const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}` : '–');
const pctAbs = (x) => (Number.isFinite(x) ? (x * 100).toFixed(2) : '–');
const table = (head, widths, rows) => [
  head.map((h, i) => (i === 0 ? h.padEnd(widths[i]) : h.padStart(widths[i]))).join('  '),
  ...rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  '))
].join('\n');

async function main() {
  if (!fs.existsSync(path.join(SERVER, 'seed.js'))) throw new Error(`kein Server in ${SERVER} (seed.js fehlt)`);
  // Seed im selben Prozess: seed.js nutzt damit dieselbe Zufallsquelle wie die Messung.
  {
    const log = console.log;
    console.log = () => {};               // Seed-Ausgaben unterdrücken; Fehler (console.error) bleiben sichtbar
    try { require(path.join(SERVER, 'seed.js')); } finally { console.log = log; }
  }
  ({ db, getSettings, setSetting } = require(path.join(SERVER, 'db')));
  if (path.basename(String(db.name)) !== DB_NAME) throw new Error(`offen ist "${db.name}", erwartet wurde die eigene ${DB_NAME}`);
  const engine = require(path.join(SERVER, 'engine'));
  const etf = require(path.join(SERVER, 'etf'));
  const jobs = require(path.join(SERVER, 'jobs'));
  bots = require(path.join(SERVER, 'bots'));

  for (const [key, value] of [['bot_tick_sec', opts.tick], ['bot_activity', opts.activity], ['bot_fast', 0]]) setSetting(key, value);

  // --reasons: Ablehnungen der Bot-Konten nach Meldungsart zählen (Text bis zum ersten Doppelpunkt).
  const rejectReasons = new Map();
  if (opts.reasons) {
    const placeOrder = engine.placeOrder;
    engine.placeOrder = function (user, order, o) {
      try { return placeOrder.call(engine, user, order, o); }
      catch (e) {
        if (user && user.is_bot) {
          const kind = String(e && e.message ? e.message : e).split(':')[0].trim() || '(ohne Meldung)';
          rejectReasons.set(kind, (rejectReasons.get(kind) || 0) + 1);
        }
        throw e;
      }
    };
  }

  // Abtastung je Wert: Kurs; bei ETFs zusätzlich last/nav − 1 und der Abstand in Cent.
  const series = new Map();                // secId → { ticker, type, prices[], prem[], gaps[] }
  let lastSampleAt = null;
  function sample() {
    lastSampleAt = Date.now();
    for (const [id, book] of engine.books) {
      if (!book.last) continue;
      let s = series.get(id);
      if (!s) { s = { ticker: book.sec.ticker, type: book.sec.type, prices: [], prem: [], gaps: [] }; series.set(id, s); }
      s.prices.push(book.last);
      if (s.type === 'etf') {
        const nav = etf.nav(id).nav_per_share;
        if (nav > 0) { s.prem.push(book.last / nav - 1); s.gaps.push(book.last - nav); }
      }
    }
  }

  jobs.startJobs();
  bots.start(true);
  const t0 = Date.now();
  // Nur Kurspunkte ab hier zählen; Punkte mit Menge > 0 stammen aus Orders mit Fills (der Sampler schreibt Menge 0).
  const phRow0 = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM price_history').get().m;
  sample();
  sampleTimer = setInterval(sample, SAMPLE_MS);
  progressTimer = setInterval(() => {
    const n = db.prepare('SELECT COUNT(*) AS c FROM trades WHERE created_at >= ?').get(t0).c;
    console.log(`  [${opts.label}] ${Math.round((Date.now() - t0) / 1000)} s, ${n} Trades`);
  }, 15000);

  await new Promise((resolve) => setTimeout(resolve, opts.seconds * 1000));
  clearInterval(sampleTimer); sampleTimer = null;
  clearInterval(progressTimer); progressTimer = null;
  const elapsedMs = lastSampleAt - t0;

  // ---------- Auswertung ----------
  const points = new Map();                // secId → Kurse der Punkte mit Menge seit Messbeginn
  for (const row of db.prepare('SELECT security_id, price, amount FROM price_history WHERE rowid > ? ORDER BY rowid').all(phRow0)) {
    if (!(row.amount > 0)) continue;
    if (!points.has(row.security_id)) points.set(row.security_id, []);
    points.get(row.security_id).push(row.price);
  }
  const stocks = [], etfs = [];
  for (const [id, s] of series) {
    const start = s.prices[0], end = s.prices[s.prices.length - 1];
    const base = { ticker: s.ticker, start, end, chg: end / start - 1, n: s.prices.length };
    if (s.type === 'etf') { etfs.push({ ...base, maxPrem: maxOf(s.prem.map(Math.abs)), offNav: s.gaps.filter((g) => Math.abs(g) > 10).length, samples: s.prem.length }); continue; }
    if (s.type !== 'stock') continue;
    // Volatilität: Standardabweichung der ln-Renditen zwischen zwei Abtastungen, per Wurzel-T-Skalierung auf Minute und Stunde.
    const rets = [];
    for (let i = 1; i < s.prices.length; i++) rets.push(Math.log(s.prices[i] / s.prices[i - 1]));
    const sd = stddev(rets);
    const dtMs = elapsedMs / Math.max(1, s.prices.length - 1);
    // Schritte: vom Startkurs über die Kurspunkte mit Menge; der erste Schritt gehört zum ersten Trade.
    const seq = [start, ...(points.get(id) || [])];
    const steps = [];
    for (let i = 1; i < seq.length; i++) steps.push(seq[i] / seq[i - 1] - 1);
    stocks.push({
      ...base,
      volMin: sd * Math.sqrt(60000 / dtMs), volH: sd * Math.sqrt(3600000 / dtMs),
      maxStep: maxOf(steps.map(Math.abs)), big: steps.filter((x) => Math.abs(x) > 0.03).length, steps: steps.length
    });
  }
  const trades = db.prepare('SELECT COUNT(*) AS c FROM trades WHERE created_at >= ?').get(t0).c;
  const st = bots && typeof bots.status === 'function' ? bots.status() : null;

  console.log(`mm-sim — Label „${opts.label}“, Server ${path.relative(process.cwd(), SERVER) || '.'}, Dauer ${opts.seconds} s, Seed ${opts.seed}, bot_activity ${opts.activity}, bot_tick_sec ${opts.tick} s, ${new Date(t0).toLocaleString('de-DE')}`);
  console.log(`Bots: ${st ? `${st.orders_this_run} Orders, ${st.trades_this_run} Fills, ${st.errors} Fehler` : 'keine Statistik'} · Trades im Messfenster: ${trades} · ${stocks.length} Aktien, ${etfs.length} ETF(s)`);
  console.log('');
  console.log(table(
    ['Ticker', 'Start', 'Ende', 'Änderung %', 'Vol/min %', 'Vol/h %', 'max. Schritt %', 'Schritte > 3 %'],
    [8, 9, 9, 12, 10, 9, 14, 18],
    stocks.map((r) => [r.ticker, cr(r.start), cr(r.end), pct(r.chg), pctAbs(r.volMin), pctAbs(r.volH), pctAbs(r.maxStep),
      r.steps ? `${(100 * r.big / r.steps).toFixed(1)} % (${r.big}/${r.steps})` : '– (0)'])
  ));
  console.log('');
  console.log('ETFs — Aufgeld = last / nav_per_share − 1 je Abtastung; „> 1 Tick“ zählt Abtastungen mit |last − NAV| > 10 Cent.');
  console.log(table(
    ['Ticker', 'Start', 'Ende', 'Änderung %', 'max. |Aufgeld| %', 'Abtastungen', '> 1 Tick'],
    [8, 9, 9, 12, 17, 12, 9],
    etfs.map((r) => [r.ticker, cr(r.start), cr(r.end), pct(r.chg), pctAbs(r.maxPrem), String(r.samples), String(r.offNav)])
  ));
  if (opts.reasons) {
    const total = [...rejectReasons.values()].reduce((a, b) => a + b, 0);
    console.log('');
    console.log(`Absagen von engine.placeOrder an Bot-Konten, nach Meldungsart (gesamt ${total}${st ? `, bots.status().errors ${st.errors}` : ''}):`);
    for (const [kind, n] of [...rejectReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${(100 * n / Math.max(1, total)).toFixed(1).padStart(5)} %  ${kind}`);
  }
  const big = stocks.reduce((a, r) => a + r.big, 0), steps = stocks.reduce((a, r) => a + r.steps, 0);
  console.log('');
  console.log(`mm-sim ${opts.label}: Aktien ${stocks.length} · Vol/h (Median) ${pctAbs(median(stocks.map((r) => r.volH)))} % · größter Schritt ${pctAbs(maxOf(stocks.map((r) => r.maxStep)))} % · Schritte > 3 % ${steps ? (100 * big / steps).toFixed(1) : '–'} % (${big}/${steps}) · ETF max. |Aufgeld| ${pctAbs(maxOf(etfs.map((r) => r.maxPrem)))} %`);
}

main().then(() => finish(0), (e) => {
  console.error(`mm-sim: abgebrochen — ${e && e.stack ? e.stack : e}`);
  finish(1);
});
