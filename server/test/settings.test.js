// Tests für Vertrag V1 (PLAN.md): neue Einstellungen, Freigabeliste im Admin, News-Wirkung `impact`.
// Erwartungen stehen in PLAN.md (V1), nicht im Code des Implementers. Eigener Server auf Port 3250 mit eigener DB
// settings-test-<pid>.db (am Ende gelöscht); schoolstreet.db wird nie geöffnet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const DATA = path.join(SERVER, 'data');
const PORT = 3250;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = `settings-test-${process.pid}.db`;
const ADMIN = { username: 'admin', password: 'ag1234' };

// Schlüssel von DEFAULT_SETTINGS in der Baseline (34, aus refs/agent-team/baseline abgelesen): die Erweiterung darf keinen entfernen.
const BASELINE = ["mm_version", "mm_impact_pct", "mm_spread_bp", "mm_size", "mm_levels", "mm_size_step", "mm_refresh_sec", "mm_fee_exempt", "mm_cash_budget_pct", "mm_jitter_bp", "mm_size_jitter", "mm_replenish_min", "mm_replenish_pct", "mm_recap_min_pct", "trading_paused", "etf_auto", "etf_auto_max_units", "etf_auto_interval_sec", "etf_ap_inventory_pct", "limit_band_pct", "cap_hours_needed", "idx_base_mcap", "bot_count", "bot_activity", "bot_tick_sec", "bot_fast", "bot_running", "fee_cent", "income_cent", "income_sec", "start_capital", "inactivity_sec", "lockup_sec", "treasury_capital"];
// Gegenprobe gegen git, falls die Referenz im Repository liegt; ohne .git oder Ref wird sie übersprungen, nicht rot.
function baselineSchluessel() {
  let quelle;
  try {
    quelle = execFileSync('git', ['show', 'refs/agent-team/baseline:server/db.js'], { encoding: 'utf8', cwd: path.join(SERVER, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return null; }
  const block = quelle.slice(quelle.indexOf('const DEFAULT_SETTINGS = {'), quelle.indexOf('const settingsCache'));
  const schluessel = [...block.matchAll(/^  ([a-z_0-9]+):/gm)].map((m) => m[1]);
  assert.ok(schluessel.length > 30, `Baseline gelesen: ${schluessel.length} Schlüssel`);
  return schluessel;
}
// V1 aus PLAN.md: Schlüssel und Default.
const V1 = { news_interval_sec: 60, bot_cash_reserve_min: 0.2, bot_cash_reserve_max: 0.4, bot_fee_cent: 0, fee_recycle_pct: 100,
  income_sim_scale: 0, mm_min_ask_shares: 1000, mm_min_depth: 2000, ipo_highlight_sec: 10800 };
// fee_pool_cent: interner Zustand (Gebühren-Pool) im Default-Set, nicht per Admin setzbar.
const INTERN = { fee_pool_cent: 0 };

let srv = null;
async function until(fn, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  do {
    if (srv.child.exitCode !== null) throw new Error(`Server beim Start beendet (Code ${srv.child.exitCode}): ${srv.output}`);
    try { if (await fn()) return; } catch { /* noch nicht da */ }
    await sleep(step);
  } while (Date.now() < end);
  throw new Error(`Server auf Port ${PORT} nicht erreichbar:\n${srv.output}`);
}
async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}

before(async () => {
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(PORT), DB_NAME, ADMIN_PASSWORD: ADMIN.password },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv = { child, output: '' };
  child.stdout.on('data', (d) => { srv.output += d; });
  child.stderr.on('data', (d) => { srv.output += d; });
  await until(async () => (await fetch(`${BASE}/api/securities`)).ok);
});
after(async () => {
  if (srv && srv.child.exitCode === null) {
    const exited = once(srv.child, 'exit');
    srv.child.kill('SIGINT');
    await exited;
  }
  for (const ende of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA, DB_NAME + ende), { force: true });
});

const login = async (username, password) => (await api('POST', '/auth/login', { body: { username, password } })).json.token;
const dbRead2 = (datei) => {
  const d = new Database(datei, { readonly: true });
  try { return d.prepare('SELECT * FROM news ORDER BY id').all(); } finally { d.close(); }
};
// Lesezugriff nur auf die eigene Test-DB
const dbRead = (fn) => {
  const d = new Database(path.join(DATA, DB_NAME), { readonly: true });
  try { return fn(d); } finally { d.close(); }
};

test('jeder V1-Schlüssel steht mit dem Default aus dem Vertrag in DEFAULT_SETTINGS, im Cache und in der Tabelle', () => {
  // db.js im eigenen Prozess auf einer eigenen frischen DB (der Server läuft auf einer anderen).
  const name = `settings-defaults-${process.pid}.db`;
  const datei = path.join(DATA, name);
  process.env.DB_NAME = name;
  try {
    const { DEFAULT_SETTINGS, getSettings } = require('../db');
    // Erwartete Schlüsselmenge: alle Schlüssel der Baseline (refs/agent-team/baseline, dort gelesen) plus V1.
    const erwartet = [...BASELINE, ...Object.keys(V1), ...Object.keys(INTERN)].sort((a, b) => a.localeCompare(b));
    const ausGit = baselineSchluessel();
    if (ausGit) assert.deepEqual([...ausGit].sort(), [...BASELINE].sort(), 'Baseline-Liste im Test stimmt mit refs/agent-team/baseline überein');
    else console.log('Hinweis: refs/agent-team/baseline nicht lesbar, Gegenprobe übersprungen');
    assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort((a, b) => a.localeCompare(b)), erwartet);
    assert.deepEqual(Object.keys(getSettings()).sort((a, b) => a.localeCompare(b)), erwartet);
    const d = new Database(datei, { readonly: true });
    try {
      const tabelle = Object.fromEntries(d.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)]));
      for (const [k, v] of Object.entries(V1)) {
        assert.deepEqual([DEFAULT_SETTINGS[k], getSettings()[k], tabelle[k]], [v, v, v], `${k} als Default, im Cache, in der Tabelle`);
      }
    } finally { d.close(); }
  } finally {
    delete process.env.DB_NAME;
    for (const ende of ['', '-wal', '-shm']) fs.rmSync(datei + ende, { force: true });
  }
});

test('PUT /admin/settings übernimmt jeden V1-Schlüssel als Zahl in Antwort, Tabelle und GET', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const neu = { news_interval_sec: 0, bot_cash_reserve_min: 0.25, bot_cash_reserve_max: 0.6, bot_fee_cent: 350, fee_recycle_pct: 60,
    income_sim_scale: 0, mm_min_ask_shares: 2200, mm_min_depth: 3000, ipo_highlight_sec: 7200 };
  const put = await api('PUT', '/admin/settings', { token, body: neu });
  assert.equal(put.status, 200);
  for (const [k, v] of Object.entries(neu)) {
    assert.deepEqual([put.json.settings[k], typeof put.json.settings[k]], [v, 'number'], `${k} in der Antwort`);
  }
  const tabelle = Object.fromEntries(dbRead((d) => d.prepare('SELECT key, value FROM settings').all()).map((r) => [r.key, JSON.parse(r.value)]));
  const get = await api('GET', '/admin/settings', { token });
  assert.equal(get.status, 200);
  for (const [k, v] of Object.entries(neu)) {
    assert.deepEqual([JSON.parse(tabelle[k]), get.json.settings[k]], [v, v], `${k} in Tabelle und GET`);
  }
  // Grenzfall 0 ist ein gültiger Wert und darf nicht wie „fehlt" behandelt werden.
  assert.deepEqual([get.json.settings.news_interval_sec, get.json.settings.income_sim_scale], [0, 0]);
});

test('PUT /admin/settings: als String gesendete Zahlen kommen als Zahl an, unveränderte Schlüssel behalten ihren Wert', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const vor = await api('PUT', '/admin/settings', { token, body: { bot_fee_cent: 300, mm_min_depth: 2400, mm_min_ask_shares: 1600 } });
  assert.equal(vor.status, 200);
  const r = await api('PUT', '/admin/settings', { token, body: { bot_fee_cent: '400', mm_min_ask_shares: '1700' } });
  assert.deepEqual([r.json.settings.bot_fee_cent, r.json.settings.mm_min_ask_shares], [400, 1700], 'Strings werden Zahlen');
  assert.deepEqual([r.json.settings.mm_min_depth, typeof r.json.settings.mm_min_depth], [2400, 'number'], 'nicht gesendeter Schlüssel bleibt');
});

test('PUT /admin/settings lehnt ungültige Werte komplett ab (400 mit deutschem Satz), nichts wird gespeichert', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const vor = (await api('GET', '/admin/settings', { token })).json.settings;
  const faelle = [
    [{ news_interval_sec: 'abc' }, /news_interval_sec/],
    [{ bot_fee_cent: '' }, /bot_fee_cent/],
    [{ mm_min_depth: null }, /mm_min_depth/],
    [{ mm_min_ask_shares: -1 }, /mm_min_ask_shares/],
    [{ income_sec: -5 }, /income_sec/],
    [{ mm_min_ask_shares: 1500.5 }, /ganze Zahl/],
    [{ bot_cash_reserve_min: 1.5 }, /bot_cash_reserve_min/],
    [{ fee_recycle_pct: 101 }, /fee_recycle_pct/],
    [{ bot_fast: 0.5 }, /bot_fast/],
    [{ etf_auto: 0.5 }, /etf_auto/],
    [{ mm_fee_exempt: 1.5 }, /ganze Zahl/],
    [{ mm_cash_budget_pct: 1.5 }, /mm_cash_budget_pct/],
    [{ mm_recap_min_pct: 5 }, /mm_recap_min_pct/],
    [{ mm_size_jitter: 1.2 }, /mm_size_jitter/],
    [{ mm_replenish_pct: 101 }, /mm_replenish_pct/],
    [{ income_sim_scale: 0.5 }, /income_sim_scale: ganze Zahl zwischen 0 und 1/],
    [{ income_sim_scale: 50 }, /income_sim_scale: ganze Zahl zwischen 0 und 1/],
    [{ bot_cash_reserve_min: 0.5, bot_cash_reserve_max: 0.3 }, /bot_cash_reserve_min darf nicht größer/],
    [{ news_interval_sec: 60, bot_fee_cent: 'xyz' }, /bot_fee_cent/],
    [{ news_interval_sec: [60] }, /news_interval_sec/]
  ];
  for (const [body, satz] of faelle) {
    const r = await api('PUT', '/admin/settings', { token, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, satz);
  }
  const tabelle = Object.fromEntries(dbRead((d) => d.prepare('SELECT key, value FROM settings').all()).map((r) => [r.key, JSON.parse(r.value)]));
  const nach = (await api('GET', '/admin/settings', { token })).json.settings;
  assert.deepEqual(nach, vor, 'Cache unverändert');
  assert.deepEqual(tabelle, vor, 'Tabelle unverändert');
  assert.ok(Object.values(tabelle).every((v) => typeof v === 'number' && Number.isFinite(v)), 'kein NaN oder null in der Tabelle');
  // Die Grenzen selbst: Anteile bis 1, Prozente bis 100, Schalter als String; income_sim_scale ist ein Schalter (0/1).
  const rand = await api('PUT', '/admin/settings', { token, body: { mm_cash_budget_pct: 1, mm_recap_min_pct: 0.95, mm_replenish_pct: 100,
    mm_impact_pct: 100, bot_fast: '1' } });
  assert.equal(rand.status, 200, JSON.stringify(rand.json));
  assert.deepEqual([rand.json.settings.mm_cash_budget_pct, rand.json.settings.mm_replenish_pct, rand.json.settings.bot_fast], [1, 100, 1]);
  // Grenzfall: neue Meldung nur, wenn sie zusammen mit dem Schwellwert kommt.
  const ok = await api('PUT', '/admin/settings', { token, body: { bot_cash_reserve_min: 0.45, bot_cash_reserve_max: 0.45, fee_recycle_pct: 0, news_interval_sec: 0 } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.settings.bot_cash_reserve_min, ok.json.settings.bot_cash_reserve_max, ok.json.settings.fee_recycle_pct], [0.45, 0.45, 0]);
});

test('etf_autobuy ist keine Einstellung mehr: PUT wird mit 400 abgelehnt, nichts gespeichert; fee_pool_cent ist nicht per Admin setzbar', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const vor = (await api('GET', '/admin/settings', { token })).json.settings;
  assert.ok(!('etf_autobuy' in vor), 'nicht in den Settings');
  assert.equal(vor.fee_pool_cent, 0, 'fee_pool_cent steht als interner Schlüssel in den Settings');
  for (const wert of [0, 1, 0.5, 'abc']) {
    const r = await api('PUT', '/admin/settings', { token, body: { etf_autobuy: wert, mm_spread_bp: 123 } });
    assert.equal(r.status, 400, `etf_autobuy=${wert}: ${r.status}`);
    assert.match(r.json.error, /etf_autobuy ist keine Einstellung mehr/);
    assert.equal(r.json.settings, undefined);
  }
  // Einzeln gesendet: 400. Zusammen mit einem gültigen Schlüssel: ebenfalls 400 und der gültige wird NICHT gesetzt (nichts Halbes).
  const tabelle = Object.fromEntries(dbRead((d) => d.prepare('SELECT key, value FROM settings').all()).map((r) => [r.key, JSON.parse(r.value)]));
  assert.deepEqual(tabelle, vor, 'Tabelle unverändert');
  assert.equal(tabelle.mm_spread_bp, vor.mm_spread_bp);
  // fee_pool_cent: kein gültiger Admin-Schlüssel — wird wie ein unbekannter ignoriert, nicht angefasst.
  const pool = await api('PUT', '/admin/settings', { token, body: { fee_pool_cent: 5000 } });
  assert.deepEqual([pool.status, pool.json.settings.fee_pool_cent], [200, 0], 'Pool bleibt');
});

test('Alt-DB mit liegen gebliebener Zeile etf_autobuy: db.js lädt ohne Absturz, die Zeile bleibt unangetastet, es gibt kein Default mehr', () => {
  const name = `settings-alt-${process.pid}.db`;
  const datei = path.join(DATA, name);
  const env = { ...process.env, DB_NAME: name };
  try {
    // Alter Stand herstellen: Zeile anlegen, wie sie ein früherer Server hinterlassen hat.
    const alt = spawnSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const d = new Database(${JSON.stringify(datei)});
      d.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      d.prepare("INSERT INTO settings VALUES ('etf_autobuy', '1'), ('mm_version', '3')").run();
      d.close();
    `], { encoding: 'utf8', env });
    assert.equal(alt.status, 0, alt.stderr);
    const r = spawnSync(process.execPath, ['-e', `
      const d = require(${JSON.stringify(path.join(SERVER, 'db.js'))});
      const t = Object.fromEntries(d.db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)]));
      console.log(JSON.stringify({ hat: 'etf_autobuy' in d.getSettings(), zeile: t.etf_autobuy, autobuyDefault: d.DEFAULT_SETTINGS.etf_autobuy,
        pool: [t.fee_pool_cent, d.getSettings().fee_pool_cent], gebuehr: d.DEFAULT_SETTINGS.bot_fee_cent }));
      d.db.close();
    `], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `db.js laden mit alter etf_autobuy-Zeile: ${r.stderr}`);
    const z = JSON.parse(r.stdout);
    // db.js bildet den Cache aus allen Tabellenzeilen: die alte Zeile steht dort mit (1), ist aber kein Default und kein Code liest sie.
    assert.deepEqual([z.hat, z.zeile, z.autobuyDefault], [true, 1, undefined], 'Zeile bleibt liegen, kein Default');
    assert.deepEqual(z.pool, [0, 0], 'fee_pool_cent: Default 0 in Tabelle und Cache');
    assert.equal(z.gebuehr, 0, 'bot_fee_cent Default 0');
  } finally {
    for (const ende of ['', '-wal', '-shm']) fs.rmSync(datei + ende, { force: true });
  }
});

test('Fehlerfall: ohne Login abgewiesen, als normaler Spieler 403, unbekannter Schlüssel wird nicht angelegt', async () => {
  const anon = await api('PUT', '/admin/settings', { body: { news_interval_sec: 5 } });
  assert.ok([401, 403].includes(anon.status), `ohne Login: ${anon.status}`);
  const name = `spieler-${process.pid}`;
  const reg = await api('POST', '/auth/register', { body: { username: name, password: 'geheim123' } });
  assert.equal(reg.status, 200, `Registrierung: ${JSON.stringify(reg.json)}`);
  const spieler = await api('PUT', '/admin/settings', { token: reg.json.token, body: { news_interval_sec: 5 } });
  assert.equal(spieler.status, 403, `als Spieler: ${spieler.status}`);
  const token = await login(ADMIN.username, ADMIN.password);
  await api('PUT', '/admin/settings', { token, body: { mm_min_ask_shares: 1800, kein_schluessel: 7 } });
  assert.equal(dbRead((d) => d.prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get('kein_schluessel').c), 0);
  assert.equal((await api('GET', '/admin/settings', { token })).json.settings.mm_min_ask_shares, 1800);
});

test('addNews: ein ungültiger impact wirft TypeError statt still 0 zu schreiben; undefined und null bedeuten 0', () => {
  const name = `settings-impact-${process.pid}.db`;
  const datei = path.join(DATA, name);
  const r = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const d = require(${JSON.stringify(path.join(SERVER, 'db.js'))});
    const aus = [];
    for (const wert of [9, -4, 1.5, '2', NaN, {}, true]) {
      assert.throws(() => d.addNews('news', 'Titel', '', null, wert), TypeError);
      aus.push(typeof wert === 'object' ? 'Objekt' : String(wert));
    }
    const nuller = d.addNews('news', 'Ohne', '', null, null);
    const leer = d.addNews('news', 'Leer', '');
    const gross = d.addNews('rumor', 'Gerücht', '', 2, -3);
    d.db.close();
    console.log(JSON.stringify({ aus, nuller, leer, gross }));
  `], { encoding: 'utf8', env: { ...process.env, DB_NAME: name } });
  assert.equal(r.status, 0, r.stderr);
  try {
    const { aus, nuller, leer, gross } = JSON.parse(r.stdout);
    assert.deepEqual(aus, ['9', '-4', '1.5', '2', 'NaN', 'Objekt', 'true'], 'jeder ungültige Wert ist geworfen');
    const zeilen = dbRead2(datei);
    assert.deepEqual(zeilen.map((z) => [z.title, z.impact, z.security_id]), [['Ohne', 0, null], ['Leer', 0, null], ['Gerücht', -3, 2]], 'keine Zeile aus abgewiesenen Aufrufen');
    assert.deepEqual([nuller.impact, leer.impact, gross.impact], [0, 0, -3]);
  } finally {
    for (const ende of ['', '-wal', '-shm']) fs.rmSync(datei + ende, { force: true });
  }
});
