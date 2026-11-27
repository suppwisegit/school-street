#!/usr/bin/env node
// ============================================================================
// Smoke-Läufer: legt eine frische Test-DB an, startet server/index.js mit
// dieser DB und einem eigenen Port, führt server/smoke.js aus und räumt
// danach auf — auch bei Fehler, Abbruch oder Signal.
//
//   npm run smoke                      (= node server/run-smoke.js, Port 3100)
//   SMOKE_PORT=3110 npm run smoke      anderer Port
//
// Die echte DB (server/data/schoolstreet.db*) wird nie geöffnet. Größe,
// Änderungszeit und Inode ihrer Dateien werden vor und nach dem Lauf
// verglichen (nur stat). Startet wird erst, wenn db.js und seed.js die
// Datenbank über DB_NAME wählen und der Port frei ist — ein fremder Prozess
// auf dem Port wird nie beendet.
//
// Umgebungsvariablen: SMOKE_PORT (3100) · SMOKE_ADMIN_PASSWORD bzw.
// ADMIN_PASSWORD (sonst zufällig pro Lauf) · alles andere wird an Seed,
// Server und smoke.js unverändert weitergereicht.
// Exit: 0 Suite bestanden und aufgeräumt · 1 Suite fehlgeschlagen, Start
// gescheitert oder nicht aufgeräumt · 2 Aufruf/Vorprüfung · 3 Dateien der
// echten DB haben sich während des Laufs verändert.
// ============================================================================
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const REAL_DB = 'schoolstreet.db';
const REAL_DB_FILES = [REAL_DB, REAL_DB + '-wal', REAL_DB + '-shm'];
const SERVER_READY_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[smoke] ${m}`);

// ---------------------------------------------------------------------------
// Kindmodus: dieser Prozess IST der Server (Aufruf: --serve <DB-Datei>).
// server/index.js bleibt unverändert; drei Zeilen Vorlauf reichen:
// nur Loopback, selbst beenden, wenn der Läufer wegstirbt, DB mitnehmen.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--serve') {
  const dbFile = process.argv[3];
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    const any = (h) => h === undefined || h === '0.0.0.0' || h === '::';
    if (args[0] !== null && typeof args[0] === 'object') {
      if (any(args[0].host)) args[0] = { ...args[0], host: '127.0.0.1' };
    } else if (any(args[1])) {
      args[1] = '127.0.0.1';
    }
    return origListen.apply(this, args);
  };
  process.on('disconnect', () => process.exit(0));
  process.on('exit', () => {
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { /* schon weg */ } }
  });
  require(path.join(__dirname, 'index.js'));
} else {
  main().then(
    (code) => process.exit(code),
    (e) => { log(`Unerwarteter Fehler im Läufer: ${e && e.stack ? e.stack : e}`); process.exit(1); }
  );
}

// ---------- Vorprüfungen ----------

// Nur Metadaten: die Dateien der echten DB werden nie geöffnet.
function snapshotRealDb() {
  return REAL_DB_FILES.map((name) => {
    try { const st = fs.statSync(path.join(DATA_DIR, name)); return `${name} ${st.size} ${Math.round(st.mtimeMs)} ${st.ino}`; }
    catch { return `${name} -`; }
  });
}

function assertDbSwitch(file) {
  const full = path.join(__dirname, file);
  const src = fs.readFileSync(full, 'utf8');
  if (!/process\.env\.DB_NAME/.test(src)) {
    throw new Error(`${file} wählt die Datenbank nicht über DB_NAME. Der Smoke-Läufer startet nicht, damit keine echte DB berührt wird — run-smoke.js an den neuen Mechanismus anpassen.`);
  }
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(new Error(`Port ${port} ist belegt (${e.code}). Es wird kein Prozess beendet — anderen Port wählen: SMOKE_PORT=<port> npm run smoke`)));
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
// HTTP-Status von http://127.0.0.1:<port><pth>; 0 = keine Antwort.
function probe(port, pth) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pth, timeout: 2000, agent: false }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

// ---------- Ablauf ----------

async function main() {
  const port = Number(process.env.SMOKE_PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log(`SMOKE_PORT: ganze Zahl 1..65535 erwartet (erhalten: ${process.env.SMOKE_PORT})`);
    return 2;
  }
  const dbName = `smoke-${process.pid}.db`;
  if (!/^smoke-\d+\.db$/.test(dbName) || REAL_DB_FILES.some((f) => f.startsWith(dbName))) {
    log(`ungültiger Name für die Test-DB: ${dbName}`);
    return 2;
  }
  const dbFile = path.join(DATA_DIR, dbName);
  const dbFiles = [dbFile, dbFile + '-wal', dbFile + '-shm'];
  const adminPw = process.env.SMOKE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
  // Alles aus der Umgebung bleibt; nur diese fünf sind pro Lauf fest.
  const env = { ...process.env, PORT: String(port), DB_NAME: dbName, ADMIN_PASSWORD: adminPw, SMOKE_PORT: String(port), SMOKE_ADMIN_PASSWORD: adminPw };

  // 1) Vorprüfungen — schlägt eine fehl, startet nichts.
  let realDbBefore;
  try {
    for (const f of ['index.js', 'seed.js', 'smoke.js']) {
      if (!fs.existsSync(path.join(__dirname, f))) throw new Error(`${f} fehlt unter ${__dirname}`);
    }
    assertDbSwitch('db.js');
    assertDbSwitch('seed.js');
    if (fs.existsSync(dbFile)) throw new Error(`Test-DB ${dbFile} existiert bereits — Rest eines alten Laufs? Datei löschen und erneut starten.`);
    await assertPortFree(port);
    realDbBefore = snapshotRealDb();
  } catch (e) {
    log(`Vorprüfung fehlgeschlagen: ${e.message}`);
    return 2;
  }

  // 2) Frische Test-DB (seed.js löscht NUR die über DB_NAME genannte Datei).
  const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) {
    log(`seed.js fehlgeschlagen (Exit ${seed.status}):\n${seed.stderr || seed.stdout}`);
    return 1;
  }
  if (!fs.existsSync(dbFile)) {
    log(`seed.js hat keine Test-DB unter ${dbFile} angelegt — Abbruch, bevor ein Server startet.`);
    return 1;
  }

  // 3) Server als eigener Kindprozess.
  const serverOut = [], serverErr = [];
  let serverExit = null;
  let tearingDown = false;
  const keep = (buf) => (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      buf.push(line.slice(0, 300));
      if (buf.length > 60) buf.shift();
    }
  };
  const child = spawn(process.execPath, [__filename, '--serve', dbFile], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', keep(serverOut));
  child.stderr.on('data', keep(serverErr));
  child.on('error', (e) => { serverExit = { code: -1, sig: null, error: e.message }; });
  child.on('exit', (code, sig) => { serverExit = { code, sig }; });

  // 4) Warten, bis die API antwortet.
  const t0 = Date.now();
  try {
    const deadline = Date.now() + SERVER_READY_MS;
    for (;;) {
      if (serverExit) throw new Error(`Serverprozess wurde beendet (Code ${serverExit.code}, Signal ${serverExit.sig})`);
      if ((await probe(port, '/api/securities')) === 200) break;
      if (Date.now() > deadline) throw new Error(`Server antwortet nach ${SERVER_READY_MS / 1000} s nicht mit 200 auf /api/securities`);
      await sleep(150);
    }
  } catch (e) {
    log(`Server startet nicht: ${e.message}`);
    if (serverErr.length) log(`Server-stderr (letzte Zeilen):\n  ${serverErr.join('\n  ')}`);
    if (serverOut.length) log(`Server-stdout (letzte Zeilen):\n  ${serverOut.join('\n  ')}`);
    await cleanup();
    return 1;
  }
  log(`Server bereit auf 127.0.0.1:${port} nach ${((Date.now() - t0) / 1000).toFixed(2)} s (pid ${child.pid}, DB ${dbName})`);

  // 5) Die Suite — Ausgabe live, Umgebung weitergereicht.
  let smokeCode = -1;
  try {
    smokeCode = await new Promise((resolve, reject) => {
      const s = spawn(process.execPath, [path.join(__dirname, 'smoke.js')], { cwd: ROOT, env, stdio: 'inherit' });
      smokeChild = s;
      s.once('error', reject);
      s.once('exit', (code, sig) => resolve(sig ? 128 : code === null ? 1 : code));
    });
  } catch (e) {
    log(`smoke.js nicht startbar: ${e.message}`);
  }

  // 6) Aufräumen, immer.
  const c = await cleanup();
  log(`Aufräumen: ${c.notes.join(' · ')}`);
  if (smokeCode !== 0) log(`Suite fehlgeschlagen (Exit ${smokeCode})`);
  if (!c.ok) log('Aufräumen unvollständig, siehe Meldungen oben.');
  if (!c.realDbSame) log('ACHTUNG: Dateien der echten DB (server/data/schoolstreet.db*) haben sich während des Laufs verändert.');
  return !c.realDbSame ? 3 : (smokeCode === 0 && c.ok) ? 0 : 1;

  // Beendet nur Prozesse, die dieser Läufer selbst gestartet hat.
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    tearingDown = true;
    cleanupPromise = (async () => {
      const notes = [];
      let ok = true;
      const running = (p) => p && p.exitCode === null && p.signalCode === null;
      const exited = (p) => new Promise((r) => p.once('exit', r));
      // Suite
      if (running(smokeChild)) {
        const gone = exited(smokeChild);
        try { smokeChild.kill('SIGTERM'); } catch { /* beendet sich gerade */ }
        if (!(await Promise.race([gone.then(() => true), sleep(3000).then(() => false)]))) {
          try { smokeChild.kill('SIGKILL'); } catch { /* schon weg */ }
          await Promise.race([gone, sleep(3000)]);
        }
        notes.push(running(smokeChild) ? `smoke.js ${smokeChild.pid} LÄUFT NOCH` : 'smoke.js beendet');
        if (running(smokeChild)) ok = false;
      }
      // Server: erst IPC schließen (beendet sich selbst), dann Signale.
      if (child && running(child)) {
        const gone = exited(child);
        try { if (child.connected) child.disconnect(); } catch { /* Kanal schon zu */ }
        if (!(await Promise.race([gone.then(() => true), sleep(3000).then(() => false)]))) {
          try { child.kill('SIGTERM'); } catch { /* beendet sich gerade */ }
          if (!(await Promise.race([gone.then(() => true), sleep(5000).then(() => false)]))) {
            try { child.kill('SIGKILL'); } catch { /* schon weg */ }
            await Promise.race([gone, sleep(5000)]);
          }
        }
        notes.push(running(child) ? `Serverprozess ${child.pid} LÄUFT NOCH` : `Serverprozess ${child.pid} beendet`);
        if (running(child)) ok = false;
      } else if (child) {
        notes.push(`Serverprozess ${child.pid} war bereits beendet`);
      }
      // Test-DB samt -wal/-shm
      let left = true;
      for (let i = 0; i < 10 && left; i++) {
        for (const f of dbFiles) { try { fs.unlinkSync(f); } catch { /* schon weg */ } }
        left = dbFiles.some((f) => fs.existsSync(f));
        if (left) await sleep(100);
      }
      notes.push(left ? `Test-DB ${dbName} IST NOCH DA` : `Test-DB ${dbName} gelöscht`);
      if (left) ok = false;
      // Port
      let open = true;
      for (let i = 0; i < 50 && open; i++) { open = await portOpen(port); if (open) await sleep(100); }
      notes.push(open ? `Port ${port} LAUSCHT NOCH` : `Port ${port} frei`);
      if (open) ok = false;
      // Echte DB unverändert?
      let same = false;
      try { same = JSON.stringify(realDbBefore) === JSON.stringify(snapshotRealDb()); } catch { same = false; }
      notes.push(same ? 'echte DB-Dateien unverändert (Größe, Änderungszeit, Inode)' : 'echte DB-Dateien VERÄNDERT');
      return { ok, realDbSame: same, notes };
    })();
    return cleanupPromise;
  }
}

let smokeChild = null;
let cleanupPromise = null;
let aborted = null;

// Signal: Suite beenden, aufräumen (cleanup läuft im Hauptpfad weiter).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    aborted = `Signal ${sig}`;
    log(`${aborted} — räume auf …`);
    try { if (smokeChild && smokeChild.exitCode === null) smokeChild.kill('SIGTERM'); } catch { /* schon weg */ }
  });
}
