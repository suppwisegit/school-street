// ============================================================================
// Schul-ETF: fixer Korb, Creation Units mit Multiplikator, NAV in Echtzeit.
// Die Investment AG ist Authorized Participant (AP): Arbitrage MANUELL über
// das Admin-Panel (Creation/Redemption inkl. Vorschau) oder AUTOMATISCH über
// autoArbitrage() (Setting etf_auto, getaktet aus jobs.js).
// ============================================================================
const { db, getSettings, setSetting, q, addNews } = require('./db');
const bus = require('./bus');
const engine = require('./engine');

function basketOf(etfId) {
  return db.prepare(`SELECT eb.qty, s.id AS stock_id, s.ticker, s.name FROM etf_baskets eb
    JOIN securities s ON s.id = eb.stock_id WHERE eb.etf_id = ?`).all(etfId);
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

function createEtf({ ticker, name, basket, shares_per_unit, initial_units }) {
  // basket: [{stock_id, qty}]. Der Treasury muss die Aktien für initial_units halten
  // (AG kauft sie vorher über das AP-Handelsterminal am Markt).
  const t = engine.treasury();
  for (const b of basket) {
    if (engine.holdingOf(t.id, b.stock_id) < b.qty * initial_units)
      throw new Error(`Treasury besitzt nicht genug ${q.secById.get(b.stock_id).ticker} für ${initial_units} Creation Units`);
  }
  const sec = engine.listSecurity({ type: 'etf', ticker, name, description: 'Schul-ETF (Indexfonds)', ipo_price: 0, total_shares: 0, shares_per_unit });
  for (const b of basket) {
    db.prepare('INSERT INTO etf_baskets(etf_id, stock_id, qty) VALUES(?,?,?)').run(sec.id, b.stock_id, b.qty);
    engine.addHoldingPublic(t.id, b.stock_id, -b.qty * initial_units);
  }
  const n = nav(sec.id);
  const shares = initial_units * shares_per_unit;
  db.prepare('UPDATE securities SET total_shares = ?, ipo_price = ? WHERE id = ?').run(shares, Math.round(n.nav_per_share), sec.id);
  engine.books.get(sec.id).sec.total_shares = shares;
  engine.books.get(sec.id).last = Math.round(n.nav_per_share) || engine.books.get(sec.id).last;
  engine.addHoldingPublic(t.id, sec.id, shares, Math.round(n.nav_per_share));
  engine.mmRecenter(engine.books.get(sec.id));
  const news = addNews('etf', `ETF-Start: ${name} (${sec.ticker}) notiert zum NAV`, `Der ${name} bildet einen fixen Korb ab. NAV je Anteil: ${(n.nav_per_share / 100).toFixed(2)} Credits. ${shares} Anteile im Umlauf.`, sec.id);
  bus.emit({ type: 'news', news });
  return sec;
}

// Creation: Korb-Aktien (aus Treasury-Depot) vernichten -> neue ETF-Anteile
function createUnits(etfId, units) {
  const etf = q.secById.get(etfId);
  if (!etf || etf.type !== 'etf') throw new Error('ETF nicht gefunden');
  units = Math.floor(Number(units));
  if (!Number.isInteger(units) || units < 1) throw new Error('Ungültige Anzahl Creation Units');
  const t = engine.treasury();
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
  engine.mmRecenter(engine.books.get(etfId));
  bus.emit({ type: 'ticker', ticker: engine.tickerRow(etfId) });
  return { units, shares_created: shares, nav_per_share: n.nav_per_share };
}

// Redemption: ETF-Anteile vernichten -> Korb-Aktien ins Treasury-Depot
function redeemUnits(etfId, units) {
  const etf = q.secById.get(etfId);
  if (!etf || etf.type !== 'etf') throw new Error('ETF nicht gefunden');
  units = Math.floor(Number(units));
  if (!Number.isInteger(units) || units < 1) throw new Error('Ungültige Anzahl Creation Units');
  const t = engine.treasury();
  const shares = units * etf.shares_per_unit;
  // MM-Quotes des ETF aufheben (Escrow zurückholen), damit der Bestand einlösbar ist
  engine.mmCancelQuotes(engine.books.get(etfId));
  if (engine.holdingOf(t.id, etfId) < shares) throw new Error(`Treasury besitzt nur ${engine.holdingOf(t.id, etfId)} ETF-Anteile`);
  const n = nav(etfId);
  engine.addHoldingPublic(t.id, etfId, -shares);
  for (const b of basketOf(etfId)) engine.addHoldingPublic(t.id, b.stock_id, b.qty * units);
  db.prepare('UPDATE securities SET total_shares = total_shares - ? WHERE id = ?').run(shares, etfId);
  engine.books.get(etfId).sec.total_shares -= shares;
  engine.mmRecenter(engine.books.get(etfId));
  bus.emit({ type: 'ticker', ticker: engine.tickerRow(etfId) });
  return { units, shares_redeemed: shares, nav_per_share: n.nav_per_share };
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
// AUTO-ARBITRAGE (AP-Automatik) — Job aus jobs.js, nur wenn Setting etf_auto=1.
// Zwei Instrumente, genau wie echte Authorized Participanten:
//
//   1) AP-NAV-PEGGING (schnell, ab halber Schwelle): Der Treasury platziert
//      eine Quote-Leiter um den NAV — bei Discount KAUFORDERS unterhalb NAV
//      (hebt den Kurs, sobald Spieler dagegen verkaufen; kreuzt der Preis
//      Spieler-Asks, werden diese sofort cheap mitgenommen), bei Premium
//      VERKAUFORDERS oberhalb NAV (analog). So klebt der Kurs am NAV.
//   2) CREATION/REDEMPTION (Hintergrund, ab voller Schwelle): passt den
//      Treasury-Bestand an die Peg-Quotes an — Units skalieren dynamisch mit
//      der Abweichung (bis etf_auto_max_units). Mindest-Intervall je ETF.
// Guards: Preview-Rechnung muss positiv sein, Fehler überspringen still.
// ---------------------------------------------------------------------------
const autoLastAt = new Map();   // etfId -> ts der letzten Creation/Redemption
const autoNewsAt = new Map();   // etfId -> ts der letzten News (Feed-Spam vermeiden)

function autoNews(etfSec, title, body) {
  if (Date.now() - (autoNewsAt.get(etfSec.id) || 0) < 60 * 1000) return; // max. 1 News/Min je ETF
  autoNewsAt.set(etfSec.id, Date.now());
  const nw = addNews('etf', title, body, etfSec.id);
  bus.emit({ type: 'news', news: nw });
}

// Quote-Leiter um den NAV (AP-Orders, KEINE MM-Orders — zahlen Gebühr, sind
// aber bewusst kein Market-Making, sondern Arbitrage-Inventar).
function pegToNav(etfSec, n, trigger) {
  const s = getSettings();
  const t = engine.treasury();
  const book = engine.books.get(etfSec.id);
  if (!t || !book) return;
  const premium = n.premium_pct / 100;
  if (Math.abs(premium) < trigger) return; // nah genug am NAV — der MM reicht
  const tk = engine.tick(etfSec);
  const navP = n.nav_per_share;
  const perLevel = Math.max(1, Math.floor(s.etf_auto_units)) * etfSec.shares_per_unit;
  // Alte AP-Orders (is_mm=0) des Treasury auf diesem ETF erneuern
  for (const o of db.prepare("SELECT id FROM orders WHERE security_id=? AND user_id=? AND is_mm=0 AND status='open'").all(etfSec.id, t.id)) {
    try { engine.cancelOrder(q.userById.get(t.id), o.id); } catch (e) { /* schon weg */ }
  }
  const at = (f) => Math.max(tk, Math.round((navP * f) / tk) * tk); // tick-gerundet
  if (premium < 0) {
    // Discount: Kaufleiter UNTER NAV — hebt den Kurs (Spieler verkaufen rein)
    for (const f of [0.985, 0.96, 0.93]) {
      const u = q.userById.get(t.id);
      const price = at(f);
      if (u.cash < price * perLevel + s.fee_cent) break;
      try { engine.placeOrder(u, { security_id: etfSec.id, side: 'buy', type: 'limit', price, amount: perLevel }, { mm: false }); }
      catch (e) { break; }
    }
  } else {
    // Premium: Verkaufsleiter ÜBER NAV — drückt den Kurs (Spieler kaufen raus)
    let inv = engine.holdingOf(t.id, etfSec.id);
    for (const f of [1.015, 1.04, 1.07]) {
      if (inv < perLevel) break;
      try { engine.placeOrder(q.userById.get(t.id), { security_id: etfSec.id, side: 'sell', type: 'limit', price: at(f), amount: perLevel }, { mm: false }); }
      catch (e) { break; }
      inv -= perLevel;
    }
  }
}

function autoArbitrage() {
  const s = getSettings();
  if (!s.etf_auto) return [];
  const t = engine.treasury();
  if (!t) return [];
  const now = Date.now();
  const th = s.etf_auto_threshold_pct / 100;
  const baseUnits = Math.max(1, Math.floor(s.etf_auto_units));
  const maxUnits = Math.max(baseUnits, Math.floor(s.etf_auto_max_units || 25));
  const actions = [];
  const fmtCr = (c) => (c / 100).toFixed(2);

  for (const etfSec of db.prepare("SELECT * FROM securities WHERE type='etf' AND status='active'").all()) {
    const book = engine.books.get(etfSec.id);
    if (!book || !book.last) continue;
    const n = nav(etfSec.id);
    if (!n.nav_per_share) continue;
    const premium = n.last / n.nav_per_share - 1;

    // (1) Schnelles Instrument: Quote-Leiter am NAV (ab halber Schwelle aktiv)
    try { pegToNav(etfSec, n, th / 2); } catch (e) { /* dünnes Buch/kein Cash — nächster Lauf */ }

    // (2) Hintergrund: Bestand per Creation/Redemption anpassen (ab voller Schwelle)
    if (Math.abs(premium) < th) continue;
    // Harter Boden: unterhalb dieser Stückzahl wird NICHT mehr eingelöst — nur
    // die Peg-Quotes wirken weiter. Sonst radiert eine Serie von Redemptions
    // den Float aus und die Ask-Seite stirbt.
    if (premium < 0 && etfSec.total_shares < Math.max(60, 3 * etfSec.shares_per_unit)) continue;
    if (now - (autoLastAt.get(etfSec.id) || 0) < s.etf_auto_interval_sec * 1000) continue;
    // Dynamik, aber supply-schonend: max. 30% des Umlaufs je Aktion einlösen —
    // sonst radiert eine Series von Redemptions den Float aus und die Ask-Seite
    // stirbt (dann kann der Kurs gar nicht mehr zum NAV konvergieren).
    const maxBySupply = Math.max(1, Math.floor(etfSec.total_shares * 0.3 / etfSec.shares_per_unit));
    const units = Math.min(maxUnits, baseUnits * Math.max(1, Math.ceil(Math.abs(premium) / th)), maxBySupply);
    try {
      if (premium > 0) {
        const pv = preview(etfSec.id, units);
        if (pv.creation.est_profit <= 0) continue; // dünnes Buch: nicht lohnend
        // MM-Quotes der Korb-Aktien aufheben: Escrow fließt ins Treasury-Depot
        // zurück (Self-Trade-Prevention verbietet dem AP sonst den Zugriff).
        for (const b of basketOf(etfSec.id)) engine.mmCancelQuotes(engine.books.get(b.stock_id));
        const ap = q.userById.get(t.id);
        for (const b of basketOf(etfSec.id)) {
          const need = b.qty * units;
          const have = engine.holdingOf(t.id, b.stock_id);
          if (have < need) {
            // Best-Effort: Rest am Markt von SPIELERN kaufen (eigene Quotes sind tabu)
            try { engine.placeOrder(ap, { security_id: b.stock_id, side: 'buy', type: 'market', amount: need - have }, { mm: false }); } catch (e2) {}
          }
        }
        const r = createUnits(etfSec.id, units);
        autoLastAt.set(etfSec.id, Date.now());
        autoNews(etfSec, `Auto-Arbitrage: ${units} Creation Units ${etfSec.ticker}`,
          `Der ${etfSec.name} notierte ${(premium * 100).toFixed(1)}% ÜBER seinem NAV (${fmtCr(n.nav_per_share)}). Der AP-Algorithmus hat Korb gekauft, ${r.shares_created} neue Anteile geschaffen und verkauft sie nahe am NAV — der Kurs wird gezogen.`);
        actions.push({ ticker: etfSec.ticker, action: 'creation', units, premium_pct: Math.round(premium * 1000) / 10 });
      } else {
        // Markt-Erneuerung vor der Einlösung: Hat der Treasury gar keine
        // ETF-Anteile mehr (Depot + Ask-Escrow leer), ist die Ask-Seite tot —
        // niemand kann kaufen, der Kurs friert ein. Dann schafft der AP kurz
        // Nachschub (2 Units); der MM quotet sie um den LETZTEN Kurs, Käufer
        // kommen zurück und heben den Kurs Richtung NAV.
        const mmAskEscrow = db.prepare("SELECT SUM(amount - filled) q FROM orders WHERE security_id=? AND is_mm=1 AND side='sell' AND status='open'").get(etfSec.id).q || 0;
        if (engine.holdingOf(t.id, etfSec.id) + mmAskEscrow < etfSec.shares_per_unit) {
          const relive = Math.max(1, Math.min(2, maxBySupply));
          const r = createUnits(etfSec.id, relive);
          autoLastAt.set(etfSec.id, Date.now());
          autoNews(etfSec, `Auto-Arbitrage: ${relive} Units ${etfSec.ticker} nachgeschaffen`,
            `Der ${etfSec.name} hatte keine handelbare Angebotsseite mehr (${(premium * 100).toFixed(1)}% unter NAV). Der AP hat ${r.shares_created} Anteile nachgeschaffen — der Handel am letzten Kurs läuft wieder, Käufer ziehen den Kurs Richtung NAV (${fmtCr(n.nav_per_share)}).`);
          actions.push({ ticker: etfSec.ticker, action: 'relive', units: relive, premium_pct: Math.round(premium * 1000) / 10 });
          continue;
        }
        const pv = preview(etfSec.id, units);
        if (pv.redemption.est_profit <= 0) continue;
        // ETF-MM-Quotes aufheben (Escrow-Refund), dann Bestand prüfen
        engine.mmCancelQuotes(book);
        const shares = units * etfSec.shares_per_unit;
        const have = engine.holdingOf(t.id, etfSec.id);
        if (have < shares) {
          // Best-Effort: Fehlmenge am Markt von SPIELERN kaufen
          try { engine.placeOrder(q.userById.get(t.id), { security_id: etfSec.id, side: 'buy', type: 'market', amount: shares - have }, { mm: false }); } catch (e2) {}
        }
        const r = redeemUnits(etfSec.id, units);
        autoLastAt.set(etfSec.id, Date.now());
        autoNews(etfSec, `Auto-Arbitrage: ${units} Units ${etfSec.ticker} eingelöst`,
          `Der ${etfSec.name} notierte ${(premium * 100).toFixed(1)}% UNTER seinem NAV (${fmtCr(n.nav_per_share)}). Der AP-Algorithmus kauft Anteile zurück und hat ${r.shares_redeemed} Stück eingelöst — die Korb-Aktien kommen zurück in den Markt, der ETF-Kurs steigt.`);
        actions.push({ ticker: etfSec.ticker, action: 'redemption', units, premium_pct: Math.round(premium * 1000) / 10 });
      }
    } catch (e) { /* zu dünn / kein Cash / Bestand fehlt — beim nächsten Lauf wieder */ }
  }
  return actions;
}

module.exports = { nav, createEtf, createUnits, redeemUnits, preview, routeDividend, autoArbitrage, basketOf };
