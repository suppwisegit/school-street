#!/usr/bin/env node
// ============================================================================
// LASTTEST für das School-Street-Backend: wie kommt der Server mit vielen
// gleichzeitigen Nutzern klar? Reproduzierbar (fester Zufalls-Samen für den
// Lastgenerator) und ehrlich (alles wird gemessen, nichts geschätzt).
//
//   node server/loadtest.js [--clients 300] [--seconds 20] [--bots 100]
//                           [--label baseline] [--port 3199] [--seed 1]
//                           [--root <Verzeichnis>]   (alternativ: SS_ROOT)
//
// --root bzw. SS_ROOT: Projektverzeichnis, dessen server/index.js getestet
// wird (Voreinstellung: das Verzeichnis, in dem loadtest.js liegt). So lässt
// sich ein sauberer Auscheck testen, ohne diesen Lasttest hinein zu kopieren.
// Fehlt dort node_modules, bekommt der Server das node_modules von loadtest.js
// über NODE_PATH. Der Bericht landet immer neben loadtest.js.
//
// Ablauf
//   1. Vorprüfungen: Port frei? Wählt server/db.js die DB über DB_NAME?
//      Sonst startet nichts.
//   2. Server als eigener Kindprozess, DB in einem Temp-Verzeichnis unter
//      os.tmpdir(). server/data/ wird nicht geöffnet; Größe, Änderungszeit und
//      Inode der echten DB-Dateien werden vor und nach dem Lauf verglichen
//      (nur stat).
//   3. Admin-Login, Bots über die Admin-API starten (gleiche Bot-Last wie im
//      Spiel). Die Zahl der Bots stellt der Server selbst ein (bot_count,
//      Standard 100); --bots wird nicht gesetzt, eine Abweichung steht im
//      Bericht. Kein seed.js: auf einer frischen DB entstehen die Wertpapiere
//      allein durch die Bot-Firmen.
//   4. --clients Testnutzer per /auth/register anlegen; jeder kauft vorab
//      wenige Stücke, damit Verkäufe möglich sind (stellt Schüler mit Depot dar).
//   5. Aufbau: Verbindungen und erste Seitenaufrufe, gleichmäßig verteilt
//      (zählt nicht ins Messfenster).
//   6. Messfenster: --seconds lang typisches Client-Verhalten aller Verbindungen.
//   7. Aufräumen: Sockets zu, Kindprozess beenden, Temp-DB löschen, Port
//      kontrollieren. Auch bei Fehler, Signal oder Abbruch des Lasttests.
//
// Ausgabe: Markdown-Bericht auf stdout, identisch in
//          .agent-team/berichte/loadtest-<label>.md (wird überschrieben).
//          Fortschritt und Diagnose stehen auf stderr.
//          Bei fehlgeschlagenem Lauf wird keine Datei geschrieben.
// Exit:    0 ok · 1 Lauf fehlgeschlagen oder nicht aufgeräumt · 2 Aufruf falsch
//          3 Dateien in server/data/ haben sich während des Laufs verändert.
// ============================================================================

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');          // hier liegt loadtest.js: Bericht und node_modules
const REPORT_DIR = path.join(ROOT, '.agent-team', 'berichte');
const USAGE = 'Aufruf: node server/loadtest.js [--clients 300] [--seconds 20] [--bots 100] [--label baseline] [--port 3199] [--seed 1] [--root <Verzeichnis>]';
let SRV_DIR = __dirname;                             // getesteter Server: <root>/server (Schalter --root bzw. SS_ROOT)
let DATA_DIR = path.join(SRV_DIR, 'data');           // sein data-Verzeichnis (die DB dort wird nie geöffnet)
let WATCH_DIRS = [DATA_DIR];                         // data-Verzeichnisse, deren DB-Dateien vor/nach verglichen werden
const TICK = { stock: 100, etf: 10 };     // client/src/api.js: tickOf()
const USER_PW = 'lasttest-passwort';      // nur für die Wegwerf-Konten in der Temp-DB
const REQUEST_TIMEOUT_MS = 30000;
const SOCKET_IDLE_MS = 2500;              // unter dem KeepAliveTimeout des Servers (Node: 5 s), siehe RetiringAgent
const NOT_SERVER_CODE = ['loadtest.js', 'seed.js', 'smoke.js'];

// Verhalten der virtuellen Nutzer. Werte mit Dateiangabe stammen aus dem
// echten Client; "ANNAHME" = geschätzt und im Bericht so gekennzeichnet.
const MODELL = {
  settleMs: 2000,                 // ANNAHME: Ruhe nach dem Aufbau, bevor das Fenster beginnt
  boardsPerStudents: 100,         // ANNAHME: ein Beamer je 100 Schüler
  tabs: [['market', 30], ['depot', 15], ['news', 10], ['profile', 10], ['detail', 35]], // ANNAHME: Anteil der offenen Tabs
  dwellMeanMs: 20000,             // ANNAHME: mittlere Verweildauer auf einem Tab (exponentialverteilt)
  candlesDetailMs: 15000,         // client/src/pages/SecurityDetail.jsx: setInterval(fetchC, 15000)
  boardPollMs: 10000,             // client/src/pages/Board.jsx: setInterval(load, 10000)
  sparksMs: 60000,                // neuer Client: GET /api/sparks alle 60 s — nur wenn der Server ihn anbietet
  previewDebounceMs: 250,         // SecurityDetail.jsx: Vorschau erst 250 ms nach der letzten Änderung
  panelOpenProb: 0.5,             // ANNAHME: Detail-Besuch mit eingegebener Stückzahl (dann läuft die Vorschau bei jedem Orderbuch-Update)
  tradeMeanMs: 120000,            // ANNAHME: ein Schüler sendet im Mittel alle 2 Minuten eine Order
  thinkMeanMs: 1500,              // ANNAHME: von der Vorschau bis zum Absenden
  limitShare: 0.2,                // ANNAHME: 20 % Limit, 80 % Market (Bots handeln zu 15 % Limit)
  maxAmount: 3,                   // ANNAHME: 1-3 Stück je Order
  cancelProb: 0.5,                // ANNAHME: die Hälfte der liegenden Limit-Orders wird storniert
  cancelMeanMs: 3000,             // ANNAHME: ... nach im Mittel 3 s
  prebuyShares: 3                 // Vorbereitung: Stücke, die jeder Testnutzer vor dem Fenster kauft
};

// ---------- Zufall (mulberry32): ein eigener Strom je Nutzer, damit die Last
// nicht von der Reihenfolge der Ereignisse abhängt ----------
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const expDist = (rnd, mean) => -Math.log(1 - rnd()) * mean;

// ---------- Aufruf ----------
function parseArgs(argv) {
  const o = { clients: 300, seconds: 20, bots: 100, label: 'baseline', port: 3199, seed: 1, root: path.resolve(process.env.SS_ROOT || ROOT), rootSet: !!process.env.SS_ROOT };
  const int = (name, v, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name}: ganze Zahl ${min}..${max} erwartet (erhalten: ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unbekanntes Argument: ${argv[i]}`);
    let v = m[2];
    if (v === undefined) { v = argv[++i]; if (v === undefined) throw new Error(`--${m[1]} erwartet einen Wert`); }
    if (m[1] === 'clients') o.clients = int('clients', v, 1, 10000);
    else if (m[1] === 'seconds') o.seconds = int('seconds', v, 1, 3600);
    else if (m[1] === 'bots') o.bots = int('bots', v, 0, 10000);
    else if (m[1] === 'port') o.port = int('port', v, 1024, 65535);
    else if (m[1] === 'seed') o.seed = int('seed', v, 0, 2147483647);
    else if (m[1] === 'root') { o.root = path.resolve(v); o.rootSet = true; }
    else if (m[1] === 'label') {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(v)) throw new Error('--label: 1-40 Zeichen aus A-Z a-z 0-9 _ -');
      o.label = v;
    } else throw new Error(`Unbekanntes Argument: --${m[1]}`);
  }
  return o;
}

// ---------- Zustand des Laufs ----------
let PORT = 0;
let child = null;                 // der einzige Prozess, den dieser Test beendet
let serverExit = null;
let tearingDown = false;
let tmpDir = null;                // Temp-Verzeichnis mit der DB
let adminPw = null;
let adminToken = null;
let secIds = [];                  // handelbare Wertpapiere: { id, type }
let users = [];                   // virtuelle Schüler (je eine Verbindung mit Token)
let boards = [];                  // virtuelle Beamer (anonyme Verbindungen)
let world = null;                 // was der Server über seine Welt meldet
let PHASE = 'setup';              // 'setup' | 'ramp' | 'window' | 'after' — zählt Anfragen in die jeweilige Statistik
let active = false;               // virtuelle Nutzer reagieren auf Timer und WS
let windowOn = false;             // Tab-Wechsel und Orders sind freigeschaltet (erst ab Fensterbeginn)
let aborted = null;               // Grund eines Abbruchs (Signal, Server-Ende) oder null
let abortDetail = '';             // Stapelverfolgung dazu, falls vorhanden
let realDbBefore = null;
let inFlight = 0;
let staleRetries = 0;
let sweeper = null;
const pending = new Set();        // laufende REST-Anfragen (für das Ende des Fensters)
const serverOut = [];             // letzte Zeilen der Server-Ausgabe (Diagnose)
const serverErr = [];
const closeNotes = [];            // WS-Verbindungsabbrüche mit Code
const timing = {};                // Dauern der Aufbauschritte
const procSamples = [];           // VmRSS im Fenster (alle 0,5 s)
const abortWaiters = new Set();
const res = {};                   // Messergebnisse für den Bericht

const stats = { setup: newStats(), ramp: newStats(), window: newStats() };
function newStats() {
  return { rest: new Map(), wsMsgs: 0, wsBytes: 0, wsByType: new Map(), wsClosed: 0, boardMsgs: 0, boardBytes: 0 };
}

const log = (...a) => console.error('[loadtest]', ...a);
function sleep(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); abortWaiters.delete(done); resolve(); };
    const t = setTimeout(done, Math.max(0, ms));
    if (ms >= 50) abortWaiters.add(done);
  });
}
const sleepUntil = (t) => sleep(t - performance.now());
function abort(reason, detail) {
  if (aborted) return;
  aborted = reason;
  abortDetail = detail || '';
  active = false;
  for (const w of [...abortWaiters]) w();
  abortWaiters.clear();
}
function checkAbort() { if (aborted) throw new Error(`Abgebrochen: ${aborted}${abortDetail}`); }

// ---------- HTTP: Keep-Alive-Agent, der unbenutzte Sockets vor dem Server schließt ----------
// Node schließt Keep-Alive-Sockets nach 5 s. Trifft eine Anfrage genau diesen
// Moment, scheitert sie mit ECONNRESET, obwohl der Server nichts falsch macht
// (Browser wiederholen das still). Sockets, die 2,5 s unbenutzt sind, werden
// deshalb selbst entfernt; als zweite Sicherung wird GET einmal wiederholt.
class RetiringAgent extends http.Agent {
  keepSocketAlive(socket) {
    socket.idleSince = performance.now();
    return super.keepSocketAlive(socket);
  }
}
const agent = new RetiringAgent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 1024, noDelay: true });
function sweepIdleSockets() {
  const cutoff = performance.now() - SOCKET_IDLE_MS;
  for (const list of Object.values(agent.freeSockets)) for (const s of list) if (s.idleSince < cutoff) s.destroy();
}

function template(pth) {
  return pth.replace(/\?.*$/, '')
    .replace(/^(\/securities\/)\d+/, '$1:id')
    .replace(/^(\/orders\/)\d+/, '$1:id')
    .replace(/^(\/admin\/[^/]+\/)\d+/, '$1:id');
}
function record(phase, method, pth, ms, status, bytes, json) {
  const s = stats[phase];
  if (!s) return;
  const key = `${method} /api${template(pth)}`;
  const row = s.rest.get(key) || { n: 0, ms: [], bytes: 0, fail: 0, bad: 0, badMsgs: new Map() };
  s.rest.set(key, row);
  row.n++; row.ms.push(ms); row.bytes += bytes;
  if (status === 0 || status >= 500) row.fail++;                 // keine Antwort oder Serverfehler
  else if (status >= 400) {                                      // vom Server abgelehnt (Anwendungslogik)
    row.bad++;
    const k = String((json && json.error) || `HTTP ${status}`).slice(0, 90);
    row.badMsgs.set(k, (row.badMsgs.get(k) || 0) + 1);
  }
}

// Liefert immer { status, json, bytes, ms, error }; status 0 = keine Antwort.
function request(method, pth, { token, body, record: doRecord = true } = {}) {
  return new Promise((resolve) => {
    const state = { settled: false };
    pending.add(state);
    send(method, pth, token, body, performance.now(), state, doRecord, resolve);
  });
}
function send(method, pth, token, body, t0, state, doRecord, resolve) {
  inFlight++;
  const phase = PHASE;
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;                 // client/src/api.js
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  const finish = (status, json, bytes, error) => {
    if (state.settled) return;
    state.settled = true; inFlight--; pending.delete(state);
    const ms = performance.now() - t0;
    if (doRecord) record(phase, method, pth, ms, status, bytes, json);
    resolve({ status, json, bytes, ms, error });
  };
  state.fail = () => finish(0, null, 0, 'keine Antwort 15 s nach Fensterende');
  const req = http.request({ host: '127.0.0.1', port: PORT, method, path: `/api${pth}`, headers, agent }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('error', (e) => finish(0, null, 0, e.code || e.message));
    r.on('end', () => {
      const buf = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* keine JSON-Antwort */ }
      finish(r.statusCode, json, buf.length, null);
    });
  });
  req.on('error', (e) => {
    const code = e.code || e.message;
    if (method === 'GET' && req.reusedSocket && (code === 'ECONNRESET' || code === 'EPIPE')) {
      staleRetries++; inFlight--;
      send(method, pth, token, body, t0, state, doRecord, resolve);
      return;
    }
    finish(0, null, 0, code);
  });
  req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  req.end(data);
}
const get = (c, pth) => request('GET', pth, { token: c.token });
const post = (c, pth, body) => request('POST', pth, { token: c.token, body });
const del = (c, pth) => request('DELETE', pth, { token: c.token });
const admin = (method, pth, body) => request(method, pth, { token: adminToken, body });
const failPending = () => { for (const s of [...pending]) if (s.fail) s.fail(); };

// ---------- /proc: CPU-Zeit und Speicher des Serverprozesses, von außen gelesen ----------
const CLK_TCK = (() => { try { return Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100; } catch { return 100; } })();
function readProc(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // ab hier beginnt Feld 3 (state): f[11] = utime, f[12] = stime
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const num = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(status); return m ? Number(m[1]) : NaN; };
    return { user: Number(f[11]) / CLK_TCK, sys: Number(f[12]) / CLK_TCK, rssKb: num('VmRSS'), hwmKb: num('VmHWM'), threads: num('Threads') };
  } catch { return null; }   // kein Linux oder Prozess beendet
}

// ---------- Schutz von server/data/ ----------
// Nur Metadaten (stat): die DB-Dateien werden nie geöffnet.
function snapshotRealDb() {
  const out = [];
  for (const dir of WATCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.startsWith('schoolstreet.db')) continue;
      const st = fs.statSync(path.join(dir, name));
      out.push(`${dir}/${name} ${st.size} ${Math.round(st.mtimeMs)} ${st.ino}`);
    }
  }
  return out;
}
// server/db.js: path.join(__dirname, 'data', process.env.DB_NAME || 'schoolstreet.db').
// Ein relativer Pfad mit ".." zeigt aus server/data/ heraus in das Temp-Verzeichnis.
function dbNameFor(dbFile) {
  const src = fs.readFileSync(path.join(SRV_DIR, 'db.js'), 'utf8');
  if (!/process\.env\.DB_NAME/.test(src)) {
    throw new Error(`${path.join(SRV_DIR, 'db.js')} wählt die Datenbank nicht mehr über DB_NAME. Der Lasttest startet nicht, damit keine echte DB berührt wird — dbNameFor() in server/loadtest.js an den neuen Mechanismus anpassen.`);
  }
  const rel = path.relative(DATA_DIR, dbFile);
  const resolved = path.join(DATA_DIR, rel);
  if (resolved !== dbFile || resolved.startsWith(DATA_DIR + path.sep)) throw new Error(`DB-Pfad lässt sich nicht aus server/data/ herausführen: ${resolved}`);
  return rel;
}
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(new Error(`Port ${port} ist belegt (${e.code}). Es wird kein Prozess beendet — anderen Port mit --port wählen.`)));
    s.listen(port, '0.0.0.0', () => s.close(resolve));
  });
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.setTimeout(1000, () => end(false));
  });
}

// ---------- Server starten ----------
async function startServer(opts) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolstreet-loadtest-'));
  const dbName = dbNameFor(path.join(tmpDir, 'loadtest.db'));
  adminPw = crypto.randomBytes(12).toString('hex');
  // Drei Zeilen Vorlauf im Serverprozess (server/index.js bleibt unverändert):
  // Endet der Lasttest, beendet sich der Server selbst (kein Waisenprozess) und
  // nimmt seine Temp-DB mit.
  const wrap = [
    "process.on('disconnect', () => process.exit(0));",
    `process.on('exit', () => { try { require('fs').rmSync(${JSON.stringify(tmpDir)}, { recursive: true, force: true }); } catch (e) {} });`,
    `require(${JSON.stringify(path.join(SRV_DIR, 'index.js'))});`
  ].join('\n');
  const t0 = performance.now();
  const env = { ...process.env, PORT: String(PORT), DB_NAME: dbName, ADMIN_PASSWORD: adminPw };
  // Hat der getestete Baum kein node_modules, verwendet der Server das von loadtest.js.
  if (!fs.existsSync(path.join(opts.root, 'node_modules')) && !fs.existsSync(path.join(SRV_DIR, 'node_modules'))) {
    env.NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  child = spawn(process.execPath, ['-e', wrap], { cwd: opts.root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const keep = (buf) => (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      buf.push(line.slice(0, 300));
      if (buf.length > 40) buf.shift();
    }
  };
  child.stdout.on('data', keep(serverOut));
  child.stderr.on('data', keep(serverErr));
  child.on('error', (e) => abort(`Serverprozess nicht startbar: ${e.message}`));
  child.on('exit', (code, sig) => {
    serverExit = { code, sig };
    if (!tearingDown) abort(`Serverprozess wurde beendet (Code ${code}, Signal ${sig})`);
  });
  const deadline = performance.now() + 30000;
  for (;;) {
    checkAbort();
    if (serverExit) throw new Error(`Server startet nicht:\n${serverErr.join('\n')}`);
    const r = await request('GET', '/securities', { record: false });
    if (r.status === 200) break;
    if (performance.now() > deadline) throw new Error('Server antwortet nach 30 s nicht auf /api/securities');
    await sleep(150);
  }
  if (!fs.existsSync(path.join(tmpDir, 'loadtest.db'))) {
    throw new Error('Die Temp-DB existiert nicht: der Server hat sie nicht geöffnet. Abbruch, bevor Last entsteht.');
  }
  timing.serverReadySec = (performance.now() - t0) / 1000;
  res.db = path.join(tmpDir, 'loadtest.db');
  res.pid = child.pid;
  res.root = opts.root;
  log(`Server aus ${opts.root} (pid ${child.pid}) auf Port ${PORT} bereit nach ${timing.serverReadySec.toFixed(2)} s, DB ${res.db}`);
}

// ---------- Welt: Admin, Bots, Testnutzer ----------
async function setupWorld(opts) {
  const t = performance.now();
  const login = await request('POST', '/auth/login', { body: { username: 'admin', password: adminPw } });
  if (login.status !== 200 || !login.json || !login.json.token) throw new Error(`Admin-Login fehlgeschlagen: HTTP ${login.status} ${login.json && login.json.error}`);
  adminToken = login.json.token;
  const st = (await admin('GET', '/admin/settings')).json.settings;
  // bot_count bewusst NICHT setzen: die Zahl der Bots regelt der Server selbst.
  const started = await admin('POST', '/admin/bots/start', {});
  const b = started.json || {};
  if (started.status !== 200 || !b.running) throw new Error(`Bots lassen sich nicht starten: HTTP ${started.status} ${b.error}`);
  const secs = (await request('GET', '/securities')).json.securities || [];
  secIds = secs.filter((s) => s.type === 'stock').map((s) => ({ id: s.id, type: s.type }));
  // Aufrufe des neuen Clients nur dann ins Lastprofil, wenn dieser Server sie kennt (sonst 404).
  const offered = async (pth) => (await request('GET', pth, { token: adminToken, record: false })).status !== 404;
  world = {
    bots: b.bots, botCount: b.count == null ? st.bot_count : b.count, wanted: opts.bots,
    activity: b.activity, tickSec: b.tick_sec, fast: !!b.fast,
    companies: (b.bot_companies || []).length, securities: secs.length, incomeSec: st.income_sec, feeCent: st.fee_cent,
    game: await offered('/game'), sparks: await offered('/sparks')
  };
  timing.botsSec = (performance.now() - t) / 1000;
  log(`Bots: ${world.bots} Konten (bot_count ${world.botCount}, --bots ${world.wanted}), ${world.companies} Bot-Firmen, ${world.securities} Wertpapiere (${timing.botsSec.toFixed(1)} s)`);
  if (world.bots !== world.wanted) log(`HINWEIS: ${world.bots} Bots aktiv, verlangt waren ${world.wanted}. bot_count wird vom Lasttest nicht gesetzt; der Bericht nennt die tatsächliche Zahl.`);
  log(`Aufrufe des neuen Clients: /api/game ${world.game ? 'vorhanden' : 'fehlt (404), nicht im Profil'}; /api/sparks ${world.sparks ? 'vorhanden' : 'fehlt (404), nicht im Profil'}`);
}

function makeUser(i, token, userId, seed) {
  return {
    i, token, userId, board: false, rnd: mulberry32((seed * 1000003 + i + 1) >>> 0),
    ws: null, wsMs: null,
    tab: null, secId: 0, secType: 'stock', ask: null, bid: null,
    amount: 0, side: 'buy', otype: 'market', trade: null,
    ledger: new Map(), refund: new Map(),   // Depot-Sicht des Nutzers; refund: Stücke liegender Verkaufs-Orders
    t: { dwell: null, candles: null, preview: null, think: null, cancel: null, trade: null, poll: null, sparks: null },
    fMsgs: 0, fBytes: 0,                    // im Messfenster empfangen
    orders: { market: 0, limit: 0, filled: 0, resting: 0, cancelled: 0, rejected: 0, fills: 0 }
  };
}

async function pool(n, concurrency, fn) {
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (next < n && !aborted) { const i = next++; await fn(i); }
  }));
  const bad = settled.find((x) => x.status === 'rejected');
  if (bad) throw bad.reason;
  checkAbort();
}

async function createUsers(opts) {
  let t = performance.now();
  users = new Array(opts.clients);
  await pool(opts.clients, 6, async (i) => {
    const r = await request('POST', '/auth/register', { body: { username: `lt_${String(i + 1).padStart(4, '0')}`, password: USER_PW } });
    if (r.status !== 200 || !r.json || !r.json.token) throw new Error(`Testnutzer ${i + 1} ließ sich nicht anlegen: HTTP ${r.status} ${(r.json && r.json.error) || r.error}`);
    users[i] = makeUser(i, r.json.token, r.json.user.id, opts.seed);
  });
  timing.registerSec = (performance.now() - t) / 1000;
  log(`${opts.clients} Testnutzer registriert (${timing.registerSec.toFixed(1)} s)`);
  res.prebuy = { ok: 0, fail: 0, msgs: new Map() };
  if (!secIds.length) { boards = makeBoards(opts); return; }
  t = performance.now();
  await pool(opts.clients, 6, async (i) => {
    const c = users[i];
    const sec = secIds[Math.floor(c.rnd() * secIds.length)];
    const r = await post(c, '/orders', { security_id: sec.id, side: 'buy', type: 'market', amount: MODELL.prebuyShares });
    if (r.status === 200) { res.prebuy.ok++; c.ledger.set(sec.id, r.json.trades.reduce((a, x) => a + x.amount, 0)); }
    else {
      res.prebuy.fail++;
      const k = String((r.json && r.json.error) || r.error).slice(0, 70);
      res.prebuy.msgs.set(k, (res.prebuy.msgs.get(k) || 0) + 1);
    }
  });
  timing.prebuySec = (performance.now() - t) / 1000;
  log(`Vorab-Kauf: ${res.prebuy.ok} ausgeführt, ${res.prebuy.fail} abgelehnt (${timing.prebuySec.toFixed(1)} s)`);
  boards = makeBoards(opts);
}
const makeBoards = (opts) => Array.from({ length: Math.max(1, Math.round(opts.clients / MODELL.boardsPerStudents)) },
  (_, i) => ({ i, board: true, token: null, ws: null, wsMs: null, t: { poll: null } }));

// ---------- WebSocket ----------
function connectWs(c) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    // client/src/ws.jsx: ws://<host>/ws?token=<token>; ohne Token (Beamer) ohne Parameter.
    // Kompression aus: der Server sendet unkomprimiert (ws-Voreinstellung), die Länge
    // der Nutzlast ist damit zugleich die gesendete Datenmenge.
    const url = `ws://127.0.0.1:${PORT}/ws${c.token ? `?token=${encodeURIComponent(c.token)}` : ''}`;
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 20000 });
    c.ws = ws; c.wsMs = null;
    const done = () => { if (c.wsMs === null) c.wsMs = performance.now() - t0; resolve(); };
    ws.on('open', done);
    ws.on('error', done);
    ws.on('message', (data) => onMessage(c, data));
    ws.on('close', (code) => {
      if (PHASE === 'window') { stats.window.wsClosed++; if (closeNotes.length < 10) closeNotes.push(`Code ${code}`); }
      done();
    });
  });
}
function onMessage(c, data) {
  const bytes = data.length;
  const s = stats[PHASE];
  let m = null;
  try { m = JSON.parse(data); } catch { /* keine JSON-Nachricht */ }
  if (s) {
    if (c.board) { s.boardMsgs++; s.boardBytes += bytes; }
    else {
      s.wsMsgs++; s.wsBytes += bytes;
      const row = s.wsByType.get(m && m.type) || { n: 0, bytes: 0 };
      row.n++; row.bytes += bytes;
      s.wsByType.set(m && m.type, row);
      if (PHASE === 'window') { c.fMsgs++; c.fBytes += bytes; }
    }
  }
  if (!active || c.board || !m || typeof m !== 'object') return;
  // Player.jsx: "dirty" für den eigenen Nutzer -> der aktive Tab lädt seine Daten neu
  if (m.type === 'dirty') { if (m.user_id === c.userId) bump(c); return; }
  // SecurityDetail.jsx: jedes Orderbuch-Update des abonnierten Werts -> neue Vorschau (entprellt)
  if (m.type === 'book' && c.tab === 'detail' && m.security_id === c.secId) {
    const b = m.book || {};
    if (b.bids && b.bids[0]) c.bid = b.bids[0][0];
    if (b.asks && b.asks[0]) c.ask = b.asks[0][0];
    if (c.amount >= 1) schedulePreview(c);
  }
}

// ---------- Verhalten eines Nutzers (spiegelt client/src/pages/*.jsx) ----------
function every(c, name, ms, guard, fn) {
  clearTimeout(c.t[name]);
  let next = performance.now() + ms;
  const tick = () => {
    c.t[name] = null;
    if (!active || !guard()) return;
    fn();
    next += ms;
    c.t[name] = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  c.t[name] = setTimeout(tick, ms);
}
function scheduleDwell(c) {
  clearTimeout(c.t.dwell); c.t.dwell = null;
  if (!windowOn) return;
  c.t.dwell = setTimeout(() => { c.t.dwell = null; if (active && windowOn) switchTab(c); }, expDist(c.rnd, MODELL.dwellMeanMs));
}
function switchTab(c) {
  if (c.trade) { scheduleDwell(c); return; }     // Order wird eingegeben -> der Nutzer bleibt auf der Seite
  const tab = pickTab(c, c.tab);
  enterTab(c, tab, tab === 'detail' ? pickSecurity(c) : 0);
}
function pickTab(c, exclude) {
  const open = MODELL.tabs.filter(([t]) => t !== exclude && (t !== 'detail' || secIds.length));
  let r = c.rnd() * open.reduce((a, [, w]) => a + w, 0);
  for (const [t, w] of open) { r -= w; if (r < 0) return t; }
  return open[open.length - 1][0];
}
function pickSecurity(c) { return secIds.length ? secIds[Math.floor(c.rnd() * secIds.length)].id : 0; }
// Anfangs-Tab fest nach Anteilen verteilt (Schichtung über den Index), nicht gewürfelt
function stratum(fraction) {
  let r = (fraction % 1) * MODELL.tabs.reduce((a, [, w]) => a + w, 0);
  for (const [t, w] of MODELL.tabs) { r -= w; if (r < 0) return t; }
  return MODELL.tabs[MODELL.tabs.length - 1][0];
}
function leaveTab(c) {
  clearTimeout(c.t.dwell); clearTimeout(c.t.candles); clearTimeout(c.t.preview);
  if (c.tab === 'detail' && c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'unsubscribe', security_id: c.secId }));
  c.amount = 0;
}
function loadPortfolio(c) {
  return get(c, '/portfolio').then((r) => {
    if (r.status === 200 && r.json) c.ledger = new Map((r.json.positions || []).map((p) => [p.security_id, p.amount]));
    return r;
  });
}
function loadDetail(c) {
  return get(c, `/securities/${c.secId}`).then((r) => {
    if (r.status === 200 && r.json && r.json.security) {
      c.secType = r.json.security.type; c.ask = r.json.security.ask; c.bid = r.json.security.bid;
      if (r.json.mine) c.ledger.set(c.secId, r.json.mine.amount);
    }
    return r;
  });
}
function bump(c) {
  if (!active) return;
  if (c.tab === 'market') loadPortfolio(c);
  else if (c.tab === 'depot') { loadPortfolio(c); get(c, '/orders'); }
  else if (c.tab === 'profile') { loadPortfolio(c); get(c, '/leaderboard'); get(c, '/companies/mine'); get(c, '/securities'); }
  else if (c.tab === 'detail') loadDetail(c);
}
async function enterTab(c, tab, secId, noPanel) {
  leaveTab(c);
  c.tab = tab; c.secId = secId || 0; c.ask = null; c.bid = null;
  scheduleDwell(c);
  if (tab === 'market') { loadPortfolio(c); get(c, '/securities'); }                       // Market.jsx
  else if (tab === 'depot') {                                                               // Depot.jsx: Depot + Orders, danach je Position eine Sparkline
    const pf = loadPortfolio(c);
    get(c, '/orders');
    const p = await pf;
    if (!active || c.tab !== 'depot' || !p.json) return;
    for (const pos of p.json.positions || []) get(c, `/securities/${pos.security_id}/candles?bucket=1800000&range=86400000`);
  } else if (tab === 'news') get(c, '/news');                                              // News.jsx
  else if (tab === 'profile') {                                                             // Profile.jsx: vier Aufrufe gleichzeitig
    loadPortfolio(c); get(c, '/leaderboard'); get(c, '/companies/mine'); get(c, '/securities');
  } else if (tab === 'detail') {                                                            // SecurityDetail.jsx
    const base = `/securities/${secId}`;
    const candles = `${base}/candles?bucket=300000&range=86400000`;                         // Standardbereich 1T
    const d = get(c, base);
    get(c, candles);
    every(c, 'candles', MODELL.candlesDetailMs, () => c.tab === 'detail' && c.secId === secId, () => get(c, candles));
    const r = await d;
    if (!active || c.tab !== 'detail' || c.secId !== secId) return;
    if (r.status === 200 && r.json && r.json.security) {
      const s = r.json.security;
      c.secType = s.type; c.ask = s.ask; c.bid = s.bid;
      if (r.json.mine) c.ledger.set(secId, r.json.mine.amount);
      if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'subscribe', security_id: secId }));   // useSubscribe
      if (!noPanel && c.rnd() < MODELL.panelOpenProb) openPanel(c, 1 + Math.floor(c.rnd() * MODELL.maxAmount), c.rnd() < 0.5 ? 'buy' : 'sell', 'market');
    }
  }
}
function openPanel(c, amount, side, otype) { c.amount = amount; c.side = side; c.otype = otype; schedulePreview(c); }
function schedulePreview(c) {
  clearTimeout(c.t.preview); c.t.preview = null;
  if (c.amount < 1 || !active) return;
  c.t.preview = setTimeout(() => {
    c.t.preview = null;
    if (!active || c.tab !== 'detail' || c.amount < 1) return;
    const q = `side=${c.side}&type=${c.otype}&amount=${c.amount}` + (c.otype === 'limit' ? `&price=${limitPrice(c)}` : '');
    get(c, `/securities/${c.secId}/preview?${q}`);
  }, MODELL.previewDebounceMs);
}
// TradeBox belegt das Limit mit Ask (Kauf) bzw. Bid (Verkauf) vor, gerundet auf den Tick
function limitPrice(c) {
  const ref = c.side === 'buy' ? c.ask : c.bid;
  const t = TICK[c.secType] || 100;
  return ref == null ? null : Math.max(t, Math.round(ref / t) * t);
}
function scheduleTrade(c) {
  clearTimeout(c.t.trade); c.t.trade = null;
  c.t.trade = setTimeout(() => { c.t.trade = null; if (active && windowOn) startTrade(c); }, expDist(c.rnd, MODELL.tradeMeanMs));
}
function startTrade(c) {
  scheduleTrade(c);                                                    // nächste Order, unabhängig vom Ausgang dieser
  if (!secIds.length || c.trade || !c.ws || c.ws.readyState !== 1) return;
  let side = c.rnd() < 0.5 ? 'sell' : 'buy';
  let secId = 0;
  if (side === 'sell') {                                               // verkaufen geht nur, was der Nutzer laut eigener Depot-Sicht hält
    const held = [...c.ledger].filter(([id, a]) => a >= 1 && secIds.some((s) => s.id === id)).map(([id]) => id);
    if (!held.length) side = 'buy'; else secId = held[Math.floor(c.rnd() * held.length)];
  }
  if (side === 'buy') secId = pickSecurity(c);
  const max = side === 'sell' ? Math.min(MODELL.maxAmount, c.ledger.get(secId) || 0) : MODELL.maxAmount;
  if (max < 1) return;
  c.trade = { side, otype: c.rnd() < MODELL.limitShare ? 'limit' : 'market', amount: 1 + Math.floor(c.rnd() * max) };
  const go = () => {
    const tr = c.trade;
    if (!active || !tr || c.tab !== 'detail' || c.secId !== secId) { c.trade = null; return; }
    if (tr.otype === 'limit' && limitPrice(c) == null) tr.otype = 'market';
    openPanel(c, tr.amount, tr.side, tr.otype);                        // Stückzahl eingegeben -> Vorschau
    c.t.think = setTimeout(() => { c.t.think = null; submitOrder(c); }, expDist(c.rnd, MODELL.thinkMeanMs));
  };
  if (c.tab === 'detail' && c.secId === secId) { scheduleDwell(c); go(); }
  else enterTab(c, 'detail', secId, true).then(go);                    // Wertpapierseite öffnen
}
async function submitOrder(c) {
  const tr = c.trade;
  if (!tr || !active) return;
  const body = { security_id: c.secId, side: tr.side, type: tr.otype, amount: tr.amount };
  if (tr.otype === 'limit') body.price = limitPrice(c);
  const r = await post(c, '/orders', body);
  if (!active) return;
  c.trade = null;
  const o = c.orders;
  if (r.status !== 200 || !r.json) { o.rejected++; return; }
  o[tr.otype]++;
  const fills = r.json.trades || [];
  const filled = fills.reduce((a, x) => a + x.amount, 0);
  o.fills += fills.length;
  if (fills.length) o.filled++;
  const order = r.json.order || {};
  const rest = Math.max(0, (order.amount || 0) - (order.filled || 0));
  const held = (c.ledger.get(c.secId) || 0) + (tr.side === 'buy' ? filled : -filled - rest);
  c.ledger.set(c.secId, Math.max(0, held));
  if (order.status === 'open') {
    o.resting++;
    if (tr.side === 'sell') c.refund.set(order.id, rest);              // Stücke liegen treuhänderisch im Buch
    if (c.rnd() < MODELL.cancelProb) {
      c.t.cancel = setTimeout(() => { c.t.cancel = null; if (active) cancelOrder(c, order.id); }, expDist(c.rnd, MODELL.cancelMeanMs));
    }
  }
  loadDetail(c);                                                       // onDone: load(); bump() löst das "dirty" per WS aus
}
function cancelOrder(c, id) {
  del(c, `/orders/${id}`).then((r) => {
    if (!active) return;
    if (r.status === 200) {
      c.orders.cancelled++;
      c.ledger.set(c.secId, (c.ledger.get(c.secId) || 0) + (c.refund.get(id) || 0));
      c.refund.delete(id);
    }
    if (c.tab === 'detail') loadDetail(c);
  });
}
function stopAll() {
  active = false; windowOn = false;
  for (const c of [...users, ...boards]) for (const k of Object.keys(c.t)) { clearTimeout(c.t[k]); c.t[k] = null; }
}

// ---------- Phasen ----------
const openWs = (list) => list.filter((c) => c.ws && c.ws.readyState === 1).length;

async function rampUp(opts) {
  PHASE = 'ramp';
  active = true;
  const all = [...users, ...boards];
  const rampMs = Math.min(5000, Math.max(1000, opts.seconds * 250));   // ANNAHME: alle melden sich in höchstens 5 s an
  const start = performance.now();
  log(`Aufbau: ${users.length} Schüler und ${boards.length} Beamer verbinden sich in ${rampMs / 1000} s`);
  const settled = await Promise.allSettled(all.map((c, i) => (async () => {
    await sleepUntil(start + (i * rampMs) / all.length);
    if (aborted) return;
    if (c.board) {
      await connectWs(c);
      if (aborted) return;                                                     // Board.jsx: /api/board sofort und alle 10 s
      request('GET', '/board');
      every(c, 'poll', MODELL.boardPollMs, () => true, () => request('GET', '/board'));
      return;
    }
    await Promise.all([connectWs(c), get(c, '/auth/me')]);                           // Player.jsx: WS und /auth/me starten gleichzeitig
    if (aborted) return;
    if (world.game) get(c, '/game');                                   // neuer Client: Spielstand beim Öffnen der App
    if (world.sparks) get(c, '/sparks');                               // neuer Client: Sparklines beim Öffnen, danach alle 60 s
    const tab = secIds.length ? stratum((c.i + 0.5) / users.length) : pickTab(c, 'detail');
    await enterTab(c, tab, tab === 'detail' ? pickSecurity(c) : 0);
  })()));
  const bad = settled.find((x) => x.status === 'rejected');
  if (bad) throw bad.reason;
  checkAbort();
  timing.rampSec = (performance.now() - start) / 1000;
  res.rampMs = rampMs;
  res.wsConnectMaxMs = Math.max(0, ...all.map((c) => c.wsMs || 0));
  log(`Aufbau fertig: ${openWs(users)}/${users.length} Schüler und ${openWs(boards)}/${boards.length} Beamer verbunden in ${timing.rampSec.toFixed(1)} s`);
}

async function measureWindow(opts) {
  // Stichtproben vor dem Fenster (zählen nicht mit)
  PHASE = 'setup';
  const ov0 = (await admin('GET', '/admin/overview')).json;
  const bt0 = (await admin('GET', '/admin/bots')).json;
  const proc0 = readProc(child.pid);
  PHASE = 'window';
  windowOn = true;
  const t0 = performance.now();
  const wall0 = Date.now();
  const lag = monitorEventLoopDelay({ resolution: 2 });   // Auflösung 2 ms: kleinere Verzögerungen misst das Histogramm nicht
  lag.enable();
  const sampler = setInterval(() => { const p = readProc(child.pid); if (p) procSamples.push(p.rssKb); }, 500);
  const progress = setInterval(() => {
    const p = readProc(child.pid);
    const n = [...stats.window.rest.values()].reduce((a, r) => a + r.n, 0);
    log(`Fenster ${((performance.now() - t0) / 1000).toFixed(0)} s: ${n} Anfragen, ${inFlight} offen` + (p ? `, Server-CPU ${(p.user + p.sys).toFixed(2)} s, RSS ${Math.round(p.rssKb / 1024)} MB` : ''));
  }, 5000);
  for (const c of users) {
    scheduleDwell(c); scheduleTrade(c);
    // Sparkline-Poll mit zufälliger Phase: die Apps sind im Fenster schon länger offen (ANNAHME)
    if (world.sparks) {
      c.t.sparks = setTimeout(function tick() {
        c.t.sparks = null;
        if (active) { get(c, '/sparks'); c.t.sparks = setTimeout(tick, MODELL.sparksMs); }
      }, c.rnd() * MODELL.sparksMs);
    }
  }
  const connected0 = openWs(users);
  await sleepUntil(t0 + opts.seconds * 1000);
  const proc1 = readProc(child.pid);
  const t1 = performance.now();
  const connected1 = openWs(users);
  for (const c of users) c.openAtEnd = !!(c.ws && c.ws.readyState === 1);   // merken, solange die Sockets noch offen sind
  PHASE = 'after';
  stopAll();
  clearInterval(sampler); clearInterval(progress);
  lag.disable();
  checkAbort();
  Object.assign(res, { t0, t1, wall0, wall1: Date.now(), proc0, proc1, connected0, connected1 });
  // Nachläufer: Anfragen aus dem Fenster abwarten, sonst gingen die langsamsten verloren
  const deadline = performance.now() + 15000;
  while (inFlight > 0 && performance.now() < deadline) await sleep(20);
  res.pendingAtEnd = inFlight;
  failPending();
  res.unanswered = pending.size;
  res.lagP99Ms = lag.percentile(99) / 1e6;
  res.lagMaxMs = lag.max / 1e6;
  const ov1 = (await admin('GET', '/admin/overview')).json;
  const bt1 = (await admin('GET', '/admin/bots')).json;
  res.trades = ov1.counts.trades_today - ov0.counts.trades_today;
  res.botTrades = bt1.trades_this_run - bt0.trades_this_run;
  res.botOrders = bt1.orders_this_run - bt0.orders_this_run;
  res.botErrors = bt1.errors;
  res.usersTotal = ov1.counts.users;
  // Fällt die Zahlung des Wocheneinkommens ins Fenster, laden alle Nutzer gleichzeitig ihre Daten neu
  const lastIncome = res.wall1 + ov1.next_income_in - world.incomeSec * 1000;
  res.incomeInWindow = lastIncome >= res.wall0 - 1500 && lastIncome <= res.wall1 + 1500;
  log(`Fenster beendet nach ${((t1 - t0) / 1000).toFixed(2)} s, ${res.unanswered} Anfragen ohne Antwort`);
}

// ---------- Aufräumen (idempotent) ----------
let cleanupPromise = null;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    tearingDown = true;
    stopAll();
    clearInterval(sweeper);
    const notes = [];
    let ok = true;
    // 1) Sockets des Lastgenerators schließen
    for (const c of [...users, ...boards]) { try { if (c.ws) c.ws.terminate(); } catch { /* schon zu */ } }
    try { agent.destroy(); } catch { /* nichts offen */ }
    res.procEnd = child ? readProc(child.pid) : null;
    // 2) Serverprozess beenden: nur diesen einen, nie einen fremden
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      try { child.kill('SIGTERM'); } catch { /* beendet sich gerade */ }
      const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!gone) {
        try { child.kill('SIGKILL'); } catch { /* schon weg */ }
        await Promise.race([exited, sleep(5000)]);
      }
      if (child.exitCode === null && child.signalCode === null) { ok = false; notes.push(`Serverprozess ${child.pid} LÄUFT NOCH`); }
      else notes.push(`Serverprozess ${child.pid} beendet`);
    } else if (child) notes.push(`Serverprozess ${child.pid} war bereits beendet`);
    try { if (child && child.connected) child.disconnect(); } catch { /* Kanal schon zu */ }
    // 3) Temp-DB löschen
    if (tmpDir) {
      for (let i = 0; i < 10 && fs.existsSync(tmpDir); i++) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* gleich nochmal */ }
        if (fs.existsSync(tmpDir)) await sleep(100);
      }
      const left = fs.existsSync(tmpDir);
      if (left) ok = false;
      notes.push(left ? `Temp-Verzeichnis ${tmpDir} IST NOCH DA` : `Temp-Verzeichnis ${tmpDir} gelöscht`);
    }
    // 4) Port frei?
    if (PORT) {
      let open = true;
      for (let i = 0; i < 50 && open; i++) { open = await portOpen(PORT); if (open) await sleep(100); }
      if (open) ok = false;
      notes.push(open ? `Port ${PORT} LAUSCHT NOCH` : `Port ${PORT} frei`);
    }
    // 5) Echte DB-Dateien unverändert?
    let same = false;
    try { same = JSON.stringify(realDbBefore) === JSON.stringify(snapshotRealDb()); } catch { same = false; }
    notes.push(same ? 'Echte DB-Dateien unverändert (Größe, Änderungszeit, Inode)' : 'ACHTUNG: echte DB-Dateien haben sich geändert');
    return { ok, realDbSame: same, notes };
  })();
  return cleanupPromise;
}

// ---------- Bericht ----------
const f1 = (x) => (x == null || Number.isNaN(x) ? 'n. v.' : x.toFixed(1));
const f0 = (x) => (x == null || Number.isNaN(x) ? 'n. v.' : String(Math.round(x)));
const MB = (kb) => (kb == null || Number.isNaN(kb) ? 'n. v.' : `${(kb / 1024).toFixed(1)} MB`);
const fBps = (b) => (b == null || Number.isNaN(b) ? 'n. v.' : b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB/s` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB/s` : `${b.toFixed(1)} B/s`);
function pct(sorted, p) {   // Nearest-Rank
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const share = (a, n) => (n ? `${((a / n) * 100).toFixed(2)} %` : '0.00 %');
const minMax = (arr) => (arr.length ? { min: Math.min(...arr), max: Math.max(...arr) } : null);
function table(head, rows) {
  return ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
function summarizeRest(s) {
  const ms = [];
  let n = 0, fail = 0, bad = 0, bytes = 0;
  for (const r of s.rest.values()) { ms.push(...r.ms); n += r.n; fail += r.fail; bad += r.bad; bytes += r.bytes; }
  ms.sort((a, b) => a - b);
  return { n, fail, bad, bytes, p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: pct(ms, 100) };
}
function restTable(s) {
  const rows = [];
  const badMsgs = new Map();
  for (const [key, r] of [...s.rest.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const ms = r.ms.slice().sort((a, b) => a - b);
    rows.push([`\`${key}\``, f0(r.n), f1(pct(ms, 50)), f1(pct(ms, 95)), f1(pct(ms, 99)), f1(pct(ms, 100)), f0(r.bytes / r.n), `${r.fail} (${share(r.fail, r.n)})`, String(r.bad)]);
    for (const [k, v] of r.badMsgs) badMsgs.set(k, (badMsgs.get(k) || 0) + v);
  }
  const all = summarizeRest(s);
  rows.push(['**alle**', `**${all.n}**`, f1(all.p50), f1(all.p95), f1(all.p99), f1(all.max), f0(all.bytes / (all.n || 1)), `**${all.fail} (${share(all.fail, all.n)})**`, String(all.bad)]);
  return { all, badMsgs, text: table(['Endpunkt', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'Ø Bytes Antwort', 'Fehler', '4xx'], rows) };
}
function perClient(field) {
  const v = users.filter((c) => c.openAtEnd).map((c) => c[field]).sort((a, b) => a - b);
  if (!v.length) return null;
  return { min: v[0], med: pct(v, 50), mean: v.reduce((a, b) => a + b, 0) / v.length, max: v[v.length - 1] };
}
function serverStamp() {
  const files = fs.readdirSync(SRV_DIR).filter((f) => f.endsWith('.js') && !NOT_SERVER_CODE.includes(f)).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(SRV_DIR, f)));
  return { files, hash: h.digest('hex').slice(0, 12) };
}
function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'unbekannt'; }
}

function buildReport(opts, r) {
  const secs = (r.t1 - r.t0) / 1000;
  const hasProc = !!(r.proc0 && r.proc1);
  const cpuU = hasProc ? r.proc1.user - r.proc0.user : null;
  const cpuS = hasProc ? r.proc1.sys - r.proc0.sys : null;
  const tab = restTable(stats.window);
  const msgs = perClient('fMsgs');
  const byt = perClient('fBytes');
  const rss = minMax(procSamples);
  const orders = {};
  for (const c of users) for (const k of Object.keys(c.orders)) orders[k] = (orders[k] || 0) + c.orders[k];
  const four = (x, div) => (x ? `${f1(x.min / div)} / ${f1(x.med / div)} / ${f1(x.mean / div)} / ${f1(x.max / div)}` : 'n. v.');
  const badTop = [...tab.badMsgs].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const L = [];
  L.push(`# Lasttest „${opts.label}" — School-Street-Backend`, '');
  L.push(table(['Rahmen', 'Wert'], [
    ['Datum (UTC)', new Date().toISOString().slice(0, 19)],
    ['Aufruf', `\`${r.cmd}\``],
    ['Getesteter Server', `\`${opts.root}\` — git HEAD ${gitHead(opts.root)}, sha256 über ${r.code.files.length} Dateien server/*.js (ohne Lasttest/Seed/Smoke) = ${r.code.hash}`],
    ['Zufalls-Samen', `${opts.seed} — nur für den Lastgenerator; Bot- und Market-Maker-Zufall bleiben serverseitig`],
    ['Umgebung', `Node ${process.version}, ${os.platform()} ${os.release()}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} Kerne, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM`],
    ['Systemlast 1/5/15 min', `vor Start ${r.load0.map((x) => x.toFixed(2)).join(' / ')}, nach Lauf ${r.load1.map((x) => x.toFixed(2)).join(' / ')} (andere Prozesse desselben Rechners eingerechnet)`],
    ['Serverprozess', `pid ${r.pid}, lauscht auf 0.0.0.0:${PORT} (in server/index.js fest), DB ${r.db}`]
  ]));
  L.push('', '## Lastprofil (Definition)', '',
    '- **Messfenster**: `--seconds` Sekunden, in denen alle Verbindungen offen sind. Gezählt wird nur, was im Fenster startet; Registrierung, Login und erste Seitenaufrufe stehen unten unter Aufbau.',
    '- **Eine Schüler-Verbindung = ein Browser**: WebSocket `ws://<host>/ws?token=<token>` (client/src/ws.jsx). Offene Tabs: Markt 30 %, Depot 15 %, News 10 %, Profil 10 %, Wertpapier-Detail 35 %; Tab-Wechsel im Mittel alle 20 s, exponentialverteilt (beides ANNAHME).',
    '- **Aufrufe je Tab wie im Client**: Markt `/api/securities` + `/api/portfolio`; Depot `/api/portfolio` + `/api/orders` + je Position `/api/securities/:id/candles`; News `/api/news`; Profil `/api/portfolio`, `/api/leaderboard`, `/api/companies/mine`, `/api/securities`; Detail `/api/securities/:id` + `/candles` alle 15 s, Abo `subscribe` fürs Orderbuch, Order-Vorschau `/preview` 250 ms nach jeder Stückzahl- oder Orderbuch-Änderung. Nach einer eigenen Order (WS `dirty`) lädt der aktive Tab neu.',
    '- **Orders** (ANNAHME): je Schüler im Mittel eine alle 120 s, 1-3 Stück, 80 % Market / 20 % Limit (Limit = Ask bzw. Bid), Kauf und Verkauf gleich wahrscheinlich, die Hälfte der liegenden Limit-Orders wird nach ca. 3 s storniert.',
    '- **Beamer**: eine anonyme Verbindung je 100 Schüler (ANNAHME), `GET /api/board` alle 10 s.',
    '- **Aufrufe des neuen Clients**: `GET /api/game` beim Öffnen der App; `GET /api/sparks` beim Öffnen und alle 60 s (Poll-Phase gleichverteilt, ANNAHME). Nur wenn dieser Server sie anbietet, siehe Welt.',
    '- **Bots**: über die Admin-API gestartet; Zahl (bot_count), activity, Takt und Schnellmodus bleiben, was der Server eingestellt hat.',
    '- **p-Werte**: Nearest-Rank über alle Antworten des Endpunkts im Fenster. **Fehler** = HTTP ≥ 500 oder keine Antwort (Verbindungsfehler, Zeitüberschreitung 30 s). **4xx** = vom Server abgelehnt, zählt nicht als Fehler.',
    '- **WS-Bytes**: Länge der empfangenen WebSocket-Nutzlast je Nachricht, ohne Frame- und TCP-Header; der Server sendet unkomprimiert.',
    `- **CPU und RSS**: \`/proc/<pid>/stat\` (utime + stime, CLK_TCK = ${CLK_TCK}) und \`/proc/<pid>/status\` (VmRSS alle 0,5 s), von außen gelesen.`
  );
  L.push('', '## Welt im Messfenster', '');
  L.push(table(['Größe', 'Wert'], [
    ['Testnutzer, je 1 Verbindung mit Token', String(users.length)],
    ['Beamer-Verbindungen (anonym)', String(boards.length)],
    ['Bot-Händler', `${world.bots} aktiv, --bots ${world.wanted}${world.bots === world.wanted ? '' : ' (ABWEICHUNG: bot_count setzt der Lasttest nicht)'}; activity ${world.activity}, Takt ${world.tickSec} s, Schnellmodus ${world.fast ? 'an' : 'aus'}`],
    ['Wertpapiere', String(world.securities)],
    ['Aufrufe des neuen Clients im Profil', `/api/game ${world.game ? 'ja' : 'nein, Server antwortet 404'}; /api/sparks ${world.sparks ? 'ja' : 'nein, Server antwortet 404'}`],
    ['Nutzerkonten insgesamt, Basis der Rangliste', String(r.usersTotal)],
    ['Vorab-Kauf der Testnutzer', `${res.prebuy.ok} ausgeführt, ${res.prebuy.fail} abgelehnt${res.prebuy.msgs.size ? ` (${[...res.prebuy.msgs].map(([k, v]) => `${v}× ${k}`).join('; ')})` : ''}`],
    ['Offene Schüler-Verbindungen', `Fensterbeginn ${r.connected0} / Fensterende ${r.connected1}`]
  ]));
  L.push('', `## Messfenster: ${secs.toFixed(2)} s`, '', '### REST je Endpunkt (im Fenster gestartete Anfragen)', '', tab.text, '',
    `- **Fehlerquote** (HTTP ≥ 500 oder keine Antwort): ${tab.all.fail} von ${tab.all.n} = **${share(tab.all.fail, tab.all.n)}**; Anfragen pro Sekunde: ${f1(tab.all.n / secs)}.`,
    `- **4xx** (abgelehnt): ${tab.all.bad}${badTop.length ? ' — ' + badTop.map(([k, v]) => `${v}× ${k}`).join('; ') : ''}.`);
  L.push('', '### WebSocket (nur Schüler-Verbindungen)', '');
  L.push(table(['Größe', 'Wert'], [
    ['Nachrichten pro Sekunde, alle Verbindungen zusammen', f1(stats.window.wsMsgs / secs)],
    ['Nachrichten pro Sekunde je Client: min / Median / Mittel / max', four(msgs, secs)],
    ['Bytes pro Sekunde, alle', fBps(stats.window.wsBytes / secs)],
    ['Bytes pro Sekunde je Client: min / Median / Mittel / max', four(byt, secs)],
    ['Verbindungsabbrüche im Fenster', `${stats.window.wsClosed}${closeNotes.length ? ` (${closeNotes.join(', ')})` : ''}`],
    ['Beamer-Verbindungen: Nachrichten / Bytes pro Sekunde', `${f1(stats.window.boardMsgs / secs)} / ${fBps(stats.window.boardBytes / secs)}`]
  ]));
  const types = [...stats.window.wsByType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([t, v]) => [String(t), f0(v.n), f1(v.n / secs), f0(v.bytes), fBps(v.bytes / secs), share(v.bytes, stats.window.wsBytes)]);
  L.push('', table(['Typ', 'n', 'n/s', 'Bytes', 'Bytes/s', 'Anteil Bytes'], types));
  L.push('', '### Serverprozess (von außen gelesen)', '');
  L.push(table(['Größe', 'Wert'], hasProc ? [
    ['CPU im Fenster: user + sys', `${f1(cpuU)} s + ${f1(cpuS)} s = ${f1(cpuU + cpuS)} s`],
    ['CPU-Auslastung im Fenster', `${f1(((cpuU + cpuS) / secs) * 100)} % eines Kerns`],
    ['Threads', String(r.proc1.threads)],
    ['RSS am Fensterbeginn / Fensterende', `${MB(r.proc0.rssKb)} / ${MB(r.proc1.rssKb)}`],
    ['RSS im Fenster min / max', rss ? `${MB(rss.min)} / ${MB(rss.max)}` : 'n. v.'],
    ['Peak seit Serverstart (VmHWM)', MB(r.proc1.hwmKb)],
    ['CPU seit Serverstart bis zum Beenden', r.procEnd ? `${f1(r.procEnd.user)} s user + ${f1(r.procEnd.sys)} s sys` : 'n. v.']
  ] : [['CPU und RSS', 'nicht verfügbar (kein /proc)']]));
  L.push('', '### Trades und Orders im Fenster', '');
  L.push(table(['Größe', 'Wert'], [
    ['Trades ausgeführt (Zähler aus /api/admin/overview)', String(r.trades)],
    ['davon Bot-Trades (/api/admin/bots)', String(r.botTrades)],
    ['Orders der Testnutzer: Market / Limit', `${orders.market} / ${orders.limit}`],
    ['... davon gefüllt / liegend geblieben / storniert', `${orders.filled} / ${orders.resting} / ${orders.cancelled}`],
    ['... davon abgelehnt (4xx)', String(orders.rejected)],
    ['Einzelausführungen (trades in den Order-Antworten)', String(orders.fills)]
  ]));
  L.push('', '### Messqualität', '');
  L.push(table(['Größe', 'Wert'], [
    ['Event-Loop-Lag des Lastgenerators p99 / max (Auflösung 2 ms; 2,0 ms heißt kein messbarer Lag)', `${f1(res.lagP99Ms)} ms / ${f1(res.lagMaxMs)} ms`],
    ['Wiederholte GET (vom Server geschlossene Keep-Alive-Verbindung)', String(staleRetries)],
    ['Bei Fensterende noch offen / davon ohne Antwort 15 s später', `${res.pendingAtEnd} / ${res.unanswered}`],
    ['Zahlung des Wocheneinkommens im Fenster', res.incomeInWindow ? 'JA — alle Nutzer laden dann gleichzeitig neu, Lauf ist nicht vergleichbar' : 'nein']
  ]));
  L.push('', '### Aufbau (zählt nicht ins Messfenster)', '');
  L.push(table(['Schritt', 'Dauer / Ergebnis'], [
    ['Server bereit', `${f1(timing.serverReadySec * 1000)} ms`],
    ['Admin-Login, Bots anlegen und starten', `${f1(timing.botsSec * 1000)} ms`],
    [`${opts.clients} Testnutzer registrieren`, `${f1((timing.registerSec || 0) * 1000)} ms`],
    ['Vorab-Käufe', `${f1((timing.prebuySec || 0) * 1000)} ms`],
    [`Verbinden und erste Seitenaufrufe (${res.rampMs / 1000} s Spreizung)`, `${f1((timing.rampSec || 0) * 1000)} ms`],
    ['Längste Zeit bis eine WS-Verbindung offen ist', `${f1(res.wsConnectMaxMs)} ms`]
  ]));
  L.push('', 'REST in der Verbindungsphase, je Endpunkt (Anmelden und erste Seitenaufrufe):', '', restTable(stats.ramp).text);
  L.push('', '## Aufräumen', '');
  for (const n of res.cleanup.notes) L.push(`- ${n}`);
  if (serverErr.length) L.push('', `Der Server schrieb ${serverErr.length} Zeilen auf stderr:`, '', ...serverErr.slice(-15).map((l) => `    ${l}`));
  if (!res.cleanup.realDbSame) L.push('', '**WARNUNG: Die echten DB-Dateien haben sich während des Laufs geändert.**');
  return L.join('\n') + '\n';
}

// ---------- Einstieg ----------
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  PORT = opts.port;
  SRV_DIR = path.join(opts.root, 'server');
  DATA_DIR = path.join(SRV_DIR, 'data');
  WATCH_DIRS = [...new Set([DATA_DIR, path.join(__dirname, 'data')])];
  res.cmd = `node ${path.relative(process.cwd(), __filename) || path.basename(__filename)} `
    + ['clients', 'seconds', 'bots', 'label', 'port', 'seed'].map((k) => `--${k} ${opts[k]}`).join(' ')
    + (opts.rootSet ? ` --root ${opts.root}` : '');
  res.load0 = os.loadavg();
  sweeper = setInterval(sweepIdleSockets, 500);
  let failure = null;
  try {
    if (!fs.existsSync(path.join(SRV_DIR, 'index.js'))) throw new Error(`Kein server/index.js unter ${opts.root} (--root bzw. SS_ROOT)`);
    await assertPortFree(PORT);
    realDbBefore = snapshotRealDb();
    res.code = serverStamp();
    await startServer(opts);
    await setupWorld(opts);
    await createUsers(opts);
    await rampUp(opts);
    await sleep(MODELL.settleMs);
    checkAbort();
    log(`Messfenster: ${opts.seconds} s mit ${openWs(users)}/${users.length} Schüler-Verbindungen`);
    await measureWindow(opts);
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  } finally {
    const c = await cleanup().catch((e) => ({ ok: false, realDbSame: false, notes: [`Aufräumen fehlgeschlagen: ${e.message}`] }));
    res.cleanup = c;
    res.load1 = os.loadavg();
    for (const n of c.notes) log(n);
    if (failure) {
      console.error(`[loadtest] FEHLER: ${failure.message}`);
      if (abortDetail) console.error(abortDetail);
      if (serverErr.length) console.error(`[loadtest] stderr des Servers (letzte ${serverErr.length} Zeilen):\n  ${serverErr.join('\n  ')}`);
      console.error(`[loadtest] Kein Bericht geschrieben; eine vorhandene Datei loadtest-${opts.label}.md bleibt unverändert.`);
      process.exit(aborted && aborted.startsWith('Signal') ? 130 : 1);
    }
    if (!c.ok) { console.error('[loadtest] Aufräumen unvollständig, siehe Meldungen oben.'); process.exit(1); }
    const md = buildReport(opts, res);
    const file = path.join(REPORT_DIR, `loadtest-${opts.label}.md`);
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(file, md);
    log(`Bericht geschrieben: ${file}`);
    process.stdout.write(md, () => process.exit(c.realDbSame ? 0 : 3));
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => abort(`Signal ${sig}`));
process.on('uncaughtException', (e) => abort(`unerwarteter Fehler im Lastgenerator: ${e && e.message}`, e && e.stack));
process.on('unhandledRejection', (e) => abort(`unerwartete abgelehnte Promise im Lastgenerator: ${e && e.message}`, e && e.stack));
main();
