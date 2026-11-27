// ============================================================================
// Schul-ETF: fixer Korb, Creation Units mit Multiplikator, NAV in Echtzeit.
// Die Investment AG ist Authorized Participant (AP): Creation/Redemption
// MANUELL über die Admin-Schnittstelle (inkl. Vorschau) oder AUTOMATISCH über
// autoArbitrage() (Setting etf_auto, getaktet aus jobs.js). Die Automatik
// hält den Arbeitsbestand der Staatskasse — den Kurs am NAV hält der Market Maker.
// ============================================================================
const { db, getSettings, q, addNews, fmtDe } = require('./db');
const bus = require('./bus');
const engine = require('./engine');

function basketOf(etfId) {
  return db.prepare(`SELECT eb.qty, s.id AS stock_id, s.ticker, s.name FROM etf_baskets eb
    JOIN securities s ON s.id = eb.stock_id WHERE eb.etf_id = ?`).all(etfId);
}

// MM-Quotes der Korbaktien sofort neu legen (mmRecenter überspringt Werte ohne
// mm_enabled): Die Creation hebt sie auf, damit der escrowte Bestand in den Korb
// wandert; die Redemption legt Aktien zurück ins Depot, die angeboten werden
// sollen. Ohne diesen Schritt bliebe der Korb bis zum nächsten Refresh (3 s)
// ohne Angebot — im Fehlerfall der Creation ganz ohne MM-Quotes.
function requoteBasket(basket) {
  for (const b of basket) {
    const book = engine.books.get(b.stock_id);
    if (book) engine.mmRecenter(book);
  }
}

// NAV: Summe Korbwerte / ETF-Anteile pro Creation Unit
function nav(etfId) {
  const etf = q.secById.get(etfId);
  const basket = basketOf(etfId);
  let basketValue = 0;
  const items = basket.map(b => {
    const book = engine.books.get(b.stock_id);
    const price = book ? book.last : 0;
    basketValue += b.qty * price;
    return { ...b, price, value: b.qty * price };
  });
  const spu = etf.shares_per_unit;
  const book = engine.books.get(etfId);
  const last = book ? book.last : 0;
  const navPer = spu ? basketValue / spu : 0;
  return {
    items, basket_value: basketValue, shares_per_unit: spu,
    nav_per_share: navPer, last,
    premium_pct: navPer ? (last / navPer - 1) * 100 : 0
  };
}

// Erwartete Ablehnungen beim Anlegen: tragen den HTTP-Status und einen Satz für den Admin.
// Alles andere ist ein Fehler im Server (kein EtfError) und wird nicht als Validierung ausgegeben.
class EtfError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Beschreibung ohne Angabe im Admin-Formular (Vertrag V6)
const DEFAULT_DESCRIPTION = 'Schul-ETF (Indexfonds)';
// Gleiche Grenzen wie das Formular (DESIGN §12.2): Aktien je Anteil, Anteile bei Start, Stück je Aktie
const LIMITS = { shares_per_unit: 100, initial_units: 100000, qty: 100000 };

// Zahl aus dem Antrag: ganze Zahl zwischen min und max. Brüche, Infinity, 1e21 und alles,
// was keine Zahl ist, werden abgelehnt statt still gerundet.
function wholeNumber(value, min, max, label) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw new EtfError(`${label} muss eine ganze Zahl ab ${min} sein.`);
  if (n > max) throw new EtfError(`${label} höchstens ${max}.`);
  return n;
}

function createEtf({ ticker, name, basket, shares_per_unit, initial_units, description }) {
  // basket: [{stock_id, qty}]. Die Staatskasse muss die Aktien für initial_units im Depot halten
  // (unquotiert, nicht in MM-Verkaufsorders); es wird beim Anlegen nichts gekauft (E011).
  const t = engine.treasury();
  const spu = wholeNumber(shares_per_unit, 1, LIMITS.shares_per_unit, 'Aktien je Anteil');
  const units = wholeNumber(initial_units, 1, LIMITS.initial_units, 'Anteile bei Start');
  for (const b of basket) wholeNumber(b.qty, 1, LIMITS.qty, 'Stück je Anteil');
  const short = basket.filter((b) => engine.holdingOf(t.id, b.stock_id) < b.qty * units);
  if (short.length) {
    // je Korbposition ein Satz mit Kürzel und Fehlmenge, in der Reihenfolge des Korbs
    throw new EtfError(short
      .map((b) => `Die Staatskasse hat zu wenig ${q.secById.get(b.stock_id).ticker}: es fehlen ${b.qty * units - engine.holdingOf(t.id, b.stock_id)} Stück.`)
      .join(' '));
  }
  const desc = String(description ?? '').trim() || DEFAULT_DESCRIPTION;
  // Alles oder nichts: Scheitert ein Schritt, bleibt kein halber ETF (Zeile ohne Korb, Depot
  // abgebucht) zurück — und das Kürzel wird nicht für einen zweiten Versuch blockiert.
  const create = db.transaction(() => {
    const sec = engine.listSecurity({ type: 'etf', ticker, name, description: desc, ipo_price: 0, total_shares: 0, shares_per_unit: spu });
    for (const b of basket) {
      db.prepare('INSERT INTO etf_baskets(etf_id, stock_id, qty) VALUES(?,?,?)').run(sec.id, b.stock_id, b.qty);
      engine.addHoldingPublic(t.id, b.stock_id, -b.qty * units);
    }
    const n = nav(sec.id);
    const shares = units * spu;
    // Der Anfangsbestand der Staatskasse ist der Arbeitsbestand W0 der AP-Automatik.
    // Den Kurs setzt hier niemand: mmRecenter rechnet ihn unten aus dem Korb (NAV).
    db.prepare('UPDATE securities SET total_shares = ?, ipo_price = ?, ap_inventory_target = ? WHERE id = ?').run(shares, Math.round(n.nav_per_share), shares, sec.id);
    engine.books.get(sec.id).sec.total_shares = shares;
    engine.addHoldingPublic(t.id, sec.id, shares, Math.round(n.nav_per_share));
    // Scheitert das Quotieren, bricht strict die Transaktion ab — kein ETF ohne Kurs.
    engine.mmRecenter(engine.books.get(sec.id), { strict: true });
    // Die Start-News gehört zur Anlage: steht sie nicht, existiert der ETF auch nicht.
    addNews('etf', `ETF-Start: ${name} (${sec.ticker}) notiert zum NAV`,
      `Der ${name} bildet einen fixen Korb ab. NAV je Anteil: ${fmtDe(n.nav_per_share)} Credits. ${shares} Anteile im Umlauf.`, sec.id);
    return { sec };
  });
  let created;
  try {
    created = create();
  } catch (e) {
    // Die Transaktion hat die Zeile zurückgerollt; das Orderbuch im Speicher muss mit verschwinden.
    for (const [id, book] of engine.books) if (book.sec.type === 'etf' && !q.secById.get(id)) engine.books.delete(id);
    throw e;
  }
  // Erst nach dem Commit: der Push meldet die Zeile, erlegt sie aber nicht mehr.
  try {
    const news = db.prepare('SELECT * FROM news WHERE security_id = ? ORDER BY id DESC LIMIT 1').get(created.sec.id);
    if (news) bus.emit({ type: 'news', news });
  } catch (e) {
    console.error(`[ETF anlegen] Start-News für ${created.sec.ticker} nicht zugestellt:`, e.message);
  }
  return created.sec;
}

// Creation: Korb-Aktien (aus Treasury-Depot) vernichten -> neue ETF-Anteile
function createUnits(etfId, units) {
  const etf = q.secById.get(etfId);
  if (!etf || etf.type !== 'etf') throw new Error('ETF nicht gefunden');
  units = Math.floor(Number(units));
  if (!Number.isInteger(units) || units < 1) throw new Error('Ungültige Anzahl Creation Units');
  const t = engine.treasury();
  try {
    // MM-Quoten der Korb-Aktien aufheben, damit escrowte Treasury-Bestände für die Creation nutzbar sind
    for (const b of basketOf(etfId)) engine.mmCancelQuotes(engine.books.get(b.stock_id));
    for (const b of basketOf(etfId)) {
      if (engine.holdingOf(t.id, b.stock_id) < b.qty * units)
        throw new Error(`Treasury besitzt nicht genug ${b.ticker}: benötigt ${b.qty * units}, vorhanden ${engine.holdingOf(t.id, b.stock_id)} (Korb vorher übers AP-Terminal kaufen!)`);
    }
    const n = nav(etfId);
    for (const b of basketOf(etfId)) engine.addHoldingPublic(t.id, b.stock_id, -b.qty * units);
    const shares = units * etf.shares_per_unit;
    db.prepare('UPDATE securities SET total_shares = total_shares + ? WHERE id = ?').run(shares, etfId);
    engine.books.get(etfId).sec.total_shares += shares;
    engine.addHoldingPublic(t.id, etfId, shares, Math.round(n.nav_per_share));
    engine.mmRecenter(engine.books.get(etfId), { strict: true });
    bus.emit({ type: 'ticker', ticker: engine.tickerRow(etfId) });
    return { units, shares_created: shares, nav_per_share: n.nav_per_share };
  } finally {
    // Erfolg oder Fehler: die hier aufgehobenen MM-Quotes der Korb-Aktien selbst wiederherstellen
    requoteBasket(basketOf(etfId));
  }
}

// Redemption: ETF-Anteile vernichten -> Korb-Aktien ins Treasury-Depot
function redeemUnits(etfId, units) {
  const etf = q.secById.get(etfId);
  if (!etf || etf.type !== 'etf') throw new Error('ETF nicht gefunden');
  units = Math.floor(Number(units));
  if (!Number.isInteger(units) || units < 1) throw new Error('Ungültige Anzahl Creation Units');
  const t = engine.treasury();
  const shares = units * etf.shares_per_unit;
  try {
    // MM-Quotes des ETF aufheben (Escrow zurückholen), damit der Bestand einlösbar ist
    engine.mmCancelQuotes(engine.books.get(etfId));
    if (engine.holdingOf(t.id, etfId) < shares) throw new Error(`Treasury besitzt nur ${engine.holdingOf(t.id, etfId)} ETF-Anteile`);
    const n = nav(etfId);
    engine.addHoldingPublic(t.id, etfId, -shares);
    for (const b of basketOf(etfId)) engine.addHoldingPublic(t.id, b.stock_id, b.qty * units);
    db.prepare('UPDATE securities SET total_shares = total_shares - ? WHERE id = ?').run(shares, etfId);
    engine.books.get(etfId).sec.total_shares -= shares;
    bus.emit({ type: 'ticker', ticker: engine.tickerRow(etfId) });
    return { units, shares_redeemed: shares, nav_per_share: n.nav_per_share };
  } finally {
    // Erfolg oder Fehler: die hier aufgehobenen MM-Quotes des ETFs selbst wiederherstellen
    engine.mmRecenter(engine.books.get(etfId), { strict: true });
    requoteBasket(basketOf(etfId)); // nach der Einlösung: zurückgekommene Aktien liegen im Depot und sollen angeboten werden
  }
}

// AP-Vorschau: Was passiert bei Creation/Redemption? (Lehrstück Arbitrage)
function preview(etfId, units) {
  const etf = q.secById.get(etfId);
  units = Math.max(1, Math.floor(Number(units) || 1));
  const t = engine.treasury();
  const n = nav(etfId);
  const etfShares = units * etf.shares_per_unit;
  const buyBasket = n.items.map(b => {
    const need = b.qty * units;
    const have = engine.holdingOf(t.id, b.stock_id);
    const { cost, shortfall } = engine.costToBuy(b.stock_id, Math.max(0, need - have));
    return { ticker: b.ticker, need, have, shortfall, buy_cost: shortfall > 0 ? cost : 0 };
  });
  const etfSell = engine.proceedsToSell(etfId, etfShares);   // ETF verkaufen: Erlös
  const etfBuy = engine.costToBuy(etfId, etfShares);         // ETF zurückkaufen: Kosten
  const sellBasket = n.items.map(b => {
    const { proceeds, shortfall } = engine.proceedsToSell(b.stock_id, b.qty * units);
    return { ticker: b.ticker, proceeds, shortfall };
  });
  return {
    units, etf_shares: etfShares,
    nav_per_share: n.nav_per_share, last: n.last, premium_pct: n.premium_pct,
    creation: {
      buy_basket_cost: buyBasket.reduce((a, b) => a + b.buy_cost, 0),
      basket_shortfalls: buyBasket.filter(b => b.shortfall > 0),
      etf_sell_proceeds: etfSell.proceeds,
      etf_sell_shortfall: etfSell.shortfall,
      est_profit: etfSell.proceeds - buyBasket.reduce((a, b) => a + b.buy_cost, 0)
    },
    redemption: {
      etf_buy_cost: etfBuy.cost,
      etf_buy_shortfall: etfBuy.shortfall,
      basket_sell_proceeds: sellBasket.reduce((a, b) => a + b.proceeds, 0),
      basket_sell_shortfall: sellBasket.filter(b => b.shortfall > 0),
      est_profit: sellBasket.reduce((a, b) => a + b.proceeds, 0) - etfBuy.cost
    }
  };
}

// Dividenden-Routing: Korb-Aktie schüttet aus => anteilig an ETF-Halter
function routeDividend(stockId, perShare) {
  const etfs = db.prepare('SELECT etf_id, qty FROM etf_baskets WHERE stock_id = ?').all(stockId);
  const routed = [];
  for (const e of etfs) {
    const etf = q.secById.get(e.etf_id);
    const perEtfShare = Math.floor((e.qty * perShare) / etf.shares_per_unit); // Rest-Cents verfallen
    if (perEtfShare <= 0) continue;
    const holders = db.prepare('SELECT user_id, amount FROM holdings WHERE security_id = ?').all(e.etf_id);
    let total = 0;
    for (const h of holders) {
      const pay = perEtfShare * h.amount;
      db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(pay, h.user_id);
      total += pay;
      bus.emit({ type: 'dirty', user_id: h.user_id, what: ['portfolio'] });
    }
    routed.push({ etf: etf.ticker, per_etf_share: perEtfShare, total });
  }
  return routed;
}

// ---------------------------------------------------------------------------
// AP-AUTOMATIK — Job aus jobs.js (alle 5 s), nur mit Setting etf_auto=1.
// Der Kurs eines ETF ist sein NAV (die Engine rechnet ihn) — die Automatik
// treibt keinen Kurs. Sie hält den Arbeitsbestand der Staatskasse, damit der
// Market Maker Anteile jederzeit verkaufen und zurückkaufen kann:
//
//   W0  Anfangsbestand bei Schöpfung (securities.ap_inventory_target); fehlt er
//       oder ist er <= 0, gilt max(1 Unit, etf_ap_inventory_pct % des Umlaufs)
//   W   = max(W0, etf_ap_inventory_pct % des Umlaufs), mindestens 1 Unit
//   T   = Depotbestand der Staatskasse + offene MM-Verkaufsorders (Ask-Escrow)
//
//   T < 0,5·W                       -> Creation bis W
//   T > 1,25·W und T − W ≥ 1 Unit   -> Redemption bis W
//
// Dazwischen passiert nichts. Beide Richtungen bringen T in ganzen Units auf W
// (T landet in [W, W + 1 Unit)): Es wird nie unter W eingelöst — der Umlauf
// bleibt mindestens W0 — und der Rest unter einer Unit löst keine Gegenaktion
// aus, keine Spirale. Mindestabstand etf_auto_interval_sec je ETF für beide
// Richtungen gemeinsam, gerechnet ab der letzten erfolgreichen Aktion. Auch
// manuelle Creation/Redemption über die AP-Schnittstelle holt die Automatik
// nach spätestens diesem Abstand in den Bereich des Arbeitsbestands zurück.
// Die Creation prüft zuerst den ganzen Korb, ohne eine Quote anzufassen oder
// etwas zu kaufen; reicht er nicht, passiert nichts und der nächste Takt
// probiert erneut. Die MM-Quotes der Korbaktien stellt createUnits/redeemUnits
// selbst wieder her — für den manuellen und den automatischen Weg.
// ---------------------------------------------------------------------------
const autoLastAt = new Map();   // etfId -> ts der letzten erfolgreichen Aktion (Creation/Redemption)
const autoNewsAt = new Map();   // etfId -> ts der letzten News (Feed-Spam vermeiden)
const autoErrAt = new Map();    // etfId -> ts der letzten Fehlerzeile (höchstens 1/Min je ETF)

function autoNews(etfSec, title, body) {
  if (Date.now() - (autoNewsAt.get(etfSec.id) || 0) < 60 * 1000) return; // max. 1 News/Min je ETF
  autoNewsAt.set(etfSec.id, Date.now());
  const nw = addNews('etf', title, body, etfSec.id);
  bus.emit({ type: 'news', news: nw });
}

function autoArbitrage() {
  const s = getSettings();
  if (!s.etf_auto) return [];
  const t = engine.treasury();
  if (!t) return [];
  const now = Date.now();
  const maxUnits = Math.max(1, Math.floor(s.etf_auto_max_units));
  // Offene MM-Verkaufsorders der Staatskasse = ihr Bestand im Ask-Escrow
  const mmAskEscrow = db.prepare("SELECT SUM(amount - filled) q FROM orders WHERE security_id=? AND user_id=? AND is_mm=1 AND side='sell' AND status='open'");
  const fmtCr = (c) => (c / 100).toFixed(2);
  const actions = [];

  for (const etfSec of db.prepare("SELECT * FROM securities WHERE type='etf' AND status='active'").all()) {
    const spu = etfSec.shares_per_unit;
    const byFloat = Math.round((s.etf_ap_inventory_pct / 100) * etfSec.total_shares);
    // Anfangsbestand fehlt (alte DB) oder ist unbrauchbar (<= 0): einmalig festlegen und
    // speichern. Er ist der feste Anker von W — ohne ihn schrumpfte W mit dem Umlauf, und
    // ein vollständig bei der Staatskasse liegender ETF würde bis zum Umlauf 0 eingelöst.
    if (!(etfSec.ap_inventory_target > 0)) {
      etfSec.ap_inventory_target = Math.max(spu, byFloat);
      db.prepare('UPDATE securities SET ap_inventory_target = ? WHERE id = ?').run(etfSec.ap_inventory_target, etfSec.id);
    }
    const book = engine.books.get(etfSec.id);
    if (!book) continue;
    const n = nav(etfSec.id);
    if (!n.nav_per_share) continue;
    if (now - (autoLastAt.get(etfSec.id) || 0) < s.etf_auto_interval_sec * 1000) continue;

    const W = Math.max(etfSec.ap_inventory_target, spu, byFloat);
    const T = engine.holdingOf(t.id, etfSec.id) + (mmAskEscrow.get(etfSec.id, t.id).q || 0);
    let action = null;
    if (T < 0.5 * W) action = 'creation';
    else if (T > 1.25 * W && T - W >= spu) action = 'redemption';
    if (!action) continue;

    const units = action === 'creation'
      ? Math.min(maxUnits, Math.max(1, Math.ceil((W - T) / spu)))
      : Math.min(maxUnits, Math.floor((T - W) / spu));
    if (action === 'creation') {
      // Erst prüfen, dann kaufen — sonst bliebe ein angefangener Teilkorb liegen. Bis zum
      // createUnits unten fasst die Automatik keine Quote an; ein Abbruch setzt keinen
      // Mindestabstand, damit der nächste Takt erneut probiert.
      const basket = basketOf(etfSec.id);
      const potential = (b) => engine.holdingOf(t.id, b.stock_id) + (mmAskEscrow.get(b.stock_id, t.id).q || 0);
      const short = (b) => b.qty * units - potential(b); // Fehlmenge: Bedarf − Depot − eigener Ask-Escrow
      // Fremdangebot: offene Verkaufsorders anderer Konten im Band (ohne eigene Orders)
      const offers = (b) => { const stockBook = engine.books.get(b.stock_id); return stockBook ? engine.sideDepth(stockBook, 'sell', t.id) : 0; };
      // Reicht Potenzial + Fremdangebot für eine Aktie nicht: Abbruch ohne Aktion, nichts kaufen
      if (basket.some((b) => short(b) > offers(b))) continue;
      // Best-Effort: Differenz am Markt von SPIELERN kaufen (Market-Order, nicht-MM).
      for (const b of basket) {
        if (short(b) <= 0) continue;
        try { engine.placeOrder(q.userById.get(t.id), { security_id: b.stock_id, side: 'buy', type: 'market', amount: short(b) }, { mm: false }); }
        // Absichtlich still: Eine Ablehnung (z. B. „Nicht genug Liquidität") ist hier ein
        // normaler Ausgang, kein Fehler. Danach greift die Potenzial-Prüfung — reicht der
        // Korb nicht, passiert nichts und der nächste Takt probiert erneut. Fehler dagegen,
        // die beim createUnits unten auftreten, werden protokolliert.
        catch (e) { /* Best-Effort */ }
      }
      // Potenzial neu lesen: Reicht es irgendwo nicht, Abbruch ohne Aktion
      if (basket.some((b) => short(b) > 0)) continue;
    }
    try {
      if (action === 'creation') {
        const r = createUnits(etfSec.id, units); // hebt die MM-Quotes der Korbaktien auf, quotiert ETF und Korb danach neu
        autoNews(etfSec, `Auto-Arbitrage: ${units} Creation Units ${etfSec.ticker}`,
          `Bestand der Investment AG am ${etfSec.name}: ${T} Anteile, Arbeitsbestand ${W}. Der AP hat ${r.shares_created} neue Anteile geschaffen (${units} Creation Units) und bietet sie zum NAV von ${fmtCr(n.nav_per_share)} Credits an.`);
      } else {
        const r = redeemUnits(etfSec.id, units); // hebt die MM-Quotes des ETF auf, quotiert ETF und Korb neu
        autoNews(etfSec, `Auto-Arbitrage: ${units} Units ${etfSec.ticker} eingelöst`,
          `Bestand der Investment AG am ${etfSec.name}: ${T} Anteile, Arbeitsbestand ${W}. Der AP hat ${r.shares_redeemed} Anteile eingelöst (${units} Creation Units) — die Korb-Aktien sind zurück im Markt. NAV: ${fmtCr(n.nav_per_share)} Credits.`);
      }
      actions.push({ ticker: etfSec.ticker, action, units, premium_pct: Math.round((n.last / n.nav_per_share - 1) * 1000) / 10 });
      autoLastAt.set(etfSec.id, Date.now());
      autoErrAt.delete(etfSec.id); // Fehler war verschwunden: die nächste Störung darf wieder melden
    } catch (e) {
      // Die Quotes stellt redeemUnits/createUnits selbst wieder her
      // Gedrosselt wie autoNews (1 Zeile/Min je ETF): eine dauerhaft scheiternde Aktion
      // darf den Serverlog nicht alle 5 s zuschreiben.
      const at = Date.now();
      if (at - (autoErrAt.get(etfSec.id) || 0) >= 60 * 1000) {
        autoErrAt.set(etfSec.id, at);
        console.error(`[ETF-Auto] ${action} ${etfSec.ticker} x${units} fehlgeschlagen:`, e.message);
      }
    }
  }
  return actions;
}

module.exports = { EtfError, LIMITS, wholeNumber, nav, createEtf, createUnits, redeemUnits, preview, routeDividend, autoArbitrage, basketOf };
