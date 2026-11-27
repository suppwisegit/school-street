// ============================================================================
// BOT-TRADER — Testspiel-Modus: virtuelle Schüler halten den Markt lebendig.
// ----------------------------------------------------------------------------
// Start/Stop über das Admin-Panel (GET/POST /api/admin/bots). Die Bots sind
// ganz normale Trader-Konten (role='user', is_bot=1): echtes Startkapital. Neue
// Bots übernehmen eine STARTPOSITION aus dem Streubesitz der Staatskasse (siehe
// endowBot): Sie bezahlen sie aus ihrem Startkapital zum aktuellen Kurs, ohne
// Kurswirkung. So ist der Markt ab der ersten Minute zweiseitig — ohne Startposition
// waren die ersten 15 Minuten eine reine Kaufphase (84–91 % Kaufanteil), und der
// Index stieg monoton, bis alle Bots ihre Zielposition gefüllt hatten. Nur manche Bots
// gründen eine Firma (IPO wie bei Spieler-Anträgen: 1.000 Gründeraktien,
// Streubesitz kauft die Staatskasse) und halten so Aktien im Depot.
//
// Handelsstil (Entscheidungslogik in botbrain.js, hier nur Markt, Uhr und Ausführung):
//   * Uhr: je Bot eine eigene Poisson-Uhr in SPIELZEIT. Läutet sie, entscheidet der
//     Bot aus seinem Depot: unter dem Zielanteil kaufen, darüber verkaufen, sonst
//     halten. bot_activity (0-100) setzt die Order-Rate der ganzen Population,
//     handlungsunfähige Bots zählen nicht. Höchstens MAX_ORDERS_TICK Orders je Tick.
//   * Persona: dauerhaft je Bot (Zielanteil, Cash-Reserve, Disposition, House Money,
//     Overconfidence, News-Aufmerksamkeit) — siehe botbrain.personaFor.
//   * News: newsImpact(news) in botbrain bewertet jede Nachricht als Verschiebung
//     des privaten Werts (in beide Richtungen) und als Aufmerksamkeits-Reiz.
//   * Fast-Modus (bot_fast): die Spieluhr der Bots läuft ×100. Raten, News-Fenster,
//     Verfall von Limit-Orders und Bot-Einkommen folgen der Spielzeit — Fast ist
//     nur schneller, das Kapital läuft nicht schneller leer.
// Alles läuft über die echte Engine: Escrow, Gebühren, Preis-Band und
// Self-Trade-Prevention greifen auch für Bots. Ablehnungen (Pleite, kein Bestand,
// Lock-up …) werden still verworfen — wie ein Schüler, der es sich anders
// überlegt; gezählt werden sie in status().errors nicht, Order-Rejections in
// status().skips.
// ============================================================================
const crypto = require('crypto');
const { db, getSettings, setSetting, q, addNews, fmtDe } = require('./db');
const bus = require('./bus');
const engine = require('./engine');
const auth = require('./auth');

const state = { running: false, timer: null, started_at: null, runner: null, counters: { orders: 0, trades: 0, errors: 0, skips: {} } };

function tick() {
  if (state.running && state.runner) return state.runner.tick();
  return null;
}

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

// ---------------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------------
const TARGET_BAND = 0.05;           // Breite der Zonen für die Grund-Zähler (why_this_run): über/innerhalb/unter Ziel ± Band
// Erreichbarer Zielanteil: Der Anteil der Persona, höchstens das, was die Cash-Reserve frei gibt.
function reachableTarget(p, s) { return Math.max(0.05, Math.min(p.targetShare, 1 - reserveFracOf(p, s))); }
// Cash-Reserve je Bot: Einstellungen bot_cash_reserve_min/_max, sonst der Persona-Wert.
function reserveFracOf(p, s) {
  const lo = Number(s.bot_cash_reserve_min), hi = Number(s.bot_cash_reserve_max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && hi >= 0) return lo + (hi - lo) * p.reserveSeed;
  return p.reserveFrac;
}

// Startposition eines NEUEN Bots aus dem Streubesitz der Staatskasse — dieselbe
// Buchung wie ein Kauf von der Staatskasse (addHoldingPublic je Seite, Cash des
// Bots an die Staatskasse), nur ohne Order und ohne Kurswirkung: Der Bot bezahlt
// den aktuellen Kurs. Wert = Zielanteil der Persona (höchstens, was die Reserve
// frei gibt), verteilt auf 2–4 Aktien; der Runner nimmt genau diese Aktien als Korb.
// Damit der Streubesitz auch für die letzten Bots reicht, bekommt jeder höchstens
// seinen Anteil am Bestand (85 % / noch erwartete Zugriffe).
//   picksLeft  Map secId → noch erwartete Zugriffe neuer Bots auf diese Aktie
// Rückgabe: Anzahl übertragener Stück (0 = keine Börse geladen / nichts frei).
//   out.picks   die k Aktien des Bots (für den zweiten Durchlauf endowBots)
//   out.spent   bezahlter Betrag in Cent
const ENDOW_KEEP_PCT = 15;             // so viel Streubesitz bleibt der Staatskasse mindestens
function endowBot(user, picksLeft, out = {}, topUp = false) {
  const t = engine.treasury();
  if (!t || !engine.books.size) return 0;
  const p = brain.personaFor(user.username);
  const s = getSettings();
  const all = [...engine.books.values()].filter(b => b.sec.type === 'stock' && b.sec.status === 'active' && b.last > 0 && b.sec.founder_id !== user.id);
  if (!all.length) return 0;
  const k = Math.min(all.length, 2 + Math.floor(Math.random() * 3));
  // Bemessung ist das STARTKAPITAL, nicht das Kontoguthaben: Ein Bot-Gründer hält den IPO-Erlös
  // (z. B. 70.000 Cr) und bekäme sonst das Siebenfache der anderen als Startposition.
  const budget = Math.floor(Math.min(user.cash, Number(s.start_capital) > 0 ? Number(s.start_capital) : user.cash)
    * Math.min(p.targetShare, Math.max(0, 1 - reserveFracOf(p, s))));
  const copy = all.slice();
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  const picked = out.picks || copy.slice(0, k).map(b => b.sec.id);
  out.picks = picked;
  const taken = new Map();
  let spent = 0, shares = 0;
  // Alles in EINER Transaktion: bricht ein Schritt ab, stehen sonst Aktien ohne Gegenwert.
  const book = db.transaction(() => {
  for (const id of picked) {
    const b = engine.books.get(id);
    if (!b || b.sec.status !== 'active' || !(b.last > 0)) continue;
    const free = engine.holdingOf(t.id, b.sec.id);
    const left = Math.max(1, (picksLeft && picksLeft.get(b.sec.id)) || 1);
    // erster Durchlauf: gerechter Anteil am Bestand (85 % / noch erwartete Zugriffe);
    // Top-up: alles, was über den 15-%-Rest hinaus frei ist
    const fair = Math.floor(free * (100 - ENDOW_KEEP_PCT) / 100 / (topUp ? 1 : left));
    const wantShares = topUp ? Math.floor((budget - (out.spent || 0)) / picked.length / b.last) : Math.floor(budget / k / b.last);
    let amount = Math.min(wantShares, fair, free);
    amount = Math.min(amount, Math.floor((user.cash - spent) / b.last)); // user.cash ist nach dem ersten Durchlauf schon gemindert
    if (picksLeft && !topUp) picksLeft.set(b.sec.id, left - 1);
    if (!(amount >= 1)) continue;
    engine.addHoldingPublic(user.id, b.sec.id, amount, b.last);
    engine.addHoldingPublic(t.id, b.sec.id, -amount);
    spent += amount * b.last;
    shares += amount;
    taken.set(b.sec.id, (taken.get(b.sec.id) || 0) + amount);
  }
  if (!shares) { // alle Zugriffe gingen ins Leere (kein Stück frei): ein Stück von jeder freien Aktie heraussuchen
    for (const b of copy) {
      if (taken.size >= k) break;
      const amount = Math.min(Math.floor(budget / k / b.last), Math.floor(engine.holdingOf(t.id, b.sec.id) * (100 - ENDOW_KEEP_PCT) / 100), Math.floor((user.cash - spent) / b.last));
      if (!(amount >= 1)) continue;
      engine.addHoldingPublic(user.id, b.sec.id, amount, b.last);
      engine.addHoldingPublic(t.id, b.sec.id, -amount);
      spent += amount * b.last;
      shares += amount;
      taken.set(b.sec.id, amount);
    }
  }
  if (!shares) return 0;
  db.prepare('UPDATE users SET cash = cash - ? WHERE id=?').run(spent, user.id);
  db.prepare('UPDATE users SET cash = cash + ? WHERE id=?').run(spent, t.id);
  for (const id of taken.keys()) engine.mmRecenter(engine.books.get(id)); // MM-Leiste mit dem kleineren Bestand
  });
  book();
  out.spent = (out.spent || 0) + spent;
  user.cash -= spent;
  return shares;
}

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

// Startposition für alle Bots, die noch nie am Markt teilgenommen haben (keine freien
// Aktien, kein Trade). Auf einer frischen Börse sind das alle; nach einem Neustart des
// Servers mitten im Spiel niemand. Muss NACH ensureBotCompanies laufen, damit die
// Aktien der Bot-Firmen mit dabei sind. Rückgabe: Zahl der Bots mit Startposition.
function endowBots() {
  const now = Date.now();
  const fresh = db.prepare(`SELECT u.id, u.username, u.cash FROM users u WHERE u.is_bot=1 AND u.frozen=0
    AND NOT EXISTS (SELECT 1 FROM holdings h JOIN securities s ON s.id = h.security_id
                    WHERE h.user_id=u.id AND h.amount>0 AND NOT (s.founder_id = u.id AND s.lockup_until > ${now}))
    AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.buyer_id=u.id OR t.seller_id=u.id)`).all();
  if (!fresh.length) return 0;
  const stocks = [...engine.books.values()].filter(b => b.sec.type === 'stock' && b.sec.status === 'active');
  // Erwartete Zugriffe auf jede Aktie: Bots × mittlerer Korb (3 Aktien) / Anzahl Aktien
  const picksLeft = new Map(stocks.map(b => [b.sec.id, Math.max(1, Math.round(fresh.length * 3 / Math.max(1, stocks.length)))]));
  const outs = new Map();
  let done = 0;
  for (const u of fresh) { const o = {}; outs.set(u.id, o); if (endowBot(u, picksLeft, o) > 0) done++; }

  // Zweiter Durchlauf: billigere Aktien liefern je Stück weniger Wert — wer sein Budget noch nicht
  // angelegt hat, nimmt den Rest über die 15 % hinaus. So kommen die Bots wirklich auf ihr Ziel.
  for (const u of fresh) { const o = outs.get(u.id); if (o.picks) endowBot(u, null, o, true); }
  return done;
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
  const n = addNews('ipo', `IPO: ${sec.name} (${sec.ticker}) startet zum Kurs ${fmtDe(ipo)}`,
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
// Bot-Runner: eine Bot-Population am Markt. Alles Nötige kommt von außen —
// Zufall, Uhr, Settings und Marktzugriff — damit Tests einen Bot-Markt
// deterministisch und ohne Timer fahren können.
// ---------------------------------------------------------------------------
const brain = require('./botbrain');

// Marktzugriff im Produktionsbetrieb (DB + Engine). Tests übergeben ein eigenes
// repo oder lassen dieses auf einer eigenen DB laufen.
function buildRepo() {
  return {
    bots: () => db.prepare("SELECT id, username, cash FROM users WHERE role='user' AND is_bot=1 AND frozen=0").all(),
    user: (id) => q.userById.get(id),
    holdings: (id) => db.prepare('SELECT security_id, amount, avg_cost FROM holdings WHERE user_id=? AND amount>0').all(id),
    securities: () => db.prepare("SELECT id, type, ticker, founder_id, lockup_until FROM securities WHERE status='active'").all(),
    quote: (secId) => {
      const b = engine.books.get(secId);
      return b ? {
        last: b.last, bid: b.bids[0] ? b.bids[0].price : null, ask: b.asks[0] ? b.asks[0].price : null,
        bidDepth: engine.sideDepth(b, 'buy'), askDepth: engine.sideDepth(b, 'sell'), // Stück je Seite im Band
        depth: engine.impactDepth(secId)                                        // Streubesitz D (Ordergrößen-Deckel)
      } : null;
    },
    market: (user, secId, side, amount) => {
      const p = engine.previewOrder(user, { security_id: secId, side, type: 'market', amount });
      return { gross: p.gross, available: p.available, cap: p.cap };
    },
    tickSize: (secId) => engine.tick(q.secById.get(secId)),
    place: (user, order) => engine.placeOrder(user, order),
    // auch marktweite News (security_id NULL) — sie stimmen alle Aktien
    news: (sinceWallMs) => db.prepare('SELECT kind, title, body, impact, security_id, created_at FROM news WHERE created_at >= ?').all(sinceWallMs),
    cancelOrder: (userId, orderId) => engine.cancelOrder(q.userById.get(userId), orderId),
    // liegende Bot-Limit-Orders (Reststück) je Aktie und Seite — zählen weiter gegen den Herding-Deckel
    openBotLimits: () => db.prepare(`SELECT o.security_id, o.side, o.amount - o.filled AS rest FROM orders o JOIN users u ON u.id=o.user_id
      WHERE o.status='open' AND o.type='limit' AND u.is_bot=1 AND o.amount > o.filled`).all(),
    openBotOrdersBefore: (wallMs) => db.prepare(`SELECT o.id, o.user_id FROM orders o JOIN users u ON u.id=o.user_id
      WHERE o.status='open' AND u.is_bot=1 AND o.created_at < ?`).all(wallMs),
    pay: (ids, amount) => db.transaction(() => {
      for (const id of ids) {
        db.prepare('UPDATE users SET cash = cash + ? WHERE id=?').run(amount, id);
        bus.emit({ type: 'dirty', user_id: id, what: ['portfolio'] });
      }
    })(),
    // Zahlt der Einkommens-Job selbst (Wanduhr)? Dann lässt der Runner ihm den Vortritt.
    jobsPayIncome: () => { try { return require('./jobs').state.timers.length > 0; } catch (e) { return false; } }
  };
}

const FAST_FACTOR = 100;            // bot_fast: so schnell läuft die Spieluhr der Bots
const MAX_ORDERS_TICK = 200;        // Engine-Schutz: höchstens so viele Orders je Tick
const MAX_ATTEMPTS_TICK = 600;      // höchstens so viele Bot-Entscheidungen je Tick (Hold kostet keine Order)
const NEWS_WINDOW_MIN = 45;         // so lange wirken News am Stück (Spielminuten)
const ORDER_STALE_MIN = 10;         // Bot-Limit-Orders verfallen danach (Spielminuten)
const PRICE_MEMORY_MIN = 360;       // Kursgedächtnis für Momentum und Kursband (Spielminuten)
const PRICE_SAMPLE_SEC = 15;        // Kurspunkte im Gedächtnis: Abstand in Spiel-Sekunden
const ETF_PICK_PROB = 0.12;         // Anteil der Versuche, die einen ETF statt einer Aktie wählen
const SIGNAL_GAIN = 1.5;            // wie stark das Gesamtsignal den Zielanteil verschiebt
const ARRIVAL_MIN = 2;              // Schüler trudeln ein: erster Handel gleichmäßig über 2 Spielminuten (jeder
                                    // handlungsfähige Bot entscheidet spätestens nach 2 Spielminuten). Bei 10 min
                                    // handelte im Normalmodus in der ersten Minute fast niemand — Schüler spielen sofort.
const INVEST_NEW_WEALTH = 0.05;     // so viel von neuem Vermögen (Einkommen, geschenkte Credits) fließt ins Aktienziel …
const RESERVE_FLOOR = 0.5;         // Cash-Reserve im Nachkauf-Fall: höchstens bis zur Hälfte anzapfen
const INVEST_GROWTH_CAP = 0.5;      // ... und zwar nur bis +50 % über dem Startvermögen. Danach wird gespart: die
                                    // Aktienmenge am Markt wächst nicht mit der Geldmenge (Fast-Modus mit
                                    // income_sec 300 zahlte 100× je Wanduhr: Vermögen ×180, Bots kauften die
                                    // Staatskasse leer, Index eingefroren, 0 Trades).
const TICK_FLOW_MAX_STEP = 0.01;     // Netto-Bot-Orderflow je Tick und Aktie: alle Bots zusammen bewegen den
                                    // fairen Kurs damit um höchstens ~1 % je Tick (Herding-Deckel). Mehr
                                    // Richtung im selben Tick wird auf den nächsten Tick verschoben.
const NEWS_EARLY_MIN = 3;            // so lange gilt eine Aktien-News als „frisch“: Wirkung je Bot gedämpft
const INCOME_CATCHUP_MAX = 100000; // Schutzgrenze der Nachhol-Schleife (bei income_sec ≥ 1 s: jeder Spielzeit)
const HERD_DEFER_MS = 1000;          // zurückgestellte Order: neuer Versuch innerhalb der nächsten Sekunde (Spielzeit)
const SETTLE_MIN = 8;                // Anklang: Signale wirken in den ersten Spielminuten nur teilweise (15 % → 100 %) —
                                    // Staatskasse leer, Index eingefroren, 0 Trades).
const MIN_NOTIONAL_FEES = 10;       // kleinste Nachschüpfung = 10 × Gebühr (höchstens 10 % der Order); Einstieg ab 1 Stück

// Optionaler Setting-Wert: Key vorhanden → nehmen, sonst Default (db.js braucht nichts zu wissen).
function opt(s, key, fallback) {
  const v = Number(s[key]);
  return Number.isFinite(v) ? v : fallback;
}

// createBotRunner({ rnd, now, settings, repo, counters, fastFactor })
//   rnd         () => 0..1, Zufall (Default Math.random)
//   now         () => Wanduhr-ms (Default Date.now); tick() liest sie je Aufruf
//   settings    () => Settings (Default getSettings)
//   repo        Marktzugriff (Default buildRepo())
//   counters    { orders, trades, errors, skips } — wird fortgeschrieben
//   fastFactor  Spieluhr-Faktor des Fast-Modus (Default 100); nur Messungen und
//               Tests setzen ihn kleiner, wenn ihre Uhr bereits komprimiert läuft
// Rückgabe { tick, attempt, bots, sim, speedUp }:
//   tick()     ein Bot-Takt: Uhren stellen, Einkommen, verfallene Orders, fällige Bots
//   attempt(b) EINE Entscheidung eines Bots (b aus bots.values()) → true = Order aufgelegt
//   bots       Map id -> Bot-Zustand (persona, nextDue, able …)
//   sim        { t, real, fast, ticks } — Spielzeit t in ms
function createBotRunner({ rnd = Math.random, now = Date.now, settings = getSettings, repo = buildRepo(), counters, fastFactor = FAST_FACTOR } = {}) {
  const speedUp = Number.isFinite(fastFactor) && fastFactor > 0 ? fastFactor : FAST_FACTOR;
  const cnt = counters || { orders: 0, trades: 0, errors: 0, skips: {} };
  const skip = (k) => { cnt.skips[k] = (cnt.skips[k] || 0) + 1; };
  const bots = new Map();     // id -> { id, name, persona, store, nextDue, lambda, wealth0, able }
  const memory = new Map();   // secId -> [{ t, p }] Kursgedächtnis (Spielzeit)
  const sim = { start: now(), t: now(), real: now(), fast: false, incomeAt: null, ticks: 0 };
  const view = { secs: [], etfs: [], quotes: new Map(), news: new Map(), newsEarly: new Map(), attention: new Map(), mood: 0 };
  const flowTick = { n: -1, net: new Map() }; // je Tick: Streubesitz-Nettoflow der Bot-Orders je Aktie (Stück, Kauf + / Verkauf −)
  const MIN = 60000;

  function sync() {
    const s = settings();
    const r = now();
    sim.t += (r - sim.real) * (sim.fast ? speedUp : 1);
    sim.real = r;
    sim.fast = !!s.bot_fast;
    return s;
  }
  const simAge = (wallMs) => Math.max(0, (sim.real - wallMs) * (sim.fast ? speedUp : 1)); // Alter in Spiel-ms
  const wallCutoff = (simMs) => sim.real - simMs / (sim.fast ? speedUp : 1);

  function loadBots() {
    const have = new Set();
    for (const u of repo.bots()) {
      have.add(u.id);
      if (!bots.has(u.id)) bots.set(u.id, { id: u.id, name: u.username, persona: brain.personaFor(u.username), store: new Map(), universe: null, nextDue: null, lambda: 0, wealth0: 0, able: true });
    }
    for (const id of [...bots.keys()]) if (!have.has(id)) bots.delete(id);
  }

  // Je Tick einmal: Wertpapiere, Kurse (ins Gedächtnis), News-Wirkung je Wertpapier
  function loadView() {
    view.secs = repo.securities();
    view.etfs = view.secs.filter(x => x.type === 'etf');
    view.quotes.clear(); view.news.clear(); view.newsEarly.clear(); view.attention.clear(); view.mood = 0;
    for (const s of view.secs) {
      const qt = repo.quote(s.id);
      if (!qt || !qt.last) continue;
      view.quotes.set(s.id, qt);
      const arr = memory.get(s.id);
      if (!arr) memory.set(s.id, [{ t: sim.t, p: qt.last }]);
      else if (sim.t - arr[arr.length - 1].t >= PRICE_SAMPLE_SEC * 1000) {
        arr.push({ t: sim.t, p: qt.last });
        const cut = sim.t - PRICE_MEMORY_MIN * MIN;
        while (arr.length > 2 && arr[0].t < cut) arr.shift();
      }
    }
    const groups = new Map();
    const fresh = repo.news(wallCutoff(NEWS_WINDOW_MIN * MIN));
    view.mood = brain.marketMood(fresh, (n) => simAge(n.created_at)); // ohne Aktie: Stimmung für alles
    for (const n of fresh) {
      if (n.security_id == null) continue;
      const g = groups.get(n.security_id);
      if (g) g.push(n); else groups.set(n.security_id, [n]);
    }
    for (const [id, list] of groups) {
      const sig = brain.newsSignal(list, (n) => simAge(n.created_at));
      view.news.set(id, sig.value);
      view.newsEarly.set(id, brain.newsSignal(list.filter(n => simAge(n.created_at) < NEWS_EARLY_MIN * MIN), (n) => simAge(n.created_at)).value);
      view.attention.set(id, sig.attention);
    }
  }

  // Je Bot ein fester Aktien-Korb (2–4 Werte, aus dem Namens-Hash-Strom gezogen und
  // dann stabil): ein Schüler beobachtet wenige Aktien, nicht den ganzen Markt.
  // Gehaltene Werte außerhalb des Korbs bleiben im Blick, bis sie verkauft sind.
  // Hat der Bot bei der ersten Wahl schon Aktien (Startposition aus endowBot), sind
  // genau diese sein Korb — sonst hätte er für sie kein Ziel und würde sie sofort wieder verkaufen.
  function universeOf(b, held = []) {
    if (!b.universe && held.length) {
      b.universe = [...new Set(held.map(h => h.security_id))].filter(id => view.quotes.has(id));
      if (b.universe.length) return b.universe;
      b.universe = null;
    }
    const stocks = view.secs.filter(s => s.type !== 'etf' && view.quotes.has(s.id));
    const all = stocks.length ? stocks : view.secs.filter(s => view.quotes.has(s.id));
    if (!all.length) return [];
    if (!b.universe || !b.universe.some(id => all.some(s => s.id === id))) {
      const k = Math.min(all.length, 2 + Math.floor(rnd() * 3));
      const copy = all.map(s => s.id);
      for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
      b.universe = copy.slice(0, k);
    }
    return b.universe.filter(id => all.some(s => s.id === id));
  }

  // Attention: mit Wahrscheinlichkeit persona.attention ein Wertpapier aus den
  // aktuellen News (stärkere Wirkung = eher), sonst eines aus dem eigenen Korb
  // bzw. Depot. Der Index wird EINMAL gezogen — nie innerhalb eines Such-Prädikats.
  function pickSecurity(b, held) {
    const hot = [];
    for (const [id, a] of view.attention) if (a > 0.02 && view.quotes.has(id)) hot.push(id);
    if (hot.length && rnd() < b.persona.attention) {
      const w = hot.map(id => 0.2 + Math.abs(view.news.get(id) || 0) * 4);
      let r = rnd() * w.reduce((x, y) => x + y, 0);
      for (let i = 0; i < hot.length; i++) { r -= w[i]; if (r <= 0) return hot[i]; }
      return hot[hot.length - 1];
    }
    const etfs = view.etfs.filter(s => view.quotes.has(s.id));
    if (etfs.length && rnd() < ETF_PICK_PROB) return etfs[Math.min(etfs.length - 1, Math.floor(rnd() * etfs.length))].id;
    const pool = [...new Set([...universeOf(b), ...held.map(h => h.security_id)])];
    return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))] : null;
  }

  // Handelbare Positionen eines Bots: Gründeraktien in der Sperrfrist zählen nicht.
  function holdingsOf(b) {
    return repo.holdings(b.id).filter(h => {
      const s = view.secs.find(x => x.id === h.security_id);
      return s && !(s.founder_id === b.id && sim.real < s.lockup_until);
    });
  }


  // Eine Entscheidung des Bots b. true = Order aufgelegt (market oder limit).
  function attempt(b) {
    const p = b.persona;
    const u = repo.user(b.id);
    if (!u) { b.able = false; return false; }
    const s = settings();
    const fee = Number(s.bot_fee_cent) > 0 ? Number(s.bot_fee_cent) : s.fee_cent; // eigene Bot-Gebühr, falls gesetzt (Vertrag V1)
    const pos = holdingsOf(b);
    let wealth = u.cash, heldValue = 0;
    for (const h of pos) { const q2 = view.quotes.get(h.security_id); if (q2) wealth += h.amount * q2.last; }
    if (!b.wealth0) b.wealth0 = wealth; // normal setzt tick() das Startvermögen schon im ersten Takt
    let cheapest = Infinity;
    for (const qt of view.quotes.values()) if (qt.ask || qt.last) cheapest = Math.min(cheapest, qt.ask || qt.last);
    // Handlungsfähig: kann ein Stück aus dem Cash kaufen oder hat handelbare Aktien
    b.able = pos.length > 0 || (cheapest !== Infinity && u.cash >= cheapest + fee);
    if (!b.able || !(wealth > 0)) { skip('unable'); return false; }

    const secId = pickSecurity(b, pos);
    if (secId == null) { skip('noSecurity'); return false; }
    const qt = view.quotes.get(secId);
    const held = pos.find(h => h.security_id === secId);
    const hist = memory.get(secId) || [];
    // Anklang: sofort handeln, aber vorsichtig beginnen (verhindert den Umschichtungs-Schub der
    // Startposition in den ersten zwei Minuten: 602 Trades je 5 min gegen 170 später)
    const settle = Math.max(0.15, Math.min(1, (sim.t - (b.firstSeen == null ? sim.t - SETTLE_MIN * MIN : b.firstSeen)) / (SETTLE_MIN * MIN)));
    const signal = settle * brain.valueSignal(p, {
      priv: brain.privateSignal(b.store, secId, p, sim.t, rnd),
      // Aktien-News wirken gedämpft und gestaffelt: Ein Bot folgt einer FRISCHEN Meldung nur mit
      // seinem persona.newsReact (0,2 … 1); die volle Wirkung baut sich auf, während die Meldung
      // älter wird. Ohne die Staffelung liefen nach einer Nachricht alle Bots im selben Tick in
      // dieselbe Richtung (gemessen: 4 935 Stück EIS in einer Sekunde, Kursschritt 13,8 %).
      news: (view.news.get(secId) || 0) - (view.newsEarly.get(secId) || 0) * (1 - (Number.isFinite(p.newsReact) ? p.newsReact : 1)),
      momentum: brain.momentum(hist.filter(x => x.t >= sim.t - 30 * MIN)),
      anchor: brain.anchorBias(hist),
      mood: view.mood,
      book: brain.bookImbalance(qt)
    });
    const korb = universeOf(b, pos);
    const inKorb = korb.includes(secId);
    // Ziel je Aktie: fester Anteil des Vermögens, verschoben um das Signal. Werte außerhalb des
    // eigenen Korbs haben kein Ziel. Unten bei 25 % geklemmt: Ein sehr negatives Signal setzte das
    // Ziel sonst auf 0. Signale verschieben das Ziel, sie erzwingen keine Seite.
    const slotShare = inKorb ? p.targetShare * Math.max(0.25, Math.min(1.75, 1 + signal * SIGNAL_GAIN)) / Math.max(1, korb.length) : 0;
    // Einkommen wird nicht automatisch zu Aktien: Anlagebasis = Startvermögen plus ein kleiner Teil
    // des neuen Vermögens (INVEST_NEW_WEALTH, höchstens bis INVEST_GROWTH_CAP); Verluste mindern das
    // Ziel voll. signal hier 0: slotShare trägt das Signal bereits.
    const gainW = b.wealth0 > 0 ? Math.min(wealth - b.wealth0, b.wealth0 * INVEST_GROWTH_CAP) : 0;
    const base = wealth > b.wealth0 && gainW > 0 ? b.wealth0 + gainW * INVEST_NEW_WEALTH : wealth;
    const want = brain.targetValue(p, { wealth: base, slotShare, signal: 0, held: held ? held.amount : 0, price: qt.last, avgCost: held ? held.avg_cost : 0 });
    if (held) heldValue = held.amount * qt.last;
    const plan = brain.planTrade(p, { wealth, want, heldValue, refWealth: b.wealth0, rnd });
    if (plan.side === 'hold') return false;
    // HINWEIS Zielband-Regel: „netto verkaufen nur über Ziel + Band, kauft nur unter Ziel − Band,
    // dazwischen umschichten“ wurde am 27.11. erprobt und wieder zurückgenommen (Kaufanteil 43 %,
    // Index −3,4 % / −7,7 %, Trades im letzten Drittel 30 % statt 50 % des ersten). Belege:
    // berichte/NACHHER-MESSUNG.md Abschnitt 9. Die Zähler je Grund (countWhy) bleiben.

    let amount;
    if (plan.side === 'buy') {
      // Kauf nur aus dem Betrag über der Reserve. Die Reserve ist weich: Wer unter seinem Ziel liegt,
      // darf sie bis zur Hälfte anzapfen.
      const under = (() => { let heldAll = 0; for (const h of pos) heldAll += h.amount * (view.quotes.get(h.security_id) || {}).last; return heldAll < 0.97 * base * p.targetShare; })();
      const spendable = u.cash - Math.round(reserveFracOf(p, s) * wealth * (under ? RESERVE_FLOOR : 1));
      const ref = qt.ask || qt.last;
      const gap = want - heldValue;
      // Nachschöpfen nur, wenn es 10 × Gebühr wert ist — aber nie mehr verlangt als die Zielposition
      const minNotional = Math.min(MIN_NOTIONAL_FEES * fee, Math.max(1, want));
      if (gap < minNotional) { skip('tooSmall'); return false; }
      const mk = repo.market(u, secId, 'buy', 1);
      amount = brain.sizeOrder({ gapValue: gap, price: ref, size: plan.side === 'buy' && !held ? 1 : plan.size, minChunk: Math.min(want * 0.2, gap) / ref, maxByMoney: (spendable - fee) / ref, limit: mk });
      while (amount >= 1) { // echte Kosten aus dem Buch, nicht Schätzung am Best Ask
        const g = repo.market(u, secId, 'buy', amount).gross + fee;
        if (g <= spendable) break;
        amount = Math.floor(amount * Math.max(0, spendable) / g);
      }
      if (!(amount >= 1)) { skip(spendable < ref + fee ? 'broke' : 'noLiquidity'); return false; }
    } else {
      if (!(heldValue > 0)) return false;
      if (heldValue <= fee) { skip('tooSmall'); return false; } // Erlös kleiner als die Gebühr
      const mk = repo.market(u, secId, 'sell', 1);
      // wie beim Kauf höchstens die Abweichung (früher mindestens 20 % der Position)
      amount = brain.sizeOrder({ gapValue: heldValue - want, price: qt.bid || qt.last, size: plan.size, minChunk: Math.min(heldValue * 0.2, heldValue - want) / (qt.bid || qt.last), maxByMoney: held.amount, limit: mk });
      if (!(amount >= 1)) { skip('noLiquidity'); return false; }
    }

    // Per-Bot-Deckel 3 %, Herding-Deckel je Tick und Aktie, Market/Limit — siehe dispatch()
    if (!dispatch(b, u, secId, plan.side, amount)) return false;
    countWhy(plan.side, held, qt, pos, base, p, s);
    return true;
  }

  // Eine Order absetzen: Per-Bot-Deckel 3 %, Herding-Deckel je Tick und Aktie, ~85 % Market / Rest
  // Limit. silent = ohne Zähler, Verzicht auf Verschieben und Fehlerzählung (derzeit unbenutzt).
  function dispatch(b, u, secId, side, amount, silent = false) {
    const qt = view.quotes.get(secId);
    if (!qt || !(amount >= 1)) return false;
    const s = settings(), p = b.persona;
    // Ordergrößen-Deckel: eine Bot-Order bewegt den fairen Kurs um höchstens 3 %. Die Engine-Grenze
    // begrenzt nur die sofortige Ausführung; der Rest einer Limit-Order liegt im Buch — deshalb
    // wird hier die ORDER begrenzt.
    const stepCap = brain.maxStepShares(qt.depth, Number(s.mm_impact_pct));
    if (stepCap != null) {
      amount = Math.min(amount, stepCap);
      if (!(amount >= 1)) { skip('stepCap'); return false; }
    }
    // Herding-Deckel: alle Bot-Orders dieses Ticks an der Aktie zusammen bleiben netto unter der
    // Stückzahl für TICK_FLOW_MAX_STEP Kurswirkung (liegende Bot-Limits zählen mit). Die Order wird
    // gekürzt; nur ohne Rest verschoben.
    if (flowTick.n !== sim.ticks) { flowTick.n = sim.ticks; flowTick.net = restingNet(); }
    const herdCap = brain.maxStepShares(qt.depth, Number(s.mm_impact_pct), TICK_FLOW_MAX_STEP);
    if (herdCap != null) {
      const net0 = flowTick.net.get(secId) || 0, dir = side === 'buy' ? 1 : -1;
      const room = herdCap - dir * net0; // Stück in diese Richtung frei (gegen den Flow: mehr als der Deckel)
      if (room < 1) {
        if (!silent) { b.nextDue = Math.min(b.nextDue, sim.t + rnd() * HERD_DEFER_MS); skip('herdCap'); } // später erneut
        return false;
      }
      if (amount > room) { amount = Math.max(1, Math.floor(room)); if (!silent) skip('herdCapTrim'); }
      flowTick.net.set(secId, net0 + dir * amount);
    }
    // ~85 % Market-Orders (wie echte Schüler), Rest Limits knapp am Spread
    let type = 'market', price = null;
    if (qt.bid != null && qt.ask != null && rnd() < p.limitAffinity) {
      const t = repo.tickSize(secId);
      price = side === 'buy' ? qt.bid + t * (1 + Math.floor(rnd() * 3)) : Math.max(t, qt.ask - t * (1 + Math.floor(rnd() * 3)));
      type = 'limit';
    }
    const order = { security_id: secId, side, type, price, amount };
    let r;
    try { r = repo.place(u, order); }
    catch (e) {
      if (silent) return false;
      if (type === 'market') { skip('rejected'); return false; }
      try { r = repo.place(u, { ...order, type: 'market', price: null }); } // Limit außerhalb des Bands → Market
      catch (e2) { skip('rejected'); return false; }
    }
    cnt.orders++;
    cnt.trades += r.trades.length;
    return true;
  }

  // Zähler je Grund (status().why_this_run): Wo steht der Bot gegenüber seinem erreichbaren
  // Zielanteil (Zielanteil, höchstens 1 − Reserve), wenn er kauft oder verkauft?
  function countWhy(side, held, qt, pos, base, p, s) {
    const why = cnt.why || (cnt.why = {});
    let heldAll = 0;
    for (const h of pos) heldAll += h.amount * ((view.quotes.get(h.security_id) || {}).last || 0);
    const target = reachableTarget(p, s);
    const zone = heldAll > (target + TARGET_BAND) * base ? 'Over' : heldAll < (target - TARGET_BAND) * base ? 'Under' : 'In';
    why[side + zone] = (why[side + zone] || 0) + 1;
    if (side === 'sell' && held && held.avg_cost > 0 && qt.last / held.avg_cost - 1 > (Number.isFinite(p.takeProfit) ? p.takeProfit : brain.DEFAULT_TAKE_PROFIT)) why.sellTakeProfit = (why.sellTakeProfit || 0) + 1;
  }

  // Netto-Flow der liegenden Bot-Limit-Orders je Aktie (Kauf +, Verkauf −): Sie zählen in jedem
  // Tick weiter gegen den Herding-Deckel, bis sie gefüllt sind oder verfallen — ihre Füllung in
  // einem späteren Tick bewegt den Kurs genauso.
  function restingNet() {
    const m = new Map();
    if (typeof repo.openBotLimits !== 'function') return m;
    for (const o of repo.openBotLimits()) {
      if (!(o.rest > 0)) continue;
      m.set(o.security_id, (m.get(o.security_id) || 0) + (o.side === 'buy' ? o.rest : -o.rest));
    }
    return m;
  }

  // Startvermögen je Bot gleich im ersten Takt festhalten — nicht erst beim ersten
  // Handel (der bis zu ARRIVAL_MIN Minuten später liegt): sonst zählten die bis dahin
  // eingegangenen Einkommen zum Startvermögen, und die Anlagegrenze wuchs mit dem
  // Geld, das sie gerade begrenzen soll. Einmal je Bot.
  function setStartWealth() {
    for (const b of bots.values()) {
      if (b.wealth0) continue;
      const u = repo.user(b.id);
      if (!u) continue;
      let w = u.cash;
      for (const h of repo.holdings(b.id)) w += h.amount * ((view.quotes.get(h.security_id) || {}).last || 0);
      // Anlagebasis ist das STARTKAPITAL, auch wer im ersten Takt schon mehr hat: Ein Bot-Gründer
      // erhält den IPO-Erlös (z. B. 70.000 Cr) und kaufte damit stundenlang Aktien nach —
      // ein Kaufdruck, der mit dem Zielanteil der Persona nichts zu tun hat. Mehr als das
      // Startkapital gilt als neues Vermögen (davon wird nur ein Teil angelegt).
      const cap0 = Number(settings().start_capital);
      if (w > 0) b.wealth0 = cap0 > 0 ? Math.min(w, cap0) : w;
      if (b.firstSeen == null) b.firstSeen = sim.t;
    }
  }

  // Einkommen auf der SPIELUHR: Fast-Modus bekommt es 100× so oft wie der
  // Wanduhr-Job zahlt. Läuft der Job und ist Spielzeit = Wanduhr, zahlt er selbst.
  function payIncome(s) {
    if (!(s.income_sec > 0)) return;
    // income_sim_scale = 1: der Einkommens-Job skaliert selbst mit der Sim-Zeit.
    const jobScales = Number(s.income_sim_scale) === 1;
    const self = !repo.jobsPayIncome() || (sim.fast && speedUp > 1 && !jobScales);
    // Dieselbe Uhr wie der Einkommens-Job: zählt er im Spielrhythmus (income_sim_scale = 1,
    // auch ohne laufenden Job), läuft die Bot-Zahlung über die Spielzeit — sonst über die
    // Wanduhr. (Vorher lief die Selbstzahlung immer über die Spielzeit: Mit
    // income_sim_scale = 0 bekamen die Schüler eine Zahlung je Stunde Wanduhr, die Bots
    // aber je 36 s — das Hundertfache.)
    const useSim = !(sim.fast && !jobScales);
    const clockNow = useSim ? sim.t : sim.real;
    const period = s.income_sec * 1000;
    if (sim.incomeClock !== useSim) { // Uhrwechsel (Fast an/aus): die laufende Periode wird auf der neuen Uhr fortgeführt
      const wasSim = sim.incomeClock === true;
      const elapsed = sim.incomeAt == null ? 0 : Math.max(0, (wasSim ? sim.t : sim.real) - sim.incomeAt); // auf der BISHERIGEN Uhr gelesen
      sim.incomeClock = useSim;
      sim.incomeAt = sim.incomeAt != null && elapsed > 0 ? clockNow - Math.min(elapsed, period) : null;
    }
    if (!self) { sim.incomeAt = clockNow; return; }
    if (sim.incomeAt == null) { sim.incomeAt = clockNow; return; } // erste Periode ab jetzt
    // Alle seit dem letzten Takt fälligen Perioden nachholen (langer Takt, Fast-Umstellung, Pause) —
    // nicht nur eine: bei 60 s Takt und income_sec 360 kamen von 50 fälligen Zahlungen 2 an.
    let due = 0;
    while (clockNow - sim.incomeAt >= period && due < INCOME_CATCHUP_MAX) { sim.incomeAt += period; due++; }
    if (!due) return;
    const ids = [...bots.keys()];
    if (ids.length) repo.pay(ids, opt(s, 'bot_income_cent', s.income_cent) * due);
    for (const b of bots.values()) b.able = true;
    cnt.income = (cnt.income || 0) + due;
  }

  // Vergessene Bot-Limit-Orders aufräumen (sonst müllt der Bot das Buch zu)
  function reapStaleOrders() {
    for (const o of repo.openBotOrdersBefore(wallCutoff(ORDER_STALE_MIN * MIN))) {
      try { repo.cancelOrder(o.user_id, o.id); } catch (e) { skip('cancelFailed'); }
    }
  }

  function tick() {
    const s = sync();
    sim.ticks++;
    if (s.trading_paused) return { attempts: 0, orders: 0 };
    loadBots();
    loadView();
    setStartWealth();
    payIncome(s);
    reapStaleOrders();

    // Poisson-Uhren: Rate je Bot aus Aktivität und Overconfidence; nur
    // handlungsfähige Bots teilen sich die Zielrate der Population.
    const base = opt(s, 'bot_trades_per_min', brain.BASE_RATE_PER_MIN);
    const able = [...bots.values()].filter(b => b.able);
    const ocSum = able.reduce((a, b) => a + b.persona.overconfidence, 0);
    const due = [];
    for (const b of able) {
      b.lambda = brain.botRatePerMin(b.persona, s.bot_activity, ocSum, base) / MIN;
      // Gestaffelter Einstieg: jeder Bot kommt zu einem eigenen Zeitpunkt (ARRIVAL_MIN)
      if (b.nextDue == null) b.nextDue = sim.t + (sim.ticks <= 1 ? rnd() * ARRIVAL_MIN * MIN : 0);
      if (!Number.isFinite(b.nextDue) && b.lambda > 0) b.nextDue = sim.t;
      if (b.nextDue <= sim.t) due.push(b);
    }
    for (let i = due.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [due[i], due[j]] = [due[j], due[i]]; }
    let attempts = 0, orders = 0;
    for (const b of due) {
      if (orders >= MAX_ORDERS_TICK || attempts >= MAX_ATTEMPTS_TICK) break; // Rest bleibt fällig
      attempts++;
      const mean = b.lambda > 0 ? 1 / b.lambda : Infinity;
      if (mean === Infinity) { b.nextDue = Infinity; continue; }
      else {
        b.nextDue = Math.max(b.nextDue, sim.t - mean) + brain.poissonInterval(b.lambda, rnd);
        if (!(b.nextDue > sim.t)) b.nextDue = sim.t + rnd() * mean;
      }
      try { if (attempt(b)) orders++; }
      catch (e) { cnt.errors++; console.error('[Bots] Entscheidungs-Fehler:', e.message); }
    }
    return { attempts, orders, due: due.length, able: able.length };
  }

  return { tick, attempt, bots, sim, speedUp };
}

// ---------------------------------------------------------------------------
// Steuerung (Admin)
// ---------------------------------------------------------------------------
function start(silent = false, runnerOpts = {}) {
  if (state.running) return status();
  ensureBots(getSettings().bot_count);
  const created = ensureBotCompanies();
  const endowed = endowBots();
  state.running = true;
  state.started_at = Date.now();
  state.counters = { orders: 0, trades: 0, errors: 0, skips: {} };
  state.runner = createBotRunner({ ...runnerOpts, counters: state.counters });
  state.timer = setInterval(tick, Math.max(1, getSettings().bot_tick_sec) * 1000);
  setSetting('bot_running', 1);
  console.log(`[Bots] Testspiel-Modus gestartet: ${getSettings().bot_count} Bots${created ? `, ${created} neue Bot-Firmen` : ''}${endowed ? `, ${endowed} Bots mit Startposition` : ''}.`);
  if (!silent) {
    const n = addNews('system', 'Testspiel-Modus aktiviert',
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
    const n = addNews('system', 'Testspiel-Modus beendet', 'Die virtuellen Trader wurden deaktiviert.');
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
    orders_this_run: state.counters.orders,
    trades_this_run: state.counters.trades,
    able_bots: state.runner ? [...state.runner.bots.values()].filter(b => b.able).length : null,
    sim_minutes: state.runner ? Math.round((state.runner.sim.t - state.runner.sim.start) / 60000) : 0,
    decisions_per_min_target: state.runner ? Math.round(brain.populationRatePerMin(s.bot_activity, opt(s, 'bot_trades_per_min', brain.BASE_RATE_PER_MIN))) : null, // Läuten der Bot-Uhren je Spielminute
    skips_this_run: { ...state.counters.skips },
    why_this_run: { ...(state.counters.why || {}) },
    trades_last_hour: db.prepare(`SELECT COUNT(*) c FROM trades WHERE created_at >= ? AND (
      buyer_id IN (SELECT id FROM users WHERE is_bot=1) OR seller_id IN (SELECT id FROM users WHERE is_bot=1))`)
      .get(Date.now() - 3600 * 1000).c,
    errors: state.counters.errors
  };
}

function setActivity(v) {
  setSetting('bot_activity', Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
  return status();
}

function setFast(on) {
  setSetting('bot_fast', on ? 1 : 0);
  console.log(`[Bots] Fast-Mode ${on ? 'AN (Spieluhr ×100, Deckel 200 Orders/Tick)' : 'aus'}.`);
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

// Konten und Bot-Firmen anlegen, ohne zu starten (Tests, Admin-Vorbereitung)
function prepare() {
  ensureBots(getSettings().bot_count);
  const created = ensureBotCompanies();
  endowBots();
  return created;
}

module.exports = { start, stop, status, setActivity, setFast, setTickSec, ensureBots, endowBot, endowBots, prepare, tick, createBotRunner, buildRepo };
