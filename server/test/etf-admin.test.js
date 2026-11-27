// Tests für Task T9 (PLAN v2, Vertrag V6, DESIGN §12): ETF im Admin anlegen.
// Erwartungen stehen im Plan, nicht im Code des Implementers. Eigener Server auf Port 3257 mit eigener,
// frisch geseedeter DB (etf-admin-<pid>.db, am Ende gelöscht); schoolstreet.db wird nie geöffnet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const DATA = path.join(SERVER, 'data');
const PORT = 3257;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = `etf-admin-${process.pid}.db`;
const ADMIN = { username: 'admin', password: 'ag123' };

let srv = null;
let token = null;
let n = 0;
let STOCKS = [];
let HAVE = {};

async function until(fn, ms = 20000, step = 100) {
  const end = Date.now() + ms;
  do {
    if (srv.child.exitCode !== null) throw new Error(`Server beim Start beendet (Code ${srv.child.exitCode}):\n${srv.output}`);
    try { if (await fn()) return; } catch { /* noch nicht da */ }
    await sleep(step);
  } while (Date.now() < end);
  throw new Error(`Server auf Port ${PORT} nicht erreichbar:\n${srv.output}`);
}
async function api(method, p, { auth = true, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}
const create = (body, opts) => api('POST', '/admin/etf/create-fund', { ...opts, body });

before(async () => {
  for (const f of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA, DB_NAME + f), { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: ADMIN.password }, stdio: 'ignore' });
  const child = spawn(process.execPath, [path.join(SERVER, 'index.js')], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(PORT), DB_NAME, ADMIN_PASSWORD: ADMIN.password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv = { child, output: '' };
  child.stdout.on('data', (d) => { srv.output += d; });
  child.stderr.on('data', (d) => { srv.output += d; });
  await until(async () => (await fetch(`${BASE}/api/securities`)).ok);
  const login = await api('POST', '/auth/login', { auth: false, body: ADMIN });
  token = login.json.token;
  assert.ok(token, `Admin-Login: ${login.status} ${JSON.stringify(login.json)}`);
  // Korb- und Bestandsdaten vom Server (so wie das Formular sie bekommt)
  const d = (await api('GET', '/admin/etf')).json;
  STOCKS = d.stocks;
  HAVE = Object.fromEntries(d.treasury_positions.map((p) => [p.ticker, p.amount]));
  // Ohne den Depotbestand der Staatskasse sind die Bestandsfälle nicht prüfbar
  assert.ok(HAVE[STOCKS[0].ticker] >= 50, `Staatskasse hält nach dem Seed zu wenig ${STOCKS[0].ticker}: ${HAVE[STOCKS[0].ticker]}`);
});
after(async () => {
  if (srv && srv.child.exitCode === null) {
    const exited = once(srv.child, 'exit');
    srv.child.kill('SIGINT');
    // Der Server beendet sich von selbst (index.js shutdown); nach 5 s wird hart beendet,
    // damit ein hängender Server den Testlauf nie offen hält.
    const force = setTimeout(() => srv.child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
  for (const f of ['', '-wal', '-shm']) fs.rmSync(path.join(DATA, DB_NAME + f), { force: true });
});

const adminEtf = async () => (await api('GET', '/admin/etf')).json;
const etfCount = async () => (await adminEtf()).etfs.length;
// Detail eines Werts (öffentlich), so wie die Werteseite ihn lädt
const security = async (id) => {
  const r = await api('GET', `/securities/${id}`, { auth: false });
  assert.equal(r.status, 200, `GET /api/securities/${id}: ${JSON.stringify(r.json)}`);
  return r.json.security;
};

// Gültiger Antrag, den jeder Test nach Bedarf ändert. Der Korb bleibt klein, damit ihn die
// Staatskasse nach dem Seed unquotiert im Depot hat.
// Eindeutiges Kürzel aus Buchstaben (TAA X, TAB X, …): das Kürzel darf keine Ziffern enthalten
const TICK = () => { const k = ++n - 1; return `T${String.fromCharCode(65 + Math.floor(k / 26))}${String.fromCharCode(65 + (k % 26))}X`; };
function valid(over = {}) {
  return {
    ticker: TICK(), name: 'Schulhof-Index', shares_per_unit: 1, initial_units: 10, description: 'Alles, was auf dem Schulhof Geld verdient.',
    basket: [{ stock_id: STOCKS[0].id, qty: 2 }, { stock_id: STOCKS[1].id, qty: 1 }],
    ...over,
  };
}
test('(a) Korb im Treasury-Bestand: ETF wird angelegt, Beschreibung gespeichert, NAV > 0, in GET /api/securities sichtbar', async () => {
  const count = await etfCount();
  const have0 = { ...HAVE };
  const r = await create(valid({ ticker: 'klima', description: '  Firmen, die das Klima schützen.  ' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.ok(r.json.security_id > 0, 'Antwort {ok:true, security_id}');
  const list = (await api('GET', '/securities', { auth: false })).json.securities;
  const row = list.find((s) => s.id === r.json.security_id);
  assert.ok(row, 'der neue ETF steht in GET /api/securities');
  assert.equal(row.ticker, 'KLIMA', 'Kürzel wird in Großbuchstaben gespeichert');
  assert.equal(row.type, 'etf');
  const info = await security(r.json.security_id);
  assert.equal(info.description, 'Firmen, die das Klima schützen.', 'Beschreibung getrimmt gespeichert');
  assert.equal(info.name, 'Schulhof-Index');
  const nav = (await adminEtf()).etfs.find((e) => e.id === r.json.security_id);
  assert.ok(nav && nav.nav_per_share > 0, `NAV je Anteil fehlt: ${JSON.stringify(nav)}`);
  assert.equal((await etfCount()), count + 1);
  // Korb × Anteile bei Start wandert aus dem Depot der Staatskasse — und nichts wird gekauft
  const have = Object.fromEntries((await adminEtf()).treasury_positions.map((p) => [p.ticker, p.amount]));
  assert.equal(have[STOCKS[0].ticker], have0[STOCKS[0].ticker] - 2 * 10);
  assert.equal(have[STOCKS[1].ticker], have0[STOCKS[1].ticker] - 1 * 10);
  assert.equal(nav.total_shares, 10, 'Umlauf = Anteile bei Start · Aktien je Anteil');
});

test('(a) Ohne Beschreibung steht der Standardtext; Aktien je Anteil > 1 teilt den NAV', async () => {
  const r = await create({ ticker: TICK(), name: 'Zweiter Test', shares_per_unit: 2, initial_units: 5,
    basket: [{ stock_id: STOCKS[2].id, qty: 4 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await security(r.json.security_id)).description, 'Schul-ETF (Indexfonds)');
  const e = (await adminEtf()).etfs.find((x) => x.id === r.json.security_id);
  assert.equal(e.shares_per_unit, 2);
  assert.equal(e.total_shares, 10);
  assert.equal(e.nav_per_share, e.basket_value / 2);
});

test('(b) Ohne Treasury-Bestand: 400 mit „es fehlen“, Kürzel und Stückzahl — es wird nichts angelegt', async () => {
  const count = await etfCount();
  const [a, b] = STOCKS;
  const r = await create(valid({ basket: [{ stock_id: a.id, qty: 1 }, { stock_id: b.id, qty: Math.floor((HAVE[b.ticker] + 40) / 10) + 1 }] }));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /Die Staatskasse hat zu wenig/);
  assert.match(r.json.error, /es fehlen/);
  assert.ok(r.json.error.includes(b.ticker), `Meldung nennt das fehlende Kürzel: ${r.json.error}`);
  assert.match(r.json.error, /es fehlen \d+ Stück\./, 'Meldung nennt die Stückzahl');
  assert.equal(await etfCount(), count, 'kein halber ETF');
  const list = (await api('GET', '/securities', { auth: false })).json.securities;
  assert.equal(list.filter((x) => x.type === 'etf').length, count, 'kein halber ETF in der Werteliste');
});

test('(b) Reicht schon der Korb für 1 Anteil nicht: Fehlmenge stimmt auf das Stück', async () => {
  const a = STOCKS[3];
  const need = HAVE[a.ticker] + 7;
  const r = await create(valid({ basket: [{ stock_id: a.id, qty: need }], initial_units: 1 }));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.error, `Die Staatskasse hat zu wenig ${a.ticker}: es fehlen 7 Stück.`);
});

test('(c) Doppeltes Kürzel: erstes Mal 200, zweites Mal 409 — auch bei doppelt abgesendetem Antrag', async () => {
  const body = valid({ ticker: 'DOPPEL' });
  const first = await create(body);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const count = await etfCount();
  const again = await create(body);
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.match(again.json.error, /Kürzel gibt es schon/);
  assert.equal(await etfCount(), count, 'Doppel-Anlage verhindert');
});

test('(c) Kürzel, das ein bestehender Wert trägt (SETF aus dem Seed, Kleinbuchstaben): 409', async () => {
  const r = await create(valid({ ticker: 'setf' }));
  assert.equal(r.status, 409, JSON.stringify(r.json));
});

test('(d) Leerer Korb: 400 mit Satz — ohne Liste, mit leerer Liste, nur Nullen, ohne Feld basket', async () => {
  for (const basket of [undefined, null, [], [{ stock_id: STOCKS[0].id, qty: 0 }]]) {
    const r = await create(valid({ basket }));
    assert.equal(r.status, 400, `Korb ${JSON.stringify(basket)}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /mindestens eine Aktie/);
  }
});

test('Brüche, negative Zahlen und Unfug im Korb werden abgelehnt (400), nicht still gerundet', async () => {
  const id = STOCKS[0].id;
  for (const basket of [
    [{ stock_id: id, qty: 0.6 }], [{ stock_id: id, qty: 2.5 }], [{ stock_id: id, qty: -3 }], [{ stock_id: id, qty: 'abc' }],
    [{ stock_id: id, qty: null }], [{ stock_id: id }], [{ stock_id: 1.5, qty: 1 }], [{ stock_id: -1, qty: 1 }], [{ stock_id: null, qty: 1 }],
    [{ qty: 1 }], ['MENSA'], [null], 'MENSA',
  ]) {
    const r = await create(valid({ basket }));
    assert.equal(r.status, 400, `Korb ${JSON.stringify(basket)}: ${JSON.stringify(r.json)}`);
    assert.doesNotMatch(r.json.error, /\[object|undefined|null|NaN/);
    assert.equal(typeof r.json.error, 'string');
  }
  // Zahlenwerte: negative, Bruch, Text, Infinity, 1e21
  for (const over of [
    { shares_per_unit: 0 }, { shares_per_unit: -1 }, { shares_per_unit: 1.5 }, { shares_per_unit: 'x' }, { shares_per_unit: null },
    { shares_per_unit: Infinity }, { shares_per_unit: 1e21 }, { shares_per_unit: {} }, { shares_per_unit: true },
    { initial_units: -5 }, { initial_units: 2.5 }, { initial_units: 'drei' }, { initial_units: Infinity }, { initial_units: 1e21 },
    { initial_units: [] }, { initial_units: 1e15 },
  ]) {
    const r = await create(valid(over));
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /ganze Zahl|höchstens/);
  }
});

test('(d) Gleiche Aktie zweimal im Antrag wird zusammengezählt, Einträge mit 0 fallen weg', async () => {
  const r = await create(valid({ basket: [{ stock_id: STOCKS[0].id, qty: 1 }, { stock_id: STOCKS[0].id, qty: 2 }, { stock_id: STOCKS[1].id, qty: 0 }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = (await adminEtf()).etfs.find((x) => x.id === r.json.security_id);
  assert.deepEqual(e.items.map((i) => [i.stock_id, i.qty]), [[STOCKS[0].id, 3]]);
});

test('(e) Beschreibung über 200 Zeichen: 400; genau 200 Zeichen werden angenommen', async () => {
  const long = await create(valid({ description: 'x'.repeat(201) }));
  assert.equal(long.status, 400, JSON.stringify(long.json));
  assert.match(long.json.error, /200 Zeichen/);
  const edge = await create(valid({ description: 'x'.repeat(200) }));
  assert.equal(edge.status, 200, JSON.stringify(edge.json));
  assert.equal((await security(edge.json.security_id)).description.length, 200);
});

test('Ungültiger Antrag: 400 mit deutschem Satz — Kürzel, Name, Zahlen, unbekannter oder nicht handelbarer Wert', async () => {
  const cases = [
    [{ ticker: {} }, /müssen Text sein/],
    [{ ticker: 123456 }, /müssen Text sein/],
    [{ name: ['a', 'b'] }, /müssen Text sein/],
    [{ description: { text: 'x' } }, /müssen Text sein/],
    [{ description: 42 }, /müssen Text sein/],
    [{ name: 123456 }, /müssen Text sein/],
    [{ name: null }, /Name braucht/],
    [{ ticker: 'AB' }, /3 bis 6 Buchstaben/],
    [{ ticker: 'AB1CD' }, /3 bis 6 Buchstaben/],
    [{ ticker: '   ' }, /3 bis 6 Buchstaben/],
    [{ name: '' }, /Name braucht/],
    [{ name: 'AB' }, /Name braucht 3 bis 60 Zeichen/],
    [{ name: 'x'.repeat(61) }, /Name braucht 3 bis 60 Zeichen/],
    [{ shares_per_unit: 0 }, /ganze Zahl ab 1/],
    [{ initial_units: 0 }, /ganze Zahl ab 1/],
    [{ basket: [{ stock_id: 99999999, qty: 1 }] }, /nicht handelbar/],
    [{ basket: [{ stock_id: (await adminEtf()).etfs[0].id, qty: 1 }] }, /nicht handelbar/],
  ];
  for (const [over, re] of cases) {
    const r = await create(valid(over));
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, re, JSON.stringify(over));
  }
});

test('Nur die Admin-Sitzung darf anlegen: ohne Token 401', async () => {
  const r = await create(valid({ ticker: TICK() }), { auth: false });
  assert.equal(r.status, 401, JSON.stringify(r.json));
});

test('Obergrenzen wie im Formular: Aktien je Anteil 100, Anteile bei Start 100 000, Stück je Anteil 100 000 — darüber 400', async () => {
  for (const over of [{ shares_per_unit: 101 }, { shares_per_unit: 100000 }, { initial_units: 100001 }, { initial_units: 1e6 }]) {
    const r = await create(valid(over));
    assert.equal(r.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /höchstens/);
  }
  const viel = await create(valid({ initial_units: 100001, basket: [{ stock_id: STOCKS[0].id, qty: 1 }] }));
  assert.equal(viel.status, 400);
  const stueck = await create(valid({ basket: [{ stock_id: STOCKS[0].id, qty: 100001 }] }));
  assert.equal(stueck.status, 400, JSON.stringify(stueck.json));
  assert.match(stueck.json.error, /höchstens 100000/);
  // Genau die Grenze ist erlaubt: Aktien je Anteil 100, Stock 1 (kein Bestandsproblem: 100 · 1 Stück für 10 Anteile)
  const grenze = await create(valid({ shares_per_unit: 100, initial_units: 10, basket: [{ stock_id: STOCKS[0].id, qty: 1 }] }));
  assert.equal(grenze.status, 200, JSON.stringify(grenze.json));
  const e = (await adminEtf()).etfs.find((x) => x.id === grenze.json.security_id);
  assert.equal(e.shares_per_unit, 100);
  assert.ok(e.nav_per_share > 0);
});

test('Zwei gleiche Anträge gleichzeitig: genau eins gewinnt (200), das andere 409 — kein zweiter ETF', async () => {
  const body = valid({ ticker: 'RENN' });
  const count = await etfCount();
  const [a, b] = await Promise.all([create(body), create(body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `${JSON.stringify([a.json, b.json])}`);
  assert.equal(await etfCount(), count + 1);
});

test('Ein Wert, der nicht mehr handelbar ist, kommt nicht in den Korb: 400 mit Satz', async () => {
  const d = new Database(path.join(DATA, DB_NAME));
  try {
    d.prepare("UPDATE securities SET status = 'inactive' WHERE id = ?").run(STOCKS[3].id);
    const r = await create(valid({ basket: [{ stock_id: STOCKS[0].id, qty: 1 }, { stock_id: STOCKS[3].id, qty: 1 }] }));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /nicht handelbar/);
    assert.equal((await adminEtf()).stocks.some((x) => x.id === STOCKS[3].id), false, 'inaktiver Wert steht nicht zur Auswahl');
  } finally {
    d.prepare("UPDATE securities SET status = 'active' WHERE id = ?").run(STOCKS[3].id);
    d.close();
  }
});

test('Kein Admin, aber angemeldet: 403', async () => {
  const u = `etf-nutzer-${process.pid}`;
  const reg = await api('POST', '/auth/register', { auth: false, body: { username: u, password: 'pw1234' } });
  assert.ok(reg.status < 300, `Registrierung: ${reg.status} ${JSON.stringify(reg.json)}`);
  const tok = (await api('POST', '/auth/login', { auth: false, body: { username: u, password: 'pw1234' } })).json.token;
  const admin = token;
  token = tok;
  try {
    const r = await create(valid({ ticker: TICK() }));
    assert.equal(r.status, 403, JSON.stringify(r.json));
    const g = await api('GET', '/admin/etf');
    assert.equal(g.status, 403, JSON.stringify(g.json));
  } finally {
    token = admin;
  }
});

// Rückrollung braucht einen Fehler mittendrin — das geht nur im selben Prozess wie die Engine.
// Eigener Prozess, eigene frisch geseedete DB; er setzt mmRecenter auf Werfen und legt an.
test('Fehler mittendrin: kein halber ETF — keine Zeile, kein Korb, kein Orderbuch, keine News, Depot unverändert, Kürzel wieder frei', () => {
  const name = `etf-admin-roll-${process.pid}.db`;
  const file = path.join(DATA, name);
  const env = { ...process.env, DB_NAME: name, ADMIN_PASSWORD: ADMIN.password };
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')], { env, stdio: 'ignore' });
  // Drei Stellen, an denen die Anlage mittendrin scheitern kann: das Einfügen der Wertzeile, das
  // Quotieren (strict) und die Start-News (hier durch einen Datenbank-Trigger, weil addNews in
  // etf.js fest verdrahtet ist). Jede muss alles zurückrollen — auch das Orderbuch im Speicher.
  const script = `
    const { db, q } = require('./db'); const engine = require('./engine'); const etf = require('./etf');
    engine.loadEngine();
    const s = q.secByTicker.get('MENSA'); const t = engine.treasury();
    const stand = () => ({
      etfs: db.prepare("SELECT COUNT(*) c FROM securities WHERE type='etf'").get().c,
      korb: db.prepare('SELECT COUNT(*) c FROM etf_baskets').get().c,
      news: db.prepare("SELECT COUNT(*) c FROM news WHERE kind = 'etf'").get().c,
      haben: engine.holdingOf(t.id, s.id), buecher: engine.books.size,
    });
    const orig = { list: engine.listSecurity, center: engine.mmRecenter };
    const anlegen = () => etf.createEtf({ ticker: 'ROLLX', name: 'Rollback Test', shares_per_unit: 1, initial_units: 2, basket: [{ stock_id: s.id, qty: 1 }] });
    const faelle = {
      einfuegen: () => { engine.listSecurity = () => { throw new Error('erzwungen: Einfügen scheitert'); }; },
      quotieren: () => { engine.mmRecenter = () => { throw new Error('erzwungen: Quotieren scheitert'); }; },
      news: () => db.exec("CREATE TRIGGER rollx_news BEFORE INSERT ON news WHEN NEW.title LIKE 'ETF-Start%' BEGIN SELECT RAISE(ABORT, 'erzwungen: News scheitert'); END"),
    };
    const aufraeumen = {
      einfuegen: () => { engine.listSecurity = orig.list; },
      quotieren: () => { engine.mmRecenter = orig.center; },
      news: () => db.exec('DROP TRIGGER rollx_news'),
    };
    const out = { vor: stand(), faelle: {} };
    for (const [fall, setzen] of Object.entries(faelle)) {
      setzen();
      let fehler = null;
      try { anlegen(); } catch (e) { fehler = e.message; }
      out.faelle[fall] = { fehler, nach: stand(), ticker: q.secByTicker.get('ROLLX') || null };
      aufraeumen[fall]();
    }
    // Danach ist alles beim Alten: dasselbe Anlegen geht durch
    let ok = null;
    try { ok = anlegen().ticker; } catch (e) { ok = 'Fehler: ' + e.message; }
    out.danach = { ok, stand: stand() };
    console.log(JSON.stringify(out));
  `;
  try {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: SERVER, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(out.vor.etfs, 1, 'der Seed legt genau einen ETF');
    assert.ok(out.vor.buecher > 1);
    for (const fall of Object.keys(out.faelle)) {
      const f = out.faelle[fall];
      assert.match(f.fehler, /erzwungen/, fall);
      assert.equal(f.nach.etfs, out.vor.etfs, `${fall}: keine ETF-Zeile`);
      assert.equal(f.nach.korb, out.vor.korb, `${fall}: keine Korbzeile`);
      assert.equal(f.nach.news, out.vor.news, `${fall}: keine Start-News`);
      assert.equal(f.nach.haben, out.vor.haben, `${fall}: Depot der Staatskasse unverändert`);
      assert.equal(f.nach.buecher, out.vor.buecher, `${fall}: Orderbuch des angefangenen ETF ist weg`);
      assert.equal(f.ticker, null, `${fall}: Kürzel wieder frei`);
    }
    assert.equal(out.danach.ok, 'ROLLX', 'nach den Fehlern ist das Kürzel frei und die Anlage klappt');
    assert.equal(out.danach.stand.buecher, out.vor.buecher + 1, 'genau ein Orderbuch mehr');
  } finally {
    for (const f of ['', '-wal', '-shm']) fs.rmSync(file + f, { force: true });
  }
});
