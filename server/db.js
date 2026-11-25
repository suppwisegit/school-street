// Datenbank: SQLite (better-sqlite3), synchron => keine Race Conditions im Orderbuch.
// Alle Geldbeträge und Preise sind INTEGER in CENT (100 Cent = 1 Credit). Kein Float.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbName = process.env.DB_NAME || 'schoolstreet.db';
// Schutz für die echte Datenbank: Unter Tests (node --test oder NODE_ENV=test)
// wird schoolstreet.db nie geöffnet — jede Test-DB braucht einen eigenen Namen.
const underTest = process.env.NODE_ENV === 'test' || !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test');
if (underTest && dbName === 'schoolstreet.db') {
  throw new Error(`[db] Test ohne eigene Datenbank: DB_NAME=<name>.db setzen. ${path.join(DATA_DIR, dbName)} wird nicht geöffnet.`);
}

const db = new Database(path.join(DATA_DIR, dbName));
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

// Migration: virtuelle Trader (Testspiel-Modus) — normales Konto, nur gekennzeichnet.
try { db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* Spalte existiert schon */ }

// Nachrüst-Indizes (additiv, auch auf bestehender Datenbank): bisher scannen diese
// Spalten ohne Index ganze Tabellen — holdings je Fill/Dividende, orders je Nutzer
// und je Takt, users je Treasury-/Ranglisten-Frage, trades/news nach Zeit.
// Die Spalte is_bot steht erst nach der Migration darüber.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_holdings_sec ON holdings(security_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_mm ON orders(is_mm, status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_bot ON users(is_bot);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_news_sec ON news(security_id);
CREATE INDEX IF NOT EXISTS idx_news_time ON news(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_ipo_user ON ipo_applications(user_id);
`);

// ---------- Settings (im RAM gecached) ----------
const DEFAULT_SETTINGS = {
  fee_cent: 2000,               // 20 Credits Geldverbrennung pro ausgeführter Order
  income_cent: 100000,          // 1.000 Credits Wocheneinkommen
  income_sec: 300,              // Test-Freundlich: alle 5 Min (real: 7 Tage)
  start_capital: 1000000,       // 10.000 Credits Startkapital
  inactivity_sec: 21 * 24 * 3600, // Ghost-Account-Löschung nach 3 Wochen
  lockup_sec: 14 * 24 * 3600,   // 2 Wochen Founder-Lock-up
  treasury_capital: 50000000,   // 500.000 Credits Startkapital der Staatskasse
  mm_spread_bp: 300,            // MM-Basis-Spread Stufe 0 (3% um den letzten Kurs)
  mm_size: 40,                  // MM-Stückzahl auf Stufe 0 (engster Spread)
  mm_levels: 6,                 // MM-Staffelung: Stufen je Seite (Ladder)
  mm_size_step: 25,             // Stück-Zuwachs je Stufe (Stufe i: mm_size + i*mm_size_step)
  mm_step_bp: 120,              // Abstands-Zuwachs je Stufe in Basispunkten (1,2%)
  mm_refresh_sec: 15,
  mm_fee_exempt: 1,
  mm_cash_budget_pct: 0.9,      // Anteil der Treasury-Cash für die Bid-Seite (Escrow)
  mm_noise_bp: 18,              // Random-Walk-Noise auf der Referenz (organisches Buch)
  mm_jitter_bp: 60,             // Abstands-Jitter je Stufe: ausgefranste statt perfekt Treppen
  mm_size_jitter: 0.35,         // Größen-Jitter ±35% je Stufe
  mm_inv_target_pct: 0.2,       // Ziel-Bestand des MM: Anteil der Gesamtaktien
  mm_inv_skew_bp: 200,          // Inventory-Skew: max. Quote-Verschiebung je Bestandslage
  mm_guard_pct: 6,              // Momentum-Bremse: ab ±6% Bewegung in 10 Min breiter quotieren
  mm_guard_widen: 1.7,          // ... Streckungsfaktor der Quote-Abstände bei Bremsung
  mm_replenish_min: 120,        // Nachplatzierung, wenn Treasury-Restbestand darunter fällt
  mm_replenish_qty: 1000,       // ... so viele neue Aktien werden platziert
  mm_replenish_price_mult: 1.15,// ... aber nur, wenn Kurs > IPO-Preis × Faktor
  mm_recap_min_pct: 0.05,       // Zentralbank-Notkredit ab 5% des Treasury-Startkapitals
  mm_recap_to_pct: 0.12,        // ... füllt die Staatskasse auf 12% auf (max. 1x/Stunde)
  mm_vol_ref: 0.01,             // Referenz-Volatilität: 1% => volF=1 (Spread-Skalierung)
  mm_vol_mult_max: 2.8,         // Maximal-Faktor: wilder Markt => bis zu 2.8x so breite Quotes
  trading_paused: 0,            // 1 = Börse macht Pause (Spiel pausiert): Spieler und Bots handeln nicht
  etf_auto: 1,                  // ETF-Auto-Arbitrage: AP schließt Premium/Discount automatisch
  etf_auto_threshold_pct: 10,   // ... ab ±10% Abweichung Kurs <-> NAV
  etf_auto_units: 2,            // ... Basis-Units je Aktion (skaliert mit Abweichung)
  etf_auto_max_units: 25,       // ... Obergrenze der dynamischen Units
  etf_auto_interval_sec: 10,    // ... min. Abstand zwischen Aktionen je ETF
  limit_band_pct: 15,           // Limit-Orders: max. 15% über/unter Referenzpreis
  limit_band_cents: 10000,      // ... aber immer mindestens 100 Credits Spielraum
  cap_hours_needed: 120,        // 5 Tage über Schwelle => Kapitalerhöhung möglich
  idx_base_mcap: 0,
  bot_count: 100,               // Testspiel-Modus: so viele virtuelle Trader
  bot_activity: 40,             // 0-100: erwartete Trades je Tick = activity/100 * 2
  bot_tick_sec: 3,              // Bot-Takt in Sekunden
  bot_fast: 0,                  // Fast-Mode: Trades je Tick ×100 (Deckel 200) — für MM-/Pattern-Tests
  bot_running: 0                // 1 = Modus läuft (überlebt Server-Neustart)
};
const settingsCache = { ...DEFAULT_SETTINGS };
{
  // Defaults in die DB schreiben, ohne bestehende Werte anzufassen (IGNORE).
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(settingsCache)) ins.run(k, JSON.stringify(v));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  for (const r of rows) settingsCache[r.key] = JSON.parse(r.value);
}
// Einmal-Migration: altes Default-Intervall der ETF-Auto-Arbitrage (60s) war zu
// träge für große Abweichungen — auf den neuen Default 10s anheben.
if (settingsCache.etf_auto_interval_sec === 60) {
  settingsCache.etf_auto_interval_sec = 10;
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run('etf_auto_interval_sec', JSON.stringify(10));
}
function getSettings() { return { ...settingsCache }; }
function setSetting(key, value) {
  settingsCache[key] = value;
  q.setSetting.run(key, JSON.stringify(value));
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
  phIns: db.prepare('INSERT INTO price_history(security_id, ts, price, amount) VALUES(?,?,?,?)'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)')
};

function fmt(cent) { return (cent / 100).toFixed(2); }
function addNews(kind, title, body, securityId = null) {
  const now = Date.now();
  const r = q.newsIns.run(kind, title, body || '', securityId, now);
  return { id: r.lastInsertRowid, kind, title, body: body || '', security_id: securityId, created_at: now };
}

// last_active: höchstens alle 60 s je Nutzer schreiben (vorher ein Schreibzugriff
// je Request). `user` ist die frisch gelesene Zeile; ihr Stand wird mitgeführt.
const ACTIVE_INTERVAL_MS = 60000;
const touchUser = db.prepare('UPDATE users SET last_active = ? WHERE id = ?');
function bumpActive(user, now = Date.now()) {
  if (!(user.last_active > now || now - user.last_active >= ACTIVE_INTERVAL_MS)) return false;
  touchUser.run(now, user.id);
  user.last_active = now;
  return true;
}

module.exports = { db, getSettings, setSetting, q, fmt, addNews, bumpActive, DEFAULT_SETTINGS };
