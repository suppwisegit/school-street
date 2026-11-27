// QA T9 — Unabhängige Prüfung von „Neuer ETF" (PLAN T9, V6, DESIGN §12). Eigene DB (qa9-<pid>.db,
// server/data), Port 3277, am Ende gelöscht. Erwartungen stammen aus dem Plan/Design, nicht aus dem Code.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const SERVER = path.join(__dirname, '..');
const DATA = path.join(SERVER, 'data');
const PORT = 3277;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = `qa9-${process.pid}.db`;
const ADMIN = { username: 'admin', password: 'ag123' };
const MIN = 'Die Staatskasse hat zu wenig';

let srv, token, student, STOCKS = [], HAVE = {};
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  do {
    if (srv.child.exitCode !== null) throw new Error(`Server beendet (${srv.child.exitCode}):\n${srv.output}`);
    try { if (await fn()) return; } catch { /* warten */ }
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`Server auf ${PORT} nicht erreichbar:\n${srv.output}`);
}
async function api(method, p, { auth = true, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers.authorization = `Bearer ${auth === 'student' ? student : token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}
const create = (body, o) => api('POST', '/admin/etf/create-fund', { ...o, body });
const adminEtf = async () => (await api('GET', '/admin/etf')).json;
const publicSecs = async () => (await api('GET', '/securities', { auth: false })).json.securities;

let n = 0;
const TICK = () => `Q${String.fromCharCode(65 + Math.floor(n / 26))}${String.fromCharCode(65 + (n++ % 26))}`;
function valid(over = {}) {
  return { ticker: TICK(), name: 'QA9 Korb', shares_per_unit: 1, initial_units: 5, basket: [{ stock_id: STOCKS[0].id, qty: 1 }, { stock_id: STOCKS[1].id, qty: 2 }], ...over };
}
const holding = async (id) => (await api('GET', '/portfolio', { auth: 'student' })).json;

before(async () => {
  for (const f of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA, DB_NAME + f), { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')], { cwd: SERVER, env: { ...process.env, DB_NAME }, stdio: 'ignore' });
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    cwd: SERVER, env: { ...process.env, PORT: String(PORT), DB_NAME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv = { child, output: '' };
  child.stdout.on('data', (d) => { srv.output += d; });
  child.stderr.on('data', (d) => { srv.output += d; });
  await until(async () => (await fetch(`${BASE}/api/securities`)).ok);
  token = (await api('POST', '/auth/login', { auth: false, body: ADMIN })).json.token;
  assert.ok(token);
  const d = await adminEtf();
  STOCKS = d.stocks; HAVE = Object.fromEntries(d.treasury_positions.map((p) => [p.ticker, p.amount]));
  const reg = await api('POST', '/auth/register', { auth: false, body: { username: 'qa9schueler', password: 'qa9123' } });
  student = reg.json.token; assert.ok(student);
});
after(async () => {
  if (srv && srv.child.exitCode === null) {
    const exited = once(srv.child, 'exit'); srv.child.kill('SIGINT');
    const force = setTimeout(() => srv.child.kill('SIGKILL'), 5000); await exited; clearTimeout(force);
  }
  for (const f of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA, DB_NAME + f), { force: true });
});

test('S1 Korb mit 3 Positionen: sichtbar in Admin-Liste und öffentlicher Werteliste (Markt/Board)', async () => {
  const r = await create(valid({ name: 'QA9 Drei', ticker: 'QDREI', basket: [1, 2, 1].map((qty, i) => ({ stock_id: STOCKS[i].id, qty })) }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = await adminEtf();
  const e = a.etfs.find((x) => x.id === r.json.security_id);
  assert.ok(e, 'in GET /admin/etf'); assert.equal(e.items.length, 3); assert.ok(e.nav_per_share > 0);
  const s = (await publicSecs()).find((x) => x.id === r.json.security_id);
  assert.ok(s && s.type === 'etf' && s.ticker === 'QDREI', 'in GET /securities');
  const board = await api('GET', '/board', { auth: false }).catch(() => null);
  if (board && board.status === 200) assert.ok(JSON.stringify(board.json).includes('QDREI'), 'im Board-Feed');
});

test('S2 Schüler kauft 1 ETF-Einheit und verkauft sie wieder', async () => {
  const r = await create(valid({ ticker: 'QHAND' }));
  const id = r.json.security_id;
  // Marktkauf 1 Stück: füllt, was der Market Maker anbietet; danach Depot = 1, Marktverkauf → 0
  const buy = await api('POST', '/orders', { auth: 'student', body: { security_id: id, side: 'buy', type: 'market', amount: 1 } });
  assert.equal(buy.status, 200, `Kauf: ${JSON.stringify(buy.json)}`);
  assert.equal(buy.json.order.filled, 1, `Kauf vollständig gefüllt: ${JSON.stringify(buy.json.order)}`);
  const held = (await holding(id)).positions.find((h) => h.security_id === id)?.amount;
  assert.equal(held, 1, `Depot nach Kauf: ${JSON.stringify((await holding(id)).positions.slice(0, 4))}`);
  const cashMid = (await holding(id)).cash;
  const sell = await api('POST', '/orders', { auth: 'student', body: { security_id: id, side: 'sell', type: 'market', amount: 1 } });
  assert.equal(sell.status, 200, `Verkauf: ${JSON.stringify(sell.json)}`);
  assert.equal(sell.json.order.filled, 1);
  const p = await holding(id);
  assert.equal(p.positions.find((h) => h.security_id === id)?.amount || 0, 0);
  assert.ok(p.cash > cashMid && p.cash - cashMid < 50000, `Cash nach Verkauf ${p.cash} vs ${cashMid} (Cent): Geld zurück minus Spread/Gebühr`);
});

test('S3 Doppeltes Kürzel → 409', async () => {
  const r = await create(valid({ ticker: 'QDOPP' })); assert.equal(r.status, 200);
  const c = (await adminEtf()).etfs.length;
  const a = await create(valid({ ticker: 'QDOPP' }));
  assert.equal(a.status, 409, JSON.stringify(a.json));
  assert.equal((await adminEtf()).etfs.length, c, 'nichts angelegt');
});

test('S4 Leerer Korb → 400', async () => {
  for (const basket of [[], undefined, [{ stock_id: STOCKS[0].id, qty: 0 }]]) {
    const r = await create(valid({ basket }));
    assert.equal(r.status, 400, JSON.stringify(basket)); assert.match(r.json.error, /mindestens eine Aktie/);
  }
});

test('S5 Name 2 / 61 Zeichen → 400; <script> in Name und Beschreibung wird unverändert gespeichert (Ausgabe prüft der Browser)', async () => {
  assert.equal((await create(valid({ name: 'AB' }))).status, 400);
  assert.equal((await create(valid({ name: 'x'.repeat(61) }))).status, 400);
  const r = await create(valid({ name: '<script>alert(1)</script>', description: '<img src=x onerror=alert(2)>' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = (await api('GET', `/securities/${r.json.security_id}`, { auth: false })).json.security;
  assert.equal(s.name, '<script>alert(1)</script>');
});

test('S6 Beschreibung 201 Zeichen → 400', async () => {
  const r = await create(valid({ description: 'y'.repeat(201) }));
  assert.equal(r.status, 400); assert.match(r.json.error, /200 Zeichen/);
});

test('S7 Negative und Bruchzahl-Stückzahlen (Korb, Aktien je Anteil, Anteile bei Start) → 400, nichts angelegt', async () => {
  const c = (await adminEtf()).etfs.length;
  const cases = [
    { basket: [{ stock_id: STOCKS[0].id, qty: -3 }] }, { basket: [{ stock_id: STOCKS[0].id, qty: 1.5 }] },
    { basket: [{ stock_id: STOCKS[0].id, qty: 1 }], shares_per_unit: 0 }, { basket: [{ stock_id: STOCKS[0].id, qty: 1 }], shares_per_unit: -1 },
    { basket: [{ stock_id: STOCKS[0].id, qty: 1 }], shares_per_unit: 1.5 }, { basket: [{ stock_id: STOCKS[0].id, qty: 1 }], initial_units: 2.5 },
  ];
  for (const over of cases) {
    const r = await create(valid(over));
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /Aktien je Anteil|Anteile bei Start|Stück je Anteil/, JSON.stringify(over));
  }
  assert.equal((await adminEtf()).etfs.length, c, 'nichts angelegt');
});

test('S8 Dieselbe Aktie zweimal → zusammengerechnet', async () => {
  const r = await create(valid({ basket: [{ stock_id: STOCKS[2].id, qty: 1 }, { stock_id: STOCKS[2].id, qty: 2 }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = (await adminEtf()).etfs.find((x) => x.id === r.json.security_id);
  assert.deepEqual(e.items.map((i) => i.qty), [3]);
});

test('S9 Nicht handelbarer Wert im Korb (ETF, unbekannt) → 400', async () => {
  const etf = (await adminEtf()).etfs[0];
  const r = await create(valid({ basket: [{ stock_id: etf.id, qty: 1 }] }));
  assert.equal(r.status, 400); assert.match(r.json.error, /nicht handelbar/);
  assert.equal((await create(valid({ basket: [{ stock_id: 99999999, qty: 1 }] }))).status, 400);
});

test('S10 Treasury-Mangel → 400 mit Kürzel und Fehlmenge', async () => {
  const a = STOCKS[3]; const need = Math.floor(HAVE[a.ticker] / 5) + 1;
  const r = await create(valid({ basket: [{ stock_id: a.id, qty: need }] }));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.error, `${MIN} ${a.ticker}: es fehlen ${need * 5 - HAVE[a.ticker]} Stück.`);
});

test('S11 Doppeltes Absenden (2 parallele POST) → genau ein ETF', async () => {
  const body = valid({ ticker: 'QPAR' });
  const [r1, r2] = await Promise.all([create(body), create(body)]);
  const ok = [r1, r2].filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify([r1.json, r2.json]));
  assert.equal([r1, r2].find((r) => r.status !== 200).status, 409);
});

test('S12 Spieler-Konto (kein Admin) erreicht den Endpunkt nicht: 401/403', async () => {
  const r = await create(valid({ ticker: 'QUSER' }), { auth: 'student' });
  assert.ok(r.status === 401 || r.status === 403, `erwartet 401/403, tatsächlich ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal((await create(valid({ ticker: 'QUSER' }), { auth: false })).status, 401);
  assert.ok(!(await publicSecs()).some((s) => s.ticker === 'QUSER'), 'nichts angelegt');
});
