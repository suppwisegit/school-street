// ============================================================================
// Schul-ETF: fixer Korb, Creation Units mit Multiplikator, NAV in Echtzeit.
// Die Investment AG ist Authorized Participant (AP) und macht die Arbitrage
// MANUELL über das Admin-Panel (Creation/Redemption inkl. Vorschau).
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

module.exports = { nav, createEtf, createUnits, redeemUnits, preview, routeDividend, basketOf };
