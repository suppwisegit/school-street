// ============================================================================
// School-Street Server: ein Prozess für alles (HTTP + WebSocket + statisches
// React-Frontend). Läuft im WLAN auf dem Server-PC:  npm start
//   http://serverip:port/        Spieler-Interface
//   http://serverip:port/admin   Investment-AG (Aufsicht)
//   http://serverip:port/board   Board/TV-Ansicht (Index, Tops/Flops)
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { db, getSettings, setSetting } = require('./db');
const auth = require('./auth');
const engine = require('./engine');
const jobs = require('./jobs');
const bus = require('./bus');
const routes = require('./routes');
const { createHub } = require('./push');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DB_NAME = process.env.DB_NAME || 'schoolstreet.db';
// Frontend-Build. PUBLIC_DIR ist nur für Tests gedacht (eigener Build-Ordner).
const PUB = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.join(__dirname, 'public');
const ASSETS = path.join(PUB, 'assets');

// ---------- Bootstrap: Admin + Treasury ----------
function bootstrap() {
  let admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex').toUpperCase();
    admin = auth.createUser(process.env.ADMIN_USER || 'admin', pw, 'admin');
    console.log('==========================================================');
    console.log('  Investment-AG Admin-Zugang (BITTE NOTIEREN/ÄNDERN):');
    console.log(`  Username: ${admin.username}   Passwort: ${pw}`);
    console.log(`  Login unter:  http://<serverip>:${PORT}/admin`);
    console.log('==========================================================');
  }
  if (!db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1").get()) {
    auth.createUser('AG-Treasury', crypto.randomBytes(16).toString('hex'), 'bank', getSettings().treasury_capital);
  }
}

// ---------- Statisches Frontend: gzip einmal, Puffer cachen (E009) ----------
// /assets/* sind gehasste Build-Dateien: ein Jahr unveränderlich. Alles andere
// (index.html, Favicon) muss neu validieren, damit ein neuer Build sofort greift.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MIN_GZIP = 1024; // kleinere Dateien: gzip bringt nichts
const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.xml': 'application/xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon'
};
// Nur Textformate: Schriften und Bilder sind schon komprimiert.
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.map', '.webmanifest', '.svg', '.txt', '.xml']);
const assetCache = new Map(); // Datei -> Promise<Eintrag>; {mtimeMs, size, raw, gz, type, etag, etagGz}

const etagOf = (buf) => '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24) + '"';

function readAsset(file) {
  return fs.promises.open(file, 'r').then(async (fh) => {
    try {
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const raw = await fh.readFile();
      const ext = path.extname(file).toLowerCase();
      const entry = { mtimeMs: st.mtimeMs, size: st.size, raw, gz: null, etag: etagOf(raw), etagGz: null, type: TYPES[ext] || 'application/octet-stream' };
      if (!COMPRESSIBLE.has(ext) || raw.length < MIN_GZIP) return entry;
      return new Promise((resolve) => {
        zlib.gzip(raw, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, gz) => {
          if (!err && gz && gz.length < raw.length) { entry.gz = gz; entry.etagGz = etagOf(gz); }
          resolve(entry); // gzip scheitert oder lohnt nicht: unkomprimiert ausliefern
        });
      });
    } finally { await fh.close(); }
  });
}

// Eintrag laden; parallele Anfragen warten auf dieselbe Kompression.
async function loadAsset(file) {
  const st = await fs.promises.stat(file);            // wirft ENOENT -> 404
  if (!st.isFile()) return null;
  const known = assetCache.get(file);
  if (known) {
    const entry = await known.then((e) => e, () => null);
    if (entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size) return entry;
    if (assetCache.get(file) === known) assetCache.delete(file); // neuer Build unter gleichem Namen
  }
  let p = assetCache.get(file);
  if (!p) {
    p = readAsset(file);
    assetCache.set(file, p);
    p.catch(() => { if (assetCache.get(file) === p) assetCache.delete(file); });
  }
  return p;
}

function acceptsGzip(req) {
  for (const part of String(req.headers['accept-encoding'] || '').toLowerCase().split(',')) {
    const [name, param] = part.trim().split(';');
    if ((name === 'gzip' || name === '*') && (param === undefined || parseFloat(param.replace(/^q=/, '') || '1') > 0)) return true;
  }
  return false;
}

async function serveAsset(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return; // Express meldet 404
  let rel;
  try { rel = decodeURIComponent(req.path.slice('/assets'.length)); } catch { return res.status(400).end(); }
  const file = path.resolve(ASSETS, '.' + rel);
  if (rel.includes('\0') || !file.startsWith(ASSETS + path.sep)) return res.status(404).end();
  let entry;
  try { entry = await loadAsset(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EACCES') return res.status(404).end();
    throw e;
  }
  if (!entry) return res.status(404).end();
  if (req.headers.range) return res.sendFile(file, { immutable: true, maxAge: '1y' }); // Bereiche unkomprimiert
  const gz = entry.gz && acceptsGzip(req) ? entry.gz : null;
  const body = gz || entry.raw;
  const etag = gz ? entry.etagGz : entry.etag;
  res.setHeader('Cache-Control', IMMUTABLE);
  res.setHeader('Content-Type', entry.type);
  res.setHeader('ETag', etag);
  if (entry.gz) res.setHeader('Vary', 'Accept-Encoding');
  if (gz) res.setHeader('Content-Encoding', 'gzip');
  if (String(req.headers['if-none-match'] || '').split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return res.status(304).end();
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use('/api', routes);

// Fehler aus der API immer als JSON {error} (V1): kaputtes JSON 400, zu groß
// 413, alles andere 500 mit Log. Außerhalb von /api gilt der Express-Standard.
function apiError(err, req, res, next) {
  if (!req.path.startsWith('/api')) return next(err);
  if (res.headersSent) return next(err);
  err = err || {};
  const status = err.type === 'entity.parse.failed' ? 400 : Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error('[API] Unbehandelter Fehler:', err);
  const error = status === 400 && err.type === 'entity.parse.failed' ? 'Anfrage enthält kein gültiges JSON'
    : err.type === 'entity.too.large' || status === 413 ? 'Anfrage zu groß'
      : status >= 500 ? 'Interner Serverfehler'
        : (err.expose && err.message) || 'Fehlerhafte Anfrage';
  res.status(status).json({ error });
}

app.use((req, res, next) => (req.path.startsWith('/assets/') ? serveAsset(req, res).catch(next) : next()));
app.use(express.static(PUB, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUB, 'index.html'), (err) => {
    if (err && !res.headersSent) res.status(503).type('html').send('Frontend noch nicht gebaut: erst <b>npm run build</b> ausführen. Die API läuft unter /api.');
  });
});
app.use(apiError);

// Die Börse ist pausiert, wenn die Einstellung trading_paused gesetzt ist.
// Fehlt sie noch, gilt: nicht pausiert.
function isPaused() {
  const s = getSettings();
  return !!(s && Number(s.trading_paused) === 1);
}

// ---------- Start ----------
function main() {
  bootstrap();
  engine.loadEngine();
  if (getSettings().idx_base_mcap === 0) {
    const stocks = db.prepare("SELECT * FROM securities WHERE type='stock' AND status='active'").all();
    let mcap = 0;
    for (const s of stocks) { const b = engine.books.get(s.id); if (b) mcap += b.last * s.total_shares; }
    if (mcap > 0) setSetting('idx_base_mcap', mcap);
  }
  try { jobs.startJobs(); } catch (e) { console.error('[Start] Hintergrund-Jobs nicht gestartet:', e); }

  // Testspiel-Modus (virtuelle Trader) fortsetzen, falls er beim Herunterfahren lief
  const bots = require('./bots');
  if (getSettings().bot_running) {
    try { bots.start(true); } catch (e) { console.error('[Start] Testspiel-Modus nicht fortgesetzt:', e); }
  }

  const server = http.createServer(app);
  server.on('error', (e) => { console.error('[Start] Server-Fehler:', e); process.exit(1); });

  // ---------- WebSocket: Live-Kurse, Orderbücher, News ----------
  const hub = createHub({
    server,
    identify: (token) => auth.userForToken(token),
    tickerAll: () => engine.tickerAll(),
    game: () => ({ paused: isPaused() })
  });
  bus.on(hub.broadcast);

  // Ein zweites Signal beendet sofort, ein einzelnes fährt sauber herunter.
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return process.exit(1);
    stopping = true;
    console.log(`\n[Shutdown] ${signal}: Verbindungen schließen, Datenbank schließen.`);
    try { hub.close(); } catch (e) { console.error('[Shutdown] WebSocket:', e.message); }
    server.close(() => process.exit(0));
    server.closeAllConnections();
    try { db.close(); } catch (e) { console.error('[Shutdown] Datenbank konnte nicht geschlossen werden:', e.message); }
    setTimeout(() => process.exit(0), 1000); // Rest-Sicherheit
  }

  server.listen(PORT, HOST, () => {
    // Ab jetzt darf kein Fehler die Börse stoppen (F13): protokollieren, weiterlaufen.
    process.on('uncaughtException', (err, origin) => console.error(`[Prozess] Unbehandelter Fehler (${origin}):`, err));
    process.on('unhandledRejection', (reason) => console.error('[Prozess] Unbehandelte Ablehnung:', reason));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║   🏦  SCHOOL-STREET — Börsensimulation läuft!     ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log(`  ║  Spieler :  http://<serverip>:${PORT}/`.padEnd(52) + '║');
    console.log(`  ║  AG/Admin:  http://<serverip>:${PORT}/admin`.padEnd(52) + '║');
    console.log(`  ║  Board/TV:  http://<serverip>:${PORT}/board`.padEnd(52) + '║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log(`  Lokal: http://localhost:${PORT}   (DB: server/data/${DB_NAME})`);
    if (!fs.existsSync(path.join(PUB, 'index.html')))
      console.log('  ⚠️  Frontend fehlt — bitte einmal `npm run build` ausführen.');
  });
}

try { main(); } catch (e) { console.error('[Start] Server konnte nicht starten:', e); process.exit(1); }
