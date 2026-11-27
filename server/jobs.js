// Hintergrund-Jobs: Einkommen + Gebühren-Recycling, News-Generator, Market-Maker-Refresh,
// Ghost-Accounts, Preis-Sampler für Charts, Aufräumen alter Zeilen,
// ETF-Auto-Arbitrage (AP-Automatik, wenn etf_auto=1).
//
// Spieluhr: Im Fast-Modus (bot_fast) läuft das Spiel mit dem Faktor
// 100 × income_sim_scale (income_sim_scale = 0: Wanduhr). Einkommen und News folgen dieser
// Uhr — Fast ist nur schneller, das Kapital läuft nicht schneller leer.
const { db, getSettings, setSetting, q, addNews, fmtDe } = require('./db');
const bus = require('./bus');
const engine = require('./engine');
const etf = require('./etf');

const FAST_FACTOR = 100;          // Spieluhr-Faktor des Fast-Modus (wie bots.js)
const state = { last_income: 0, timers: [], simOrigin: null, simScale: 1, incomeScale: undefined, incomeFirstTick: false };
// last_income: Beginn der laufenden Zahlungsperiode in Wanduhr-ms. Er rückt je Zahlung um genau ein
// Intervall weiter (Raster), nie auf „jetzt“ — ein verspäteter Takt verschiebt die folgenden nicht.

// Faktor der Spieluhr gegenüber der Wanduhr (1 = Wanduhr).
function simScale(s = getSettings()) {
  const scale = Number(s.income_sim_scale);
  return s.bot_fast && scale > 0 ? FAST_FACTOR * scale : 1;
}

// Abstand zweier Einkommenszahlungen in Wanduhr-ms (null = Einkommen ist aus).
function incomeIntervalMs(s = getSettings()) {
  const sec = Number(s.income_sec);
  return sec > 0 ? sec * 1000 / simScale(s) : null;
}

// Zahlt der Bot-Runner das Einkommen der Bots gerade selbst? Er tut es, wenn dieser Job
// läuft, Fast an ist und die Spieluhr NICHT hier skaliert (income_sim_scale ≠ 1); sonst
// bekäme ein Bot das Einkommen doppelt. Dann zahlt dieser Job nur den Spielern das
// Einkommen; den Pool-Anteil der Bots zahlt er weiter.
function runnerPaysBots(s) {
  try { return state.timers.length > 0 && !!s.bot_fast && Number(s.income_sim_scale) !== 1 && require('./bots').status().running; }
  catch (e) { return false; }
}

// Einkommen eines Kontos (Bots: wie der Runner, bot_income_cent, falls gesetzt).
function incomeOf(s, isBot) {
  const own = Number(s.bot_income_cent);
  return isBot && own > 0 ? own : s.income_cent;
}

// Eine Zahlung = EINE Transaktion: Einkommen an alle aktiven Trader und der Gebühren-Pool
// (fee_recycle_pct % dessen, was chargeFee tatsächlich abgebucht hat) gleichmäßig an alle
// aktiven Konten, Spieler wie Bots. Der Pool steht in der Datenbank und wird hier bis auf
// den Rest geleert — ein Abbruch mitten in der Zahlung rollt alles zurück, ein Neustart
// zahlt nichts doppelt, und es fließt nur zurück, was vorher wirklich abgezogen wurde.
// nextAnchor: Beginn der nächsten Periode (tickIncome hält damit das Raster); ohne: ab jetzt.
// botIncome = false: die Bots bekommen nur ihren Pool-Anteil (nach einem Wechsel des Zeitmaßstabs
// hat der Runner sie womöglich gerade erst gezahlt).
function payIncome({ nextAnchor, botIncome = true } = {}) {
  const s = getSettings();
  const skipBots = !botIncome || runnerPaysBots(s);
  const active = db.prepare("SELECT id, is_bot FROM users WHERE role='user' AND frozen=0").all();
  if (!active.length) return;
  // Stand aus der Tabelle (siehe chargeFee: der Cache kann nach einem Rollback vorauseilen).
  const row = db.prepare("SELECT value FROM settings WHERE key = 'fee_pool_cent'").get();
  const pool = Math.max(0, Number(JSON.parse(row.value)) || 0);
  const pct = Math.max(0, Math.min(100, Number(s.fee_recycle_pct) || 0));
  const share = Math.floor(pool * pct / 100 / active.length);
  const pays = active.map((u) => ({ id: u.id, amount: (skipBots && u.is_bot ? 0 : incomeOf(s, u.is_bot)) + share }));
  db.transaction(() => {
    for (const p of pays) db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(p.amount, p.id);
    setSetting('fee_pool_cent', pool - share * active.length);
  })();
  for (const p of pays) bus.emit({ type: 'dirty', user_id: p.id, what: ['portfolio'] });
  state.last_income = nextAnchor ?? Date.now();
  // Die System-News zum Einkommen hat im Spielrhythmus keinen Platz (alle paar Sekunden); sie
  // erscheint nur, wenn die Zahlungen mindestens eine Minute Wanduhr auseinanderliegen.
  const interval = incomeIntervalMs(s);
  if (interval !== null && interval < 60 * 1000) return;
  const n = addNews('system', 'Wocheneinkommen ausgezahlt',
    `Die ${active.length} aktiven Trader haben ihr Einkommen erhalten${share > 0 ? ` — je Konto zusätzlich ${fmtDe(share)} Credits aus den zurückgeführten Handelsgebühren` : ''}. Viel Erfolg an der School-Street!`);
  bus.emit({ type: 'news', news: n });
}

// Spieluhr: Sim-Zeit zu einer Wanduhr, nullpunktfrei seit dem letzten Takt. Wechselt der
// Faktor zwischen zwei Takten, läuft die angebrochene Zeit noch mit dem alten und erst ab jetzt
// mit dem neuen — die Sim-Zeit bleibt stetig (kein Sprung, kein Nachholen).
function simNow(now = Date.now()) {
  const scale = simScale();
  const o = state.simOrigin;
  const sim = o ? o.sim + (now - o.wall) * state.simScale : now; // bis jetzt mit dem Faktor des letzten Takts
  state.simOrigin = { sim, wall: now };
  state.simScale = scale;
  return sim;
}

// News-Generator (newsgen.js): kein eigener Timer — hier wird einmal je Sekunde nachgeschaut.
// Fehlt das Modul, wird still übersprungen; jeder andere Fehler beim Laden wird gemeldet.
let newsgen;
function loadNewsgen() {
  if (newsgen !== undefined) return newsgen;
  try { newsgen = require('./newsgen'); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[Job news] Generator nicht ladbar:', e.message); newsgen = null; }
  return newsgen;
}
// Ein dauerhafter Fehler im Generator würde jede Sekunde ins Log gehen — er steht einmal da,
// bis ein Takt wieder gelingt.
let newsFailed = false;
// Marktbild für den News-Generator (Ereignis-News, E018): je Wertpapier der letzte Kurs und
// die Tagesänderung gegen den Bezugswert des Tickers, dazu Index und Breite der Aktien —
// beide über dieselbe Kursänderung gewichtet (Marktkapitalisierung bzw. Anteil der Steigerer).
// 0…1, keine Angabe möglich: 0. Die Wirkung legt allein newsgen.js fest.
function marketSnapshot(now = Date.now()) {
  let mcap = 0, mcapRef = 0, up = 0, stocks = 0;
  const securities = engine.tickerAll().map((r) => {
    const row = { id: r.id, ticker: r.ticker, type: r.type, last: r.last, ref: r.ref, chgPct: r.chg };
    if (r.type === 'stock' && r.ref > 0) {
      const shares = Number(engine.books.get(r.id)?.sec.total_shares) || 0;
      mcap += r.last * shares; mcapRef += r.ref * shares;
      stocks++; if (r.last > r.ref) up++;
    }
    return row;
  });
  const chg = mcapRef > 0 ? Math.round((mcap / mcapRef - 1) * 10000) / 100 : 0;
  return { now, sim: simNow(now), securities, indexChgPct: chg, breadth: stocks ? Math.round(up / stocks * 100) / 100 : 0 };
}

// Übergabe an den Generator: kennt er setMarket, bekommt er das Marktbild vor dem Takt. Ein
// altes Modul ohne setMarket läuft weiter nur mit der Uhr. Die Signatur legt newsgen.js.
function feedMarket(gen) {
  if (typeof gen.setMarket !== 'function') return;
  try {
    gen.setMarket(marketSnapshot());
    marketFailed = false;
  } catch (e) {
    if (!marketFailed) console.error('[Job news] Marktbild nicht übergeben (weitere bis zur Erholung still):', e.message);
    marketFailed = true;
  }
}
let marketFailed = false;

function tickNews() {
  const gen = loadNewsgen();
  if (!gen) return;
  feedMarket(gen);
  try {
    gen.once(simNow());
    newsFailed = false;
  } catch (e) {
    // Hier behandeln, NICHT weiterwerfen: safe() würde jeden Fehlschlag erneut melden, einmal je Sekunde.
    // So steht ein dauerhafter Fehler genau einmal im Log, bis ein Takt wieder gelingt.
    if (!newsFailed) console.error('[Job news] Fehler (weitere bis zur Erholung still):', e.message);
    newsFailed = true;
  }
}

// Einkommens-Takt (1000 ms). Zahlt höchstens eine Periode je Takt, und der Periodenbeginn rückt je
// Zahlung um ein Intervall weiter: kein Auseinanderlaufen unter Last und nichts geht verloren —
// eine verspätet gezahlte Periode wird nachgezahlt, die nächste schon im folgenden Takt.
function tickIncome() {
  const now = Date.now();
  // Die erste Periode beginnt mit dem ersten Takt nach dem Start, nicht schon beim Start selbst: das
  // Hochfahren (Bots anlegen, Bücher laden) blockiert die Uhr sonst und verkürzt die erste Periode.
  if (state.incomeFirstTick) { state.incomeFirstTick = false; state.last_income = now; }
  const interval = incomeIntervalMs();
  if (interval === null) { state.last_income = now; return; } // 0 = Einkommen ist aus; Einschalten beginnt eine neue Periode
  const scale = simScale();
  // Wechsel des Zeitmaßstabs (Fast an/aus, income_sim_scale): stünde sofort eine Zahlung fällig,
  // beginnt eine neue Periode auf der neuen Uhr. Die Spieler bekommen, was fällig ist (ihr Abstand
  // zur letzten Zahlung ist bekannt und nicht kürzer als das neue Intervall); die Bots bekommen ihr
  // Einkommen dann erst nach einer vollen Periode — der Runner hat sie womöglich gerade gezahlt.
  if (state.incomeScale !== undefined && scale !== state.incomeScale) {
    state.incomeScale = scale;
    if (now - state.last_income < interval) return;
    payIncome({ botIncome: false });
    return;
  }
  state.incomeScale = scale;
  if (now - state.last_income < interval) return;
  payIncome({ nextAnchor: state.last_income + interval });
}

function ghostCleanup() {
  const s = getSettings();
  const cutoff = Date.now() - s.inactivity_sec * 1000; // Einstellung steht in Sekunden
  // Bots (is_bot) sind ausgenommen: sie "loggen sich nie ein" und dürfen vom
  // Ghost-Cleanup nicht weggeräumt werden.
  const ghosts = db.prepare("SELECT * FROM users WHERE role='user' AND is_bot=0 AND last_active < ?").all(cutoff);
  if (!ghosts.length) return;
  const t = engine.treasury();
  if (!t) return;
  const clean = db.transaction(() => {
    for (const g of ghosts) {
      // offene Orders stornieren (Escrow fließt ins Konto), dann Vermögen an den Staat
      for (const o of db.prepare("SELECT * FROM orders WHERE user_id = ? AND status='open'").all(g.id)) {
        const remaining = o.amount - o.filled;
        if (o.side === 'buy') db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(o.price * remaining, g.id);
        else engine.addHoldingPublic(g.id, o.security_id, remaining);
        const book = engine.books.get(o.security_id);
        if (book) {
          book.bids = book.bids.filter(x => x.id !== o.id);
          book.asks = book.asks.filter(x => x.id !== o.id);
        }
      db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(o.id);
      }
      // frischen Kontostand holen: Order-Stornos haben Escrow zurückerstattet
      const freshCash = q.userById.get(g.id).cash;
      db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(freshCash, t.id);
      for (const h of db.prepare('SELECT * FROM holdings WHERE user_id = ?').all(g.id)) {
        engine.addHoldingPublic(t.id, h.security_id, h.amount);
        db.prepare('DELETE FROM holdings WHERE user_id = ? AND security_id = ?').run(g.id, h.security_id);
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(g.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(g.id);
    }
  });
  clean();
  const n = addNews('system', 'Ghost-Accounts entfernt',
    `${ghosts.length} inaktive Konten wurden gelöscht. Das Vermögen fällt an die Investment AG (den Staat) und fließt als Streubesitz zurück in den Markt: ${ghosts.map(g => g.username).join(', ')}`);
  bus.emit({ type: 'news', news: n });
}

function priceSampler() {
  const now = Date.now();
  for (const book of engine.books.values()) q.phIns.run(book.sec.id, now, book.last, 0);
}

// Orders-Aufräumjob: Der MM-Refresh erzeugt ~4.000 Order-Zeilen pro Stunde
// (Quote legen -> cancel -> neu legen). Alte MM-Orders haben keinerlei Wert,
// Spieler-Orders bleiben 14 Tage als Historie erhalten. Hält die Tabelle klein,
// damit Serverstart (loadEngine) und Admin-Ansichten schnell bleiben.
function pruneOrders() {
  const day = 86400000;
  const now = Date.now();
  const r1 = db.prepare("DELETE FROM orders WHERE is_mm = 1 AND created_at < ?").run(now - day);
  const r2 = db.prepare("DELETE FROM orders WHERE is_mm = 0 AND status = 'canceled' AND created_at < ?").run(now - 14 * day);
  // Kursverlauf und Sitzungen älter als 30 Tage weg — der Sampler schreibt ~2.900
  // Zeilen je Wert und Tag, sonst wächst die Datei unbegrenzt. In Happen, damit
  // ein großer Altbestand die Börse beim ersten Aufräumen nicht blockiert.
  const r3 = db.prepare('DELETE FROM price_history WHERE rowid IN (SELECT rowid FROM price_history WHERE ts < ? LIMIT 20000)').run(now - 30 * day);
  const r4 = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  if (r1.changes + r2.changes + r3.changes + r4.changes > 0) console.log(`[Job prune-orders] ${r1.changes} MM- + ${r2.changes} Spieler-Orders, ${r3.changes} Kurspunkte, ${r4.changes} Sitzungen entfernt`);
}

// Wann kommt das nächste Einkommen? (null = Einkommen ist aus)
function incomeNextAt() {
  const interval = incomeIntervalMs();
  return interval !== null ? state.last_income + interval : null;
}

// Ein fehlgeschlagener Job darf niemals die ganze Börse mitreißen
function safe(name, fn) {
  return () => {
    try { fn(); } catch (e) { console.error(`[Job ${name}] Fehler:`, e.message); }
  };
}

function startJobs() {
  state.last_income = Date.now();
  state.timers.forEach(clearInterval);
  state.simOrigin = null; // Spieluhr beginnt bei null
  state.incomeScale = undefined;
  state.incomeFirstTick = true;
  state.timers = [
    setInterval(safe('income', tickIncome), 1000),
    setInterval(safe('news', tickNews), 1000),
    // MM-Refresh: schneller Loop, aber jedes Buch hat seinen eigenen gestaffelten
    // Takt (mm_refresh_sec ± 30%) — die Bücher wirken lebendig, nicht synchron.
    setInterval(safe('mm-refresh', () => engine.mmRefreshAll()), 3000),
    setInterval(safe('ghost-cleanup', ghostCleanup), 10 * 60 * 1000),
    setInterval(safe('price-sampler', priceSampler), 30 * 1000),
    setInterval(safe('prune-orders', pruneOrders), 60 * 60 * 1000),
    setInterval(safe('etf-auto', () => {
      const r = etf.autoArbitrage();
      if (r.length) console.log(`[Job etf-auto] ${r.map((a) => `${a.ticker} ${a.action} x${a.units} (${a.premium_pct}%)`).join(', ')}`);
    }), 5000)
  ];
  engine.mmRefreshAll();
  safe('prune-orders', pruneOrders)();
}

// Timer anhalten (Neustart der Jobs, Tests); offene Beträge gehen nicht verloren — der Pool steht in der DB.
function stopJobs() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

module.exports = { startJobs, stopJobs, payIncome, ghostCleanup, incomeNextAt, incomeIntervalMs, simScale, simNow, marketSnapshot, tickIncome, tickNews, state };
