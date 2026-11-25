// Tests T-B1: Push-Pipeline (push.js) und HTTP-Auslieferung (index.js).
// Teil A prüft den Hub in diesem Prozess mit echten Sockets und Stubs.
// Teil B startet den echten Server: Port 3201, eigene DB b1-<pid>.db (wird
// am Ende gelöscht), eigener Build-Ordner. schoolstreet.db wird nie geöffnet.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const WebSocket = require('ws');
const bus = require('../bus');
const { createHub, fanout, MAX_BUFFERED } = require('../push');

const PORT = 3201;
const DB_NAME = `b1-${process.pid}.db`;
const DATA = path.join(__dirname, '..', 'data');
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

async function until(fn, ms = 3000, step = 10) {
  const end = Date.now() + ms;
  do {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  } while (Date.now() < end);
  throw new Error('Zeitüberschreitung beim Warten');
}

// WebSocket-Client, der alle Frames samt Text/Binary-Flag sammelt.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.frames = [];
    ws.on('message', (data, isBinary) => ws.frames.push({ data, isBinary }));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject); // bleibt dran: ein späterer Fehler darf den Test nicht sprengen
  });
}
const json = (frame) => JSON.parse(frame.data.toString());
const closeAll = (sockets) => sockets.forEach((ws) => ws.terminate());

// Hub mit Stubs statt Engine und DB. tickMs/pingMs nur hier kürzer.
async function startHub(t, opts = {}) {
  const server = http.createServer();
  const logs = [];
  const calls = { ticker: 0 };
  const hub = createHub({
    server,
    identify: (token) => (token === 't7' ? { id: 7, username: 'kim', role: 'user' } : null),
    tickerAll: () => { calls.ticker++; return [{ id: 1, ticker: 'ACME', last: 1234 }]; },
    game: () => ({ paused: false }),
    log: (m, e) => logs.push(String(m) + (e ? ` ${e.message}` : '')),
    ...opts
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { hub, logs, calls, url: (token) => `ws://127.0.0.1:${server.address().port}/ws?token=${token || ''}` };
}

// Roher Client ohne Pong: nur den Handshake, dann nur lesen.
function silentClient(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.closed = false;
    socket.on('data', (d) => { if (String(d).startsWith('HTTP/1.1 101')) resolve(socket); });
    socket.on('close', () => { socket.closed = true; });
    socket.on('error', () => {});
    setTimeout(() => reject(new Error('Handshake timed out')), 3000).unref();
  });
}

// ============================ Teil A: Push-Hub ============================

test('A1 · 50 Verbindungen, ein bus.emit: byteweise derselbe Ticker-Puffer, einmal serialisiert', async (t) => {
  const { url, hub } = await startHub(t);
  bus.on(hub.broadcast);
  const sockets = [];
  t.after(() => closeAll(sockets));
  for (let i = 0; i < 50; i++) {
    const ws = await connect(url());
    sockets.push(ws);
    await until(() => ws.frames.length >= 2); // hello + tickerAll
  }
  assert.equal(hub.size, 50);

  let stringified = 0;
  const orig = JSON.stringify;
  JSON.stringify = (...a) => { stringified++; return orig(...a); };
  const msg = { type: 'ticker', ticker: { id: 1, ticker: 'ACME', name: 'Acme AG', type: 'stock', last: 1250, ref: 1200, chg: 4.17, bid: 1249, ask: 1251, vol: 12 } };
  try { bus.emit(msg); } finally { JSON.stringify = orig; }

  for (const ws of sockets) await until(() => ws.frames.length >= 3);
  assert.equal(stringified, 1, 'ein bus.emit, eine Serialisierung');
  const expected = Buffer.from(orig(msg));
  for (const ws of sockets) {
    assert.ok(ws.frames[2].data.equals(expected), 'Nachricht byteweise gleich');
    assert.equal(ws.frames[2].isBinary, false, 'Text-Frame: Browser bekommen einen String');
  }
});

test('A2 · fanout: 50 Sockets, derselbe Puffer; Stau, Wurffehler und tote Sockets fressen die Schleife nicht', () => {
  const fake = () => ({ readyState: 1, bufferedAmount: 0, got: [], send(buf, opts) { this.got.push(buf); this.opts = opts; } });
  const clients = new Map();
  for (let i = 0; i < 50; i++) clients.set(fake(), { userId: 1, subs: new Set([1]), stalled: false });
  const [slow, broken, dead] = [...clients.keys()];
  slow.bufferedAmount = MAX_BUFFERED + 1;
  broken.send = () => { throw new Error('kaputt'); };
  dead.readyState = 3;
  const logs = [];
  const buf = Buffer.from('{"type":"ticker"}');
  const last = Buffer.from('{"type":"tickerAll"}');

  assert.equal(fanout(clients, buf, null, last, (m) => logs.push(m)), 47);
  for (const [w, c] of clients) {
    if (w === slow || w === broken) continue;
    assert.equal(c.stalled, false);
    assert.equal(w.got.length, 1);
    assert.ok(w.got[0] === buf, 'derselbe Puffer, keine Kopie je Socket');
    assert.equal(w.opts.binary, false, 'Text-Frame');
  }
  assert.equal(clients.has(dead), false, 'totes Socket fliegt raus');
  assert.deepEqual(slow.got, [], 'gestautes Socket wird nicht weiter gefüttert');
  assert.equal([...clients.values()].find((c) => c.stalled) != null, true, 'gestautes Socket bleibt markiert');
  assert.ok(logs.some((l) => String(l).includes('Senden fehlgeschlagen')), 'Sendefehler ist protokolliert');

  slow.bufferedAmount = 0;
  fanout(clients, buf, null, last, () => {});
  assert.deepEqual(slow.got, [last, buf], 'beim Aufholen zuerst der letzte Kurs, dann die neue Nachricht');
});

test('A3 · hello mit game, Filter für dirty/book/trade, game-Ereignis, Snapshot wird wiederverwendet', async (t) => {
  const { url, hub, calls } = await startHub(t);
  const kim = await connect(url('t7')), guest = await connect(url()), sub = await connect(url());
  t.after(() => closeAll([kim, guest, sub]));
  await until(() => kim.frames.length >= 2 && guest.frames.length >= 2 && sub.frames.length >= 2);
  for (const ws of [kim, guest, sub]) {
    assert.deepEqual(json(ws.frames[0]), { type: 'hello', user: ws === kim ? { id: 7, username: 'kim', role: 'user' } : null, game: { paused: false } });
    assert.equal(json(ws.frames[1]).type, 'tickerAll');
  }
  assert.equal(calls.ticker, 1, 'drei Verbindungen, ein tickerAll()-Aufruf: letzter Snapshot wird wiederverwendet');

  // Abo senden und per Probe aushandeln, bis das Socket books bekommt (kein Ack im Vertrag)
  sub.send(JSON.stringify({ type: 'subscribe', security_id: 1 }));
  const count = (ws, type) => ws.frames.filter((f) => json(f).type === type).length;
  const book = { type: 'book', security_id: 1, book: { bids: [[1249, 5]], asks: [[1251, 3]] } };
  for (let i = 0; i < 40 && count(sub, 'book') === 0; i++) { hub.broadcast(book); await sleep(25); }
  assert.equal(count(sub, 'book') > 0, true, 'Abonnent bekommt book');
  assert.equal(count(kim, 'book') + count(guest, 'book'), 0, 'ohne Abo kein book');

  hub.broadcast({ type: 'trade', security_id: 1, price: 1250, amount: 1, buyer: 'a', seller: 'b', ts: Date.now() });
  hub.broadcast({ type: 'dirty', user_id: 7, what: ['portfolio', 'orders'] });
  hub.broadcast({ type: 'game', game: { paused: true } });
  await until(() => count(kim, 'dirty') === 1 && count(kim, 'game') === 1 && count(guest, 'game') === 1 && count(sub, 'trade') === 1 && count(sub, 'game') === 1);
  assert.equal(count(sub, 'dirty') + count(guest, 'dirty'), 0, 'dirty nur an das Socket des Nutzers');
  assert.equal(count(kim, 'trade') + count(guest, 'trade'), 0, 'trade nur an Abonnenten');
  for (const ws of [kim, guest, sub]) {
    assert.deepEqual(json(ws.frames[ws.frames.length - 1]), { type: 'game', game: { paused: true } }, 'game-Ereignis kommt an');
  }

  // Sind alle weg, verfällt der Snapshot: die nächste Verbindung bekommt einen frischen
  closeAll([kim, guest, sub]);
  await until(() => hub.size === 0);
  const late = await connect(url());
  t.after(() => late.terminate());
  await until(() => late.frames.length >= 2);
  assert.equal(calls.ticker, 2, 'neuer Snapshot statt eines veralteten');
});

test('A4 · Herzschlag und maxPayload: stumme und übergroße Sockets fliegen raus, der Rest bleibt', async (t) => {
  const { url, hub, logs } = await startHub(t, { pingMs: 60 });
  const good = await connect(url());
  const silent = await silentClient(url());
  const big = await connect(url());
  t.after(() => { closeAll([good, big]); silent.destroy(); });
  await until(() => good.frames.length >= 2);
  await until(() => silent.closed, 2000);
  await sleep(250); // vier weitere Herzschläge
  assert.equal(good.readyState, WebSocket.OPEN, 'wer pongt, bleibt verbunden');

  big.send('x'.repeat(2048));
  await until(() => big.readyState === WebSocket.CLOSED, 2000);
  assert.ok(logs.some((l) => l.includes('Socket-Fehler')), 'Fehler ist protokolliert, nicht geworfen');
  const before = good.frames.length;
  hub.broadcast({ type: 'game', game: { paused: true } });
  await until(() => good.frames.length >= before + 1);
  assert.deepEqual(json(good.frames[good.frames.length - 1]), { type: 'game', game: { paused: true } });
});

test('A5 · Ticker-Intervall: ein Fehler wird protokolliert, der Takt läuft weiter', async (t) => {
  let broken = false, built = 0;
  const { url, logs } = await startHub(t, { tickMs: 40, tickerAll: () => { if (broken) throw new Error('DB kaputt'); built++; return []; } });
  const ws = await connect(url());
  t.after(() => ws.terminate());
  await until(() => ws.frames.length >= 2);

  broken = true;
  await sleep(200); // fünf Takte mit Fehler; ohne Absicherung wäre der Prozess jetzt tot
  assert.ok(logs.some((l) => l.startsWith('[Timer ticker] Fehler:') && l.includes('DB kaputt')), 'Fehler ist protokolliert');
  assert.equal(ws.readyState, WebSocket.OPEN);

  broken = false;
  const before = built;
  await until(() => built > before && json(ws.frames[ws.frames.length - 1]).type === 'tickerAll');
  assert.equal(logs.filter((l) => l.startsWith('[Timer ticker]')).length, 5, 'danach kommen keine weiteren Fehler');
});

// ======================== Teil B: der echte Server ========================

// HTTP-Antwort roh einsammeln (Status, Kopfzeilen, Bytes) — ohne Entpacken durch fetch.
function raw(port, p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const X_JS = 'const x = 1;\n'.repeat(200); // 2,6 KB, gut komprimierbar
const HTML = '<!doctype html><html><head><title>B1</title></head><body><div id="root"></div></body></html>';

function buildDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-public-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'x.js'), X_JS);
  fs.writeFileSync(path.join(dir, 'assets', 'x.woff2'), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(dir, 'index.html'), HTML);
  return dir;
}

async function startServer(t) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_NAME, PUBLIC_DIR: buildDir() },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server beim Start beendet (Code ${child.exitCode}):\n${output}`);
    try { return (await fetch(`${BASE}/api/securities`)).ok; } catch { return false; }
  }, 20000, 100);
  return child;
}

async function stopServer(child, signal) {
  const exited = once(child, 'exit');
  child.kill(signal);
  return (await exited)[0];
}

after(() => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(DATA, DB_NAME + suffix), { force: true });
  for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('b1-public-'))) {
    fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
  }
});

test('B · Echter Server auf 3201', async (t) => {
  const child = await startServer(t);

  await t.test('hello enthält game, danach der letzte tickerAll-Snapshot', async (t) => {
    const ws = await connect(WS);
    t.after(() => ws.terminate());
    await until(() => ws.frames.length >= 2);
    assert.deepEqual(json(ws.frames[0]), { type: 'hello', user: null, game: { paused: false } });
    assert.equal(json(ws.frames[1]).type, 'tickerAll');
    assert.ok(Array.isArray(json(ws.frames[1]).ticker));
  });

  await t.test('50 Verbindungen: ein bus.emit (News) und der 5-s-Ticker kommen byteweise gleich an', async (t) => {
    const sockets = [];
    t.after(() => closeAll(sockets));
    for (let i = 0; i < 50; i++) sockets.push(await connect(WS));
    await until(() => sockets.every((ws) => ws.frames.length >= 2));
    assert.equal(new Set(sockets.map((ws) => ws.frames[1].data.toString())).size, 1, 'alle starten mit demselben Snapshot');

    const r = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'b1tester', password: 'b1geheim' }) });
    assert.equal(r.status, 200, await r.text());
    await until(() => sockets.every((ws) => ws.frames.length >= 3), 5000);
    const news = sockets.map((ws) => ws.frames[2].data.toString());
    assert.equal(new Set(news).size, 1, '50 Empfänger, ein Puffer');
    assert.equal(JSON.parse(news[0]).type, 'news');

    const lastIsTicker = (ws) => ws.frames.length >= 4 && json(ws.frames[ws.frames.length - 1]).type === 'tickerAll';
    await until(() => sockets.every(lastIsTicker), 7000);
    assert.equal(new Set(sockets.map((ws) => ws.frames[ws.frames.length - 1].data.toString())).size, 1, 'ein Ticker-Puffer für alle 50');
  });

  await t.test('/assets/x.js: immutable und gzip; index.html: no-cache', async () => {
    // Roh abfragen: fetch würde den Körper selbst entpacken, die Bytes wären nicht sichtbar
    const get = (p, headers) => raw(PORT, p, headers);
    const cc = (r) => r.headers['cache-control'];
    const gz = await get('/assets/x.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(gz.status, 200);
    assert.equal(cc(gz), 'public, max-age=31536000, immutable');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers['content-type'], /javascript/);
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.ok(gz.body.length < X_JS.length / 4, `wirklich komprimiert: ${gz.body.length} statt ${X_JS.length} Bytes`);
    assert.equal(zlib.gunzipSync(gz.body).toString(), X_JS);
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    const etag = gz.headers.etag;

    const again = await get('/assets/x.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(again.headers.etag, etag);
    assert.ok(again.body.equals(gz.body), 'zweiter Abruf: gleicher Puffer aus dem Cache');

    const rawRes = await get('/assets/x.js');
    assert.equal(rawRes.headers['content-encoding'], undefined, 'ohne Accept-Encoding unkomprimiert');
    assert.equal(cc(rawRes), 'public, max-age=31536000, immutable');
    assert.equal(rawRes.body.toString(), X_JS);

    const notMod = await get('/assets/x.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    assert.equal(notMod.status, 304);
    assert.match(cc(notMod), /immutable/);
    assert.equal(notMod.body.length, 0);

    const head = await raw(PORT, '/assets/x.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-encoding'], 'gzip');
    assert.equal(head.body.length, 0);

    const font = await get('/assets/x.woff2', { 'Accept-Encoding': 'gzip' });
    assert.equal(font.headers['content-encoding'], undefined, 'Schrift ist schon komprimiert');
    assert.match(cc(font), /immutable/);

    for (const p of ['/', '/board', '/index.html']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.equal(cc(r), 'no-cache', `${p} darf nie unveränderlich sein`);
      assert.equal(r.body.toString(), HTML);
    }
    // fehlender Asset: 404, kein immutable (sonst bliebe eine Fehlerseite ein Jahr als Skript gecacht)
    for (const p of ['/assets/missing.js', '/assets/..%2Findex.html']) {
      const r = await get(p, { 'Accept-Encoding': 'gzip' });
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(cc(r) || '', /immutable/);
    }
  });

  await t.test('Fehler an einem Socket und kaputtes JSON beenden den Server nicht', async (t) => {
    const ws = await connect(WS);
    t.after(() => ws.terminate());
    await until(() => ws.frames.length >= 2);
    const big = new WebSocket(WS);
    big.on('error', () => {});
    await once(big, 'open');
    big.send('x'.repeat(2048));
    await once(big, 'close');

    const ok = await fetch(`${BASE}/api/securities`);
    assert.equal(ok.status, 200, 'Server lebt noch');
    const bad = await fetch(`${BASE}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"side":' });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(typeof body.error, 'string', 'API-Fehler sind JSON {error}');
    assert.equal(ws.readyState, WebSocket.OPEN, 'die anderen Sockets bleiben verbunden');
  });

  await t.test('SIGINT: sauberes Ende, Datenbank geschlossen (-wal/-shm weg)', async () => {
    assert.ok(fs.existsSync(path.join(DATA, DB_NAME)), 'Test-DB liegt unter server/data/');
    assert.ok(fs.existsSync(path.join(DATA, `${DB_NAME}-wal`)), 'WAL besteht, solange der Server läuft');
    assert.equal(await stopServer(child, 'SIGINT'), 0);
    assert.ok(fs.existsSync(path.join(DATA, DB_NAME)), 'Daten bleiben');
    for (const suffix of ['-wal', '-shm']) assert.equal(fs.existsSync(path.join(DATA, DB_NAME + suffix)), false, `${DB_NAME}${suffix} ist weg`);
  });
});

test('B2 · Neustart mit vorhandener DB, SIGTERM', async (t) => {
  const child = await startServer(t);
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.equal(await stopServer(child, 'SIGTERM'), 0);
  for (const suffix of ['-wal', '-shm']) assert.equal(fs.existsSync(path.join(DATA, DB_NAME + suffix)), false, `${DB_NAME}${suffix} ist weg`);
});
