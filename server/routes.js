// Alle REST-Routen: Auth, Markt/Handel, Unternehmen, Board (öffentlich), Admin (AG).
const express = require('express');
const { db, getSettings, setSetting, q, addNews } = require('./db');
const bus = require('./bus');
const engine = require('./engine');
const etf = require('./etf');
const auth = require('./auth');
const jobs = require('./jobs');
const bots = require('./bots');

const router = express.Router();
router.use(auth.middleware);

const pubUser = (u) => u && ({ id: u.id, username: u.username, role: u.role, cash: u.cash, frozen: !!u.frozen });

// =========================== AUTH ===========================
router.post('/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (name.length < 3 || name.length > 20) return res.status(400).json({ error: 'Username: 3-20 Zeichen' });
  if (!/^[a-zA-Z0-9_äöüÄÖÜß .-]+$/.test(name)) return res.status(400).json({ error: 'Ungültige Zeichen im Username' });
  if (String(password || '').length < 4) return res.status(400).json({ error: 'Passwort: min. 4 Zeichen' });
  if (q.userByName.get(name)) return res.status(409).json({ error: 'Username vergeben' });
  const u = auth.createUser(name, password, 'user', getSettings().start_capital);
  const token = auth.createSession(u.id);
  const n = addNews('system', `🆕 Neuer Trader: ${name}`, `${name} hat ein Depot eröffnet und ${(getSettings().start_capital / 100).toFixed(0)} Credits Startkapital erhalten.`);
  bus.emit({ type: 'news', news: n });
  res.json({ token, user: pubUser(u) });
});

router.post('/auth/login', async (req, res) => {
  const u = await auth.verifyLoginAsync(req.body?.username, req.body?.password);
  if (!u) return res.status(401).json({ error: 'Falsche Zugangsdaten' });
  if (u.role === 'bank') return res.status(403).json({ error: 'Das Treasury-Konto kann sich nicht einloggen' });
  auth.destroySession(req.token);
  const token = auth.createSession(u.id);
  res.json({ token, user: pubUser(u) });
});
router.post('/auth/logout', (req, res) => { auth.destroySession(req.token); res.json({ ok: true }); });
router.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  res.json({ user: pubUser(req.user) });
});

// =========================== MARKT (public Daten) ===========================
router.get('/securities', (req, res) => res.json({ securities: engine.tickerAll() }));

router.get('/securities/:id', (req, res) => {
  const sec = q.secById.get(Number(req.params.id));
  if (!sec) return res.status(404).json({ error: 'Nicht gefunden' });
  const book = engine.books.get(sec.id);
  const tape = db.prepare('SELECT t.*, bu.username buyer, se.username seller FROM trades t LEFT JOIN users bu ON bu.id=t.buyer_id LEFT JOIN users se ON se.id=t.seller_id WHERE t.security_id=? ORDER BY t.id DESC LIMIT 25').all(sec.id);
  const info = { ...engine.tickerRow(sec.id), description: sec.description, total_shares: sec.total_shares, ipo_price: sec.ipo_price };
  if (sec.type === 'etf') Object.assign(info, { nav: etf.nav(sec.id) });
  let mine = null;
  if (req.user) {
    const h = q.holding.get(req.user.id, sec.id);
    const orders = db.prepare("SELECT * FROM orders WHERE user_id=? AND security_id=? AND status='open' ORDER BY id DESC").all(req.user.id, sec.id);
    mine = { amount: h ? h.amount : 0, avg_cost: h ? h.avg_cost : 0, open_orders: orders };
  }
  res.json({
    security: info, book: engine.bookSnapshot(sec.id), tape, mine,
    stats: engine.computeStats(sec.id),
    band: engine.priceBand(book),
    founder: sec.founder_id ? pubUser(q.userById.get(sec.founder_id)) : null, is_founder: req.user && sec.founder_id === req.user.id, lockup_until: sec.lockup_until
  });
});

// Order-Preview: exakter Book-Walk (10@50 + 10@55 = 1050), nicht ausführend.
router.get('/securities/:id/preview', (req, res) => {
  try {
    const { side = 'buy', type = 'market', amount = 1, price = null } = req.query;
    res.json(engine.previewOrder(req.user, {
      security_id: Number(req.params.id), side, type,
      amount: Number(amount), price: price != null ? Math.round(Number(price)) : null
    }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/securities/:id/candles', (req, res) => {
  const secId = Number(req.params.id);
  const bucket = Math.max(60000, Number(req.query.bucket) || 300000); // min 1 Min
  const range = Math.min(30 * 86400000, Number(req.query.range) || 86400000);
  const rows = db.prepare('SELECT ts, price, amount FROM price_history WHERE security_id=? AND ts>=? ORDER BY ts ASC').all(secId, Date.now() - range);
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.ts / bucket) * bucket;
    if (!buckets.has(b)) buckets.set(b, { t: b, o: r.price, h: r.price, l: r.price, c: r.price, v: 0 });
    const c = buckets.get(b);
    c.h = Math.max(c.h, r.price); c.l = Math.min(c.l, r.price); c.c = r.price; c.v += r.amount;
  }
  res.json({ candles: [...buckets.values()] });
});

router.get('/news', (req, res) => res.json({ news: q.newsAll.all(Math.min(100, Number(req.query.limit) || 40)) }));

// =========================== HANDEL (auth) ===========================
router.post('/orders', auth.requireAuth, (req, res) => {
  try {
    const u = q.userById.get(req.user.id);
    const result = engine.placeOrder(u, req.body || {});
    res.json({ order: result.order, trades: result.trades, cash: q.userById.get(u.id).cash });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/orders', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT o.*, s.ticker, s.name FROM orders o JOIN securities s ON s.id=o.security_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 60').all(req.user.id);
  res.json({ orders: rows });
});
router.delete('/orders/:id', auth.requireAuth, (req, res) => {
  try { res.json(engine.cancelOrder(q.userById.get(req.user.id), Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/portfolio', auth.requireAuth, (req, res) => {
  const u = q.userById.get(req.user.id);
  const positions = db.prepare(`SELECT h.*, s.ticker, s.name, s.type, s.id sec_id FROM holdings h JOIN securities s ON s.id=h.security_id WHERE h.user_id=?`).all(u.id);
  let worth = u.cash;
  const pos = positions.map(p => {
    const book = engine.books.get(p.security_id);
    const last = book ? book.last : 0;
    const value = p.amount * last;
    worth += value;
    return { security_id: p.security_id, ticker: p.ticker, name: p.name, type: p.type, amount: p.amount, avg_cost: p.avg_cost, last, value, pnl: (last - p.avg_cost) * p.amount };
  });
  const founded = db.prepare('SELECT id, ticker, name FROM securities WHERE founder_id=? AND type=? ').all(u.id, 'stock');
  const takeovers = db.prepare('SELECT id, ticker, name FROM securities WHERE majority_holder_id=?').all(u.id);
  res.json({
    cash: u.cash, realized_pl: u.realized_pl, net_worth: worth, positions: pos,
    badges: {
      founder: founded.map(f => f.ticker),
      bagholder: pos.some(p => p.avg_cost > 0 && p.last < p.avg_cost * 0.5),
      takeover_king: takeovers.length > 0, takeovers: takeovers.map(t => t.ticker)
    }
  });
});

router.get('/leaderboard', (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE role='user' AND is_bot=0").all();
  const rows = users.map(u => {
    let worth = u.cash;
    for (const h of db.prepare('SELECT * FROM holdings WHERE user_id=?').all(u.id)) {
      const b = engine.books.get(h.security_id);
      if (b) worth += h.amount * b.last;
    }
    return { id: u.id, username: u.username, worth, realized_pl: u.realized_pl, frozen: !!u.frozen };
  }).sort((a, b) => b.worth - a.worth);
  const rankOf = (id) => { const i = rows.findIndex(r => r.id === id); return i === -1 ? null : i + 1; };
  res.json({ leaderboard: rows.slice(0, 20).map((r, i) => ({ ...r, rank: i + 1 })), my_rank: req.user ? rankOf(req.user.id) : null });
});

// =========================== UNTERNEHMEN (Spieler) ===========================
router.post('/companies/apply', auth.requireAuth, (req, res) => {
  const { name, ticker, description } = req.body || {};
  const tick = String(ticker || '').trim().toUpperCase();
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'Firmenname zu kurz' });
  if (!/^[A-Z]{3,6}$/.test(tick)) return res.status(400).json({ error: 'Ticker: 3-6 Buchstaben (z.B. MENSA)' });
  if (q.secByTicker.get(tick)) return res.status(409).json({ error: 'Ticker schon vergeben' });
  const r = db.prepare('INSERT INTO ipo_applications(user_id, name, ticker, description, created_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, String(name).trim(), tick, String(description || '').slice(0, 500), Date.now());
  res.json({ ok: true, id: r.lastInsertRowid });
});
router.get('/companies/mine', auth.requireAuth, (req, res) => {
  const apps = db.prepare('SELECT * FROM ipo_applications WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  const companies = db.prepare("SELECT * FROM securities WHERE founder_id=? AND type='stock'").all(req.user.id).map(c => {
    const book = engine.books.get(c.id);
    const eligible = c.hours_above >= getSettings().cap_hours_needed && book && book.last >= c.threshold_price;
    const openReq = db.prepare("SELECT COUNT(*) c FROM requests WHERE security_id=? AND type='capital_increase' AND status='pending'").get(c.id).c;
    return { ...c, last: book ? book.last : 0, cap_eligible: !!eligible && !openReq, hours_needed: getSettings().cap_hours_needed };
  });
  res.json({ applications: apps, companies });
});
// Übernahme-Sonderrecht: Umbenennung durch Mehrheitsinhaber (>50%)
router.post('/companies/:id/rename', auth.requireAuth, (req, res) => {
  const sec = q.secById.get(Number(req.params.id));
  if (!sec || sec.type !== 'stock') return res.status(404).json({ error: 'Nicht gefunden' });
  const h = engine.holdingOf(req.user.id, sec.id);
  if (h * 2 <= sec.total_shares) return res.status(403).json({ error: 'Nur mit >50% der Anteile (Übernahme-Sonderrecht)' });
  const name = String(req.body?.name || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name zu kurz' });
  db.prepare('UPDATE securities SET name=? WHERE id=?').run(name, sec.id);
  engine.books.get(sec.id).sec.name = name;
  const n = addNews('takeover', `${sec.name} heißt jetzt ${name}`, `${req.user.username} hat als Mehrheitsinhaber die Firma ${sec.name} (${sec.ticker}) in ${name} umbenannt.`, sec.id);
  bus.emit({ type: 'news', news: n });
  bus.emit({ type: 'ticker', ticker: engine.tickerRow(sec.id) });
  res.json({ ok: true });
});
router.post('/companies/:id/request-special-dividend', auth.requireAuth, (req, res) => {
  const sec = q.secById.get(Number(req.params.id));
  if (!sec || sec.type !== 'stock') return res.status(404).json({ error: 'Nicht gefunden' });
  const h = engine.holdingOf(req.user.id, sec.id);
  if (h * 2 <= sec.total_shares) return res.status(403).json({ error: 'Nur mit >50% der Anteile (Übernahme-Sonderrecht)' });
  const per = Math.round(Number(req.body?.per_share) * 100);
  if (!Number.isInteger(per) || per <= 0) return res.status(400).json({ error: 'Ungültige Dividende je Aktie' });
  const open = db.prepare("SELECT COUNT(*) c FROM requests WHERE security_id=? AND type='special_dividend' AND status='pending'").get(sec.id).c;
  if (open) return res.status(409).json({ error: 'Es liegt schon ein Antrag offen' });
  db.prepare("INSERT INTO requests(type, security_id, user_id, amount, created_at) VALUES('special_dividend',?,?,?,?)").run(sec.id, req.user.id, per, Date.now());
  res.json({ ok: true });
});
router.post('/companies/:id/request-capital-increase', auth.requireAuth, (req, res) => {
  const sec = q.secById.get(Number(req.params.id));
  if (!sec || sec.type !== 'stock' || sec.founder_id !== req.user.id) return res.status(403).json({ error: 'Nur der Gründer' });
  const book = engine.books.get(sec.id);
  if (!(sec.hours_above >= getSettings().cap_hours_needed && book.last >= sec.threshold_price))
    return res.status(400).json({ error: `Milestone nicht erreicht: Kurs muss ${getSettings().cap_hours_needed}h über ${(sec.threshold_price / 100).toFixed(2)} bleiben (aktuell ${sec.hours_above}h)` });
  db.prepare("INSERT INTO requests(type, security_id, user_id, created_at) VALUES('capital_increase',?,?,?)").run(sec.id, req.user.id, Date.now());
  res.json({ ok: true });
});

// =========================== BOARD / DESK (öffentlich) ===========================
// Index + Historie (5-Min-Buckets) — gemeinsam für /board und /desk.
function boardIndexData(stocks) {
  const mcap = (sec) => { const b = engine.books.get(sec.id); return b ? b.last * sec.total_shares : 0; };
  const totalMcap = stocks.reduce((a, s) => a + mcap(s), 0);
  let base = getSettings().idx_base_mcap;
  if (!base && totalMcap > 0) { base = totalMcap; setSetting('idx_base_mcap', base); }
  const index = base ? Math.round(totalMcap / base * 1000) : 0;

  const bucket = 5 * 60 * 1000, range = 24 * 3600 * 1000;
  const rows = db.prepare(`SELECT security_id, ts, price FROM price_history WHERE ts>=? AND security_id IN (SELECT id FROM securities WHERE type='stock') ORDER BY ts ASC`).all(Date.now() - range);
  const lastP = new Map(), points = [];
  let cur = null;
  for (const r of rows) {
    const b = Math.floor(r.ts / bucket) * bucket;
    if (cur === null) { cur = b; }
    else if (b !== cur) {
      let mc = 0;
      for (const s of stocks) { const p = lastP.get(s.id) || s.ipo_price; mc += p * s.total_shares; }
      points.push({ t: cur, v: base ? Math.round(mc / base * 1000) : 0 });
      cur = b;
    }
    lastP.set(r.security_id, r.price);
  }
  if (cur !== null) {
    let mc = 0;
    for (const s of stocks) { const p = lastP.get(s.id) || s.ipo_price; mc += p * s.total_shares; }
    points.push({ t: cur, v: base ? Math.round(mc / base * 1000) : 0 });
  }
  return { index, points: points.slice(-200) };
}

// Sparkline-Daten für Mini-Charts (Tops/Flops, Desk-Kacheln): letzte N Punkte.
// Bucket-Größe passt sich der tatsächlichen Daten-Spanne an, damit auch junge
// Wertpapiere sofort einen schönen Kurvenverlauf liefern.
function sparkFor(secId, points = 40, spanMs = 12 * 3600 * 1000) {
  const rows = db.prepare('SELECT ts, price FROM price_history WHERE security_id=? AND ts>=? ORDER BY ts ASC').all(secId, Date.now() - spanMs);
  if (rows.length < 2) return rows.map((r) => r.price);
  const dataSpan = Math.max(60000, rows[rows.length - 1].ts - rows[0].ts);
  const bucket = Math.max(60000, Math.floor(dataSpan / points));
  const m = new Map();
  for (const r of rows) m.set(Math.floor(r.ts / bucket) * bucket, r.price);
  return [...m.entries()].sort((a, b) => a - b).slice(-points).map(([, p]) => p);
}

// OHLC-Kerzen (bucketed) — wie /securities/:id/candles, als Helper für /desk.
function bucketCandles(secId, range, bucket) {
  const rows = db.prepare('SELECT ts, price, amount FROM price_history WHERE security_id=? AND ts>=? ORDER BY ts ASC').all(secId, Date.now() - range);
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.ts / bucket) * bucket;
    if (!buckets.has(b)) buckets.set(b, { t: b, o: r.price, h: r.price, l: r.price, c: r.price, v: 0 });
    const c = buckets.get(b);
    c.h = Math.max(c.h, r.price); c.l = Math.min(c.l, r.price); c.c = r.price; c.v += r.amount;
  }
  return [...buckets.values()];
}

router.get('/board', (req, res) => {
  const stocks = db.prepare("SELECT * FROM securities WHERE type='stock' AND status='active'").all();
  const etfs = db.prepare("SELECT * FROM securities WHERE type='etf' AND status='active'").all();
  const { index, points } = boardIndexData(stocks);

  const tick = engine.tickerAll();
  const withChg = tick.filter(t => t.type === 'stock' || t.type === 'etf');
  const sorted = [...withChg].sort((a, b) => b.chg - a.chg);
  const withSpark = (t) => ({ ...t, spark: sparkFor(t.id) });
  const lb = db.prepare("SELECT * FROM users WHERE role='user' AND is_bot=0").all().map(u => {
    let worth = u.cash;
    for (const h of db.prepare('SELECT * FROM holdings WHERE user_id=?').all(u.id)) {
      const b = engine.books.get(h.security_id);
      if (b) worth += h.amount * b.last;
    }
    return { username: u.username, worth };
  }).sort((a, b) => b.worth - a.worth).slice(0, 10);

  res.json({
    index, index_history: points,
    tops: sorted.slice(0, 4).map(withSpark),
    flops: [...sorted].reverse().filter(f => f.chg < 0).slice(0, 4).map(withSpark),
    leaderboard: lb, news: q.newsAll.all(12),
    etf: etfs.map(e => ({ ...engine.tickerRow(e.id), nav: etf.nav(e.id) }))
  });
});

// Trading-Desk (/desk): volle Markt-Ansicht für den PC — Kerzen je Wert, Stats,
// Breadth, News, Leaderboard. ?range= in ms (Default 24h), ?bucket= in ms.
router.get('/desk', (req, res) => {
  const range = Math.min(30 * 86400000, Math.max(3600000, Number(req.query.range) || 86400000));
  const bucket = Math.max(60000, Number(req.query.bucket) || Math.max(60000, Math.floor(range / 96)));
  const stocks = db.prepare("SELECT * FROM securities WHERE type='stock' AND status='active'").all();
  const { index, points } = boardIndexData(stocks);

  const securities = db.prepare("SELECT * FROM securities WHERE status='active' ORDER BY id").all().map(sec => ({
    id: sec.id, ticker: sec.ticker, name: sec.name, type: sec.type, description: sec.description,
    total_shares: sec.total_shares, ipo_price: sec.ipo_price,
    ...engine.tickerRow(sec.id),
    stats: engine.computeStats(sec.id),
    candles: bucketCandles(sec.id, range, bucket),
    spark: sparkFor(sec.id),
    nav: sec.type === 'etf' ? etf.nav(sec.id) : null
  }));

  const day = Date.now() - 24 * 3600 * 1000;
  const tot = db.prepare('SELECT COUNT(*) n, SUM(amount) vol, SUM(price*amount) turnover FROM trades WHERE created_at>=?').get(day);
  const advancers = securities.filter(s => s.type === 'stock' && s.chg > 0).length;
  const decliners = securities.filter(s => s.type === 'stock' && s.chg < 0).length;
  const lb = db.prepare("SELECT * FROM users WHERE role='user' AND is_bot=0").all().map(u => {
    let worth = u.cash;
    for (const h of db.prepare('SELECT * FROM holdings WHERE user_id=?').all(u.id)) {
      const b = engine.books.get(h.security_id);
      if (b) worth += h.amount * b.last;
    }
    return { username: u.username, worth };
  }).sort((a, b) => b.worth - a.worth).slice(0, 10);

  res.json({
    index, index_history: points,
    securities,
    breadth: { advancers, decliners, unchanged: stocks.length - advancers - decliners, stocks: stocks.length },
    totals: { trades24: tot.n || 0, volume24: tot.vol || 0, turnover24: tot.turnover || 0 },
    news: q.newsAll.all(15),
    leaderboard: lb,
    range, bucket,
    generated_at: Date.now()
  });
});

// =========================== ADMIN (Investment AG) ===========================
function adminOverview() {
  const t = engine.treasury();
  const counts = {
    users: db.prepare("SELECT COUNT(*) c FROM users WHERE role='user' AND is_bot=0").get().c,
    bots: db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=1').get().c,
    bots_running: bots.status().running,
    frozen: db.prepare('SELECT COUNT(*) c FROM users WHERE frozen=1').get().c,
    securities: db.prepare("SELECT COUNT(*) c FROM securities WHERE status='active'").get().c,
    trades_today: db.prepare('SELECT COUNT(*) c FROM trades WHERE created_at>=?').get(Date.now() - 86400000).c,
    fees_burned: db.prepare("SELECT COUNT(*) c FROM orders WHERE fee_charged=1 AND is_mm=0").get().c * getSettings().fee_cent
  };
  const treasuryPositions = t ? db.prepare(`SELECT h.*, s.ticker FROM holdings h JOIN securities s ON s.id=h.security_id WHERE h.user_id=?`).all(t.id) : [];
  return { treasury: { cash: t ? t.cash : 0, positions: treasuryPositions }, counts, next_income_in: Math.max(0, jobsState.last_income + getSettings().income_sec * 1000 - Date.now()) };
}
let jobsState = jobs.state; // für "nächstes Einkommen in"-Anzeige

router.get('/admin/overview', auth.requireAdmin, (req, res) => res.json(adminOverview()));

router.get('/admin/settings', auth.requireAdmin, (req, res) => res.json({ settings: getSettings() }));
router.put('/admin/settings', auth.requireAdmin, (req, res) => {
  const allowed = ['fee_cent', 'income_cent', 'income_sec', 'start_capital', 'inactivity_sec', 'lockup_sec',
    'treasury_capital',
    'mm_spread_bp', 'mm_size', 'mm_levels', 'mm_size_step', 'mm_step_bp', 'mm_refresh_sec', 'mm_fee_exempt',
    'mm_cash_budget_pct', 'mm_noise_bp', 'mm_jitter_bp', 'mm_size_jitter', 'mm_inv_target_pct', 'mm_inv_skew_bp',
    'mm_guard_pct', 'mm_guard_widen', 'mm_replenish_min', 'mm_replenish_qty', 'mm_replenish_price_mult',
    'mm_recap_min_pct', 'mm_recap_to_pct', 'mm_vol_ref', 'mm_vol_mult_max',
    'etf_auto', 'etf_auto_threshold_pct', 'etf_auto_units', 'etf_auto_interval_sec', 'etf_auto_max_units',
    'bot_count', 'bot_activity', 'bot_tick_sec', 'bot_fast',
    'limit_band_pct', 'limit_band_cents', 'cap_hours_needed'];
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) setSetting(k, Number(v));
  res.json({ settings: getSettings() });
});
router.post('/admin/income/now', auth.requireAdmin, (req, res) => { jobs.payIncome(); res.json(adminOverview()); });

// ---- IPO-Anträge ----
router.get('/admin/ipo', auth.requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.username FROM ipo_applications a LEFT JOIN users u ON u.id=a.user_id WHERE a.status='pending' ORDER BY a.id`).all();
  res.json({ applications: rows });
});
router.post('/admin/ipo/:id/approve', auth.requireAdmin, (req, res) => {
  const app = db.prepare('SELECT * FROM ipo_applications WHERE id=?').get(Number(req.params.id));
  if (!app || app.status !== 'pending') return res.status(404).json({ error: 'Antrag nicht offen' });
  if (q.secByTicker.get(app.ticker)) return res.status(409).json({ error: 'Ticker inzwischen vergeben' });
  const ipo = Math.round(Number(req.body?.ipo_price) * 100);
  const founderShares = Math.floor(Number(req.body?.founder_shares) || 1000);
  const floatShares = Math.floor(Number(req.body?.float_shares) ?? 2000);
  const thresholdMult = Number(req.body?.threshold_mult) || 1.5;
  if (!(ipo > 0) || founderShares < 1 || floatShares < 0) return res.status(400).json({ error: 'Ungültige Parameter' });
  const founder = q.userById.get(app.user_id);
  if (!founder) return res.status(404).json({ error: 'Gründer gelöscht' });
  const sec = engine.listSecurity({ type: 'stock', ticker: app.ticker, name: app.name, description: app.description, founder_id: founder.id, ipo_price: ipo, total_shares: founderShares + floatShares });
  db.prepare('UPDATE securities SET threshold_price=? WHERE id=?').run(Math.round(ipo * thresholdMult), sec.id);
  sec.threshold_price = Math.round(ipo * thresholdMult);
  const t = engine.treasury();
  // Streubesutz: Treasury kauft float_shares vom Gründer zum IPO-Preis (Zahlung an Gründer)
  engine.addHoldingPublic(founder.id, sec.id, founderShares, ipo);
  if (floatShares > 0) {
    // FIX: float_shares nur ins Treasury-Depot buchen (nicht zusaetzlich beim Gruender) -
    // sonst existieren founder_shares + 2*float_shares statt total_shares (= founder+float).
    engine.addHoldingPublic(t.id, sec.id, floatShares, ipo);
    db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(ipo * floatShares, founder.id);
    db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(ipo * floatShares, t.id);
  }
  db.prepare('UPDATE ipo_applications SET status=?, decided_at=? WHERE id=?').run('approved', Date.now(), app.id);
  engine.mmRecenter(engine.books.get(sec.id));
  const n = addNews('ipo', `IPO: ${sec.name} (${sec.ticker}) startet zum Kurs ${(ipo / 100).toFixed(2)}`,
    `${founder.username} hat mit ${sec.name} den Börsengang geschafft! ${founderShares} Gründeraktien (2 Wochen Lock-up), ${floatShares} Stück Streubesitz. Konzept: ${app.description}`, sec.id);
  bus.emit({ type: 'news', news: n });
  bus.emit({ type: 'ticker', ticker: engine.tickerRow(sec.id) });
  res.json({ ok: true, security_id: sec.id });
});
router.post('/admin/ipo/:id/reject', auth.requireAdmin, (req, res) => {
  db.prepare("UPDATE ipo_applications SET status='rejected', decided_at=? WHERE id=? AND status='pending'").run(Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

// ---- Anträge (Kapitalerhöhung / Sonderdividende) ----
router.get('/admin/requests', auth.requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT r.*, s.ticker, s.name, u.username FROM requests r JOIN securities s ON s.id=r.security_id LEFT JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.id`).all();
  res.json({ requests: rows });
});
router.post('/admin/requests/:id/decide', auth.requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(Number(req.params.id));
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Antrag nicht offen' });
  const approve = !!req.body?.approve;
  const sec = q.secById.get(r.security_id);
  if (approve && r.type === 'capital_increase') {
    const newShares = Math.floor(sec.total_shares * 0.2);
    db.prepare('UPDATE securities SET total_shares=?, hours_above=0, threshold_price=? WHERE id=?')
      .run(sec.total_shares + newShares, Math.round(engine.books.get(sec.id).last * 1.5), sec.id);
    engine.books.get(sec.id).sec.total_shares += newShares;
    engine.books.get(sec.id).sec.threshold_price = Math.round(engine.books.get(sec.id).last * 1.5);
    engine.addHoldingPublic(sec.founder_id, sec.id, newShares);
    const n = addNews('news', `Kapitalerhöhung: ${sec.name} (${sec.ticker})`,
      `Die Investment AG hat die Kapitalerhöhung genehmigt: +${newShares} neue Aktien (20%) für den Gründer ${q.userById.get(sec.founder_id)?.username}. Neue Kurs-Schwelle: ${(engine.books.get(sec.id).last * 1.5 / 100).toFixed(2)}.`, sec.id);
    bus.emit({ type: 'news', news: n });
    bus.emit({ type: 'dirty', user_id: sec.founder_id, what: ['portfolio'] });
  }
  if (approve && r.type === 'special_dividend') {
    payDividend(sec.id, r.amount, `Sonderdividende (${q.userById.get(r.user_id)?.username})`);
  }
  db.prepare('UPDATE requests SET status=?, decided_at=? WHERE id=?').run(approve ? 'approved' : 'rejected', Date.now(), r.id);
  res.json({ ok: true });
});

// ---- News ----
router.post('/admin/news', auth.requireAdmin, (req, res) => {
  const { title, body, security_id, kind } = req.body || {};
  if (!title || String(title).trim().length < 3) return res.status(400).json({ error: 'Titel zu kurz' });
  const n = addNews(['news', 'bafin', 'dividend'].includes(kind) ? kind : 'news', String(title).trim(), String(body || ''), security_id || null);
  bus.emit({ type: 'news', news: n });
  res.json({ ok: true, news: n });
});

// ---- Dividenden ----
function payDividend(secId, perShare, reason) {
  const sec = q.secById.get(secId);
  const holders = db.prepare('SELECT user_id, amount FROM holdings WHERE security_id=?').all(secId);
  let total = 0;
  for (const h of holders) {
    const pay = h.amount * perShare;
    db.prepare('UPDATE users SET cash = cash + ? WHERE id=?').run(pay, h.user_id);
    total += pay;
    bus.emit({ type: 'dirty', user_id: h.user_id, what: ['portfolio'] });
  }
  db.prepare('INSERT INTO dividends(security_id, per_share, total, created_at) VALUES(?,?,?,?)').run(secId, perShare, total, Date.now());
  const t = engine.treasury();
  db.prepare('UPDATE users SET cash = cash - ? WHERE id=?').run(total, t.id); // Staatskasse zahlt
  const n = addNews('dividend', `Dividende: ${sec.name} (${sec.ticker}) schüttet ${(perShare / 100).toFixed(2)} je Aktie`,
    `${reason ? reason + '. ' : ''}Insgesamt ${(total / 100).toFixed(2)} Credits an ${holders.length} Aktionäre. Achtung ETF-Anleger: auch der Korb wurde bedient.`, secId);
  bus.emit({ type: 'news', news: n });
  const routed = etf.routeDividend(secId, perShare);
  return { total, holders: holders.length, routed };
}
router.get('/admin/dividend/preview', auth.requireAdmin, (req, res) => {
  const secId = Number(req.query.security_id), per = Math.round(Number(req.query.per_share) * 100);
  const sec = q.secById.get(secId);
  if (!sec || !(per > 0)) return res.status(400).json({ error: 'Ungültig' });
  const holders = db.prepare('SELECT COUNT(*) c, SUM(amount) s FROM holdings WHERE security_id=?').get(secId);
  res.json({ security: { id: sec.id, ticker: sec.ticker }, per_share: per, total_shares: holders.s || 0, holders: holders.c, total: (holders.s || 0) * per });
});
router.post('/admin/dividend', auth.requireAdmin, (req, res) => {
  try {
    const secId = Number(req.body?.security_id), per = Math.round(Number(req.body?.per_share) * 100);
    if (!(per > 0)) return res.status(400).json({ error: 'Ungültige Dividende' });
    res.json(payDividend(secId, per, req.body?.reason));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Nutzer-Verwaltung ----
router.get('/admin/users', auth.requireAdmin, (req, res) => {
  const search = `%${String(req.query.q || '')}%`;
  const botFilter = req.query.bots === '1' ? 'AND is_bot=1' : req.query.bots === '0' ? 'AND is_bot=0' : '';
  const rows = db.prepare(`SELECT id, username, cash, realized_pl, frozen, last_active, role, is_bot FROM users
    WHERE role='user' AND is_bot=0 ${botFilter} AND (username LIKE ?) ORDER BY cash DESC LIMIT 200`).all(search);
  res.json({ users: rows.map(u => ({ ...u, worth: u.cash })) });
});
router.post('/admin/users/:id/freeze', auth.requireAdmin, (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u || u.role !== 'user') return res.status(404).json({ error: 'Nicht gefunden' });
  const freeze = req.body?.freeze !== false;
  db.prepare('UPDATE users SET frozen=? WHERE id=?').run(freeze ? 1 : 0, u.id);
  if (freeze) engine.cancelUserOrders(u.id); // offene Orders zurück, Escrow erstattet
  if (freeze) {
    const n = addNews('bafin', `BaFin ermittelt gegen ${u.username}`,
      `Die Börsenaufsicht hat das Konto von ${u.username} eingefroren und wegen des Verdachts auf Marktmanipulation Ermittlungen aufgenommen.`);
    bus.emit({ type: 'news', news: n });
  }
  res.json({ ok: true });
});
router.post('/admin/users/:id/delete', auth.requireAdmin, (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u || u.role !== 'user') return res.status(404).json({ error: 'Nicht gefunden' });
  const t = engine.treasury();
  // offene Orders stornieren (Escrow fließt zurück), dann Vermögen an die Staatskasse
  for (const o of db.prepare("SELECT * FROM orders WHERE user_id=? AND status='open'").all(u.id)) {
    try { engine.cancelOrder(u, o.id); } catch (e) {}
  }
  const fresh = q.userById.get(u.id);
  db.prepare('UPDATE users SET cash=? WHERE id=?').run(t.cash + fresh.cash, t.id);
  for (const h of db.prepare('SELECT * FROM holdings WHERE user_id=?').all(fresh.id)) engine.addHoldingPublic(t.id, h.security_id, h.amount);
  db.prepare('DELETE FROM holdings WHERE user_id=?').run(fresh.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(fresh.id);
  db.prepare('DELETE FROM users WHERE id=?').run(fresh.id);
  res.json({ ok: true });
});

// ---- ETF-Verwaltung (Arbitrage per AP) ----
router.get('/admin/etf', auth.requireAdmin, (req, res) => {
  const etfs = db.prepare("SELECT * FROM securities WHERE type='etf' AND status='active'").all();
  const stocks = db.prepare("SELECT id, ticker, name FROM securities WHERE type='stock' AND status='active'").all();
  res.json({
    etfs: etfs.map(e => ({ id: e.id, ticker: e.ticker, name: e.name, shares_per_unit: e.shares_per_unit, total_shares: e.total_shares, ...etf.nav(e.id), ticker_data: engine.tickerRow(e.id) })),
    stocks, treasury_positions: (() => { const t = engine.treasury(); return db.prepare(`SELECT s.ticker, h.amount FROM holdings h JOIN securities s ON s.id=h.security_id WHERE h.user_id=?`).all(t.id); })()
  });
});
router.post('/admin/etf/create-fund', auth.requireAdmin, (req, res) => {
  try {
    const { ticker, name, shares_per_unit, basket, initial_units } = req.body || {};
    const tick = String(ticker || '').toUpperCase();
    if (!/^[A-Z]{3,6}$/.test(tick)) return res.status(400).json({ error: 'Ticker: 3-6 Buchstaben' });
    if (q.secByTicker.get(tick)) return res.status(409).json({ error: 'Ticker vergeben' });
    const spu = Math.floor(Number(shares_per_unit));
    const units = Math.floor(Number(initial_units));
    if (!(spu >= 1) || !(units >= 1)) return res.status(400).json({ error: 'Ungültige Multiplikator/Units' });
    const b = (basket || []).filter(x => Number(x.qty) > 0 && Number(x.stock_id) > 0)
      .map(x => ({ stock_id: Number(x.stock_id), qty: Math.floor(Number(x.qty)) }));
    if (!b.length) return res.status(400).json({ error: 'Korb leer' });
    const sec = etf.createEtf({ ticker: tick, name: String(name || tick), basket: b, shares_per_unit: spu, initial_units: units });
    res.json({ ok: true, security_id: sec.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/admin/etf/:id/preview', auth.requireAdmin, (req, res) => {
  try { res.json(etf.preview(Number(req.params.id), Number(req.query.units) || 1)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/etf/:id/create-units', auth.requireAdmin, (req, res) => {
  try {
    const r = etf.createUnits(Number(req.params.id), req.body?.units);
    const n = addNews('etf', `ETF-Creation: ${q.secById.get(Number(req.params.id)).ticker}`,
      `Die Investment AG hat ${r.units} Creation Units (${r.shares_created} ETF-Anteile) geschaffen und verkauft sie am Markt. Das drückt den ETF-Kurs Richtung NAV.`);
    bus.emit({ type: 'news', news: n });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/admin/etf/:id/redeem-units', auth.requireAdmin, (req, res) => {
  try {
    const r = etf.redeemUnits(Number(req.params.id), req.body?.units);
    const n = addNews('etf', `ETF-Redemption: ${q.secById.get(Number(req.params.id)).ticker}`,
      `Die Investment AG hat ${r.units} Creation Units (${r.shares_redeemed} ETF-Anteile) vernichtet und die Korb-Aktien am Markt verkauft. Das zieht den ETF-Kurs Richtung NAV.`);
    bus.emit({ type: 'news', news: n });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Bot-Modus (Testspiel mit virtuellen Tradern) ----
router.get('/admin/bots', auth.requireAdmin, (req, res) => res.json(bots.status()));
router.post('/admin/bots/start', auth.requireAdmin, (req, res) => res.json(bots.start()));
router.post('/admin/bots/stop', auth.requireAdmin, (req, res) => res.json(bots.stop()));
router.put('/admin/bots/settings', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.bot_activity != null) bots.setActivity(b.bot_activity);
  if (b.bot_tick_sec != null) bots.setTickSec(b.bot_tick_sec);
  if (b.bot_fast != null) bots.setFast(!!b.bot_fast);
  res.json(bots.status());
});

// ---- AP-Handelsterminal: Treasury handelt als normaler Marktteilnehmer ----
router.post('/admin/treasury/order', auth.requireAdmin, (req, res) => {
  try {
    const t = engine.treasury();
    const result = engine.placeOrder(t, req.body || {}, { mm: false });
    res.json({ order: result.order, trades: result.trades });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/admin/treasury/orders', auth.requireAdmin, (req, res) => {
  const t = engine.treasury();
  res.json({ orders: db.prepare("SELECT o.*, s.ticker FROM orders o JOIN securities s ON s.id=o.security_id WHERE o.user_id=? AND o.status='open' ORDER BY o.id DESC").all(t.id) });
});
router.post('/admin/treasury/cancel/:orderId', auth.requireAdmin, (req, res) => {
  try { res.json(engine.cancelOrder(engine.treasury(), Number(req.params.orderId))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// =========================== SPIEL (Börse verwalten) ==========================
// Zustand der Börse für die Spieler-App und den Bereich „Spiel“.
function gameState() {
  const s = getSettings();
  return {
    paused: !!s.trading_paused, bots_running: !!s.bot_running,
    income_cent: s.income_cent, income_sec: s.income_sec, income_next_at: jobs.incomeNextAt(),
    start_capital: s.start_capital, fee_cent: s.fee_cent,
  };
}
function setPaused(paused) {
  setSetting('trading_paused', paused ? 1 : 0);
  bus.emit({ type: 'game', game: { paused } });
  return { ok: true, paused };
}
router.get('/game', (req, res) => res.json(gameState()));
router.post('/admin/game/pause', auth.requireAdmin, (req, res) => res.json(setPaused(true)));
router.post('/admin/game/resume', auth.requireAdmin, (req, res) => res.json(setPaused(false)));

// Passwort zurücksetzen: neues Passwort setzen, alte Sitzungen beenden.
router.post('/admin/users/:id/reset-password', auth.requireAdmin, async (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u || u.role !== 'user') return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  const password = String((req.body || {}).password ?? '');
  const problem = auth.passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  await auth.setPasswordAsync(u.id, password);
  res.json({ ok: true });
});

// Guthaben aufladen: Betrag in Credits.
router.post('/admin/users/:id/topup', auth.requireAdmin, (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u || u.role !== 'user' || u.is_bot) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: 'Betrag zwischen 1 und 1.000.000 Credits' });
  }
  db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(Math.round(amount * 100), u.id);
  bus.emit({ type: 'dirty', user_id: u.id, what: ['portfolio'] });
  res.json({ ok: true, cash: q.userById.get(u.id).cash });
});

// Kursverlauf aller Werte in EINER Abfrage (Markt- und Depotliste), 30 s zwischengespeichert.
let sparksCache = null;
router.get('/sparks', (req, res) => {
  const points = Math.min(120, Math.max(2, Number(req.query.points) || 40));
  if (sparksCache && sparksCache.points === points && Date.now() - sparksCache.at < 30000) return res.json(sparksCache.data);
  const day = 24 * 3600 * 1000;
  const step = Math.max(60000, Math.round(day / points));
  const sparks = {};
  const stmt = db.prepare('SELECT AVG(price) AS p FROM price_history WHERE security_id = ? AND ts >= ? GROUP BY ts / ? ORDER BY ts ASC');
  for (const book of engine.books.values()) sparks[book.sec.id] = stmt.all(book.sec.id, Date.now() - day, step).map((r) => Math.round(r.p));
  sparksCache = { at: Date.now(), points, data: { sparks, ts: Date.now() } };
  res.json(sparksCache.data);
});


module.exports = router;
