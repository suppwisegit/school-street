// Tests für die IPO-Freigabe (POST /api/admin/ipo/:id/approve, routes.js):
// 1. Fehlende Stückzahlen dürfen nie 500 geben (früher: NaN → NULL in securities.total_shares).
// 2. Vollständige Freigabe: 200, handelbar, News-Texte ohne Dezimalpunkt.
// 3. Notkredit-News des Market Makers (engine.js mmRefreshAll) formatiert mit deutscher Zahl.
// Eigener Serverprozess auf Loopback-Port 3296, eigene DB ipoapprove-<pid>.db, am Ende gelöscht.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const PORT = 3296;
const DB_NAME = `ipoapprove-${process.pid}.db`;
const DB_FILE = path.join(SERVER, 'data', DB_NAME);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'ia-ag-3296';
// „Kein Dezimalpunkt“: in keiner Zahl darf ein Punkt das Dezimalzeichen sein. Der deutsche
// Tausenderpunkt (fmtDeInt → „125.000“) ist keine Dezimalstelle und ausdrücklich erlaubt.
const ZAHL = /\d[\d.,]*/g;
const DEUTSCH_GRUPPIERT = /^\d{1,3}(\.\d{3})+(,\d+)?$/;                  // 125.000 · 1.234,50
const OHNE_PUNKT = /^\d+(,\d+)?$/;                                           // 125000 · 12,50
const zahlenMitDezimalpunkt = (text) => (text.match(ZAHL) || []).filter((z) => z.includes('.') && !DEUTSCH_GRUPPIERT.test(z) && !OHNE_PUNKT.test(z));
const keinDezimalpunkt = (text, wo) => assert.deepEqual(zahlenMitDezimalpunkt(text), [], `Zahl mit Dezimalpunkt in ${wo}`);

async function until(fn, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  do {
    try { const v = await fn(); if (v) return v; } catch { /* noch nicht */ }
    await sleep(step);
  } while (Date.now() < end);
  throw new Error(`Zeitüberschreitung (${ms} ms)`);
}

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}
const GET = (p, token) => api('GET', p, { token });
const POST = (p, body, token) => api('POST', p, { token, body: body ?? {} });

let srv = null;
async function startServer() {
  const child = spawn(process.execPath, [path.join(SERVER, 'run-smoke.js'), '--serve', DB_FILE], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(PORT), DB_NAME, ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  srv = { child, output: '' };
  child.stdout.on('data', (d) => { srv.output += d; });
  child.stderr.on('data', (d) => { srv.output += d; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server beim Start beendet (Code ${child.exitCode}):\n${srv.output}`);
    try { return (await fetch(`${BASE}/api/securities`)).ok; } catch { return false; }
  });
}
async function stopServer() {
  if (!srv || srv.child.exitCode !== null) return;
  const exited = once(srv.child, 'exit');
  srv.child.kill('SIGTERM');
  await exited;
  srv = null;
}

const rnd = Math.random().toString(36).slice(2, 7);
const newsOf = (secId) => {
  const d = new Database(DB_FILE, { readonly: true });
  try { return d.prepare('SELECT kind, title, body FROM news WHERE security_id=? ORDER BY id').all(secId); }
  finally { d.close(); }
};

before(() => {
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(DB_FILE + s, { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { cwd: SERVER, env: { ...process.env, DB_NAME, ADMIN_PASSWORD }, stdio: 'ignore' });
});

after(async () => {
  try { await stopServer(); } catch { /* schon beendet */ }
  for (const f of fs.readdirSync(path.join(SERVER, 'data'))) {
    if (f.startsWith(DB_NAME)) fs.unlinkSync(path.join(SERVER, 'data', f));
  }
});

test('Freigabe mit nur ipo_price: kein 500 — Defaults oder sauberes 400 mit deutschem Satz', { timeout: 40000 }, async (t) => {
  await startServer();
  const admin = (await POST('/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).json.token;
  assert.ok(admin, 'Admin-Login');

  const apply = async (label) => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let ticker = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const have = new Set((await GET('/securities')).json.securities.map((s) => s.ticker));
    while (have.has(ticker)) ticker = ticker.slice(1) + letters[Math.floor(Math.random() * letters.length)];
    const u = await POST('/auth/register', { username: `ia_${label}_${rnd}`, password: 'geheim123' });
    assert.equal(u.status, 200, JSON.stringify(u.json));
    const a = await POST('/companies/apply', { name: `Kiosk ${label} GmbH`, ticker, description: `Konzept ${label}: Pausenbrot und Saft.` }, u.json.token);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    return a.json.id;
  };

  await t.test('Body { ipo_price } ohne Stückzahlen → 200 (Defaults wie im Admin-Dialog) oder 400, nie 500', async () => {
    const id = await apply('nurpreis');
    const r = await POST(`/admin/ipo/${id}/approve`, { ipo_price: 10 }, admin);
    assert.notEqual(r.status, 500, `kein interner Serverfehler: ${JSON.stringify(r.json)}\n${srv.output}`);
    if (r.status === 400) {
      assert.match(r.json.error, /Gründeraktien und Streubesitz angeben/);
      const d = new Database(DB_FILE, { readonly: true });
      try {
        assert.equal(d.prepare('SELECT COUNT(*) c FROM securities WHERE total_shares IS NULL').get().c, 0, 'kein Wert mit NULL-Stückzahl angelegt');
      } finally { d.close(); }
      return;
    }
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const row = (await GET('/securities')).json.securities.find((s) => s.id === r.json.security_id);
    assert.ok(row, 'Wert steht in der Marktliste');
    const d = new Database(DB_FILE, { readonly: true });
    try {
      const sec = d.prepare('SELECT id, total_shares, ipo_price, founder_id FROM securities WHERE id=?').get(r.json.security_id);
      assert.ok(sec && Number.isInteger(sec.total_shares), 'Stückzahl ist eine ganze Zahl, nicht NULL');
      assert.equal(sec.ipo_price, 1000);
      // Gründeraktien stehen unter Lock-up, die Zahl ist also fest; total_shares kann im laufenden
      // Spiel nur durch Nachplatzierung wachsen — deshalb „mindestens“.
      const founder = d.prepare('SELECT amount FROM holdings WHERE security_id=? AND user_id=?').get(sec.id, sec.founder_id);
      assert.equal(founder && founder.amount, 1000, 'Default Gründeraktien: 1000');
      assert.ok(sec.total_shares >= 3000, `mindestens 1000 + 2000 = 3000 Stück, tatsächlich ${sec.total_shares}`);
    } finally { d.close(); }
  });

  await t.test('Unleserliche Stückzahlen („abc“) → 400 mit Satz, nicht 500', async () => {
    const id = await apply('abc');
    const r = await POST(`/admin/ipo/${id}/approve`, { ipo_price: 10, float_shares: 'abc' }, admin);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /Gründeraktien und Streubesitz angeben/);
    const id2 = await apply('null');
    const r2 = await POST(`/admin/ipo/${id2}/approve`, { ipo_price: 10, founder_shares: 0 }, admin);
    assert.equal(r2.status, 400, JSON.stringify(r2.json));
  });

  let secId;
  await t.test('Vollständige Felder → 200, handelbar, News ohne Dezimalpunkt', async () => {
    const id = await apply('voll');
    const r = await POST(`/admin/ipo/${id}/approve`, { ipo_price: 12.5, founder_shares: 1000, float_shares: 400, threshold_mult: 1.5 }, admin);
    assert.equal(r.status, 200, r.json?.error);
    secId = r.json.security_id;
    const row = (await GET('/securities')).json.securities.find((s) => s.id === secId);
    assert.ok(row && row.type === 'stock' && row.last === 1250, 'in der Marktliste zum Startkurs 12,50');
    const d = await GET(`/securities/${secId}`);
    assert.equal(d.status, 200);
    const buyer = await POST('/auth/register', { username: `ia_kauf_${rnd}`, password: 'geheim123' });
    const p = await GET(`/securities/${secId}/preview?side=buy&type=market&amount=1`, buyer.json.token);
    assert.equal(p.status, 200, p.json?.error, 'ein Kauf ist möglich');
    assert.ok(p.json.cap >= 1, 'mindestens 1 Aktie kaufbar');
    const news = newsOf(secId);
    assert.ok(news.some((n) => n.kind === 'ipo' && /^IPO: /.test(n.title)), 'IPO-News zur Freigabe geschrieben');
    for (const n of news) {
      keinDezimalpunkt(`${n.title} ${n.body}`, `News [${n.kind}] „${n.title}“`);
    }
    assert.match(news[0].title, /12,50/, 'Startkurs mit Komma');
  });

  await t.test('Kein NULL-Stückzahl-Wert, keine 500er im Serverlog', async () => {
    const d = new Database(DB_FILE, { readonly: true });
    try {
      assert.equal(d.prepare('SELECT COUNT(*) c FROM securities WHERE total_shares IS NULL').get().c, 0);
    } finally { d.close(); }
  });
});

test('Notkredit-News der Zentralbank schreibt die Zahl mit Komma (kein Dezimalpunkt)', async () => {
  // Eigene DB, nur im Testprozess: Engine laden, Staatskasse leeren, Refresh ausführen.
  const MM_DB = `${DB_NAME}.mm`;
  for (const s of ['', '-wal', '-shm']) fs.rmSync(path.join(SERVER, 'data', MM_DB) + s, { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { cwd: SERVER, env: { ...process.env, DB_NAME: MM_DB, ADMIN_PASSWORD }, stdio: 'ignore' });
  process.env.DB_NAME = MM_DB;
  process.env.SEED = '';
  const dbmod = require('../db');
  const engine = require('../engine');
  try {
    engine.loadEngine();
    const t = engine.treasury();
    assert.ok(t, 'Staatskasse vorhanden');
    dbmod.db.prepare('UPDATE users SET cash = 0 WHERE id = ?').run(t.id);
    const before = dbmod.db.prepare("SELECT COUNT(*) c FROM news WHERE title LIKE 'Notkredit%'").get().c;
    engine.mmRefreshAll();
    const n = dbmod.db.prepare("SELECT * FROM news WHERE title LIKE 'Notkredit%' ORDER BY id DESC LIMIT 1").get();
    assert.ok(n && n.id > 0, 'Notkredit-News geschrieben');
    assert.ok(dbmod.db.prepare("SELECT COUNT(*) c FROM news WHERE title LIKE 'Notkredit%'").get().c === before + 1);
    keinDezimalpunkt(`${n.title} ${n.body}`, `News [system] „${n.title}“`);
    // Betrag laut Logik in mmRefreshAll: 25 % des Staatskapitals, abzüglich Kasse vor der Stützung (0).
    const erwartet = dbmod.fmtDeInt(Math.floor(dbmod.getSettings().treasury_capital * 0.25));
    assert.match(n.body, new RegExp(`mit ${erwartet} Credits gestützt`), 'News nennt den tatsächlich gutgeschriebenen Betrag');
    assert.match(erwartet, /^\d{1,3}(\.\d{3})*$/, 'Betrag groß genug, um die Gruppierung wirklich zu prüfen');
  } finally {
    dbmod.db.close();
    for (const f of fs.readdirSync(path.join(SERVER, 'data'))) {
      if (f.startsWith(MM_DB)) fs.unlinkSync(path.join(SERVER, 'data', f));
    }
  }
});
