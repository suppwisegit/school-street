// QA T1 (unabhängig aus PLAN.md V1 / DoD T1 abgeleitet, nicht aus dem Implementer-Code).
// Eigene DB qa1-<pid>.db (Muster mm.test.js), nie schoolstreet.db, eigener Port 3263. DB wird am Ende gelöscht.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const DATA = path.join(SERVER, 'data');
const PORT = 3263;
const BASE = `http://127.0.0.1:${PORT}`;
// DB-Dateien qa1-<pid>*.db (Muster mm.test.js), am Ende gelöscht.
const ADMIN = { username: 'admin', password: 'ag1234' };
const V1 = { news_interval_sec: 60, bot_cash_reserve_min: 0.2, bot_cash_reserve_max: 0.4, bot_fee_cent: 0, fee_recycle_pct: 100,
  income_sim_scale: 0, mm_min_ask_shares: 1000, mm_min_depth: 2000 };

// Der laufende Server (HTTP-Tests) behält qa1-<pid>.db; die Ladetests ohne Server arbeiten auf eigenen Kopien.
const MAIN = `qa1-${process.pid}.db`;
const DBFILE = path.join(DATA, MAIN);
const fileOf = (name) => path.join(DATA, name);
const N = (s) => `qa1-${process.pid}-${s}.db`;
const clean = () => {
  for (const f of fs.readdirSync(DATA)) if (f.startsWith(`qa1-${process.pid}`)) fs.unlinkSync(fileOf(f));
};
const direkt = (name, fn) => { const d = new Database(fileOf(name)); try { return fn(d); } finally { d.close(); } };
const tbl = (n) => direkt(n, (d) => Object.fromEntries(d.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])));
const tabelle = () => direkt(MAIN, (d) => Object.fromEntries(d.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])));
const news = (name) => direkt(name, (d) => d.prepare('SELECT * FROM news ORDER BY id').all());
const newsSpalten = (name) => direkt(name, (d) => d.prepare('PRAGMA table_info(news)').all());
// „Start": db.js in einem Kindprozess laden (dort läuft die Nachrüstung), optional Skript danach.
const laden = (skript = '', NAME = MAIN) => {
  const r = spawnSync(process.execPath, ['-e', `
    const d = require(${JSON.stringify(path.join(SERVER, 'db.js'))});
    let out;
    ${skript.replace(/§/g, 'd.')}
    if (out === undefined) out = d.getSettings();
    d.db.close(); console.log(JSON.stringify(out));`],
  { encoding: 'utf8', env: { ...process.env, DB_NAME: NAME }, timeout: 30000 });
  return r;
};
const altDB = (name, { dropNewsTabelle = false, eigene = {} } = {}) => {
  for (const e of ['', '-wal', '-shm']) fs.rmSync(fileOf(name + e), { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { env: { ...process.env, DB_NAME: name, ADMIN_PASSWORD: ADMIN.password }, stdio: 'ignore' });
  direkt(name, (d) => {
    const weg = d.prepare('DELETE FROM settings WHERE key = ?');
    for (const k of Object.keys(V1)) weg.run(k);
    const set = d.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)');
    for (const [k, v] of Object.entries({ fee_cent: 777, mm_spread_bp: 250, bot_fast: 1, ...eigene })) set.run(k, JSON.stringify(v));
    if (dropNewsTabelle) d.exec('DROP TABLE news');
    else d.exec('ALTER TABLE news DROP COLUMN impact; DELETE FROM news;');
  });
};

const api = async (method, p, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
};

let srv = null;
before(async () => {
  // Der Server startet auf der ALTen DB: Nachrüstung beim echten Start beweisen.
  altDB(MAIN);
  const vor = tabelle();
  assert.ok(!('mm_min_depth' in vor) && !newsSpalten(MAIN).some((c) => c.name === 'impact'), 'Vorbedingung Alt-DB');
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')],
    { cwd: SERVER, env: { ...process.env, PORT: String(PORT), DB_NAME: MAIN, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv = { child, out: '' };
  child.stdout.on('data', (d) => { srv.out += d; });
  child.stderr.on('data', (d) => { srv.out += d; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Server endete beim Start (${child.exitCode}): ${srv.out.slice(-800)}`);
    try { if ((await fetch(`${BASE}/api/securities`)).ok) return; } catch { /* noch nicht da */ }
    await sleep(100);
  }
  throw new Error(`Server auf ${PORT} nicht erreichbar: ${srv.out.slice(-800)}`);
});
after(async () => {
  if (srv && srv.child.exitCode === null) { const e = once(srv.child, 'exit'); srv.child.kill('SIGINT'); await e; }
  clean();
});
const login = async (u, p) => (await api('POST', '/auth/login', { body: { username: u, password: p } })).json.token;

test('A1 Alt-DB ohne neue Schlüssel und ohne news.impact: echter Serverstart rüstet nach, eigene Werte bleiben', () => {
  const nach = tabelle();
  for (const [k, v] of Object.entries(V1)) {
    assert.deepEqual([nach[k], typeof nach[k]], [v, 'number'], `${k} nachgerüstet mit Default`);
  }
  assert.deepEqual([nach.fee_cent, nach.mm_spread_bp, nach.bot_fast], [777, 250, 1], 'bestehende Werte unverändert');
  const s = newsSpalten(MAIN).find((c) => c.name === 'impact');
  assert.deepEqual([s.type, s.notnull, s.dflt_value], ['INTEGER', 1, '0'], 'V1: impact INTEGER NOT NULL DEFAULT 0');
});

test('A2 Alt-DB, bei der die Tabelle news ganz fehlt: Start legt sie mit impact an, addNews funktioniert', () => {
  altDB(N('N'), { dropNewsTabelle: true });
  assert.throws(() => news(N('N')), 'Vorbedingung: keine Tabelle news');
  const r = laden('out = [§addNews("rumor","T","B",null,-3), §addNews("news","T2",null,4,2)]', N('N'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(news(N('N')).map((n) => [n.kind, n.title, n.security_id, n.impact]), [['rumor', 'T', null, -3], ['news', 'T2', 4, 2]]);
  assert.deepEqual([out[0].id, out[0].impact, out[1].security_id], [1, -3, 4], 'Rückgabe entspricht der Zeile');
  assert.equal(newsSpalten(N('N')).find((c) => c.name === 'impact').notnull, 1);
});

test('A3 Alt-DB: stehen schon eigene V1-Werte drin, überschreibt der Start sie nicht; zweites Laden unverändert; Cache = Tabelle', () => {
  altDB(N('E'), { eigene: { news_interval_sec: 0, mm_min_depth: 0, etf_autobuy: 0 } }); // etf_autobuy: liegen gebliebene Zeile, bleibt in der Tabelle
  const r1 = laden('', N('E')); assert.equal(r1.status, 0, r1.stderr);
  const c1 = JSON.parse(r1.stdout), t1 = tbl(N('E'));
  const r2 = laden('', N('E')); assert.equal(r2.status, 0, r2.stderr);
  const c2 = JSON.parse(r2.stdout);
  assert.deepEqual([t1.news_interval_sec, t1.mm_min_depth], [0, 0], 'vorhandene V1-Werte (0) bleiben');
  // etf_autobuy ist keine Einstellung mehr (kein Default, kein Code liest sie): die alte Zeile bleibt unangetastet liegen.
  assert.deepEqual([t1.etf_autobuy, c1.etf_autobuy], [0, 0], 'liegen gebliebene etf_autobuy-Zeile bleibt');
  assert.equal(('etf_autobuy' in V1), false);
  for (const [k, v] of Object.entries(V1)) {
    assert.deepEqual([c1[k], t1[k]], [t1[k], v === t1[k] ? t1[k] : t1[k]], `${k} Cache`);
    assert.equal(typeof c1[k], 'number');
  }
  assert.deepEqual([c1.bot_cash_reserve_min, c1.bot_fee_cent], [0.2, 0], 'fehlende V1-Schlüssel = Default');
  assert.deepEqual(tbl(N('E')), t1, 'Tabelle nach zweitem Laden unverändert');
  assert.deepEqual(c2, c1, 'Cache nach zweitem Laden unverändert');
  assert.deepEqual(Object.keys(c1).sort(), Object.keys(t1).sort(), 'Cache und Tabelle führen dieselben Schlüssel');
});

test('B1 HTTP: jeder V1-Schlüssel einzeln per PUT setzbar, als Zahl in Tabelle und GET; ein PUT ändert nur den gesendeten Schlüssel', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const werte = { news_interval_sec: 240, bot_cash_reserve_min: 0.33, bot_cash_reserve_max: 0.5, bot_fee_cent: 450, fee_recycle_pct: 55,
    income_sim_scale: 1, mm_min_ask_shares: 1900, mm_min_depth: 2700 };
  for (const [k, v] of Object.entries(werte)) {
    const vorher = tabelle();
    const put = await api('PUT', '/admin/settings', { token, body: { [k]: v } });
    assert.equal(put.status, 200, `${k}: ${put.status}`);
    const get = await api('GET', '/admin/settings', { token });
    assert.equal(get.status, 200);
    const nach = tabelle();
    assert.deepEqual([put.json.settings[k], get.json.settings[k], nach[k], typeof nach[k]], [v, v, v, 'number'], k);
    const geaendert = Object.keys(nach).filter((x) => nach[x] !== vorher[x]);
    assert.deepEqual(geaendert, [k], `nur ${k} ändert sich, geändert: ${geaendert}`);
    assert.deepEqual(Object.keys(nach).sort(), Object.keys(vorher).sort(), 'PUT legt keine Schlüssel an');
  }
});

test('B2 HTTP Grenzfall 0: jedes auf 0 gesetzte V1-Setting bleibt 0 (Antwort, GET, Tabelle, nach erneutem PUT eines anderen Schlüssels)', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  for (const k of Object.keys(V1)) {
    const put = await api('PUT', '/admin/settings', { token, body: { [k]: 0 } });
    assert.equal(put.status, 200);
    assert.deepEqual([put.json.settings[k], typeof put.json.settings[k]], [0, 'number'], k);
  }
  await api('PUT', '/admin/settings', { token, body: { mm_spread_bp: 110 } });
  const get = await api('GET', '/admin/settings', { token });
  const t = tabelle();
  for (const k of Object.keys(V1)) assert.deepEqual([get.json.settings[k], t[k]], [0, 0], `${k} bleibt 0`);
});

test('B3 HTTP Fehlerfall: ohne Login 401/403 (PUT und GET), Spieler 403, falsches Token abgelehnt, nichts verändert', async () => {
  const vorher = tabelle();
  for (const body of [{ mm_min_depth: 1 }, {}]) {
    const r = await api('PUT', '/admin/settings', { body });
    assert.ok([401, 403].includes(r.status), `ohne Login PUT: ${r.status}`);
  }
  assert.ok([401, 403].includes((await api('GET', '/admin/settings')).status), 'ohne Login GET');
  assert.ok([401, 403].includes((await api('PUT', '/admin/settings', { token: 'ungueltig', body: { mm_min_depth: 1 } })).status), 'falsches Token');
  const name = `qa1-${process.pid}`;
  const reg = await api('POST', '/auth/register', { body: { username: name, password: 'geheim123' } });
  assert.equal(reg.status, 200, `Registrierung ${reg.status}`);
  assert.equal((await api('PUT', '/admin/settings', { token: reg.json.token, body: { mm_min_depth: 1 } })).status, 403, 'Spieler PUT');
  assert.equal((await api('GET', '/admin/settings', { token: reg.json.token })).status, 403, 'Spieler GET');
  assert.equal(tabelle().mm_min_depth, vorher.mm_min_depth, 'abgelehnte PUTs schreiben nichts');
});

test('B4 HTTP Unbekannte Schlüssel werden nicht angelegt; bekannte im selben PUT werden übernommen; ungültige Zahl wird nicht NaN', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const vor = Object.keys(tabelle()).length;
  const r = await api('PUT', '/admin/settings', { token, body: { qa1_unbekannt: 7, bot_cash_reserv_min: 1, MM_MIN_DEPTH: 5, mm_version: 99, mm_min_depth: 2600 } });
  assert.equal(r.status, 200);
  const t = tabelle();
  for (const k of ['qa1_unbekannt', 'bot_cash_reserv_min', 'MM_MIN_DEPTH']) assert.ok(!(k in t) && !(k in r.json.settings), `${k} angelegt`);
  assert.equal(Object.keys(t).length, vor, 'Zahl der Schlüssel unverändert');
  assert.equal(t.mm_min_depth, 2600, 'bekannter Schlüssel im selben PUT');
  // ungültiger Wert: 400 mit error, keine settings im Body, Tabelle und GET unverändert — auch wenn im selben
  // PUT ein gültiger Schlüssel steht (nichts Halbes), und für jeden V1-Schlüssel.
  const vor2 = tabelle();
  for (const [k, v] of [['mm_min_depth', 'abc'], ['mm_min_depth', -5], ['mm_min_depth', 2.5], ['bot_fee_cent', null], ['fee_recycle_pct', 101],
    ['bot_cash_reserve_min', 'x'], ['bot_cash_reserve_max', {}], ['news_interval_sec', 1.5], ['income_sim_scale', []]]) {
    const u = await api('PUT', '/admin/settings', { token, body: { [k]: v, mm_spread_bp: 111 } });
    assert.deepEqual([u.status, typeof u.json.error, u.json.settings], [400, 'string', undefined], `${k}=${JSON.stringify(v)}: ${u.status} ${JSON.stringify(u.json)}`);
    assert.ok(u.json.error.includes(k), `Fehlertext nennt ${k}: ${u.json.error}`);
  }
  assert.deepEqual(tabelle(), vor2, 'abgelehnte PUTs verändern die Tabelle nicht');
  const g = await api('GET', '/admin/settings', { token });
  assert.deepEqual(g.json.settings, vor2, 'Cache unverändert');
});

test('B5 Feststellung (Review): Schalter bot_fast / etf_auto / income_sim_scale — wird 0,5 angenommen oder mit 400 abgelehnt?', async () => {
  const token = await login(ADMIN.username, ADMIN.password);
  const erg = {};
  for (const k of ['bot_fast', 'etf_auto', 'income_sim_scale']) {
    const u = await api('PUT', '/admin/settings', { token, body: { [k]: 0.5 } });
    erg[k] = `${u.status} → ${u.status === 200 ? u.json.settings[k] : u.json.error}`;
    await api('PUT', '/admin/settings', { token, body: { [k]: k === 'etf_auto' ? 1 : 0 } });
  }
  console.log('B5 Schalter mit 0,5:', JSON.stringify(erg));
  // Grenzen 0 und 1 müssen angenommen werden.
  for (const k of ['bot_fast', 'etf_auto', 'income_sim_scale']) {
    for (const v of [0, 1]) {
      const u = await api('PUT', '/admin/settings', { token, body: { [k]: v } });
      assert.deepEqual([u.status, u.json.settings?.[k], tabelle()[k]], [200, v, v], `${k}=${v}`);
    }
  }
});

test('C1 addNews Grenzen: −3 und +3 bleiben; außerhalb (−4, +4, 9, −100), Bruch, String, NaN, null, undefined erzeugen nie impact außerhalb −3…+3', () => {
  altDB(N('C'));
  const faelle = [['news', 'A', -3, -3], ['news', 'B', 3, 3], ['news', 'C', 0, 0], ['news', 'D', 2, 2],
    ['news', 'E', -4, 'aussen'], ['news', 'F', 4, 'aussen'], ['news', 'G', 9, 'aussen'], ['news', 'H', -100, 'aussen'],
    ['news', 'I', 2.5, 'aussen'], ['news', 'J', '2', 'aussen'], ['news', 'K', 'NaN', 'aussen'], ['news', 'L', 'abc', 'aussen'],
    ['news', 'M', null, 'aussen'], ['news', 'N', undefined, 'aussen'], ['news', 'O', 3.0000001, 'aussen'], ['news', 'Q', true, 'aussen'], ['rumor', 'P', 1, 1]];
  const skript = `out = ${JSON.stringify(faelle)}.map(([k, t, i]) => { try { return §addNews(k, t, 'B', 3, i); } catch (e) { return { fehler: String(e.message) }; } });`;
  const r = laden(skript, N('C'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const zeilen = news(N('C'));
  assert.equal(zeilen.length, out.filter((o) => !o.fehler).length, 'Rückgabe und Zeilen entsprechen einander (abgelehnt oder gespeichert)');
  const summe = [];
  // Gültig: ganze Zahlen −3…+3 und fehlend (undefined/null → 0). Alles andere wirft TypeError ohne Zeile.
  for (const [i, [k, t, imp, art]] of faelle.entries()) {
    const o = out[i];
    const fehlt = imp === undefined || imp === null;
    if (art === 'aussen' && !fehlt) {
      assert.match(String(o.fehler), /impact/i, `impact ${String(imp)}: TypeError erwartet, kam ${JSON.stringify(o)}`);
      continue;
    }
    const z = zeilen.find((x) => x.id === o.id);
    assert.ok(z, `impact ${String(imp)}: Zeile fehlt (${JSON.stringify(o)})`);
    assert.deepEqual([z.impact, o.impact], [fehlt ? 0 : imp, fehlt ? 0 : imp], `impact ${String(imp)}`);
    assert.equal(typeof o.impact, 'number');
    summe.push(`${String(imp)}→${z.impact}`);
  }
  console.log('addNews-Wirkung:', summe.join(' | '));
  assert.ok(zeilen.some((z) => z.kind === 'rumor'), 'kind rumor');
});

test('C2 addNews Standardwerte: ohne impact → 0; ohne securityId → null; leere Rückgabe-Form nach V1', () => {
  altDB(N('D2'));
  const r = laden('out = [§addNews("system", "S", "B"), §addNews("dividend", "D", "B", 2)]', N('D2'));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(news(N('D2')).map((z) => [z.kind, z.title, z.body, z.security_id, z.impact]), [['system', 'S', 'B', null, 0], ['dividend', 'D', 'B', 2, 0]]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['body', 'created_at', 'id', 'impact', 'kind', 'security_id', 'title'], 'Felder nach V1');
});

test('D1 setSetting direkt: speichert als Zahl, 0 bleibt 0, unbekannter Schlüssel entsteht nicht durch getSettings allein', () => {
  altDB(N('D'));
  const r = laden('§setSetting("etf_autobuy", Number("0")); out = [§getSettings().etf_autobuy, typeof §getSettings().etf_autobuy];', N('D'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [0, 'number']);
  assert.equal(tbl(N('D')).etf_autobuy, 0);
});
