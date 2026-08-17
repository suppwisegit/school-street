// ============================================================================
// BOT-TRADER — Testspiel-Modus: virtuelle Schüler halten den Markt lebendig.
// ----------------------------------------------------------------------------
// Start/Stop über das Admin-Panel (GET/POST /api/admin/bots). Die Bots sind
// ganz normale Trader-Konten (role='user', is_bot=1): echtes Startkapital und
// KEIN Anfangsbestand an Aktien — genau wie echte Schüler. Nur manche Bots
// gründen eine Firma (IPO wie bei Spieler-Anträgen: 1.000 Gründeraktien,
// Streubesitz kauft die Staatskasse) und halten so Aktien im Depot.
//
// Handelsstil ("nahezu random" mit Anlässen):
//   * Häufigkeit: bot_activity (0-100) steuert die erwarteten Trades je Tick
//     (activity/100 × 2) — "balanced, ab und zu mal wenige Trades".
//   * Order-Typ: ~85 % Market-Orders wie echte Schüler, sonst Limits am Spread.
//   * News/Sentiment: Schlüsselwörter in News (+Dividende/-BaFin) kippen die
//     Kauf-/Verkaufswahrscheinlichkeit; "heisse" News-Aktien werden bevorzugt.
//   * Momentum: steigt der Kurs, kaufen die meisten Bots trendfolgend — ein
//     fester ~20 %-Anteil jeder Bot-Population handelt konträr (Fading).
// Alles läuft über die echte Engine: Escrow, Gebühren, Preis-Band und
// Self-Trade-Prevention greifen auch für Bots. Fehler (pleite, kein Bestand,
// Lock-up …) werden still verworfen — wie ein Schüler, der es sich anders
// überlegt.
// ============================================================================
const crypto = require('crypto');
const { db, getSettings, setSetting, q, addNews } = require('./db');
const bus = require('./bus');
const engine = require('./engine');
const auth = require('./auth');

const state = { running: false, timer: null, started_at: null, orders: 0, trades: 0, errors: 0 };

const NEWS_WINDOW_MS = 10 * 60 * 1000;       // so lange wirken News auf die Bots
const BOT_ORDER_STALE_MS = 10 * 60 * 1000;   // Bot-Limit-Orders verfallen danach
const BOT_COMPANY_TARGET = 4;                // so viele Bot-Firmen sollen existieren
const DEFAULT_FLOAT = 2000;                  // Streubesitz je Bot-IPO (wie Admin-Default)

const FIRST_NAMES = [
  'Alex', 'Mia', 'Ben', 'Emma', 'Paul', 'Lea', 'Jonas', 'Marie', 'Finn', 'Sophia',
  'Luis', 'Anna', 'Elias', 'Lena', 'Noah', 'Greta', 'Tim', 'Clara', 'David', 'Nina',
  'Emre', 'Hannah', 'Gustav', 'Zoe', 'Jakob', 'Isabel', 'Liam', 'Frieda', 'Anton', 'Ida',
  'Oskar', 'Maja', 'Felix', 'Lara', 'Milan', 'Johanna', 'Theo', 'Amelie', 'Matteo', 'Nele',
  'Leonie', 'Simon', 'Elif', 'Daniel', 'Kira', 'Tobias', 'Jana', 'Fabian', 'Lene', 'Julian',
  'Romy', 'Moritz', 'Thea', 'Vincent', 'Alina', 'Niklas', 'Sina', 'Arthur', 'Lotta', 'Samuel',
  'Valentina', 'Carla', 'Bruno', 'Heidi', 'Levin', 'Melina', 'Jannik', 'Stella', 'Anni', 'Konstantin'
];

// Firmen-Pool für Bot-Gründer (Ticker must match /^[A-Z]{3,6}$/)
const BOT_COMPANIES = [
  { name: 'Kicker Sport AG', ticker: 'KICK', description: 'Schulhof-Turniere, Fußball und Basketball mit Sponsoren-Feeling.' },
  { name: 'Oberstufen-Taxi e.K.', ticker: 'TAXI', description: 'Pünktlich zur ersten Stunde: Schülertaxis für Spätaufsteher.' },
  { name: 'Bio-Pausenbrot SE', ticker: 'BIO', description: 'Frische Snacks aus der Schulküche — nachhaltig, lecker, schnell weg.' },
  { name: 'Tablet-Verleih GmbH', ticker: 'TAB', description: 'Digitale Endgeräte für den Unterricht: mieten statt kaufen.' },
  { name: 'Band- & Proberaum AG', ticker: 'BAND', description: 'Instrumente, Proberaum, Schulkonzerte. Rockt die Aula.' },
  { name: 'Merch-Outfitter AG', ticker: 'MERCH', description: 'Hoodies, Tassen und Fan-Artikel für jede Klassenstufe.' },
  { name: 'E-Scooter Rental SE', ticker: 'SCOOT', description: 'Elektro-Roller für den Schulweg — geladen in der Fahrradhalle.' },
  { name: 'Lernkarten-Verlag AG', ticker: 'LERN', description: 'Karteikarten und Lernboxen für die Klausurphase. Vokabeln? Kein Problem.' },
  { name: 'Aula-Kino GmbH', ticker: 'AULA', description: 'Filmabende, Gaming-Nights und Popcorn im Großformat.' },
  { name: 'Hausarbeiten-Druck AG', ticker: 'PRINT', description: 'Drucken, Binden, Laminieren — Facharbeit in 10 Minuten.' }
];

// News-Stimmung: Wörter, die Schüler optimistisch/pessimistisch stimmen.
const GOOD_WORDS = ['rekord', 'gewinn', 'gewinne', 'erfolg', 'boom', 'wächst', 'wachstum', 'vertrag',
  'sieg', 'expansion', 'ausbau', 'festival', 'sommer', 'hitze', 'sonderdividende', 'dividende',
  'kapitalerhöhung', 'durchbruch', 'beliebt', 'gefragt', 'startet', 'gewinnt', 'preis', 'expandiert', 'ipo'];
const BAD_WORDS = ['verlust', 'warnung', 'ermittelt', 'ermittlungen', 'bafin', 'skandal', 'rückruf',
  'einbruch', 'krise', 'desaster', 'pleite', 'insolvenz', 'verbot', 'rückgang', 'minus', 'schwach',
  'streik', 'unfall', 'brand', 'ausfall', 'kündig'];

// ---------------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------------
function ensureBots(count) {
  const have = db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=1').get().c;
  for (let i = have; i < count; i++) {
    const name = FIRST_NAMES[i % FIRST_NAMES.length];
    const username = `${name} (Bot ${i + 1})`;
    const u = auth.createUser(username, crypto.randomBytes(8).toString('hex'), 'user', getSettings().start_capital);
    db.prepare('UPDATE users SET is_bot=1 WHERE id=?').run(u.id);
  }
  return db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=1').get().c;
}

// Bot-IPO: gleiche Buchung wie /api/admin/ipo/:id/approve (Gründeraktien +
// Float-Kauf durch die Staatskasse). Returns security oder null (kein Geld mehr).
function listBotCompany(founder, c) {
  const t = engine.treasury();
  const ipo = Math.round((18 + Math.random() * 37) * 100); // 18–55 Credits
  // Streubesitz nur so groß, wie sich die Staatskasse leisten kann (ohne sich
  // komplett zu entblößen — der MM braucht noch Cash für die Bid-Seite).
  const floatShares = Math.min(DEFAULT_FLOAT, Math.floor(t.cash * 0.6 / ipo));
  if (floatShares < 200) return null;
  const founderShares = 1000;
  const sec = engine.listSecurity({ type: 'stock', ticker: c.ticker, name: c.name, description: c.description, founder_id: founder.id, ipo_price: ipo, total_shares: founderShares + floatShares });
  db.prepare('UPDATE securities SET threshold_price=? WHERE id=?').run(Math.round(ipo * 1.5), sec.id);
  sec.threshold_price = Math.round(ipo * 1.5);
  engine.addHoldingPublic(founder.id, sec.id, founderShares, ipo);
  engine.addHoldingPublic(t.id, sec.id, floatShares, ipo);
  db.prepare('UPDATE users SET cash = cash + ? WHERE id=?').run(ipo * floatShares, founder.id);
  db.prepare('UPDATE users SET cash = cash - ? WHERE id=?').run(ipo * floatShares, t.id);
  engine.mmRecenter(engine.books.get(sec.id));
  const n = addNews('ipo', `🔔 IPO: ${sec.name} (${sec.ticker}) startet zum Kurs ${(ipo / 100).toFixed(2)}`,
    `${founder.username} hat mit ${sec.name} den Börsengang geschafft! ${founderShares} Gründeraktien (Lock-up), ${floatShares} Stück Streubesitz. Konzept: ${c.description}`, sec.id);
  bus.emit({ type: 'news', news: n });
  bus.emit({ type: 'ticker', ticker: engine.tickerRow(sec.id) });
  return sec;
}

function ensureBotCompanies() {
  const existing = db.prepare('SELECT s.ticker FROM securities s JOIN users u ON u.id=s.founder_id WHERE u.is_bot=1').all().map(r => r.ticker);
  const pool = BOT_COMPANIES.filter(c => !existing.includes(c.ticker));
  let created = 0;
  while (existing.length + created < BOT_COMPANY_TARGET && pool.length) {
    const bots = db.prepare('SELECT * FROM users WHERE is_bot=1 AND frozen=0').all();
    if (!bots.length) break;
    const c = pool.splice((Math.random() * pool.length) | 0, 1)[0];
    if (listBotCompany(bots[(Math.random() * bots.length) | 0], c)) created++;
    else break; // Treasury kann keinen Float mehr bezahlen
  }
  return created;
}

// ---------------------------------------------------------------------------
// Entscheidungs-Helfer
// ---------------------------------------------------------------------------
// Stabiler Pseudo-Zufall pro Bot-Name: die Persona überlebt Server-Neustarts.
function personaFor(u) {
  let h = 0;
  for (const ch of u.username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    contrarian: h % 5 === 0,                     // ~20 % Fading-Trader
    sizeBias: 0.5 + ((h >>> 3) % 100) / 100      // 0.5 – 1.5 (kleine/large Orders)
  };
}

// Stimmung der letzten News einer Aktie: -3 (seht bearish) .. +3 (sehr bullish)
function newsSentiment(secId) {
  const rows = db.prepare('SELECT kind, title, body, created_at FROM news WHERE security_id=? ORDER BY id DESC LIMIT 5').all(secId);
  const now = Date.now();
  let score = 0;
  for (const n of rows) {
    if (now - n.created_at > NEWS_WINDOW_MS) continue; // alte News wirken nicht mehr
    const text = `${n.title} ${n.body || ''}`.toLowerCase();
    let s = 0;
    for (const w of GOOD_WORDS) if (text.includes(w)) s += 1;
    for (const w of BAD_WORDS) if (text.includes(w)) s -= 1;
    if (n.kind === 'dividend') s += 2;   // Ausschüttung mögen Schüler
    if (n.kind === 'bafin') s -= 2;      // Ermittlungen mögen sie gar nicht
    if (n.kind === 'ipo') s += 1;        // frisches IPO weckt Neugier
    score += s;
  }
  return Math.max(-3, Math.min(3, score));
}

// Kurs-Momentum aus der Preis-Historie: -0.6 .. +0.6 (gedämpft — volle
// Selbstverstärkung erzeugt nur unrealistische Pump-und-Dump-Blasen)
function momentum(secId) {
  const rows = db.prepare('SELECT price FROM price_history WHERE security_id=? ORDER BY ts DESC LIMIT 25').all(secId).reverse();
  if (rows.length < 4 || !rows[0].price) return 0;
  const chg = rows[rows.length - 1].price / rows[0].price - 1;
  return Math.max(-0.6, Math.min(0.6, chg * 6));
}

// Wert-Anker: Position des Kurses im Hoch/Tief-Band (0 = am Tief, 1 = am Hoch).
// Nahe Tief kaufen Bots gern ("Schnäppchen"), nahe Hoch nehmen sie Gewinn mit —
// das erzeugt natürliche Oszillation statt Endlos-Drift. Im Fast-Mode schrumpft
// das Fenster mit (Zeitkompression ×100), sonst wäre "24h" dort eine Ewigkeit.
function valueBias(secId, last) {
  const winMs = (24 * 3600 * 1000) / (getSettings().bot_fast ? 100 : 1);
  const r = db.prepare('SELECT MIN(price) lo, MAX(price) hi FROM price_history WHERE security_id=? AND ts>=?').get(secId, Date.now() - winMs);
  if (!r || !r.lo || !r.hi || r.hi <= r.lo) return 0;
  const pos = (last - r.lo) / (r.hi - r.lo);
  if (pos < 0.3) return 0.15;      // tief im Band: Kauf-Reiz
  if (pos > 0.7) return -0.15;     // hoch im Band: Gewinnmitnahme
  return 0;
}

// ---------------------------------------------------------------------------
// Der eigentliche Handel
// ---------------------------------------------------------------------------
function pickSecurity(pool) {
  // 35 % Chance: eine "heisse" Aktie aus den aktuellen News bevorzugen
  const hot = db.prepare('SELECT DISTINCT security_id FROM news WHERE created_at >= ? AND security_id IS NOT NULL')
    .all(Date.now() - NEWS_WINDOW_MS).map(r => r.security_id).filter(id => pool.some(s => s.id === id));
  if (hot.length && Math.random() < 0.35) return pool.find(s => s.id === hot[(Math.random() * hot.length) | 0]);
  return pool[(Math.random() * pool.length) | 0];
}

// Ein Versuch. Liefert true, wenn tatsächlich eine Order aufgelegt wurde —
// stille Skips (pleite, kein Bestand, leeres Buch) liefern false, damit der
// Tick nachlegen kann und die Ziel-Handelsfrequenz wirklich ankommt.
function oneTrade() {
  const secs = db.prepare("SELECT * FROM securities WHERE status='active'").all();
  const stocks = secs.filter(s => s.type === 'stock');
  const etfs = secs.filter(s => s.type === 'etf');
  let pool = stocks;
  if (!pool.length) pool = etfs;
  else if (etfs.length && Math.random() < 0.12) pool = etfs; // ETFs nur gelegentlich
  if (!pool.length) return false;
  let sec = pickSecurity(pool);
  let book = engine.books.get(sec.id);
  if (!book) return false;

  const bots = db.prepare("SELECT * FROM users WHERE role='user' AND is_bot=1 AND frozen=0").all();
  if (!bots.length) return false;
  const bot = bots[(Math.random() * bots.length) | 0];
  const botAcct = q.userById.get(bot.id); // frischer Cash-Stand (Escrow!)

  // Arbitrage-Instinkt: notiert eine Bid DEUTLICH über dem letzten Kurs (z.B.
  // AP-Peg-Quotes am NAV oder ein fetter Tipp-Fehler), verkauft der Bot gern
  // hinein — freies Geld zieht Verkäufer an und zieht Kurse Richtung NAV.
  if (Math.random() < 0.5) {
    for (const h of db.prepare('SELECT security_id FROM holdings WHERE user_id=? AND amount>0 ORDER BY RANDOM() LIMIT 4').all(bot.id)) {
      const b = engine.books.get(h.security_id);
      if (b && b.bids[0] && b.last && b.bids[0].price > b.last * 1.03) {
        const amount = Math.min(engine.holdingOf(bot.id, h.security_id), 5 + ((Math.random() * 10) | 0));
        if (amount >= 1) {
          try {
            const r = engine.placeOrder(botAcct, { security_id: h.security_id, side: 'sell', type: 'market', amount });
            state.orders++;
            state.trades += r.trades.length;
            return true;
          } catch (e) { /* Bid schon weg — normal weiter */ }
        }
      }
    }
  }

  const p = personaFor(bot);
  let buyProb = 0.5 + newsSentiment(sec.id) * 0.12;
  buyProb += (p.contrarian ? -1 : 1) * momentum(sec.id) * 0.18; // gedämpft: sanftes Trendfolgen
  buyProb += valueBias(sec.id, book.last);                      // Wert-Anker: Mean Reversion
  buyProb = Math.min(0.9, Math.max(0.1, buyProb));
  let side = Math.random() < buyProb ? 'buy' : 'sell';

  let holding = engine.holdingOf(bot.id, sec.id);
  // Verkaufs-Laune ohne Bestand? Dann verkaufe eine Position, die der Bot WIRKLICH
  // hält — sonst kann ein frischer Bot-Schwarm anfangs nur kaufen und pumpt den
  // Markt einseitig in den Himmel, bis sich Bestände verteilt haben.
  if (side === 'sell' && holding < 1) {
    const held = db.prepare('SELECT security_id FROM holdings WHERE user_id=? AND amount>0 ORDER BY RANDOM() LIMIT 1').get(bot.id);
    if (!held) return false;
    const altBook = engine.books.get(held.security_id);
    if (!altBook) return false;
    sec = q.secById.get(held.security_id);
    book = altBook;
    holding = engine.holdingOf(bot.id, sec.id);
    if (sec.founder_id === bot.id && Date.now() < sec.lockup_until) return false; // Lock-up
  } else if (sec.founder_id === bot.id && Date.now() < sec.lockup_until) holding = 0; // Lock-up gilt auch für Bots
  // Cash-Pacing: nie mehr als 25% des Cash pro Order (Wale 35%) — Bots bleiben
  // handlungsfähig, statt sich beim ersten Hype komplett leer zu kaufen.
  let amount = Math.max(1, Math.round((1 + Math.random() * 10) * p.sizeBias));
  const whale = Math.random() < 0.07;
  if (whale) amount = Math.round(amount * (3 + Math.random() * 2)); // Wale: seltene Riesen-Orders fürs Tape
  const fee = getSettings().fee_cent;
  const bestBid = book.bids[0]?.price || null;
  const bestAsk = book.asks[0]?.price || null;

  if (side === 'buy') {
    const refPrice = bestAsk || book.last || sec.ipo_price;
    const budget = Math.floor(botAcct.cash * (whale ? 0.35 : 0.25) - fee);
    const affordable = Math.floor(budget / refPrice);
    if (affordable < 1) return false; // pleite — kein Trade
    amount = Math.min(amount, affordable);
  } else {
    if (holding < 1) return false;   // nichts zu verkaufen
    amount = Math.min(amount, holding);
  }

  // ~85 % Market-Orders (wie echte Schüler), Rest Limits direkt am Spread
  let type = 'market', price = null;
  if (Math.random() > 0.85 && bestBid != null && bestAsk != null) {
    type = 'limit';
    const t = engine.tick(sec);
    price = side === 'buy'
      ? Math.max(t, bestBid + t * ((Math.random() * 3) | 0))       // rein in den Spread
      : Math.max(t, bestAsk - t * (1 + ((Math.random() * 2) | 0))); // knapp unter Best Ask
    if (side === 'buy' && price * amount + fee > botAcct.cash) { type = 'market'; price = null; }
  }
  if (type === 'market' && side === 'buy' && !bestAsk) return false; // kein Gegengebot im Buch
  if (type === 'market' && side === 'sell' && !bestBid) return false;

  const r = engine.placeOrder(botAcct, { security_id: sec.id, side, type, price, amount });
  state.orders++;
  state.trades += r.trades.length;
  return true;
}

// Vergessene Bot-Limit-Orders aufräumen (sonst müllt der Testspiel-Bot das Buch zu)
function reapStaleBotOrders() {
  const rows = db.prepare(`SELECT o.id, o.user_id FROM orders o JOIN users u ON u.id=o.user_id
    WHERE o.status='open' AND u.is_bot=1 AND o.created_at < ?`).all(Date.now() - BOT_ORDER_STALE_MS);
  for (const r of rows) {
    try { engine.cancelOrder(q.userById.get(r.user_id), r.id); } catch (e) { /* schon weg */ }
  }
}

function tick() {
  if (!state.running) return;
  try {
    reapStaleBotOrders();
    const s = getSettings();
    let exp = (s.bot_activity / 100) * 2; // erwartete Trades je Tick
    if (s.bot_fast) exp *= 100;           // Fast-Mode: Muster-/MM-Tests in Minuten statt Stunden
    let n = Math.min(200, Math.floor(exp)); // Deckel schützt die Engine
    if (Math.random() < exp - Math.floor(exp)) n = Math.min(200, n + 1);
    // Skips (pleite, leerer Bestand, …) bis zu 3x nachlegen — sonst kommt die
    // Ziel-Frequenz nie an, weil viele Würfe still verfallen.
    let done = 0, tries = 0;
    while (done < n && tries++ < n * 3) {
      try { if (oneTrade()) done++; } catch (e) { state.errors++; } // pleite/leeres Buch/… — egal
    }
  } catch (e) {
    state.errors++;
    console.error('[Bots] Tick-Fehler:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Steuerung (Admin)
// ---------------------------------------------------------------------------
function start(silent = false) {
  if (state.running) return status();
  ensureBots(getSettings().bot_count);
  const created = ensureBotCompanies();
  state.running = true;
  state.started_at = Date.now();
  state.orders = 0; state.trades = 0; state.errors = 0;
  state.timer = setInterval(tick, Math.max(1, getSettings().bot_tick_sec) * 1000);
  setSetting('bot_running', 1);
  console.log(`[Bots] Testspiel-Modus gestartet: ${getSettings().bot_count} Bots${created ? `, ${created} neue Bot-Firmen` : ''}.`);
  if (!silent) {
    const n = addNews('system', '🤖 Testspiel-Modus aktiviert',
      `Die Investment AG hat ${getSettings().bot_count} virtuelle Trader aktiviert — der Markt ist jetzt auch ohne echte Mitschüler lebendig.`);
    bus.emit({ type: 'news', news: n });
  }
  return status();
}

function stop(silent = false) {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.running = false;
  setSetting('bot_running', 0);
  console.log('[Bots] Testspiel-Modus gestoppt.');
  if (!silent) {
    const n = addNews('system', '🤖 Testspiel-Modus beendet', 'Die virtuellen Trader wurden deaktiviert.');
    bus.emit({ type: 'news', news: n });
  }
  return status();
}

function status() {
  const s = getSettings();
  return {
    running: state.running,
    started_at: state.started_at,
    activity: s.bot_activity,
    fast: !!s.bot_fast,
    tick_sec: s.bot_tick_sec,
    count: s.bot_count,
    bots: db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=1').get().c,
    bot_companies: db.prepare(`SELECT s.ticker, s.name FROM securities s JOIN users u ON u.id=s.founder_id
      WHERE u.is_bot=1 AND s.status='active' ORDER BY s.id`).all(),
    orders_this_run: state.orders,
    trades_this_run: state.trades,
    trades_last_hour: db.prepare(`SELECT COUNT(*) c FROM trades WHERE created_at >= ? AND (
      buyer_id IN (SELECT id FROM users WHERE is_bot=1) OR seller_id IN (SELECT id FROM users WHERE is_bot=1))`)
      .get(Date.now() - 3600 * 1000).c,
    errors: state.errors
  };
}

function setActivity(v) {
  setSetting('bot_activity', Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
  return status();
}

function setFast(on) {
  setSetting('bot_fast', on ? 1 : 0);
  console.log(`[Bots] Fast-Mode ${on ? 'AN (×100, Deckel 200/Tick)' : 'aus'}.`);
  return status();
}

function setTickSec(v) {
  const sec = Math.max(1, Math.round(Number(v) || 3));
  setSetting('bot_tick_sec', sec);
  if (state.timer) { // laufenden Takt live umstellen
    clearInterval(state.timer);
    state.timer = setInterval(tick, sec * 1000);
  }
  return status();
}

module.exports = { start, stop, status, setActivity, setFast, setTickSec, ensureBots };
