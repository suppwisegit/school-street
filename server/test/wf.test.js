// T12: End-to-End-Tests echter Spielabläufe — HTTP + WebSocket gegen einen echten Serverprozess
// (Port 3292, eigene DB wf-<pid>.db aus seed.js, am Ende gelöscht). Jeder Test ist ein Ablauf,
// wie ihn ein Nutzer spielt: Schüler registrieren und handeln, Admin gibt einen Börsengang frei,
// legt einen ETF an und bedient das Panel, News entstehen aus dem Markt, Bots handeln.
//
// Kein Engine-/Job-Aufruf im Testprozess — nur HTTP, WebSocket und Lese-/Test-DB-Zugriffe
// (Gebühren-Pool lesen, Zeitstempel der IPO-News zurückdaten).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const PORT = 3292;
const DB_NAME = `wf-${process.pid}.db`;
const DB_FILE = path.join(SERVER, 'data', DB_NAME);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'wf-ag-3292';
const QUIET_TICKS_MS = 60000;      // der News-Job tacktet fest jede Sekunde: 60 Takte = 60 s Wanduhr
const BOT_RUN_MS = 60000;          // 60 s Bot-Markt = sechs 10-s-Fenster

async function until(fn, ms = 5000, step = 100) {
  const end = Date.now() + ms;
  let last;
  do {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(step);
  } while (Date.now() < end);
  throw new Error(`Zeitüberschreitung (${ms} ms)${last ? `: ${last.message}` : ''}`);
}

async function api(method, p, { token, body, raw } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/api${p}`, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}
const GET = (p, token) => api('GET', p, { token });
const POST = (p, body, token) => api('POST', p, { token, body: body ?? {} });
const PUT = (p, body, token) => api('PUT', p, { token, body });

// ---------- Server, WebSocket, Test-DB ----------
let srv = null;            // { child, output }
const serverLog = () => (srv ? srv.output : '');
const serverUp = () => srv && srv.child.exitCode === null && srv.child.signalCode === null;

// Der Server läuft im Kindmodus des Smoke-Läufers (run-smoke.js --serve): nur Loopback,
// endet mit dem Testprozess, löscht seine DB beim Beenden.
function startServer() {
  const child = spawn(process.execPath, [path.join(SERVER, 'run-smoke.js'), '--serve', DB_FILE], {
    cwd: SERVER,
    env: { ...process.env, PORT: String(PORT), DB_NAME, ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  srv = { child, output: '' };
  child.stdout.on('data', (d) => { srv.output += d; });
  child.stderr.on('data', (d) => { srv.output += d; });
  return until(async () => {
    if (child.exitCode !== null) throw new Error(`Server beim Start beendet (Code ${child.exitCode}):\n${srv.output}`);
    try { return (await fetch(`${BASE}/api/securities`)).ok; } catch { return false; }
  }, 20000, 100);
}

async function stopServer() {
  if (!serverUp()) return;
  const exited = once(srv.child, 'exit');
  srv.child.kill('SIGTERM');
  await exited;
  srv = null;
}

let dbw = null; // Schreibzugriff, nur für das Zurückdatieren des Zeitstempels einer News-Zeile
function dbWrite(fn) {
  if (!dbw) dbw = new Database(DB_FILE, { timeout: 5000 });
  return fn(dbw);
}
function dbRead(fn) {
  const d = new Database(DB_FILE, { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
const feePool = () => dbRead((d) => JSON.parse(d.prepare("SELECT value FROM settings WHERE key='fee_pool_cent'").get().value));
// Orders, für die eine Gebühr abgebucht wurde (orders.fee_charged) — auch die der Staatskasse (AP-Automatik)
const feeOrders = () => dbRead((d) => d.prepare('SELECT COUNT(*) c FROM orders WHERE fee_charged=1').get().c);
// Vom Generator erzeugte Markt-News (keine Ereignis-News, nicht vom Admin)
const autoNewsSince = (id) => dbRead((d) => d.prepare("SELECT * FROM news WHERE id > ? AND kind IN ('news','rumor') ORDER BY id").all(id))
  .filter((n) => !manualNews.has(n.id));
const manualNews = new Set();       // vom Admin im Panel geschriebene News (gleiche Art `news`/`rumor`)
const maxNewsId = () => dbRead((d) => d.prepare('SELECT COALESCE(MAX(id),0) m FROM news').get().m);

// Eine WebSocket-Verbindung wie der Browser sie öffnet; alle Nachrichten landen der Reihe nach in `wsAll`.
let ws = null;
const wsAll = [];
function openSocket(token) {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  ws.on('message', (raw) => { try { wsAll.push(JSON.parse(raw)); } catch { /* kein JSON */ } });
  return once(ws, 'open');
}
const wsMark = () => wsAll.length;
const wsSince = (mark, type) => wsAll.slice(mark).filter((m) => m.type === type);

// ---------- Ablauf-Helfer ----------
const rnd = Math.random().toString(36).slice(2, 7);
async function register(label) {
  const username = `wf_${label}_${rnd}`;
  const r = await POST('/auth/register', { username, password: 'geheim123' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...r.json, username };
}
const login = async (username, password = 'geheim123') => {
  const r = await POST('/auth/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const portfolio = async (tok) => (await GET('/portfolio', tok)).json;
const positionOf = async (tok, secId) => ((await portfolio(tok)).positions.find((p) => p.security_id === secId)?.amount) || 0;
const marketList = async () => (await GET('/securities')).json.securities;
const detail = async (secId, tok) => (await GET(`/securities/${secId}`, tok)).json;
const filled = (trades) => trades.reduce((a, t) => a + t.amount, 0);
const money = (trades) => trades.reduce((a, t) => a + t.price * t.amount, 0);
const sum = (xs) => xs.reduce((a, x) => a + x, 0);

// Größte Markt-Kauf-Order, die ein Konto gerade noch bezahlen kann (Vorschau, Stück für Stück
// ausgereift: die Ordergrenze und die tiefere Geldgrenze fallen beide heraus).
async function biggestAffordableBuy(secId, tok, fee, budget) {
  const one = await GET(`/securities/${secId}/preview?side=buy&type=market&amount=1`, tok);
  assert.equal(one.status, 200, one.json?.error);
  let lo = 0, hi = one.json.cap ?? 100000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const p = await GET(`/securities/${secId}/preview?side=buy&type=market&amount=${mid}`, tok);
    if (p.status === 200 && p.json.gross + fee <= budget) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------- Lauf ----------
const ctx = {}; // geteilte Beobachtungen: Startkurse, ruhiges Fenster, Ablauf-Objekte

before(() => {
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(DB_FILE + s, { force: true });
  execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
    { cwd: SERVER, env: { ...process.env, DB_NAME, ADMIN_PASSWORD }, stdio: 'ignore' });
});

after(async () => {
  try { if (ws) { ws.terminate(); ws = null; } } catch { /* schon zu */ }
  try { await stopServer(); } catch { /* schon beendet */ }
  try { if (dbw) dbw.close(); } catch { /* schon zu */ }
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(DB_FILE + s, { force: true });
});

// =============================================================================
test('Ablauf 1 · Schüler registriert sich, kauft mit fast dem ganzen Startkapital und verkauft wieder', { timeout: 40000 }, async (t) => {
  await startServer();
  assert.equal((await GET('/securities')).status, 200);
  ctx.admin = (await login('admin', ADMIN_PASSWORD)).token;
  ctx.game = (await GET('/game')).json;                 // fee_cent, start_capital
  ctx.startLast = Object.fromEntries((await marketList()).map((s) => [s.id, s.last]));
  await openSocket();                                  // Beamer-Ansicht: alles, was gepusht wird
  await until(() => wsAll[0]?.type === 'hello', 3000, 50);
  assert.equal(wsAll[0].type, 'hello', 'WebSocket: Begrüßung');
  await until(() => wsSince(0, 'tickerAll').length > 0, 6000, 100);

  const reg = await register('kim');
  const mark = wsMark();
  const tok = (await login(reg.username)).token;
  ctx.kim = { ...reg, token: tok };

  await t.test('Registrierung → Login → Startkapital', async () => {
    assert.ok(reg.token && reg.user?.role === 'user');
    assert.ok(tok, 'Login liefert einen Token');
    const me = (await GET('/auth/me', tok)).json;
    assert.equal(me.user.username, reg.username);
    const p = await portfolio(tok);
    assert.equal(p.cash, 1000000, '10 000 Cr Startkapital');
    assert.equal(p.cash, ctx.game.start_capital, 'Startkapital = Einstellung start_capital');
    assert.equal(p.positions.length, 0, 'frisches Konto ohne Position');
  });

  let stock;
  await t.test('Marktliste öffnen → Aktie öffnen: Kurs, Orderbuch, Band', async () => {
    const list = await marketList();
    assert.ok(list.filter((s) => s.type === 'stock').length >= 4, 'Marktliste zeigt Aktien');
    assert.ok(list.every((s) => s.bid != null && s.ask != null), 'jeder Wert mit Geld/Brief');
    stock = list.find((s) => s.type === 'stock' && s.bid !== s.ask);
    assert.ok(stock, 'keine handelbare Aktie mit Spread gefunden');
    const d = await detail(stock.id, tok);
    assert.equal(d.security.id, stock.id);
    assert.equal(d.security.last, stock.last, 'Aktienseite und Marktliste zeigen denselben Kurs');
    assert.ok(d.book.asks.length >= 2 && d.book.bids.length >= 1, 'MM-Staffel auf beiden Seiten');
    assert.ok(d.book.asks[0][0] > d.book.bids[0][0], 'keine Kreuzung');
    assert.ok(d.band.min < d.security.last && d.security.last < d.band.max, 'Kurs im Band');
    assert.equal(d.mine.amount, 0, 'noch nichts im Depot');
    t.diagnostic(`${stock.ticker}: last ${stock.last / 100} Cr, bid ${d.book.bids[0][0] / 100} / ask ${d.book.asks[0][0] / 100}, Band ${d.band.min / 100}–${d.band.max / 100}`);
  });

  let amount, buy, sell;
  const pool0 = feePool(), feeOrders0 = feeOrders();
  await t.test('Große Market-Order knapp unter der Kaufkraft: vollständig ausgeführt, ≥ 95 % umgesetzt', async () => {
    const fee = ctx.game.fee_cent;
    const cash0 = (await portfolio(tok)).cash;
    // knapp unter der Kaufkraft, mit Reserve für die Gebühr dieser Order und die des Verkaufs danach
    amount = await biggestAffordableBuy(stock.id, tok, fee, cash0 - fee);
    assert.ok(amount > 0, 'keine bezahlbare Stückzahl gefunden');
    const pv = (await GET(`/securities/${stock.id}/preview?side=buy&type=market&amount=${amount}`, tok)).json;
    assert.equal(pv.gross + fee <= cash0, true, 'Vorschau passt ins Guthaben');
    ws.send(JSON.stringify({ type: 'subscribe', security_id: stock.id })); // Aktienseite: Orderbuch und Trades live
    const markTrade = wsMark();
    buy = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount }, tok);
    assert.equal(buy.status, 200, buy.json?.error);
    assert.equal(buy.json.order.status, 'filled');
    assert.equal(buy.json.order.filled, amount);
    assert.equal(filled(buy.json.trades), amount, 'alle Stück ausgeführt');
    assert.equal(money(buy.json.trades), pv.gross, 'Vorschau = Ausführung');
    const spent = money(buy.json.trades);
    assert.ok(spent / cash0 >= 0.95, `nur ${(spent / cash0 * 100).toFixed(1)} % der Kaufkraft umgesetzt`);
    const trades = await until(() => { const x = wsSince(markTrade, 'trade'); return x.length && x; }, 5000, 50);
    assert.equal(sum(trades.map((x) => x.amount)), amount, 'WebSocket `trade`: dieselbe Stückzahl wie die Antwort');
    assert.ok(wsSince(markTrade, 'book').length > 0, 'WebSocket `book`: Orderbuch neu gepusht');
    t.diagnostic(`Markt-Kauf ${amount} Stück ${stock.ticker} zu ${(spent / 100).toFixed(2)} Cr (${(spent / cash0 * 100).toFixed(1)} % der Kaufkraft), ${buy.json.trades.length} Fills`);
  });

  await t.test('Depot zeigt die Position, Geld stimmt auf den Cent', async () => {
    const p = await portfolio(tok);
    const pos = p.positions.find((x) => x.security_id === stock.id);
    assert.ok(pos, 'Position fehlt im Depot');
    assert.equal(pos.amount, amount);
    // Der Einstand wird je Geschäft fortlaufend gerundet: höchstens ein Cent Abweichung je Fill.
    assert.ok(Math.abs(pos.avg_cost - money(buy.json.trades) / amount) <= buy.json.trades.length, `Einstandskosten ${pos.avg_cost} ≈ ${money(buy.json.trades) / amount}`);
    assert.equal(p.cash, 1000000 - money(buy.json.trades) - ctx.game.fee_cent);
  });

  await t.test('Wieder verkaufen: Orderbuch und Ticker konsistent, Gebühren landen im Pool', async () => {
    const cashBeforeSell = (await portfolio(tok)).cash;
    sell = await POST('/orders', { security_id: stock.id, side: 'sell', type: 'market', amount }, tok);
    assert.equal(sell.status, 200, sell.json?.error);
    assert.equal(filled(sell.json.trades), amount, 'alles verkauft');
    assert.equal(await positionOf(tok, stock.id), 0, 'Position weg');
    const p = await portfolio(tok);
    const fee = ctx.game.fee_cent;
    const gross = money(buy.json.trades), proceeds = money(sell.json.trades);
    const dump = JSON.stringify({ vor: cashBeforeSell, antwort: sell.json.cash, depot: p.cash, erloes: proceeds, gebuehr: fee,
      trades: sell.json.trades.map((x) => [x.price, x.amount, x.buyer]) });
    assert.equal(sell.json.cash, cashBeforeSell + proceeds - fee, `Cash in der Order-Antwort = Stand vor dem Verkauf + Erlös − Gebühr: ${dump}`);
    assert.equal(p.cash, sell.json.cash, `Depot zeigt denselben Kontostand wie die Order-Antwort: ${dump}`);
    // Der Pool wächst genau um eine Gebühr je gebührenpflichtiger Order — die zwei des Schülers und
    // die jeder anderen in der Zwischenzeit (die AP-Automatik kauft alle 5 s den ETF-Korb nach).
    const feeOrdersSince = feeOrders() - feeOrders0;
    assert.ok(feeOrdersSince >= 2, `Orders mit Gebühr seit dem Kauf: ${feeOrdersSince}`);
    assert.equal(feePool() - pool0, fee * feeOrdersSince, 'Pool wächst genau um die abgebuchten Gebühren');
    assert.equal(feePool() - pool0 >= 2 * fee, true, 'beide Gebühren des Schülers stehen im Pool');
    assert.ok(proceeds - gross <= 0 && gross - proceeds <= 0.03 * gross,
      `Hin- und Rückverkauf kostet außer den Gebühren höchstens den Spread: ${gross} → ${proceeds}`);
    // Geld bleibt erhalten: Startkapital − 2 Gebühren ± Spread; die Gebühren sind im Pool, nicht weg.
    assert.equal(p.cash + 2 * fee + (gross - proceeds), 1000000);
    const [d, row, tape] = [await detail(stock.id, tok), (await marketList()).find((s) => s.id === stock.id), null];
    assert.equal(d.security.last, row.last, 'Aktienseite und Ticker zeigen denselben Kurs');
    assert.ok(d.book.bids.length && d.book.asks.length, 'MM quotiert danach beidseitig');
    assert.ok(d.book.asks[0][0] > d.book.bids[0][0], 'keine Kreuzung');
    assert.ok(d.book.bids[0][0] <= d.security.last && d.security.last <= d.book.asks[0][0], 'Letzter Kurs zwischen Geld und Brief');
    assert.ok(d.band.min < d.security.last && d.security.last < d.band.max, 'Kurs im Band');
    assert.equal(d.tape.length >= 2 * buy.json.trades.length, true, 'Handelsliste führt die Geschäfte');
    assert.equal(d.mine.open_orders.length, 0, 'keine Order liegen geblieben');
    t.diagnostic(`${stock.ticker}: Verkaufserlös ${(proceeds / 100).toFixed(2)} Cr, Kurs ${d.security.last / 100}, Geld/Brief ${d.book.bids[0][0] / 100}/${d.book.asks[0][0] / 100}; Pool +${feePool() - pool0}c aus ${feeOrdersSince} Orders mit Gebühr`);
  });

  // Ab hier darf der Markt ruhen: der News-Job bekommt 60 Takte ohne_AUTO-News (Ablauf 3 wertet aus).
  await sleep(1500);
  ctx.quiet = { from: Date.now(), newsId: maxNewsId() };
});

// =============================================================================
test('Ablauf 2 · IPO: Schüler beantragt eine Firma, Admin gibt frei, Börsengang ist handelbar und News', { timeout: 30000 }, async (t) => {
  assert.ok(ctx.kim, 'Ablauf 1 muss zuerst laufen');
  const description = [
    'Wir sind die Kaffee-Küche E12 und verkaufen in der zweiten Pause heiße Getränke und belegte Brötchen.',
    'Standort: Gruppenraum neben der Mensa. Team: fünf Schüler der Elften.',
    'Angebot: Kaffee 1,50 Cr, Tee 1,20 Cr, Brötchen 2,00 Cr — alles selbst gemacht.',
    'Gewinn der letzten vier Wochen: 310 Cr. Damit kaufen wir eine zweite Thermoskanne.',
    'Risiken: Prüfungstage, wenig Laufkundschaft im Winter. Wir sparen 20 % zurück.',
    'Wir suchen zwei Leute aus der Zehnten für die große Pause.',
  ].join('\n');
  assert.ok(description.length > 400 && description.length <= 500 && description.split('\n').length >= 6, 'langer, mehrzeiliger Antrag');

  let appId, secId;
  await t.test('Antrag mit langem, mehrzeiligem Text → Admin sieht ihn ungekürzt', async () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const have = new Set((await marketList()).map((s) => s.ticker));
    let ticker = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    while (have.has(ticker)) ticker = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const a = await POST('/companies/apply', { name: `Kaffee-Küche E12 ${rnd} GmbH`, ticker, description }, ctx.kim.token);
    assert.equal(a.status, 200, a.json?.error);
    appId = a.json.id;
    const app = (await GET('/admin/ipo', ctx.admin)).json.applications.find((x) => x.id === appId);
    assert.ok(app, 'Antrag steht in der Freigabe-Liste');
    assert.equal(app.status, 'pending');
    assert.equal(app.description, description, 'Antragstext vollständig, mit allen Zeilenumbrüchen');
    ctx.ticker = ticker;
    t.diagnostic(`Antrag ${ticker}: ${description.length} Zeichen, ${description.split('\n').length} Zeilen`);
  });

  await t.test('Freigabe mit Startpreis und Stückzahl → sofort handelbar, genug Angebot, News per Push und im Feed', async () => {
    const mark = wsMark();
    const ap = await POST(`/admin/ipo/${appId}/approve`, { ipo_price: 12.5, founder_shares: 1000, float_shares: 400, threshold_mult: 1.5 }, ctx.admin);
    assert.equal(ap.status, 200, ap.json?.error);
    secId = ap.json.security_id;
    ctx.ipo = { secId };
    const row = (await marketList()).find((s) => s.id === secId);
    assert.ok(row && row.type === 'stock', 'neue Aktie steht in der Marktliste');
    assert.equal(row.last, 1250, 'Startkurs 12,50 Cr');
    const d = await detail(secId, ctx.kim.token);
    assert.ok(d.book.bids.length && d.book.asks.length, 'beidseitig quotiert');
    const askShares = sum(d.book.asks.map((x) => x[1]));
    const minAsk = (await GET('/admin/settings', ctx.admin)).json.settings.mm_min_ask_shares;
    assert.ok(askShares >= minAsk, `Angebot ${askShares} < mm_min_ask_shares ${minAsk}`);
    assert.equal(d.security.description, description, 'Beschreibung an der Aktie vollständig');
    const pushed = await until(() => wsSince(mark, 'news').find((n) => n.news.kind === 'ipo' && n.news.security_id === secId), 5000, 50);
    assert.ok(String(pushed.news.body).includes(description.split('\n')[0]), 'Push-News trägt den Antragstext');
    const feed = (await GET('/news?kind=ipo&security_id=' + secId)).json.news;
    assert.equal(feed.length, 1, 'genau eine Börsengang-News zu dieser Aktie');
    assert.equal(feed[0].id, pushed.news.id, 'Feed und Push sind dieselbe Zeile');
    assert.ok(feed[0].body.includes('Kaffee 1,50 Cr'), 'Konzept-Text (letzte Zeilen) steht in der News');
    ctx.ipo.newsId = feed[0].id;
    t.diagnostic(`${ctx.ticker}: Startkurs ${(row.last / 100).toFixed(2)} Cr, Angebot ${askShares} Stück (Mindest ${minAsk}), News id ${feed[0].id}`);
  });

  await t.test('Zweiter Schüler kauft 50 Stück sofort', async () => {
    const lea = await register('lea');
    const r = await POST('/orders', { security_id: secId, side: 'buy', type: 'market', amount: 50 }, lea.token);
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(filled(r.json.trades), 50, '50 Stück ausgeführt');
    assert.equal(await positionOf(lea.token, secId), 50);
    assert.ok((await detail(secId)).band.min <= (await marketList()).find((s) => s.id === secId).last, 'Kurs bleibt im Band');
    ctx.ipo.buyer = lea;
    t.diagnostic(`50 Stück zu Ø ${(money(r.json.trades) / 5000).toFixed(2)} Cr`);
  });

  await t.test('3 Stunden später (Zeitstempel zurückdatiert): keine IPO-Hervorhebung mehr fällig', async () => {
    // Dasselbe Modul, mit dem der Client „Neu an der Börse“ rechnet (client/src/ipo.js, V7).
    const { ipoHighlights } = await import(pathToFileURL(path.join(SERVER, '..', 'client', 'src', 'ipo.js')).href);
    const win = (await GET('/admin/settings', ctx.admin)).json.settings.ipo_highlight_sec;
    const feed = async () => (await GET(`/news?kind=ipo&security_id=${secId}&limit=100`)).json.news;
    const before = ipoHighlights(await feed(), Date.now(), win);
    assert.equal(before.length, 1, 'direkt nach dem Börsengang gilt die Aktie als neu');
    assert.equal(before[0].securityId, secId);
    const row = dbRead((d) => d.prepare('SELECT created_at c FROM news WHERE id=?').get(ctx.ipo.newsId));
    dbWrite((d) => d.prepare('UPDATE news SET created_at=? WHERE id=?').run(row.c - (win + 600) * 1000, ctx.ipo.newsId));
    const after = ipoHighlights(await feed(), Date.now(), win);
    assert.equal(after.length, 0, `nach ${win / 3600} h ist der Börsengang nicht mehr hervorgehoben`);
    t.diagnostic(`Fenster ${win / 3600} h: Hervorhebungen 1 → ${after.length}; News weiter im Feed (${(await feed()).length})`);
  });
});

// =============================================================================
test('Ablauf 4 · Admin legt einen ETF an, ein Schüler kann ihn sehen, kaufen und verkaufen', { timeout: 30000 }, async (t) => {
  const admin = ctx.admin;
  const before = (await GET('/admin/etf', admin)).json;
  const pick = (arr) => arr.slice(0, 3);

  let secId;
  await t.test('Oberflächen-Route create-fund: Beschreibung und drei Positionen', async () => {
    const stocks = pick(before.stocks);
    assert.equal(stocks.length, 3);
    const have = Object.fromEntries(before.treasury_positions.map((p) => [p.ticker, p.amount]));
    for (const s of stocks) assert.ok((have[s.ticker] || 0) >= 2, `Staatskasse hat zu wenig ${s.ticker}`);
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const ticker = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const description = 'Drei Werte aus dem Klassenzimmer: Mensa, Kaffee und der Kiosk vor der Aula.';
    const r = await POST('/admin/etf/create-fund', {
      name: `Klassenzimmer-ETF ${rnd}`, ticker, description,
      basket: stocks.map((s) => ({ stock_id: s.id, qty: 2 })), shares_per_unit: 2, initial_units: 5
    }, admin);
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.ok, true);
    secId = r.json.security_id;
    ctx.etf = { secId, stocks };
    const after = (await GET('/admin/etf', admin)).json;
    const mine = after.etfs.find((x) => x.id === secId);
    assert.ok(mine && mine.ticker === ticker, 'ETF steht in der Admin-Liste');
    assert.ok(mine.nav_per_share > 0, 'NAV > 0');
    assert.equal(mine.total_shares, 10, '5 Anteile × 2 Aktien je Anteil');
    // Bestand der Staatskasse: für jede Korbposition genau qty × units abgeflossen, sonst nichts
    const haveAfter = Object.fromEntries(after.treasury_positions.map((p) => [p.ticker, p.amount]));
    for (const s of stocks) assert.equal(haveAfter[s.ticker] - have[s.ticker], -10, `Staatskasse ${s.ticker}: 2 × 5 Stück in den ETF`);
    t.diagnostic(`${ticker}: NAV ${(mine.nav_per_share / 100).toFixed(2)} Cr, Korb ${stocks.map((x) => x.ticker).join(', ')}`);
  });

  await t.test('Schüler sieht den ETF in der Marktliste (Chip-Feld) und an der Aktienseite', async () => {
    const row = (await marketList()).find((s) => s.id === secId);
    assert.ok(row, 'ETF fehlt in /api/securities');
    assert.equal(row.type, 'etf', 'Feld für den ETF-Chip');
    assert.ok(row.bid != null && row.ask != null, 'handelbar: Geld und Brief');
    const d = await detail(secId, ctx.kim.token);
    assert.equal(d.security.type, 'etf');
    assert.equal(d.security.description, 'Drei Werte aus dem Klassenzimmer: Mensa, Kaffee und der Kiosk vor der Aula.');
    assert.ok(d.security.nav?.nav_per_share > 0, 'NAV an der Seite');
    assert.ok(Math.abs(d.security.last - d.security.nav.nav_per_share) <= 10, 'Kurs am NAV (± 1 Tick)');
    t.diagnostic(`${row.ticker}: last ${row.last / 100} Cr, NAV ${(d.security.nav.nav_per_share / 100).toFixed(2)}, bid/ask ${row.bid / 100}/${row.ask / 100}`);
  });

  await t.test('Schüler kauft eine Einheit und verkauft sie: Bestand bleibt konsistent', async () => {
    const tok = ctx.kim.token;
    const total = async () => (await GET('/admin/etf', ctx.admin)).json.etfs.find((x) => x.id === secId).total_shares;
    const cash0 = (await portfolio(tok)).cash;
    assert.equal(await total(), 10);
    const b = await POST('/orders', { security_id: secId, side: 'buy', type: 'market', amount: 1 }, tok);
    assert.equal(b.status, 200, b.json?.error);
    assert.equal(filled(b.json.trades), 1);
    assert.equal(await positionOf(tok, secId), 1, 'eine Einheit im Depot');
    const s = await POST('/orders', { security_id: secId, side: 'sell', type: 'market', amount: 1 }, tok);
    assert.equal(s.status, 200, s.json?.error);
    assert.equal(filled(s.json.trades), 1);
    assert.equal(await positionOf(tok, secId), 0, 'Einheit wieder weg');
    assert.equal(await total(), 10, 'Umlauf des ETF unverändert (keine Creation/Redemption)');
    const cash1 = (await portfolio(tok)).cash;
    assert.equal(cash0 - cash1, money(b.json.trades) - money(s.json.trades) + 2 * ctx.game.fee_cent, 'Geld: Kauf − Verkauf − 2 Gebühren');
    const d = await detail(secId, tok);
    assert.ok(Math.abs(d.security.last - d.security.nav.nav_per_share) <= 10, 'weiter am NAV');
    t.diagnostic(`Kauf ${(money(b.json.trades) / 100).toFixed(2)} Cr, Verkauf ${(money(s.json.trades) / 100).toFixed(2)} Cr, Cash-Delta ${(cash1 - cash0) / 100} Cr`);
  });
});

// =============================================================================
test('Ablauf 5 · Admin-Panel: Einstellungen, Schnellmodus, Bots, News', { timeout: 30000 }, async (t) => {
  const admin = ctx.admin;
  const settings = async () => (await GET('/admin/settings', admin)).json.settings;
  const orig = await settings();

  await t.test('Einstellungen speichern: gültige Werte werden übernommen', async () => {
    const r = await PUT('/admin/settings', { income_sec: 240, bot_count: 60, fee_cent: 1500, 'mm_spread_bp': 110, bot_cash_reserve_min: 0.25 }, admin);
    assert.equal(r.status, 200, r.json?.error);
    const s = await settings();
    assert.deepEqual([s.income_sec, s.bot_count, s.fee_cent, s.mm_spread_bp, s.bot_cash_reserve_min], [240, 60, 1500, 110, 0.25]);
  });

  await t.test('Ungültige Werte (NaN, Text, negativ, Bruch, außerhalb) → 400, nichts halb geschrieben', async () => {
    const bad = [
      ['income_sec', NaN], ['income_sec', 'abc'], ['income_sec', -5], ['fee_cent', '12ab'], ['bot_fast', 2],
      ['bot_cash_reserve_min', 1.5], ['bot_count', 2.5], ['ipo_highlight_sec', -1], ['fee_recycle_pct', 101],
      ['bot_activity', 'viele'], ['etf_autobuy', 1], ['income_sim_scale', 0.5], ['mm_min_depth', -100],
    ];
    for (const [k, v] of bad) {
      const r = await PUT('/admin/settings', { [k]: v }, admin);
      assert.equal(r.status, 400, `${k}=${String(v)}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.ok(r.json?.error, `${k}: Fehlermeldung fehlt`);
      assert.match(r.json.error, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${k}: Meldung nennt das Feld`);
    }
    const raw = await api('PUT', '/admin/settings', { token: admin, raw: '{"income_sec": NaN}' });
    assert.equal(raw.status, 400, 'wörtliches NaN im JSON-Körper');
    const mixed = await PUT('/admin/settings', { income_sec: 480, fee_cent: -1 }, admin);
    assert.equal(mixed.status, 400);
    const s = await settings();
    assert.equal(s.income_sec, 240, 'gültiger Teil desselben Requests ist NICHT gespeichert');
    assert.equal(s.fee_cent, 1500);
    assert.equal((await PUT('/admin/settings', { bot_cash_reserve_min: 0.9, bot_cash_reserve_max: 0.2 }, admin)).status, 400, 'min > max');
    assert.equal((await PUT('/admin/settings', { income_sec: 240 }, ctx.kim.token)).status, 403, 'Schüler darf nicht');
  });

  await t.test('Schnellmodus an und aus', async () => {
    const on = await PUT('/admin/bots/settings', { bot_fast: true }, admin);
    assert.equal(on.json?.fast, true);
    assert.equal((await settings()).bot_fast, 1);
    await sleep(300);
    const off = await PUT('/admin/bots/settings', { bot_fast: false }, admin);
    assert.equal(off.json?.fast, false);
    assert.equal((await settings()).bot_fast, 0);
  });

  let started;
  await t.test('Bots starten und stoppen', async () => {
    started = (await POST('/admin/bots/start', {}, admin)).json;
    assert.equal(started.running, true);
    assert.equal((await GET('/game')).json.bots_running, true);
    await sleep(3400); // ein Bot-Takt (bot_tick_sec = 3)
    const st = (await GET('/admin/bots', admin)).json;
    assert.equal(st.running, true);
    assert.ok(st.bots >= 1, `Bots angelegt: ${st.bots}`);
    const stopped = (await POST('/admin/bots/stop', {}, admin)).json;
    assert.equal(stopped.running, false);
    assert.equal((await GET('/game')).json.bots_running, false);
    t.diagnostic(`Bots ${st.bots}, Orders ${st.orders_this_run}, Trades ${st.trades_this_run} nach einem Takt; Fehler ${st.errors}`);
  });

  await t.test('Admin-News mit Wirkung: News und Gerücht landen im Feed und als Push', async () => {
    const secId = ctx.ipo?.secId || (await marketList()).find((s) => s.type === 'stock').id;
    const mark = wsMark();
    const n = await POST('/admin/news', { title: 'Bilanzpressekonferenz der Kaffee-Küche', body: 'Das Team rechnet vor der Oberstufe ab.', security_id: secId, kind: 'news', impact: 2 }, admin);
    assert.equal(n.status, 200, n.json?.error);
    assert.equal(n.json.news.impact, 2);
    assert.equal(n.json.news.security_id, secId);
    const r = await POST('/admin/news', { title: 'Investment AG hört: Mensa bald geschlossen?', body: 'Ein Gerücht aus der Pause — unbestätigt.', security_id: secId, kind: 'rumor', impact: -1 }, admin);
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(r.json.news.kind, 'rumor');
    assert.equal(r.json.news.impact, -1);
    manualNews.add(n.json.news.id).add(r.json.news.id);
    const pushed = await until(() => { const x = wsSince(mark, 'news'); return x.length >= 2 && x; }, 5000, 50);
    assert.deepEqual(pushed.map((x) => x.news.id), [n.json.news.id, r.json.news.id], 'beide News per WebSocket, in der Reihenfolge');
    const feed = (await GET(`/news?security_id=${secId}&kind=news,rumor&limit=5`)).json.news;
    assert.deepEqual(feed.map((x) => x.id).slice(0, 2), [r.json.news.id, n.json.news.id], 'Feed: jüngste zuerst, Filter kind=news,rumor');
    for (const impact of [4, -4, 1.5, '2', null]) {
      if (impact === null) continue;
      const bad = await POST('/admin/news', { title: 'Zu starke Wirkung', body: 'x', impact }, admin);
      assert.equal(bad.status, 400, `impact=${String(impact)} angenommen`);
    }
    assert.equal((await POST('/admin/news', { title: 'x', body: '', impact: 0 }, admin)).status, 400, 'Titel zu kurz');
    assert.equal((await POST('/admin/news', { title: 'Schüler schreibt mit', body: 'x', impact: 0 }, ctx.kim.token)).status, 403, 'Schüler darf keine News schreiben');
  });

  await t.test('Original-Einstellungen wiederhergestellt', async () => {
    const r = await PUT('/admin/settings', {
      income_sec: orig.income_sec, bot_count: orig.bot_count, fee_cent: orig.fee_cent, mm_spread_bp: orig.mm_spread_bp,
      bot_cash_reserve_min: orig.bot_cash_reserve_min,
    }, admin);
    assert.equal(r.status, 200, r.json?.error);
    const s = await settings();
    assert.deepEqual([s.income_sec, s.bot_count, s.fee_cent, s.mm_spread_bp, s.bot_cash_reserve_min, s.bot_fast],
      [orig.income_sec, orig.bot_count, orig.fee_cent, orig.mm_spread_bp, orig.bot_cash_reserve_min, 0]);
  });
});

// =============================================================================
test('Ablauf 3 · News entstehen aus dem Markt: ruhig = nichts, Kursbewegung über 5 % = genau eine Meldung', { timeout: 100000 }, async (t) => {
  assert.ok(ctx.quiet, 'Ablauf 1 muss zuerst laufen');
  const admin = ctx.admin;

  await t.test('Ruhiger Markt, 60 Takte: keine automatische News', async () => {
    const waited = ctx.quiet.from + QUIET_TICKS_MS + 500 - Date.now();
    if (waited > 0) await sleep(waited);
    const auto = autoNewsSince(ctx.quiet.newsId);
    assert.equal(auto.length, 0, `automatische News im ruhigen Markt: ${JSON.stringify(auto.map((n) => [n.kind, n.title]))}`);
    const since = autoNewsSince(0);
    t.diagnostic(`60 Takte ruhiger Markt: ${auto.length} neue Auto-News; Art news/rumor in der DB insgesamt: ${since.length}`);
  });

  let moved, row;
  await t.test('Kurs über das Orderbuch um mehr als 5 % bewegen: mehrere Schüler kaufen', async () => {
    const list = (await marketList()).filter((s) => s.type === 'stock');
    const target = list.filter((s) => s.id in ctx.startLast).sort((a, b) => a.last - b.last)[0]; // billigster Wert aus dem Seed
    const fee = ctx.game.fee_cent;
    // Eigener Maßstab: Kurs gegen den Stand beim Serverstart. Dazu der vom Server gemeldete Tagesstand
    // (chg gegen den 24-h-Kurs der Kurs-Historie) — derselbe Bezug, den der News-Generator benutzt.
    const chg = async () => (await detail(target.id)).security.last / ctx.startLast[target.id] - 1;
    const chgServer = async () => (await marketList()).find((x) => x.id === target.id).chg / 100;
    const [c0, cs0] = [await chg(), await chgServer()];
    assert.ok(c0 < 0.005 && Math.abs(cs0) < 0.04, `Ausgangslage: Wert nahe am Startkurs (Lauf ${(c0 * 100).toFixed(2)} %, Tagesstand ${(cs0 * 100).toFixed(2)} %)`);
    moved = { secId: target.id, ticker: target.ticker, chg0: c0, buyers: [], orders: [] };
    ctx.move = moved;
    for (const name of ['jan', 'noah', 'ema', 'oli', 'mia']) {
      const u = await register(name);
      moved.buyers.push(u);
      const p = await portfolio(u.token);
      // in Etappen: höchstens die Hälfte des Guthabens je Order, damit die Bewegung vor der 10-%-Stufe endet
      const n = Math.min(await biggestAffordableBuy(target.id, u.token, fee, p.cash - fee),
        await biggestAffordableBuy(target.id, u.token, fee, Math.floor(p.cash / 2)));
      assert.ok(n > 0, `${name}: nichts kaufbar`);
      const r = await POST('/orders', { security_id: target.id, side: 'buy', type: 'market', amount: n }, u.token);
      assert.equal(r.status, 200, `${name}: ${r.json?.error}`);
      assert.equal(filled(r.json.trades), n, `${name}: Order nicht vollständig ausgeführt`);
      moved.orders.push({ name, amount: n, chg: await chg() });
      const [c, cs] = [await chg(), await chgServer()];
      if (c >= 0.056 && cs >= 0.056) break;
    }
    moved.chg1 = await chg();
    assert.ok(moved.chg1 > 0.05, `Kurs nur um ${(moved.chg1 * 100).toFixed(2)} % bewegt (${moved.buyers.length} Käufer)`);
    moved.chgServer1 = await chgServer();
    assert.ok(moved.chgServer1 < 0.098, `Tagesstand ${(moved.chgServer1 * 100).toFixed(2)} % — zu weit für genau die 5-%-Stufe`);
    row = (await marketList()).find((s) => s.id === target.id);
    assert.equal(row.last / ctx.startLast[target.id] - 1 > 0.05, true, 'Marktliste zeigt den neuen Kurs');
    t.diagnostic(`${target.ticker}: ${(ctx.startLast[target.id] / 100).toFixed(1)} → ${(row.last / 100).toFixed(1)} Cr (+${(moved.chg1 * 100).toFixed(2)} %, Tagesstand ${row.chg} %): ${moved.orders.map((o) => `${o.name} ${o.amount} Stück → ${(o.chg * 100).toFixed(1)} %`).join(', ')}`);
  });

  await t.test('Genau eine Auslöser-News (5-%-Stufe) — im Feed und als WebSocket-Event `news`', async () => {
    const mark = wsMark();
    const id0 = maxNewsId();
    const pushed = await until(() => {
      const n = wsSince(mark, 'news').map((x) => x.news).find((x) => x.kind === 'news' && x.security_id === moved.secId);
      return n || null;
    }, 8000, 100);
    await sleep(2600); // drei weitere Takte: darf keine zweite Meldung folgen
    const auto = autoNewsSince(id0);
    assert.equal(auto.length, 1, `genau eine automatische News erwartet: ${JSON.stringify(auto.map((n) => [n.kind, n.security_id, n.title]))}`);
    const [n] = auto;
    assert.equal(n.id, pushed.id, 'Push und Datenbank sind dieselbe Zeile');
    assert.equal(n.kind, 'news');
    assert.equal(n.security_id, moved.secId);
    assert.equal(n.impact, 0, 'beschreibende Meldung der 5-%-Stufe ohne Kurs-Wirkung');
    assert.ok(n.title.startsWith(moved.ticker + ':'), `Titel nennt den Wert: ${n.title}`);
    // Der Text nennt die Bewegung gegen den Bezug des Generators (Kurs vor 24 h aus der Kurs-Historie),
    // nicht gegen den Startkurs dieses Laufs: eine ganze Prozentzahl in der 5-%-Stufe.
    const p = Number((n.body.match(/(\d+) %/) || [])[1]);
    assert.ok(p >= 5 && p < 10, `Text nennt die Bewegung (5 bis unter 10 %): ${n.body}`);
    for (const w of ['kräftig', 'stark', 'deutlich', 'weg', 'stürzt']) assert.ok(!n.title.includes(w), `Text der 10-/20-%-Stufe (${w}): ${n.title}`);
    const feed = (await GET('/news?limit=20')).json.news;
    assert.ok(feed.some((x) => x.id === n.id), 'News steht im Feed');
    t.diagnostic(`News ${n.id}: „${n.title}“ — ${n.body}`);
  });

  await t.test('Filter ?security_id= und ?kind= liefern nur Passendes', async () => {
    const n = autoNewsSince(ctx.quiet.newsId)[0];
    const bySec = (await GET(`/news?security_id=${moved.secId}&limit=100`)).json.news;
    assert.ok(bySec.length >= 1 && bySec.every((x) => x.security_id === moved.secId), 'nur News dieses Werts');
    assert.ok(bySec.some((x) => x.id === n.id), 'die Auslöser-News ist dabei');
    const byKind = (await GET('/news?kind=news&limit=100')).json.news;
    assert.ok(byKind.length >= 1 && byKind.every((x) => x.kind === 'news'), 'nur Art news');
    assert.ok(byKind.some((x) => x.id === n.id));
    const both = (await GET(`/news?kind=news&security_id=${moved.secId}&limit=100`)).json.news;
    assert.deepEqual(both.map((x) => x.id), [n.id].concat(both.map((x) => x.id).filter((i) => i !== n.id)));
    assert.ok(both.every((x) => x.kind === 'news' && x.security_id === moved.secId));
    const ipo = (await GET(`/news?kind=ipo&security_id=${ctx.ipo.secId}`)).json.news;
    // Kommt später eine Nachplatzierung dazu, trägt sie ebenfalls kind=ipo — die Börsengang-News steht jedenfalls darin.
    assert.ok(ipo.some((x) => x.id === ctx.ipo.newsId) && ipo.every((x) => x.kind === 'ipo' && x.security_id === ctx.ipo.secId),
      `Börsengang-News (Ablauf 2) per Filter gefunden: ${JSON.stringify(ipo.map((x) => x.title))}`);
    assert.equal((await GET('/news?kind=xyz')).status, 400, 'unbekannte Art → 400');
    assert.equal((await GET('/news?security_id=abc')).status, 400, 'keine Zahl → 400');
    // Nachplatzierungen tragen ebenfalls kind=ipo — dann müssen es genau solche Meldungen sein, sonst leer.
    const none = (await GET(`/news?kind=ipo&security_id=${moved.secId}`)).json.news;
    assert.ok(none.every((x) => x.kind === 'ipo' && x.security_id === moved.secId && /Nachplatzierung/.test(x.title)), `Kombination kind=ipo&security_id: nur Nachplatzierungen dieses Werts, kam ${JSON.stringify(none.map((x) => x.title))}`);
  });
});

// =============================================================================
test('Ablauf 6 · Bot-Markt 60 s im Normalmodus: gehandelt in jedem 10-s-Fenster, ruhige Kurse, Stop wirkt', { timeout: 100000 }, async (t) => {
  const admin = ctx.admin;
  const pick = async () => Object.fromEntries((await marketList()).filter((s) => s.type === 'stock').map((s) => [s.id, s.last]));
  const before = await pick();
  assert.ok(Object.keys(before).length >= 4, `Marktliste vor dem Bot-Start: ${Object.keys(before).length} Aktien`);
  const logMark = serverLog().length;
  const start = (await POST('/admin/bots/start', {}, admin)).json;
  assert.equal(start.fast, false, 'Normalmodus');
  assert.equal(start.running, true);
  const startedAt = Date.now();

  const windows = [];          // Trades je 10-s-Fenster
  const steps = new Map();     // secId → größter Kursschritt zwischen zwei Proben
  let last = before, lastTrades = 0;
  while (Date.now() - startedAt < BOT_RUN_MS) {
    await sleep(1000);
    const cur = await pick();
    for (const [id, p] of Object.entries(cur)) {
      if (last[id] === undefined) continue;
      steps.set(id, Math.max(steps.get(id) || 0, Math.abs(p / last[id] - 1)));
    }
    last = cur;
    const st = (await GET('/admin/bots', admin)).json;
    if ((windows.length + 1) * 10000 <= Date.now() - startedAt + 500) { windows.push(st.trades_this_run - lastTrades); lastTrades = st.trades_this_run; }
  }
  ctx.bots = { windows, steps, before };

  await t.test('Trades in jedem 10-s-Fenster > 0', async () => {
    const st = (await GET('/admin/bots', admin)).json;
    assert.equal(st.errors, 0, `Bot-Fehler: ${st.errors}`);
    assert.ok(st.bots >= 10, `Bots im Spiel: ${st.bots}`);
    assert.equal(windows.length, 6, `Fenster gezählt: ${windows.length}`);
    // Der Anspruch des Auftrags („Bots handeln über die ganze Spieldauer“) schon in der ersten Minute:
    // In jedem 10-s-Fenster mindestens ein Trade. Siehe Fundliste: bots.js staffelt den Einstieg
    // über ARRIVAL_MIN = 10 Spielminuten, im Normalmodus bleiben darum anfangs Fenster leer.
    assert.deepEqual(windows.map((w) => w > 0), [true, true, true, true, true, true], `Trades je 10-s-Fenster (Normalmodus, Minute 1): ${JSON.stringify(windows)}`);
    t.diagnostic(`Trades je 10 s: ${windows.join(' / ')} (gesamt ${st.trades_this_run}, Orders ${st.orders_this_run}, ${st.bots} Bots, Fehler ${st.errors})`);
  });

  await t.test('Größter Kursschritt je Aktie < 3 %', async () => {
    let worst = [null, 0];
    for (const [id, s] of steps) if (s > worst[1]) worst = [id, s];
    assert.ok(worst[0] !== null, 'keine Kursprobe mit Aktien');
    for (const [id, s] of steps) assert.ok(s < 0.03, `Wert ${id}: Schritt ${(s * 100).toFixed(2)} % zwischen zwei Sekunden`);
    const d = await detail(worst[0]);
    t.diagnostic(`größter Schritt ${(worst[1] * 100).toFixed(2)} % (${d.security.ticker}); ${(await marketList()).filter((s) => s.type === 'stock').length} Aktien beobachtet`);
  });

  await t.test('Keine Ausnahme im Server-Log', async () => {
    const log = serverLog().slice(logMark);
    const bad = log.split('\n').filter((l) => /Unbehandelt|Fehler:|Error|Traceback|Senden fehlgeschlagen|Socket-Fehler/.test(l));
    assert.deepEqual(bad, [], `Server-Log seit Bot-Start:\n${bad.join('\n')}`);
  });

  await t.test('/api/board liefert Index und News', async () => {
    const b = (await GET('/board')).json;
    assert.ok(Number.isFinite(b.index) && b.index > 0, `Index ${b.index}`);
    assert.ok(Array.isArray(b.index_history) && b.index_history.length > 0);
    assert.ok(Array.isArray(b.news) && b.news.length > 0, 'News auf dem Board');
    assert.ok(Array.isArray(b.tops) && b.tops.length > 0);
    assert.ok(Array.isArray(b.flops), 'Flops vorhanden (darf leer sein)');
  });

  await t.test('Bots stoppen → keine neuen Trades', async () => {
    const s0 = (await GET('/admin/bots', admin)).json;
    const stopped = (await POST('/admin/bots/stop', {}, admin)).json;
    assert.equal(stopped.running, false);
    assert.equal((await GET('/game')).json.bots_running, false);
    await sleep(4500); // mehr als ein Bot-Takt
    const s1 = (await GET('/admin/bots', admin)).json;
    assert.equal(s1.trades_this_run, s0.trades_this_run, 'nach Stop kam noch ein Trade');
    assert.equal(s1.orders_this_run, s0.orders_this_run);
    assert.equal((await GET('/news?kind=system&limit=3')).json.news[0]?.title, 'Testspiel-Modus beendet');
  });
});
