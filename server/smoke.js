#!/usr/bin/env node
// ============================================================================
// End-to-End-Smoke-Test für das School-Street-Backend.
// Keine npm-Deps — nur globale fetch/URL (Node >= 18).
//
//   SMOKE_PORT=3100 SMOKE_ADMIN_PASSWORD=smokeag node server/smoke.js
//
// Erwartet einen FRISCH geseedeten Server (server/seed.js) auf BASE.
// Alle Beträge/Preise = INTEGER-CENTS (Ausnahmen wie in der API: Dividende
// per_share und IPO ipo_price in Credits mit Dezimalstellen).
// ============================================================================
const BASE = `http://127.0.0.1:${process.env.SMOKE_PORT || 3100}`;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || 'ag123';
const FEE = 2000;          // fee_cent Default (Gebühr pro ausgeführter Order)
const START_CAPITAL = 1000000; // 10.000 Credits

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  const d = detail !== undefined && detail !== null && detail !== '' ? ` — ${detail}` : '';
  console.log(`${good ? '✅' : '❌'} ${name}${d}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------- HTTP-Helper ----------
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* nicht-JSON-Antwort */ }
  return { status: res.status, json };
}
const GET = (p, token) => api('GET', p, { token });
const POST = (p, body, token) => api('POST', p, { token, body });
const PUT = (p, body, token) => api('PUT', p, { token, body });
const DEL = (p, token) => api('DELETE', p, { token });

// Ein Abschnitt: bricht ein AssertionError ab, wird ein FAIL notiert und weitergegangen.
async function section(name, fn) {
  try { await fn(); }
  catch (e) { ok(name, false, `ABBRUCH: ${e.message}`); }
}

// Zufalls-Suffix, damit mehrere Läufe gegen dieselbe DB klarkommen
const rnd = Math.random().toString(36).slice(2, 8);
const U1 = `smku1_${rnd}`;
const U2 = `smku2_${rnd}`;
const PW = 'test1234';

(async () => {
  let t1, t2, tAdmin, u1id, u2id;
  let stock; // erste Aktie aus /securities
  const port = async (tok) => (await GET('/portfolio', tok)).json;

  // Aggressiv kreuzende Limit-Order (füllt sofort); falls überraschend keine
  // Quote im Buch liegt: stornieren und bis zu 3x erneut versuchen.
  async function aggressive(tok, secId, side, amount, off) {
    for (let i = 0; i < 3; i++) {
      const d = (await GET(`/securities/${secId}`, tok)).json;
      const ref = side === 'buy' ? d?.book?.asks?.[0]?.[0] : d?.book?.bids?.[0]?.[0];
      assert(ref != null, `aggressive ${side}: keine Quote im Buch`);
      const price = side === 'buy' ? ref + off : ref - off;
      const r = await POST('/orders', { security_id: secId, side, type: 'limit', price, amount }, tok);
      assertEq(r.status, 200, `aggressive ${side} status (${r.json?.error})`);
      if ((r.json?.trades || []).length) return r.json;
      await DEL(`/orders/${r.json.order.id}`, tok);
    }
    throw new Error(`aggressive ${side} wurde nicht gefüllt`);
  }

  // ======================= 1) AUTH =======================
  await section('Auth', async () => {
    const r1 = await POST('/auth/register', { username: U1, password: PW });
    assertEq(r1.status, 200, `register u1 (${r1.json?.error})`);
    assert(!!r1.json?.token, 'register u1: kein Token');
    assertEq(r1.json?.user?.username, U1, 'register u1: username');
    assertEq(r1.json?.user?.role, 'user', 'register u1: role');
    assertEq(r1.json?.user?.cash, START_CAPITAL, 'register u1: Startkapital');
    t1 = r1.json.token; u1id = r1.json.user.id;
    ok('Auth: register u1 -> token, 1000000c Startkapital', true);

    const r2 = await POST('/auth/register', { username: U2, password: PW });
    assertEq(r2.status, 200, `register u2 (${r2.json?.error})`);
    t2 = r2.json.token; u2id = r2.json.user.id;
    ok('Auth: register u2 -> token', true);

    const dup = await POST('/auth/register', { username: U1, password: PW });
    assertEq(dup.status, 409, `duplicate register (${dup.status}, ${dup.json?.error})`);
    ok('Auth: duplicate register -> 409', true, dup.json?.error);

    const bad = await POST('/auth/login', { username: U1, password: 'falsch' });
    assertEq(bad.status, 401, `falsches login (${bad.status})`);
    ok('Auth: falsches Login -> 401', true, bad.json?.error);

    const me = await GET('/auth/me', t1);
    assertEq(me.status, 200, `auth/me (${me.status})`);
    assertEq(me.json?.user?.username, U1, 'auth/me: username');
    ok('Auth: GET /auth/me ok', true);
  });

  // ======================= 2) MARKTDATEN =======================
  await section('Marktdaten', async () => {
    const r = await GET('/securities');
    assertEq(r.status, 200, `GET /securities (${r.status})`);
    const secs = r.json?.securities || [];
    const stocks = secs.filter(s => s.type === 'stock');
    const etfs = secs.filter(s => s.type === 'etf');
    assert(stocks.length >= 4, `zu wenige Aktien: ${stocks.length}`);
    assert(etfs.length >= 1, `kein ETF vorhanden`);
    const noQuote = secs.filter(s => s.bid == null || s.ask == null).map(s => s.ticker);
    assert(noQuote.length === 0, `bid/ask fehlt bei: ${noQuote.join(',') || 'keine'}`);
    stock = stocks[0];
    ok('Markt: >=4 Aktien + 1 ETF, alle mit bid&ask (MM aktiv)', true,
      `${stocks.length} Aktien, ${etfs.length} ETF(s)`);

    const d = await GET(`/securities/${stock.id}`);
    assertEq(d.status, 200, `GET /securities/${stock.id} (${d.status})`);
    const bids = (d.json?.book?.bids || []).map(x => x[0]);
    const asks = (d.json?.book?.asks || []).map(x => x[0]);
    assert(bids.length > 0 && asks.length > 0, 'Orderbuch leer');
    const bidsSorted = bids.every((p, i) => i === 0 || bids[i - 1] >= p);
    const asksSorted = asks.every((p, i) => i === 0 || asks[i - 1] <= p);
    assert(bidsSorted, `bids nicht absteigend sortiert: ${bids}`);
    assert(asksSorted, `asks nicht aufsteigend sortiert: ${asks}`);
    ok(`Markt: Orderbuch ${stock.ticker} sortiert (bids desc, asks asc)`, true,
      `bid ${bids[0]} / ask ${asks[0]}`);

    const c = await GET(`/securities/${stock.id}/candles`);
    assertEq(c.status, 200, `candles status (${c.status})`);
    assert((c.json?.candles || []).length > 0, 'candles leer');
    ok('Markt: candles nicht leer', true, `${c.json.candles.length} Kerzen`);

    const n = await GET('/news');
    assertEq(n.status, 200, `news status (${n.status})`);
    assert((n.json?.news || []).length > 0, 'news leer');
    ok('Markt: /api/news nicht leer', true, `${n.json.news.length} Einträge`);
  });

  // ======================= 3) HANDEL =======================
  await section('Handel: aggressiver Kauf', async () => {
    const before = await port(t1);
    assertEq(before.cash, START_CAPITAL, 'u1 cash vor Kauf');
    const r = await aggressive(t1, stock.id, 'buy', 5, 200);
    const trades = r.trades || [];
    const cost = trades.reduce((a, t) => a + t.price * t.amount, 0);
    assert(trades.length >= 1, 'kein Trade ausgeführt');
    const after = await port(t1);
    assertEq(after.cash, START_CAPITAL - cost - FEE, 'cash nach Kauf (Escrow-Refund + Gebühr)');
    const pos = (after.positions || []).find(p => p.security_id === stock.id);
    assert(!!pos && pos.amount >= 1, `position amount < 1: ${pos?.amount}`);
    const avgExp = Math.round(cost / trades.reduce((a, t) => a + t.amount, 0));
    assert(pos.avg_cost > 0 && Math.abs(pos.avg_cost - avgExp) <= 1,
      `avg_cost unplausibel: ${pos.avg_cost} vs ${avgExp}`);
    ok('Handel: limit buy ask+200 -> fill, cash & position korrekt', true,
      `${trades.length} fill(s), cost ${cost}c + ${FEE}c Gebühr, pos ${pos.amount} @ ${pos.avg_cost}`);
  });

  await section('Handel: Verkauf', async () => {
    const before = await port(t1);
    const posB = (before.positions || []).find(p => p.security_id === stock.id);
    assert(posB && posB.amount >= 2, 'zu wenig Aktien für Verkaufstest');
    const r = await aggressive(t1, stock.id, 'sell', 2, 200);
    const trades = r.trades || [];
    assert(trades.length >= 1, 'Verkauf nicht gefüllt');
    const proceeds = trades.reduce((a, t) => a + t.price * t.amount, 0);
    const qty = trades.reduce((a, t) => a + t.amount, 0);
    const after = await port(t1);
    assertEq(after.cash, before.cash + proceeds - FEE, 'cash nach Verkauf (Erlös - Gebühr)');
    const plExp = trades.reduce((a, t) => a + (t.price - posB.avg_cost) * t.amount, 0);
    assertEq(after.realized_pl - before.realized_pl, plExp, 'realized_pl Delta');
    const posA = (after.positions || []).find(p => p.security_id === stock.id);
    assertEq(posA.amount, posB.amount - qty, 'positionsgröße nach Verkauf');
    ok('Handel: limit sell bid-200 -> fill, cash/realized_pl korrekt', true,
      `Erlös ${proceeds}c, realized_pl ${before.realized_pl} -> ${after.realized_pl}`);
  });

  await section('Handel: Market-Order', async () => {
    const before = await port(t1);
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'market', amount: 1 }, t1);
    assertEq(r.status, 200, `market buy status (${r.json?.error})`);
    const trades = r.json?.trades || [];
    assert(trades.length >= 1, 'market buy nicht gefüllt');
    const cost = trades.reduce((a, t) => a + t.price * t.amount, 0);
    const after = await port(t1);
    assertEq(after.cash, before.cash - cost - FEE, 'cash nach market buy');
    ok('Handel: market buy füllt', true, `${trades.length} fill(s) zu ${cost}c + ${FEE}c Gebühr`);
  });

  await section('Handel: weit entfernte Limit-Order + Storno-Refund', async () => {
    const before = await port(t1);
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: 100, amount: 5 }, t1);
    assertEq(r.status, 200, `far limit status (${r.json?.error})`);
    assertEq(r.json.order.status, 'open', 'far limit: status');
    assertEq(r.json.order.filled, 0, 'far limit: filled');
    assertEq((r.json.trades || []).length, 0, 'far limit: keine Trades');
    assertEq((await port(t1)).cash, before.cash - 500, 'far limit: Escrow 100x5 abgezogen');
    const ol = await GET('/orders', t1);
    const persisted = (ol.json?.orders || []).some(o => o.id === r.json.order.id && o.status === 'open');
    assert(persisted, 'Order nicht als open persistiert');
    const c = await DEL(`/orders/${r.json.order.id}`, t1);
    assertEq(c.status, 200, `cancel status (${c.json?.error})`);
    const after = await port(t1);
    assertEq(after.cash, before.cash, 'Storno: Cash-Refund exakt, Gebühr NICHT abgezogen');
    ok('Handel: ferne Limit-Order bleibt offen, Storno-Refund exakt (ohne Gebühr)', true);
  });

  await section('Handel: Fehlerfälle', async () => {
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price: 100000, amount: 10000 }, t1);
    assertEq(r.status, 400, `order ohne geld (${r.status})`);
    assert(!!r.json?.error, 'order ohne geld: keine Fehlermeldung');
    ok('Handel: Order ohne Geld -> 400', true, r.json?.error);

    const p = await port(t1);
    const have = (p.positions || []).find(x => x.security_id === stock.id)?.amount || 0;
    const s = await POST('/orders', { security_id: stock.id, side: 'sell', type: 'limit', price: 1000, amount: have + 5 }, t1);
    assertEq(s.status, 400, `sell zu viele (${s.status})`);
    assert(!!s.json?.error, 'sell zu viele: keine Fehlermeldung');
    ok('Handel: Verkauf von mehr Aktien als im Depot -> 400', true, s.json?.error);
  });

  // ======================= 4) XETRA-PRINZIP =======================
  await section('XETRA: nicht kreuzende Order bleibt liegen', async () => {
    const d = (await GET(`/securities/${stock.id}`, t2)).json;
    const bid = d?.book?.bids?.[0]?.[0];
    assert(bid != null, 'kein bid für XETRA-Test');
    const price = bid - 100; // ein Tick unter Best Bid -> kreuzt nichts
    const r = await POST('/orders', { security_id: stock.id, side: 'buy', type: 'limit', price, amount: 3 }, t2);
    assertEq(r.status, 200, `u2 limit buy status (${r.json?.error})`);
    assertEq(r.json.order.status, 'open', 'XETRA: order sollte open sein');
    assertEq((r.json.trades || []).length, 0, 'XETRA: es darf kein Trade entstehen');
    const c = await DEL(`/orders/${r.json.order.id}`, t2);
    assertEq(c.status, 200, `XETRA cancel (${c.json?.error})`);
    ok('XETRA: limit buy unter Best Bid -> open, kein Trade, cancel ok', true,
      `bid ${bid}, order @ ${price}`);
  });

  // ======================= 5) PORTFOLIO / LEADERBOARD =======================
  await section('Portfolio & Leaderboard', async () => {
    const p = await port(t1);
    const sum = (p.positions || []).reduce((a, x) => a + x.value, 0);
    assert(Math.abs(p.net_worth - (p.cash + sum)) <= 1,
      `net_worth ${p.net_worth} != cash+positions ${p.cash + sum}`);
    ok('Portfolio: net_worth = cash + Summe positions.value (±1c)', true,
      `${p.cash} + ${sum} = ${p.cash + sum}`);

    const lb = await GET('/leaderboard', t1);
    assertEq(lb.status, 200, `leaderboard (${lb.status})`);
    const hit = (lb.json?.leaderboard || []).some(r => r.username === U1);
    assert(hit, 'u1 nicht im Leaderboard');
    assert(typeof lb.json?.my_rank === 'number' && lb.json.my_rank >= 1, `my_rank fehlt: ${lb.json?.my_rank}`);
    ok('Leaderboard: u1 enthalten, my_rank gesetzt', true, `my_rank ${lb.json.my_rank}`);
  });

  // ======================= 6) IPO-FLOW =======================
  let newSecId = null, newTicker = null;
  await section('IPO-Flow', async () => {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const existing = new Set(((await GET('/securities')).json?.securities || []).map(s => s.ticker));
    do { newTicker = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
    while (existing.has(newTicker));
    const name = `Smoke ${newTicker} AG`;

    const a = await POST('/companies/apply', { name, ticker: newTicker, description: 'Smoke-Test GmbH' }, t1);
    assertEq(a.status, 200, `apply (${a.status}, ${a.json?.error})`);
    const appId = a.json?.id;
    assert(!!appId, 'apply: keine id');

    const al = await POST('/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
    assertEq(al.status, 200, `admin login (${al.status}, ${al.json?.error})`);
    assertEq(al.json?.user?.role, 'admin', 'admin login: role');
    tAdmin = al.json.token;

    const list = await GET('/admin/ipo', tAdmin);
    assertEq(list.status, 200, `admin/ipo (${list.status})`);
    const app = (list.json?.applications || []).find(x => x.id === appId);
    assert(!!app, 'Antrag nicht in /admin/ipo');
    assertEq(app.status, 'pending', 'Antrag-Status');
    assertEq(app.username, U1, 'Antrag-username');

    const ap = await POST(`/admin/ipo/${appId}/approve`,
      { ipo_price: 10, founder_shares: 1000, float_shares: 400, threshold_mult: 1.5 }, tAdmin);
    assertEq(ap.status, 200, `approve (${ap.status}, ${ap.json?.error})`);
    newSecId = ap.json?.security_id;
    assert(!!newSecId, 'approve: keine security_id');

    const secs = (await GET('/securities')).json?.securities || [];
    const found = secs.find(s => s.ticker === newTicker);
    assert(!!found, `neue Security ${newTicker} nicht in /securities`);
    ok('IPO: apply -> admin sieht Antrag -> approve -> Security sichtbar', true,
      `${newTicker} id=${newSecId}, last=${found?.last}`);

    const p = await port(t1);
    const pos = (p.positions || []).find(x => x.security_id === newSecId);
    assert(!!pos, 'u1 hat keine Position an der neuen Aktie');
    assertEq(pos.amount, 1000, 'u1 sollte genau 1000 Gruenderaktien haben');
    ok('IPO: u1 erhaelt 1000 Gruenderaktien', true, `amount=${pos?.amount} avg_cost=${pos?.avg_cost}`);

    const lk = await POST('/orders', { security_id: newSecId, side: 'sell', type: 'limit', price: 1100, amount: 1 }, t1);
    assertEq(lk.status, 400, `lockup sell (${lk.status})`);
    assert(String(lk.json?.error || '').includes('Lock-up'), `Lock-up-Fehler erwartet: ${lk.json?.error}`);
    ok('IPO: Lock-up verhindert Gruender-Verkauf', true, lk.json?.error);

    const ov = await GET('/admin/overview', tAdmin);
    assertEq(ov.status, 200, `admin/overview (${ov.status})`);
    const tpos = (ov.json?.treasury?.positions || []).find(x => x.security_id === newSecId);
    assert(!!tpos, 'Treasury hat keine Position an der neuen Aktie');
    // MM-Ask des Treasuries liegt mit mm_size=10 Stueck treuhaenderisch im Buch
    assert(tpos.amount >= 390 && tpos.amount <= 400,
      `Treasury sollte ~400 Float-Stuecke haben (400 minus MM-Escrow): ${tpos?.amount}`);
    ok('IPO: Treasury haelt die Float-Stuecke (~400)', true, `amount=${tpos?.amount}`);
  });

  // ======================= 7) DIVIDENDE =======================
  await section('Dividende', async () => {
    const before = (await port(t1)).cash;
    const pv = await GET(`/admin/dividend/preview?security_id=${newSecId}&per_share=0.5`, tAdmin);
    assertEq(pv.status, 200, `preview (${pv.status}, ${pv.json?.error})`);
    assertEq(pv.json?.per_share, 50, 'preview: per_share (50c)');
    // 1000 (u1) + 400 (Treasury) abzueglich ggf. im MM-Ask treuhaenderisch liegender 10 Stueck
    assert([1390, 1400].includes(pv.json?.total_shares),
      `preview: total_shares sollte 1400 (1000+400) sein: ${pv.json?.total_shares}`);
    assertEq(pv.json?.total, pv.json.total_shares * 50, 'preview: total = total_shares x 50c');
    ok('Dividende: preview total = total_shares x 50c', true,
      `holders=${pv.json?.holders}, total_shares=${pv.json?.total_shares}, total=${pv.json?.total}`);

    const pd = await POST('/admin/dividend', { security_id: newSecId, per_share: 0.5, reason: 'Smoke-Test' }, tAdmin);
    assertEq(pd.status, 200, `dividend post (${pd.status}, ${pd.json?.error})`);
    const after = (await port(t1)).cash;
    assertEq(after - before, 50000, 'u1 cash sollte +1000x50c = 50000c sein');
    ok('Dividende: u1 cash +50000c (1000 x 50c)', true, `${before} -> ${after}`);

    const news = (await GET('/news?limit=50')).json?.news || [];
    const hit = news.some(n => n.kind === 'dividend' && n.security_id === newSecId);
    assert(hit, 'keine Dividenden-News gefunden');
    ok('Dividende: News vorhanden', true);
  });

  // ======================= 8) ETF =======================
  await section('ETF', async () => {
    const e = await GET('/admin/etf', tAdmin);
    assertEq(e.status, 200, `admin/etf (${e.status})`);
    const etfs = e.json?.etfs || [];
    assert(etfs.length >= 1, 'kein ETF in admin/etf');
    const etf0 = etfs[0];
    assert(typeof etf0.nav_per_share === 'number' && etf0.nav_per_share > 0,
      `nav_per_share ungueltig: ${etf0.nav_per_share}`);
    ok('ETF: nav_per_share > 0', true, `${etf0.ticker}: NAV ${etf0.nav_per_share.toFixed(1)}c`);

    const pv = await GET(`/admin/etf/${etf0.id}/preview?units=2`, tAdmin);
    assertEq(pv.status, 200, `preview units=2 (${pv.status}, ${pv.json?.error})`);
    const cp = pv.json?.creation?.est_profit, rp = pv.json?.redemption?.est_profit;
    assert(typeof cp === 'number' && Number.isFinite(cp), `creation.est_profit keine Zahl: ${cp}`);
    assert(typeof rp === 'number' && Number.isFinite(rp), `redemption.est_profit keine Zahl: ${rp}`);
    ok('ETF: preview units=2 mit creation/redemption est_profit', true,
      `creation ${cp}c / redemption ${rp}c`);

    // Redemption ohne Bestand: riesige units -> Treasury hat nie genug
    const rr = await POST(`/admin/etf/${etf0.id}/redeem-units`, { units: 1000000000 }, tAdmin);
    assertEq(rr.status, 400, `redeem riesig (${rr.status})`);
    assert(/ETF-Anteile/.test(String(rr.json?.error || '')), `erwartete 'besitzt nur X ETF-Anteile'-Meldung: ${rr.json?.error}`);
    ok('ETF: redemption ohne Bestand -> Fehlermeldung', true, rr.json?.error);

    const r0 = await POST(`/admin/etf/${etf0.id}/redeem-units`, { units: 0 }, tAdmin);
    assertEq(r0.status, 400, `redeem units=0 (${r0.status}, ${r0.json?.error})`);
    ok('ETF: units=0 -> 400', true, r0.json?.error);
  });

  // ======================= 9) TREASURY / AP =======================
  await section('Treasury/AP', async () => {
    const r = await POST('/admin/treasury/order',
      { security_id: stock.id, side: 'buy', type: 'limit', price: 100, amount: 5 }, tAdmin);
    assertEq(r.status, 200, `treasury order (${r.status}, ${r.json?.error})`);
    assertEq(r.json?.order?.status, 'open', 'treasury order: status');
    assertEq((r.json?.trades || []).length, 0, 'treasury order: darf nicht fuellen');
    const oid = r.json.order.id;

    const l = await GET('/admin/treasury/orders', tAdmin);
    assertEq(l.status, 200, `treasury orders (${l.status})`);
    assert((l.json?.orders || []).some(o => o.id === oid), 'Order nicht in treasury/orders sichtbar');
    ok('Treasury: limit buy weit unten bleibt offen + sichtbar', true, `order ${oid} @ 100c`);

    const c = await POST(`/admin/treasury/cancel/${oid}`, {}, tAdmin);
    assertEq(c.status, 200, `treasury cancel (${c.status}, ${c.json?.error})`);
    const l2 = await GET('/admin/treasury/orders', tAdmin);
    assert(!(l2.json?.orders || []).some(o => o.id === oid), 'Order nach cancel noch sichtbar');
    ok('Treasury: cancel -> Order weg', true);
  });

  // ======================= 10) AUFSICHT =======================
  await section('Aufsicht (Freeze)', async () => {
    const body = { security_id: stock.id, side: 'buy', type: 'limit', price: 100, amount: 1 };
    const f = await POST(`/admin/users/${u2id}/freeze`, { freeze: true }, tAdmin);
    assertEq(f.status, 200, `freeze (${f.status}, ${f.json?.error})`);
    const fro = await POST('/orders', body, t2);
    assertEq(fro.status, 403, `frozen order (${fro.status})`);
    assert(/eingefroren/i.test(String(fro.json?.error || '')), `Fehler sollte 'eingefroren' enthalten: ${fro.json?.error}`);
    ok('Aufsicht: freeze -> u2 Order -> 403 eingefroren', true, fro.json?.error);

    const u = await POST(`/admin/users/${u2id}/freeze`, { freeze: false }, tAdmin);
    assertEq(u.status, 200, `unfreeze (${u.status})`);
    const o = await POST('/orders', body, t2);
    assertEq(o.status, 200, `order nach unfreeze (${o.status}, ${o.json?.error})`);
    if (o.json?.order?.id) await DEL(`/orders/${o.json.order.id}`, t2);
    ok('Aufsicht: unfreeze -> Order geht wieder', true);

    const s = await GET(`/admin/users?q=${encodeURIComponent(U2)}`, tAdmin);
    assertEq(s.status, 200, `admin/users (${s.status})`);
    assert((s.json?.users || []).some(x => x.username === U2), `u2 per ?q= nicht gefunden`);
    ok('Aufsicht: admin/users?q= findet u2', true);
  });

  // ======================= 11) BOARD =======================
  await section('Board', async () => {
    const b = await GET('/board');
    assertEq(b.status, 200, `board (${b.status})`);
    const j = b.json || {};
    assert(typeof j.index === 'number' && j.index > 0, `index ungueltig: ${j.index}`);
    assert((j.index_history || []).length > 0, 'index_history leer');
    assert((j.tops || []).length > 0, 'tops leer');
    assert((j.leaderboard || []).length > 0, 'leaderboard leer');
    assert((j.news || []).length > 0, 'news leer');
    ok('Board: index>0, index_history/tops/leaderboard/news gefuellt', true,
      `index=${j.index}, history=${(j.index_history || []).length} Punkte`);
  });

  // ======================= 12) SETTINGS + EINKOMMEN =======================
  await section('Settings & Einkommen', async () => {
    const put = await PUT('/admin/settings', { income_sec: 60 }, tAdmin);
    assertEq(put.status, 200, `put settings (${put.status})`);
    assertEq(put.json?.settings?.income_sec, 60, 'put: income_sec nicht uebernommen');
    const get = await GET('/admin/settings', tAdmin);
    assertEq(get.json?.settings?.income_sec, 60, 'get: income_sec != 60');
    ok('Settings: PUT income_sec=60 -> GET liefert 60', true);

    const before = (await port(t1)).cash;
    const inc = await POST('/admin/income/now', {}, tAdmin);
    assertEq(inc.status, 200, `income/now (${inc.status})`);
    const after = (await port(t1)).cash;
    assertEq(after - before, 100000, `u1 cash sollte +income_cent (100000c) steigen: ${after - before}`);
    ok('Einkommen: income/now -> u1 cash +100000c', true, `${before} -> ${after}`);
  });

  // ======================= 13) ROLLENTRENNUNG =======================
  await section('Rollentrennung', async () => {
    const r = await PUT('/admin/settings', { income_sec: 120 }, t1);
    assertEq(r.status, 403, `u1 als admin (${r.status})`);
    ok('Rolle: u1 (role user) auf /admin/settings -> 403', true, r.json?.error);
  });

  console.log('\n==========================================');
  console.log(`ERGEBNIS: ${pass} PASS, ${fail} FAIL`);
  console.log('==========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('❌ Unerwarteter Fehler im Test-Harness:', e);
  process.exit(1);
});
