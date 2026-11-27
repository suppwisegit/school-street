// INT: End-to-End über die HTTP-API gegen den echten Server (Port 3231, eigene DB
// e2e-<pid>.db aus seed.js, am Ende gelöscht). Keine Admin-/Engine-Aufrufe im Prozess —
// nur HTTP, dazu Lesezugriffe auf die eigene Test-DB (fair_price, Orders).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const PORT = 3231;
const DB_NAME = `e2e-${process.pid}.db`;
const DATA = path.join(__dirname, '..', 'data');
const BASE = `http://127.0.0.1:${PORT}`;
const BUILD = '/tmp/ss-build-agent';
const FEE = 2000;

async function until(fn, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  let last;
  do {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(step);
  } while (Date.now() < end);
  throw new Error(`Zeitüberschreitung (${ms} ms)${last ? `: ${last.message}` : ''}`);
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
const GET = (p, token) => api('GET', p, { token });
const POST = (p, body, token) => api('POST', p, { token, body: body ?? {} });
const PUT = (p, body, token) => api('PUT', p, { token, body });
const DEL = (p, token) => api('DELETE', p, { token });

let srv = null; // { child, output }
const log = () => (srv ? srv.output : '');
const serverUp = () => srv && srv.child.exitCode === null && srv.child.signalCode === null;

function startServer(env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_NAME, ADMIN_PASSWORD: 'ag123',
      ...(fs.existsSync(BUILD) ? { PUBLIC_DIR: BUILD } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
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
  const exited = once(srv.child, 'exit');
  srv.child.kill('SIGINT');
  const code = (await exited)[0];
  srv = null;
  return code;
}

// Lesezugriff nur auf die eigene Test-DB
const Database = require('better-sqlite3');
function dbRead(fn) {
  const d = new Database(path.join(DATA, DB_NAME), { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
const fairOf = (id) => dbRead((d) => d.prepare('SELECT fair_price f FROM securities WHERE id=?').get(id).f);
const sumFilled = (trades) => trades.reduce((a, t) => a + t.amount, 0);
const sumMoney = (trades) => trades.reduce((a, t) => a + t.price * t.amount, 0);

before(() => {
  fs.rmSync(path.join(DATA, DB_NAME), { force: true });
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
});

after(() => {
  if (serverUp()) srv.child.kill('SIGKILL');
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(DATA, DB_NAME + s), { force: true });
});

test('INT · End-to-End über HTTP', { timeout: 240000 }, async (t) => {
  await startServer();
  const rnd = Math.random().toString(36).slice(2, 7);
  const register = async (name) => {
    const r = await POST('/auth/register', { username: `${name}_${rnd}`, password: 'geheim123' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const reg = async (name, expected) => {
    const r = await register(name);
    await t.test(`Schüler ${name} registrieren → 200, Token, 10 000 Cr`, () => {
      assert.ok(r.token); assert.equal(r.user.cash, 1000000); assert.equal(r.user.role, 'user');
    });
    return r;
  };
  const u1 = await reg('kim'), u2 = await reg('jan'), u3 = await reg('lea');
  const admin = (await POST('/auth/login', { username: 'admin', password: 'ag123' })).json;

  let stock, etf, cap, band;
  const price = async (id) => (await GET(`/securities/${id}`)).json.security.last;
  const ordersOf = async (id, tok) => ((await GET(`/securities/${id}`, tok)).json.mine.open_orders || []);
  const pos = async (tok) => (await GET('/portfolio', tok)).json;

  await t.test('Login → Token; Marktliste; Detail mit sortiertem Orderbuch', async () => {
    const l = await POST('/auth/login', { username: u1.user.username, password: 'geheim123' });
    assert.equal(l.status, 200); assert.ok(l.json.token);
    assert.equal((await POST('/auth/login', { username: u1.user.username, password: 'falsch' })).status, 401);
    const secs = (await GET('/securities')).json.securities;
    stock = secs.find((s) => s.type === 'stock');
    etf = secs.find((s) => s.type === 'etf');
    assert.ok(stock && etf, 'Seed liefert Aktie und ETF');
    assert.ok(secs.every((s) => s.bid != null && s.ask != null), 'jedes Wert hat Bid und Ask');
    const d = (await GET(`/securities/${stock.id}`, u1.token)).json;
    const bids = d.book.bids.map((x) => x[0]), asks = d.book.asks.map((x) => x[0]);
    assert.ok(asks.length >= 2 && bids.length >= 1, `MM-Staffel: ${bids.length} bids / ${asks.length} asks`);
    assert.ok(asks.every((p, i) => i === 0 || asks[i - 1] < p), 'asks aufsteigend');
    assert.ok(bids.every((p, i) => i === 0 || bids[i - 1] > p), 'bids absteigend');
    assert.ok(asks[0] > bids[0], 'keine Kreuzung');
    assert.ok(d.tape.length > 0 && Array.isArray(d.stats.vola === undefined ? d.tape : d.tape), 'Handelsliste vorhanden');
    band = d.band;
    t.diagnostic(`${stock.ticker}: last ${d.security.last / 100} Cr, bid ${bids[0] / 100} / ask ${asks[0] / 100}, Band ${band.min / 100}–${band.max / 100}`);
  });

  await t.test('Vorschau = Ausführung (Markt-Kauf, Markt-Verkauf), Gebühr und Cash stimmen', async () => {
    const before = await pos(u1.token);
    const pv = (await GET(`/securities/${stock.id}/preview?side=buy&type=market&amount=5`, u1.token)).json;
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 5 }, u1.token);
    assert.equal(r.status, 200, r.json?.error);
    assert.equal(sumFilled(r.json.trades), 5);
    assert.equal(sumMoney(r.json.trades), pv.gross, `Vorschau ${pv.gross} ≠ Ausführung`);
    assert.equal(Math.round(sumMoney(r.json.trades) / 5), pv.avg_price);
    assert.equal((await pos(u1.token)).cash, before.cash - pv.gross - FEE);
    const pv2 = (await GET(`/securities/${stock.id}/preview?side=sell&type=market&amount=2`, u1.token)).json;
    const s = await POST('/orders', { security_id: stock.id, side: 'sell', type: 'market', amount: 2 }, u1.token);
    assert.equal(s.status, 200, s.json?.error);
    assert.equal(sumMoney(s.json.trades), pv2.gross);
    const after = await pos(u1.token);
    assert.equal(after.cash, before.cash - pv.gross - FEE + pv2.gross - FEE);
    const p = after.positions.find((x) => x.security_id === stock.id);
    assert.equal(p.amount, 3);
    t.diagnostic(`Kauf 5: ${pv.gross} Cr-Cent Ø ${pv.avg_price / 100} Cr; Verkauf 2: ${pv2.gross} Ø ${pv2.avg_price / 100} Cr`);
  });

  await t.test('Limit-Kauf kreuzt und füllt; Limit-Verkauf bleibt liegen; Storno; Storno erneut idempotent', async () => {
    const ask0 = (await GET(`/securities/${stock.id}`)).json.book.asks[0][0];
    const b = (await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: ask0 + 10, amount: 2 }, u1.token)).json;
    assert.equal(sumFilled(b.trades), 2, 'Limit über Ask füllt vollständig');
    assert.ok(sumMoney(b.trades) <= (ask0 + 10) * 2, 'höchstens zum Limit');
    // ruhender Verkauf: unter jedem Gebot, aber im Band (die Staffel steht nach jedem Trade neu)
    const bidsNow = (await GET(`/securities/${stock.id}`)).json.book.bids;
    let rest = band.min;
    while (bidsNow.some((b) => b[0] >= rest)) rest += 10;
    const before = await pos(u1.token);
    const l = await POST('/orders', { security_id: stock.id, side: 'sell', type: 'limit', price: rest, amount: 2 }, u1.token);
    assert.equal(l.status, 200, l.json?.error);
    assert.equal(l.status, 200, l.json?.error);
    assert.equal(l.json.order.status, 'open'); assert.equal(l.json.trades.length, 0);
    assert.equal((await ordersOf(stock.id, u1.token)).some((o) => o.id === l.json.order.id), true, 'Order liegt im Buch (mine)');
    const c1 = await DEL(`/orders/${l.json.order.id}`, u1.token);
    assert.equal(c1.status, 200); assert.equal(c1.json.ok, true);
    const cashAfter = (await pos(u1.token)).cash;
    const [c2, c3] = await Promise.all([DEL(`/orders/${l.json.order.id}`, u1.token), DEL(`/orders/${l.json.order.id}`, u1.token)]);
    assert.deepEqual([c2.status, c2.json.ok, c3.status, c3.json.ok], [200, true, 200, true], 'zweites/drittes Storno idempotent');
    assert.equal((await pos(u1.token)).cash, cashAfter, 'idempotenter Storno bucht nichts');
    assert.equal((await ordersOf(stock.id, u1.token)).some((o) => o.id === l.json.order.id), false);
    assert.equal(before.cash, cashAfter, 'Verkaufs-Escrow vollständig zurück');
  });

  let f0;
  await t.test('Limit 10 000 Cr → 400 mit erlaubtem Bereich; Markt-Order cap+1 → 400 „Zu groß“, nichts gebucht', async () => {
    f0 = fairOf(stock.id);
    const b = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: 1000000, amount: 1 }, u1.token);
    assert.equal(b.status, 400);
    assert.match(b.json.error, /Erlaubt/);
    assert.match(b.json.error, /Erlaubt: [\d.,]+ – [\d.,]+/);
    const pv = (await GET(`/securities/${stock.id}/preview?side=buy&type=market&amount=1`, u1.token)).json;
    cap = pv.cap;
    const before = await pos(u1.token);
    const big = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: cap + 1 }, u1.token);
    assert.equal(big.status, 400); assert.match(big.json.error, new RegExp(`Zu groß für eine Order: höchstens ${cap} Stück`));
    assert.equal((await pos(u1.token)).cash, before.cash);
    assert.equal(fairOf(stock.id), f0, 'F unverändert');
    const l = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: band.min, amount: 1 }, u1.token);
    assert.equal(l.status, 200);
    await DEL(`/orders/${l.json.order.id}`, u1.token);
    t.diagnostic(`Band ${band.min / 100}–${band.max / 100} Cr, Meldung: ${b.json.error}; cap ${cap}`);
  });

  await t.test('Kurs steht ohne Trades (6 s, über alle Prüfungen hinweg)', async () => {
    const p0 = await price(stock.id);
    await sleep(6000);
    const p1 = await price(stock.id);
    assert.equal(fairOf(stock.id), f0);
    assert.equal(p1, p0);
    t.diagnostic(`${stock.ticker} last ${p0 / 100} → ${p1 / 100} Cr, fair ${f0}`);
  });

  await t.test('1-Stück-Kauf bewegt den Kurs kaum', async () => {
    const d0 = (await GET(`/securities/${stock.id}/preview?side=buy&type=market&amount=1`, u2.token)).json;
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, u2.token);
    assert.equal(sumMoney(r.json.trades), d0.gross);
    const f1 = fairOf(stock.id), p1 = await price(stock.id);
    const rel = f1 / f0 - 1;
    assert.ok(rel >= 0 && rel < 0.0005, `ΔF ${rel * 100} %`);
    const tickOf = (f) => Math.max(10, Math.round(f / 1000 / 10) * 10);
    assert.equal(p1, tickOf(f1), 'K = F auf Tick gerundet');
    t.diagnostic(`1 Stück: F ${f0} → ${f1} (${(rel * 100).toFixed(4)} %), Kurs ${p1 / 100} Cr`);
  });

  await t.test('Kauf 150 → 20 × hin und her zwischen zwei Konten → Verkauf 150: alter Kurs exakt', async () => {
    // Flow zählt nur Geschäfte mit der Staatskasse (im Seed liegen auch Orders von Demo-Trägern im Buch)
    const mm = (trades) => trades.reduce((a, t) => a + ([t.buyer, t.seller].includes('AG-Treasury') ? (t.seller === 'AG-Treasury' ? t.amount : -t.amount) : 0), 0);
    const depth = dbRead((d) => d.prepare('SELECT total_shares t FROM securities WHERE id=?').get(stock.id).t
      - dbRead((d) => d.prepare('SELECT COALESCE(SUM(amount),0) h FROM holdings WHERE security_id=? AND user_id=(SELECT founder_id FROM securities WHERE id=?)').get(stock.id, stock.id).h));
    const expectF = (from, flow) => Math.max(1, Math.round(from * Math.exp(Math.log(1.5) / Math.max(1, depth) * flow)));
    const b = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 150 }, u2.token);
    assert.equal(sumFilled(b.json.trades), 150, b.json?.error);
    const fa = fairOf(stock.id);
    assert.equal(fa, expectF(f0, mm(b.json.trades)), `Kauf 150 (${mm(b.json.trades)} Stück von der Staatskasse) → F = F0·e^(λ·q), Streubesitz ${depth}`);
    for (let i = 0; i < 20; i++) {
      // abwechselnd: Jan legt, Lea kauft — und umgekehrt (die Stücke wechseln nur den Besitzer).
      const maker = i % 2 ? u3 : u2, taker = i % 2 ? u2 : u3;
      const side = 'sell'; // der Legende bietet jeweils 15 Stück an, der andere kauft per Markt-Order
      const d = (await GET(`/securities/${stock.id}`)).json;
      const px = side === 'buy' ? d.book.bids[0][0] + 10 : d.book.asks[0][0] - 10;
      const s = await POST('/orders', { security_id: stock.id, side, type: 'limit', price: px, amount: 15 }, maker.token);
      assert.equal(s.json.order?.status, 'open', `Runde ${i}: ${s.json?.error} ${JSON.stringify((await pos(maker.token)).positions.find((x) => x.security_id === stock.id))} offen ${JSON.stringify((await ordersOf(stock.id, maker.token)).map((o) => [o.side, o.price, o.amount, o.filled]))}`);
      const k = await POST('/orders', { security_id: stock.id, side: side === 'buy' ? 'sell' : 'buy', type: 'market', amount: 15 }, taker.token);
      assert.equal(k.json?.trades?.length, 1, `Runde ${i}: ${k.status} ${k.json?.error} — Maker ${side} limit ${px} × 15 → ${s.json.order.status}, Taker ${JSON.stringify(k.json)}`);
      assert.equal(k.json.trades[0].amount, 15); assert.equal(k.json.trades[0].price, px);
      assert.equal([k.json.trades[0].buyer, k.json.trades[0].seller].includes('AG-Treasury'), false, `Runde ${i}: nicht gegen die Staatskasse`);
    }
    const fb = fairOf(stock.id);
    assert.equal(fb, fa, `20 × 15 hin und her: F ${fa} → ${fb}`);
    const s2 = await POST('/orders', { security_id: stock.id, side: 'sell', type: 'market', amount: 150 }, u2.token);
    assert.equal(sumFilled(s2.json.trades), 150, s2.json.error);
    // F wird je Order einmal gerundet: Kauf F0 → fa, Rückverkauf fa → F. Die Erwartung deshalb in denselben
    // zwei Schritten rechnen. Die eine Formel aus F0 lag je nach Kaufmenge 1 Milli-Cent daneben und ließ
    // den Test flackern; erlaubt bleibt höchstens diese eine Rundung.
    assert.equal(fairOf(stock.id), expectF(fa, mm(s2.json.trades)), 'Kauf und Rückverkauf: F = round(fa · e^(λ·q)), q = Flow des Rückverkaufs');
    assert.ok(Math.abs(fairOf(stock.id) - expectF(f0, mm(b.json.trades) + mm(s2.json.trades))) <= 1, 'höchstens 1 Milli-Cent neben F0 · e^(λ·Σq)');
    t.diagnostic(`F: ${f0} → nach Kauf 150 ${fa} (davon ${mm(b.json.trades)} von der Staatskasse) → nach 20×15 ${fb} → nach Rückverkauf ${fairOf(stock.id)} (${mm(s2.json.trades)} an die Staatskasse); Streubesitz ${depth}`);
  });

  let newSec;
  await t.test('Börsengang: Antrag → Freigabe → Handel; Dividende', async () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let ticker = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const have = new Set((await GET('/securities')).json.securities.map((s) => s.ticker));
    if (have.has(ticker)) ticker = 'Q' + ticker.slice(1);
    const a = await POST('/companies/apply', { name: `INT ${ticker} AG`, ticker, description: 'Integrationstest' }, u1.token);
    assert.equal(a.status, 200, `${a.json?.error} (ticker „${ticker}“)`);
    const list = (await GET('/admin/ipo', admin.token)).json.applications.find((x) => x.id === a.json.id);
    assert.equal(list?.status, 'pending');
    const ap = await POST(`/admin/ipo/${a.json.id}/approve`, { ipo_price: 10, founder_shares: 1000, float_shares: 400, threshold_mult: 1.5 }, admin.token);
    assert.equal(ap.status, 200, ap.json?.error);
    newSec = ap.json.security_id;
    const d = (await GET(`/securities/${newSec}`)).json;
    assert.equal(d.security.ticker, ticker); assert.equal(d.security.last, 1000);
    assert.ok(d.book.asks.length >= 1 && d.book.bids.length >= 1, 'MM quotiert die neue Aktie beidseitig');
    const lk = await POST('/orders', { security_id: newSec, side: 'sell', type: 'limit', price: 1100, amount: 1 }, u1.token);
    assert.equal(lk.status, 400); assert.match(lk.json.error, /Lock-up/);
    const pv = (await GET(`/admin/dividend/preview?security_id=${newSec}&per_share=0.5`, admin.token)).json;
    const before = (await pos(u1.token)).cash;
    const pd = await POST('/admin/dividend', { security_id: newSec, per_share: 0.5, reason: 'INT' }, admin.token);
    assert.equal(pd.status, 200, pd.json?.error);
    assert.equal((await pos(u1.token)).cash - before, 50000);
    assert.equal(pv.total, pv.total_shares * 50);
    assert.equal(fairOf(newSec), 1000000, 'Auffüllen alleine macht keinen Kurs');
    const k = await POST('/orders', { security_id: newSec, side: 'buy', type: 'market', amount: 5 }, u2.token);
    assert.equal(sumFilled(k.json.trades), 5, k.json?.error);
    const d2 = (await GET(`/securities/${newSec}`)).json;
    // Ab E015 gilt auch für einen frisch gelisteten Wert der Spiel-Default: die Streubesitz-Regeln
    // (mm_min_ask_shares = 1000, mm_min_depth = 2000) füllen die 400 Stück vom Antrag sofort auf,
    // damit vom ersten Sekunde an genug Angebot da ist. Ein kleiner Börsengang soll keine Aktien
    // sein, an denen 5 Stück den Kurs um 1 % bewegen. Die 5 Stück laufen also gegen die Staatskasse
    // und bewegen F um λ · 5 mit λ = ln(1,5) / D; D steht nach dem Auffüllen in der Tabelle.
    // Erwartung deshalb aus der Tabelle gerechnet, nicht mehr die feste Zahl 10,10.
    const newDepth = dbRead((d) => d.prepare('SELECT total_shares t FROM securities WHERE id=?').get(newSec).t)      - dbRead((d) => d.prepare('SELECT COALESCE(SUM(amount),0) h FROM holdings WHERE security_id=? AND user_id=(SELECT founder_id FROM securities WHERE id=?)').get(newSec, newSec).h);
    assert.ok(newDepth >= 2000, `Streubesitz nach dem Listing ${newDepth} (mm_min_depth)`);
    assert.ok(k.json.trades.every((x) => x.seller === 'AG-Treasury' && x.price <= d.band.max), 'alles von der Staatskasse, im Band');
    const fairNew = Math.round(1_000_000 * Math.exp(Math.log(1.5) / newDepth * 5));
    assert.equal(fairOf(newSec), fairNew);
    assert.equal(d2.security.last, Math.max(10, Math.round(fairNew / 1000 / 10) * 10), 'K = F auf 0,1 Cr gerundet');
    t.diagnostic(`${ticker}: Kurs 10,00 → nach 5 Stück ${d2.security.last / 100} Cr; Dividende ${pv.total_shares} Stück × 0,50`);
  });

  const treasuryT = async (id) => {
    // /admin/etf zeigt treasury_positions (Depot); die MM-Verkaufsorders liegen im Ask-Escrow.
    // T = Depot + offene MM-Verkaufsorders der Staatskasse (so rechnet die Automatik) — aus der eigenen Test-DB.
    const escrow = dbRead((d) => d.prepare("SELECT COALESCE(SUM(amount - filled), 0) q FROM orders WHERE security_id=? AND status='open' AND is_mm=1 AND side='sell' AND user_id=(SELECT id FROM users WHERE role='bank')").get(id).q);
    const e = (await GET('/admin/etf', admin.token)).json;
    const n = e.etfs.find((x) => x.id === id);
    return { T: (e.treasury_positions.find((x) => x.ticker === n.ticker)?.amount ?? 0) + escrow, nav: n.nav_per_share, total: n.total_shares };
  };

  await t.test('ETF: Kurs = NAV ± 1 Tick, bei Kauf- und Verkaufsdruck', async () => {
    const chk = async (where) => {
      const { nav } = await treasuryT(etf.id);
      const last = await price(etf.id);
      assert.ok(Math.abs(last - nav) <= 10, `${where}: last ${last} vs NAV ${nav}`);
      return `${last / 100}/${(nav / 100).toFixed(2)} Cr`;
    };
    const out = [await chk('Start')];
    const pv = (await GET(`/securities/${etf.id}/preview?side=buy&type=market&amount=150`, u2.token)).json;
    assert.equal(pv.cap, null, 'ETF ohne Stückgrenze');
    const b = await POST('/orders', { security_id: etf.id, side: 'buy', type: 'market', amount: 150 }, u2.token);
    assert.equal(sumFilled(b.json.trades), 150, `${b.status} ${b.json?.error} — Vorschau ${JSON.stringify(pv.fills.slice(0, 2))} available ${pv.available} cap ${pv.cap}`);
    assert.equal(sumMoney(b.json.trades), pv.gross);
    out.push(`nach Kauf 150: ${await chk('Kauf')}`);
    const s = await POST('/orders', { security_id: etf.id, side: 'sell', type: 'market', amount: 150 }, u2.token);
    assert.equal(sumFilled(s.json.trades), 150, `${s.status} ${s.json?.error} — Buch danach ${JSON.stringify((await GET(`/securities/${etf.id}`)).json.book)}`);
    out.push(`nach Verkauf 150: ${await chk('Verkauf')}`);
    t.diagnostic(`ETF last/NAV — ${out.join(', ')}`);
  });

  await t.test('ETF-Automatik: Creation (T < ½ W), danach Redemption (T > 1,25 W)', { timeout: 60000 }, async () => {
    // W0 = Anfangsbestand bei Schöpfung (Seed: 25 Units × 10); am Start gilt T = W0.
    const { T: tStart, total } = await treasuryT(etf.id);
    const W = dbRead((d) => d.prepare('SELECT ap_inventory_target w FROM securities WHERE id=?').get(etf.id).w);
    assert.ok(tStart >= 0.5 * W && tStart <= 1.25 * W, `Start: T ${tStart} im Arbeitsbestands-Bereich um W ${W} (Umlauf ${total})`);
    await POST('/orders', { security_id: etf.id, side: 'buy', type: 'market', amount: 150 }, u2.token);
    const tLow = (await treasuryT(etf.id)).T;
    const start = log().length;
    await until(() => /\[Job etf-auto\].*creation/.test(log().slice(start)), 25000, 250);
    const after = await treasuryT(etf.id);
    assert.ok(after.T >= W && after.T < W + 10, `Creation bis W: T ${after.T}, W ${W}, Umlauf ${after.total}`);
    const line1 = log().slice(start).split('\n').find((l) => l.includes('etf-auto'));
    // Einheiten aus dem Log der Automatik; Umlauf wächst genau um diese Units
    const units = Number(line1.match(/creation x(\d+)/)?.[1]);
    assert.ok(units >= 1, `Log der Automatik: ${line1.trim()}`);
    assert.equal(after.total, total + units * 10);
    t.diagnostic(`T vor dem Kauf ${tStart}, direkt danach gelesen ${tLow}, bei der Aktion ${after.T - units * 10} → Creation ${units} Units → T ${after.T}`);
    for (const s of [stock.id, etf.id]) {
      const d = (await GET(`/securities/${s}`)).json;
      assert.ok(d.book.asks.length >= 1 && d.book.bids.length >= 1, 'MM-Quotes nach der Aktion beidseitig');
    }
    assert.ok(Math.abs(await price(etf.id) - after.nav) <= 10, 'ETF am NAV');
    await sleep(10200); // Mindestabstand 10 s je ETF
    const c = await POST(`/admin/etf/${etf.id}/create-units`, { units: 20 }, admin.token);
    assert.equal(c.status, 200, c.json?.error);
    await until(() => /\[Job etf-auto\].*redemption/.test(log().slice(start)), 25000, 250);
    const fin = await treasuryT(etf.id);
    assert.equal(fin.T, after.T, `Redemption bis W: T ${fin.T}`);
    const lines = log().slice(start).split('\n').filter((l) => l.includes('etf-auto')).map((l) => l.trim());
    t.diagnostic(`T ${tStart} → nach Kauf ${tLow} → ${line1.trim()} → T ${after.T}; manuell +200 → ${lines[lines.length - 1]} → T ${fin.T}, Umlauf ${fin.total}; |last−NAV| ${Math.abs(await price(etf.id) - fin.nav)}`);
  });

  await t.test('Doppeltes Absenden: zwei gleiche Orders gleichzeitig → zweimal ausgeführt, kein Doppelbuch', async () => {
    const before = await pos(u2.token);
    const [a, b] = await Promise.all([1, 2].map(() => POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 3 }, u2.token)));
    assert.equal(a.status, 200, a.json?.error); assert.equal(b.status, 200, b.json?.error);
    assert.notEqual(a.json.order.id, b.json.order.id);
    assert.equal(sumFilled(a.json.trades) + sumFilled(b.json.trades), 6);
    assert.equal((before.cash - (await pos(u2.token)).cash) - sumMoney(a.json.trades) - sumMoney(b.json.trades), 2 * FEE);
    const bNow = (await GET(`/securities/${stock.id}`)).json.band;
    const l = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: bNow.min, amount: 1 }, u2.token);
    assert.equal(l.status, 200, l.json?.error);
    const cash = (await pos(u2.token)).cash;
    await Promise.all([1, 2, 3].map(() => DEL(`/orders/${l.json.order.id}`, u2.token)));
    const cashEnd = (await pos(u2.token)).cash; // Escrow (price × amount) kam genau einmal zurück
    assert.equal(cashEnd, cash + l.json.order.price * l.json.order.amount, `Escrow nach drei parallelen Stornos: ${cash} + ${l.json.order.price * l.json.order.amount} erwartet, gekommen ${cashEnd}`);
  });

  await t.test('Pause: Order abgelehnt, Kurse stehen; Weiter: Order geht wieder', async () => {
    assert.equal((await POST('/admin/game/pause', {}, admin.token)).json.paused, true);
    assert.equal((await GET('/game')).json.paused, true);
    const before = await pos(u2.token);
    const o = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, u2.token);
    assert.equal(o.status, 400); assert.match(o.json.error, /Pause/);
    assert.equal((await pos(u2.token)).cash, before.cash);
    const c = await POST(`/admin/etf/${etf.id}/create-units`, { units: 1 }, admin.token);
    t.diagnostic(`AP-Schnittstelle während Pause: ${c.status} ${JSON.stringify(c.json).slice(0, 80)}`);
    const p0 = await price(stock.id);
    await sleep(3500);
    assert.equal(await price(stock.id), p0);
    assert.equal((await POST('/admin/game/resume', {}, admin.token)).json.paused, false);
    const ok = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, u2.token);
    assert.equal(ok.status, 200, ok.json?.error);
  });

  await t.test('Eingefrorenes Konto: Order 403, offene Orders weg; nach Auftauen Handel möglich', async () => {
    const id = u3.user.id;
    const bNow = (await GET(`/securities/${stock.id}`)).json.band;
    const l = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: bNow.min, amount: 2 }, u3.token);
    assert.equal(l.status, 200, l.json?.error);
    const cashOpen = (await pos(u3.token)).cash;
    assert.equal((await POST(`/admin/users/${id}/freeze`, { freeze: true }, admin.token)).status, 200);
    const o = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, u3.token);
    assert.equal(o.status, 403); assert.match(o.json.error, /eingefroren/i);
    assert.equal((await ordersOf(stock.id, u3.token)).length, 0, 'offene Orders storniert');
    // Nicht festgelegt: ein zweiter Storno auf dem eingefrorenen Konto kam in verschiedenen Läufen mit
    // 200 {ok:true} und mit 403 — nur beobachten, nicht bewerten.
    const again = await DEL(`/orders/${l.json.order.id}`, u3.token);
    t.diagnostic(`Storno auf eingefrorenem Konto: HTTP ${again.status} ${JSON.stringify(again.json)}`);
    t.diagnostic(`/portfolio während des Einfrierens: HTTP ${(await pos(u3.token)).status}`);
    const cashDb = dbRead((d) => d.prepare('SELECT cash c FROM users WHERE id=?').get(id).c);
    assert.equal(cashDb, cashOpen + l.json.order.price * 2, 'Escrow durch den Freeze genau einmal zurück');
    t.diagnostic('eingefroren: Storno und /portfolio liefern 403 „Konto eingefroren“');
    assert.equal((await POST(`/admin/users/${id}/freeze`, { freeze: false }, admin.token)).status, 200);
    const k = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, u3.token);
    assert.equal(k.status, 200, k.json?.error);
  });

  let restId, restSec;
  await t.test('Neustart mit vorhandenen Daten: Kurse exakt erhalten, offene Order wieder im Buch', async () => {
    restSec = stock.id;
    const d = (await GET(`/securities/${stock.id}`)).json;
    const l = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: d.band.min + 10, amount: 4 }, u1.token);
    assert.equal(l.json.order.status, 'open');
    restId = l.json.order.id;
    const snap = async () => Object.fromEntries((await GET('/securities')).json.securities.map((s) => [s.id, s.last]));
    const quotes = async () => Object.fromEntries((await GET('/securities')).json.securities.filter((x) => x.type === 'stock').map((s) => [s.ticker, `${s.bid}/${s.ask}`]));
    const etfNav = (await treasuryT(etf.id)).nav;
    const s0 = await snap(), q0 = await quotes();
    const f = fairOf(stock.id);
    assert.equal(await stopServer(), 0, log());
    await startServer();
    const s1 = await snap();
    assert.deepEqual(s1, s0, 'Kurse (last) nach Neustart');
    t.diagnostic(`Geld/Brief vor dem Neustart ${JSON.stringify(q0)} — danach ${JSON.stringify(await quotes())}`);
    assert.equal(fairOf(stock.id), f);
    assert.ok(Math.abs(await price(etf.id) - etfNav) <= 10, 'ETF nach Neustart am NAV');
    const mine = await ordersOf(restSec, u1.token);
    assert.equal(mine.length, 1); assert.equal(mine[0].id, restId); assert.equal(mine[0].status, 'open');
    const book = (await GET(`/securities/${restSec}`)).json.book;
    assert.ok(book.bids.some((x) => x[0] === mine[0].price), 'Order liegt wieder im Orderbuch');
    const depth = (await GET(`/securities/${restSec}`)).json.stats.bid_depth;
    const pv = (await GET(`/securities/${restSec}/preview?side=sell&type=market&amount=${depth + 1}`, u2.token)).json;
    assert.ok(pv.fills.some((x) => x.price === mine[0].price), `Vorschau (Verkauf ${depth + 1} Stück) sieht die liegende Order nicht: ${JSON.stringify(pv.fills)} — Order ${mine[0].price} × ${mine[0].amount}, cap ${pv.cap}`);
    t.diagnostic(`${Object.keys(s1).length} Werte unverändert; Order ${restId} @ ${mine[0].price / 100} Cr wieder im Buch`);
  });

  await t.test('Bots (Testspiel-Modus) 40 s: ruhige Kurse, kein Schritt über 3 %, ETF am NAV; Stop', { timeout: 90000 }, async () => {
    const pick = async () => Object.fromEntries((await GET('/securities')).json.securities.filter((s) => s.type === 'stock').map((s) => [s.id, s.last]));
    const before = await pick();
    const b0 = (await POST('/admin/bots/start', {}, admin.token)).json;
    assert.equal(b0.running, true);
    const samples = []; let maxStep = 0, worst = ''; let maxEtfGap = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const cur = await pick();
      for (const [id, p] of Object.entries(cur)) {
        if (!(id in before)) continue;
        const step = Math.abs(p / before[id] - 1);
        if (step > maxStep) { maxStep = step; worst = `Wert ${id}: ${before[id]} → ${p}`; }
        before[id] = p;
      }
      const { nav } = await treasuryT(etf.id);
      maxEtfGap = Math.max(maxEtfGap, Math.abs(await price(etf.id) - nav));
    }
    const st = (await GET('/admin/bots', admin.token)).json;
    const stopped = (await POST('/admin/bots/stop', {}, admin.token)).json;
    assert.equal(stopped.running, false);
    assert.equal((await GET('/game')).json.bots_running, false);
    assert.ok(st.trades_this_run > 0, `Bots haben gehandelt: ${JSON.stringify({ orders: st.orders_this_run, trades: st.trades_this_run })}`);
    assert.equal(st.orders_this_run > 0, true, 'Bots haben Orders aufgegeben');
    assert.ok(maxStep <= 0.03, `größter Kursschritt ${(maxStep * 100).toFixed(2)} % (${worst})`);
    assert.ok(maxEtfGap <= 10, `ETF-Abstand zum NAV ${maxEtfGap}`);
    assert.ok((await GET('/securities')).json.securities.every((s) => s.bid != null && s.ask != null), 'alle Werte beidseitig quotiert');
    t.diagnostic(`Bots ${st.bots}, Orders ${st.orders_this_run}, Trades ${st.trades_this_run}, Fehler ${st.errors}; größter Schritt pro Sekunde ${(maxStep * 100).toFixed(2)} % (${worst}); ETF max |last−NAV| ${maxEtfGap}`);
  });

  await t.test('Frontend wird ausgeliefert (/, /admin, /board)', async () => {
    for (const p of ['/', '/admin', '/board']) {
      const r = await fetch(`${BASE}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      assert.match(await r.text(), /<div id="root"><\/div>/);
    }
  });
});
