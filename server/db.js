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
  kind TEXT NOT NULL DEFAULT 'news',         -- news | rumor | dividend | bafin | ipo | system | takeover | etf
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  security_id INTEGER,
  impact INTEGER NOT NULL DEFAULT 0,          -- Marktwirkung -3…+3 (0 = keine); Bots lesen sie als Zahl
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
// Migration: fairer Kurs F je Aktie in Milli-Cent (Market Maker V3). Bewusst ohne Default —
// NULL zeigt der Engine (loadEngine), dass die Zeile noch keinen Kurs hat.
try { db.exec('ALTER TABLE securities ADD COLUMN fair_price INTEGER'); } catch (e) { /* Spalte existiert schon */ }
// Migration: nur ETF — Arbeitsbestand der Staatskasse in ETF-Anteilen (Anfangsbestand bei Schöpfung).
try { db.exec('ALTER TABLE securities ADD COLUMN ap_inventory_target INTEGER'); } catch (e) { /* Spalte existiert schon */ }
// Migration: News-Wirkung als Zahl (impact). Per PRAGMA geprüft, damit der Stand der Spalte (NOT NULL, DEFAULT 0)
// auf alten Datenbanken genauso ist wie bei einer frisch angelegten. Bestehende News behalten impact = 0.
{
  const spalten = db.prepare('PRAGMA table_info(news)').all().map((c) => c.name);
  if (!spalten.includes('impact')) db.exec('ALTER TABLE news ADD COLUMN impact INTEGER NOT NULL DEFAULT 0');
}

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
  fee_cent: 2000,               // 20 Credits Gebühr pro ausgeführter Order (Spieler; Bots siehe bot_fee_cent)
  income_cent: 100000,          // 1.000 Credits Wocheneinkommen
  income_sec: 300,              // Test-Freundlich: alle 5 Min (real: 7 Tage)
  start_capital: 1000000,       // 10.000 Credits Startkapital
  inactivity_sec: 21 * 24 * 3600, // Ghost-Account-Löschung nach 3 Wochen
  lockup_sec: 14 * 24 * 3600,   // 2 Wochen Founder-Lock-up
  treasury_capital: 50000000,   // 500.000 Credits Startkapital der Staatskasse
  mm_version: 3,                // Stand des Market-Maker-Modells; wandert über INSERT OR IGNORE in jede DB (fehlt die Zeile: Migration beim Laden)
  mm_impact_pct: 50,            // Orderflow: Kursanstieg in %, wenn netto der ganze Streubesitz gekauft wird
  mm_spread_bp: 100,            // MM-Basis-Spread Stufe 0 (1% um den fairen Kurs)
  mm_size: 10,                  // MM-Stückzahl auf Stufe 0 (engster Spread); klein, weil jede Stufe an der
                                // eigenen Mitte preist (Austritt um λ·mm_size/2). Stufen: 10/35/60/85/110/135
  mm_levels: 6,                 // MM-Staffelung: Stufen je Seite (Ladder)
  mm_size_step: 25,             // Stück-Zuwachs je Stufe (Stufe i: mm_size + i*mm_size_step)
  mm_refresh_sec: 15,
  mm_fee_exempt: 1,
  mm_cash_budget_pct: 0.9,      // Anteil der Treasury-Cash für die Bid-Seite (Escrow)
  mm_jitter_bp: 20,             // Abstands-Jitter je Stufe: ausgefranste statt perfekt Treppen
  mm_size_jitter: 0.35,         // Größen-Jitter ±35% je Stufe
  mm_replenish_min: 120,        // Nachplatzierung, wenn Treasury-Restbestand darunter fällt
  mm_replenish_pct: 50,         // ... neue Aktien in % des Streubesitzes, mindestens 100 Stück
  mm_recap_min_pct: 0.05,       // Zentralbank-Notkredit ab 5% des Treasury-Startkapitals
  trading_paused: 0,            // 1 = Börse macht Pause (Spiel pausiert): Spieler und Bots handeln nicht
  etf_auto: 1,                  // ETF-Automatik: AP hält den Arbeitsbestand (Creation und Redemption)
  etf_auto_max_units: 25,       // ... höchstens so viele Units je Aktion
  etf_auto_interval_sec: 10,    // ... min. Abstand zwischen Aktionen je ETF
  etf_ap_inventory_pct: 25,     // ETF: Arbeitsbestand der Staatskasse in % des Umlaufs (mindestens Anfangsbestand)
  limit_band_pct: 15,           // Limit-Orders und Ausführung: max. 15% über/unter dem fairen Kurs
  cap_hours_needed: 120,        // 5 Tage über Schwelle => Kapitalerhöhung möglich
  idx_base_mcap: 0,
  bot_count: 100,               // Testspiel-Modus: so viele virtuelle Trader
  bot_activity: 40,             // 0-100: erwartete Trades je Tick = activity/100 * 4
  bot_tick_sec: 3,              // Bot-Takt in Sekunden
  bot_fast: 0,                  // Fast-Mode: Trades je Tick ×100 (Deckel 200) — für MM-/Pattern-Tests
  bot_running: 0,               // 1 = Modus läuft (überlebt Server-Neustart)
  news_interval_sec: 60,        // Auto-News: 0 = aus, jeder andere Wert = an (News entstehen aus Marktdaten, siehe newsgen.js)
  bot_cash_reserve_min: 0.2,     // Bots: Mindestanteil Cash am Vermögen (je Persona zwischen min und max)
  bot_cash_reserve_max: 0.4,
  bot_fee_cent: 0,               // Bots: eigene Gebühr je ausgeführter Order; 0 = wie fee_cent (auch bots.js rechnet so)
  fee_recycle_pct: 100,          // % der tatsächlich abgebuchten Gebühren, die mit dem Einkommen zurückgezahlt werden
  fee_pool_cent: 0,              // Gebühren-Pool in Cent (persistent, von chargeFee gefüllt, von jobs.payIncome geleert) — keine Admin-Einstellung
  income_sim_scale: 0,           // 1 = Einkommen im Spielrhythmus, im Fast-Modus ×100 mehr Geld pro Echtzeitstunde; 0 = Wanduhr, empfohlen,
                                 // weil die Gebühren über den Pool zurückfließen. Nur 0 oder 1
  mm_min_ask_shares: 1000,        // Streubesitz: so viele Stück muss die Angebotsseite der MM-Leiste mindestens halten
  mm_min_depth: 2000,           // ... Unterschreitet der Streubesitz diesen Wert, wird nachplatziert
  ipo_highlight_sec: 10800      // Börsengang: so lange (Wanduhr-Sekunden) gilt eine neu gelistete Aktie als „neu“ (3 Stunden)
};
const settingsCache = { ...DEFAULT_SETTINGS };
// Einmal-Migration. Erkennung: Die Zeile mm_version fehlt in der Tabelle — deshalb vor dem Nachtragen der
// Defaults. Läuft auf jeder DB ohne Marker: auf frischen DBs setzt sie nur den Marker, auf DBs vor V3
// (egal wie alt) löscht sie die 14 entfallenen Schlüssel und ersetzt die alten Defaults. Alles in einer
// Transaktion, damit ein Abbruch weder Halbes noch den Marker hinterlässt (der nächste Start migriert dann
// erneut): (a) entfallene Schlüssel löschen, (b) alte Defaults ersetzen, eigene Werte bleiben, (c) Marker setzen.
// Rollt man zum alten Code zurück und wieder auf V3, bleiben die 14 Schlüssel, die der alte Code neu
// anlegt, stehen — der Marker ist ja da, und kein Code liest sie.
const REMOVED_SETTINGS = ['limit_band_cents', 'mm_step_bp', 'mm_noise_bp', 'mm_inv_target_pct', 'mm_inv_skew_bp',
  'mm_guard_pct', 'mm_guard_widen', 'mm_vol_ref', 'mm_vol_mult_max', 'mm_replenish_qty', 'mm_replenish_price_mult',
  'mm_recap_to_pct', 'etf_auto_threshold_pct', 'etf_auto_units'];
const OLD_DEFAULTS = { mm_spread_bp: [350, 300, 100], mm_jitter_bp: [60, 20], mm_size: [15, 40, 10] }; // [alte Defaults früherer Versionen …, neuer Default]
db.transaction(() => {
  const read = db.prepare('SELECT value FROM settings WHERE key = ?');
  if (read.get('mm_version')) return; // Marker da: nichts zu tun
  const write = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)');
  db.prepare(`DELETE FROM settings WHERE key IN (${REMOVED_SETTINGS.map(() => '?').join(', ')})`).run(...REMOVED_SETTINGS);
  for (const [k, versions] of Object.entries(OLD_DEFAULTS)) {
    const row = read.get(k);
    if (row && versions.slice(0, -1).includes(JSON.parse(row.value))) write.run(k, JSON.stringify(versions.at(-1)));
  }
  write.run('mm_version', JSON.stringify(DEFAULT_SETTINGS.mm_version));
}).immediate(); // Schreibsperre gleich am Anfang: lesen und schreiben in einer Transaktion, ohne Busy-Fehler beim Start
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
  newsIns: db.prepare('INSERT INTO news(kind, title, body, security_id, impact, created_at) VALUES(?,?,?,?,?,?)'),
  newsAll: db.prepare('SELECT * FROM news ORDER BY id DESC LIMIT ?'),
  phIns: db.prepare('INSERT INTO price_history(security_id, ts, price, amount) VALUES(?,?,?,?)'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)')
};

function fmt(cent) { return (cent / 100).toFixed(2); }
// Zahl mit Komma für News-Texte (Schüler lesen „20,00“): Cent mit zwei Stellen, ganze Credits ohne.
const deNum = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const deInt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
function fmtDe(cent) { return deNum.format(cent / 100); }
function fmtDeInt(cent) { return deInt.format(Math.round(cent / 100)); }
// impact: Marktwirkung -3…+3 als ganze Zahl. Fehlt er (undefined/null), ist er 0. Jeder andere Wert wirft
// TypeError, statt still 0 zu schreiben — ein Rechenfehler im Generator soll auffallen, nicht verschwinden.
function addNews(kind, title, body, securityId = null, impact) {
  const now = Date.now();
  let wirkung = 0;
  if (impact !== undefined && impact !== null) {
    if (!Number.isInteger(impact) || impact < -3 || impact > 3) {
      throw new TypeError(`addNews: impact muss eine ganze Zahl von -3 bis +3 sein (bekam ${typeof impact === 'object' ? String(impact) : JSON.stringify(impact)})`);
    }
    wirkung = impact;
  }
  const r = q.newsIns.run(kind, title, body || '', securityId, wirkung, now);
  return { id: r.lastInsertRowid, kind, title, body: body || '', security_id: securityId, impact: wirkung, created_at: now };
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

module.exports = { db, getSettings, setSetting, q, fmt, fmtDe, fmtDeInt, addNews, bumpActive, DEFAULT_SETTINGS };
