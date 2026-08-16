// Datenbank: SQLite (better-sqlite3), synchron => keine Race Conditions im Orderbuch.
// Alle Geldbeträge und Preise sind INTEGER in CENT (100 Cent = 1 Credit). Kein Float.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, process.env.DB_NAME || 'schoolstreet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',        -- user | admin | bank
  cash INTEGER NOT NULL DEFAULT 0,
  realized_pl INTEGER NOT NULL DEFAULT 0,
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                        -- stock | etf
  ticker TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  founder_id INTEGER,
  ipo_price INTEGER NOT NULL DEFAULT 0,
  total_shares INTEGER NOT NULL,
  lockup_until INTEGER NOT NULL DEFAULT 0,
  threshold_price INTEGER NOT NULL DEFAULT 0, -- Kapitalerhöhung: Kurs-Schwelle
  hours_above INTEGER NOT NULL DEFAULT 0,
  majority_holder_id INTEGER,
  mm_enabled INTEGER NOT NULL DEFAULT 1,
  shares_per_unit INTEGER,                   -- nur ETF: ETF-Anteile pro Creation Unit
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS etf_baskets (
  etf_id INTEGER NOT NULL,
  stock_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (etf_id, stock_id)
);
CREATE TABLE IF NOT EXISTS holdings (
  user_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  avg_cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, security_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  side TEXT NOT NULL,                        -- buy | sell
  type TEXT NOT NULL,                        -- limit | market
  price INTEGER,                             -- NULL bei Market-Order
  amount INTEGER NOT NULL,
  filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',       -- open | filled | canceled
  is_mm INTEGER NOT NULL DEFAULT 0,
  fee_charged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_sec ON orders(security_id, status, side, price);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  buyer_id INTEGER,
  seller_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_sec ON trades(security_id, created_at);
CREATE TABLE IF NOT EXISTS price_history (
  security_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  price INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ph ON price_history(security_id, ts);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'news',         -- news | dividend | bafin | ipo | system | takeover | etf
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  security_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ipo_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                        -- capital_increase | special_dividend
  security_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  amount INTEGER,                            -- Sonderdividende: Cent je Aktie
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS dividends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  per_share INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// ---------- Settings (im RAM gecached) ----------
const DEFAULT_SETTINGS = {
  fee_cent: 2000,               // 20 Credits Geldverbrennung pro ausgeführter Order
  income_cent: 100000,          // 1.000 Credits Wocheneinkommen
  income_sec: 300,              // Test-Freundlich: alle 5 Min (real: 7 Tage)
  start_capital: 1000000,       // 10.000 Credits Startkapital
  inactivity_sec: 21 * 24 * 3600, // Ghost-Account-Löschung nach 3 Wochen
  lockup_sec: 14 * 24 * 3600,   // 2 Wochen Founder-Lock-up
  mm_spread_bp: 350,            // Market-Maker-Spread 3,5% (nur Liquidität, kein Trend)
  mm_size: 10,                  // Stück pro MM-Quote (dünn => Kurssprünge möglich)
  mm_refresh_sec: 20,
  mm_fee_exempt: 1,
  cap_hours_needed: 120,        // 5 Tage über Schwelle => Kapitalerhöhung möglich
  idx_base_mcap: 0
};
const settingsCache = { ...DEFAULT_SETTINGS };
{
  const rows = db.prepare('SELECT key, value FROM settings').all();
  for (const r of rows) settingsCache[r.key] = JSON.parse(r.value);
  const ins = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(settingsCache)) if (!(k in rows.map(r => r.key))) ins.run(k, JSON.stringify(v));
}
function getSettings() { return { ...settingsCache }; }
function setSetting(key, value) {
  settingsCache[key] = value;
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run(key, JSON.stringify(value));
  return settingsCache;
}

// ---------- kleine Helfer ----------
const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  holding: db.prepare('SELECT * FROM holdings WHERE user_id = ? AND security_id = ?'),
  upsertHolding: db.prepare(`INSERT INTO holdings(user_id, security_id, amount, avg_cost) VALUES(?,?,?,?)
    ON CONFLICT(user_id, security_id) DO UPDATE SET amount = excluded.amount, avg_cost = excluded.avg_cost`),
  addCash: db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?'),
  secById: db.prepare('SELECT * FROM securities WHERE id = ?'),
  secByTicker: db.prepare('SELECT * FROM securities WHERE ticker = ?'),
  allSecs: db.prepare('SELECT * FROM securities WHERE status = ? ORDER BY id'),
  newsIns: db.prepare('INSERT INTO news(kind, title, body, security_id, created_at) VALUES(?,?,?,?,?)'),
  newsAll: db.prepare('SELECT * FROM news ORDER BY id DESC LIMIT ?'),
  phIns: db.prepare('INSERT INTO price_history(security_id, ts, price, amount) VALUES(?,?,?,?)')
};

function fmt(cent) { return (cent / 100).toFixed(2); }
function addNews(kind, title, body, securityId = null) {
  const now = Date.now();
  const r = q.newsIns.run(kind, title, body || '', securityId, now);
  return { id: r.lastInsertRowid, kind, title, body: body || '', security_id: securityId, created_at: now };
}
function getUser() { return q.userById.get(1); } // helper unused placeholder
function bumpActive(userId) { db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(Date.now(), userId); }

module.exports = { db, getSettings, setSetting, q, fmt, addNews, bumpActive, DEFAULT_SETTINGS };
