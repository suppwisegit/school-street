// ============================================================================
// Matching Engine (XETRA-Prinzip: Price-Time-Priority, kontinuierlicher Handel)
// ----------------------------------------------------------------------------
// WICHTIG (Vorgabe): Der Market-Maker erzeugt KEINE Kurstrends. Er legt nur
// passive Quoten um den LETZTEN HANDELSPREIS. Kursbewegungen entstehen
// ausschließlich durch Spieler-Trades (der MM re-zentriert nach jedem Trade).
// News steuern Kurse nur indirekt (Spieler reagieren auf News).
// ============================================================================
const { db, getSettings, q, addNews } = require('./db');
const bus = require('./bus');

// In-Memory-Orderbücher: bids absteigend (Preis, dann Zeit), asks aufsteigend.
const books = new Map(); // secId -> { sec, bids: [], asks: [], last: cent, vol24: int }

function tick(sec) { return sec.type === 'etf' ? 10 : 100; } // Aktie: 1 Credit, ETF: 0,1 Credit
function roundToTick(p, sec, dir) { const t = tick(sec); return dir === 'down' ? Math.floor(p / t) * t : Math.ceil(p / t) * t; }

function getBook(secId) { return books.get(secId); }
function bookSnapshot(secId, depth = 10) {
  const b = books.get(secId);
  if (!b) return { bids: [], asks: [] };
  const agg = (arr) => {
    const m = new Map();
    for (const o of arr) m.set(o.price, (m.get(o.price) || 0) + (o.amount - o.filled));
    return [...m.entries()].slice(0, depth);
  };
  return { bids: agg(b.bids), asks: agg(b.asks) };
}

function insertIntoBook(book, o) {
  const arr = o.side === 'buy' ? book.bids : book.asks;
  const i = arr.findIndex(x =>
    o.side === 'buy'
      ? (o.price > x.price || (o.price === x.price && o.created_at <= x.created_at))
      : (o.price < x.price || (o.price === x.price && o.created_at <= x.created_at)));
  arr.splice(i === -1 ? arr.length : i, 0, o);
}
function removeFromBook(book, orderId) {
  book.bids = book.bids.filter(o => o.id !== orderId);
  book.asks = book.asks.filter(o => o.id !== orderId);
}

function loadEngine() {
  books.clear();
  const secs = q.allSecs.all('active');
  const openOrders = db.prepare(`SELECT * FROM orders WHERE status='open' ORDER BY created_at ASC, id ASC`).all();
  const bySec = new Map();
  for (const o of openOrders) { if (!bySec.has(o.security_id)) bySec.set(o.security_id, []); bySec.get(o.security_id).push(o); }
  for (const sec of secs) {
    const lastTrade = db.prepare('SELECT price FROM trades WHERE security_id = ? ORDER BY id DESC LIMIT 1').get(sec.id);
    books.set(sec.id, {
      sec, bids: [], asks: [],
      last: lastTrade ? lastTrade.price : sec.ipo_price,
      vol24: 0
    });
    for (const o of bySec.get(sec.id) || []) insertIntoBook(books.get(sec.id), o);
  }
}

function touch(userId) { db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(Date.now(), userId); }

// ---------- Holdings/Cash-Helfer ----------
function holdingOf(userId, secId) { const h = q.holding.get(userId, secId); return h ? h.amount : 0; }
function addHolding(userId, secId, delta, price = null) {
  const h = q.holding.get(userId, secId);
  if (!h || h.amount + delta === 0) {
    if (h && h.amount + delta === 0) db.prepare('DELETE FROM holdings WHERE user_id=? AND security_id=?').run(userId, secId);
    else if (delta !== 0) q.upsertHolding.run(userId, secId, delta, price || 0);
    return;
  }
  let amount = h.amount + delta, avg = h.avg_cost;
  if (delta > 0 && price != null) avg = Math.round((h.avg_cost * h.amount + price * delta) / amount);
  q.upsertHolding.run(userId, secId, amount, avg);
}

// ---------- Gebühren (Geldverbrennung) ----------
function chargeFee(order) {
  if (order.fee_charged || order.is_mm && getSettings().mm_fee_exempt) return;
  const fee = getSettings().fee_cent;
  db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(fee, order.user_id);
  order.fee_charged = 1;
  db.prepare('UPDATE orders SET fee_charged = 1 WHERE id = ?').run(order.id);
}

// ---------- Ein Trade ----------
function executeFill(taker, maker, price, qty, book) {
  const buyerOrder = taker.side === 'buy' ? taker : maker;
  const sellerOrder = taker.side === 'buy' ? maker : taker;
  const buyer = q.userById.get(buyerOrder.user_id);
  const seller = q.userById.get(sellerOrder.user_id);

  // Käufer: Limit-Käufe haben price*amount treuhänderisch hinterlegt -> Differenz zurück
  for (const o of [buyerOrder, sellerOrder]) chargeFee(o);
  if (buyerOrder.type === 'limit') {
    const refund = (buyerOrder.price - price) * qty; // >= 0
    if (refund > 0) db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(refund, buyer.id);
  } else {
    db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(price * qty, buyer.id);
  }
  addHolding(buyer.id, book.sec.id, qty, price);
  // Verkäufer: Aktien beim Resting-Order schon hinterlegt, bei Market jetzt abbuchen
  db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(price * qty, seller.id);
  if (sellerOrder.type === 'market') {
    const h = q.holding.get(seller.id, book.sec.id);
    const avg = h ? h.avg_cost : price;
    db.prepare('UPDATE users SET realized_pl = realized_pl + ? WHERE id = ?').run((price - avg) * qty, seller.id);
    addHolding(seller.id, book.sec.id, -qty);
  } else {
    const h = q.holding.get(seller.id, book.sec.id);
    const avg = h ? h.avg_cost : price;
    db.prepare('UPDATE users SET realized_pl = realized_pl + ? WHERE id = ?').run((price - avg) * qty, seller.id);
  }
  maker.filled += qty;
  db.prepare('UPDATE orders SET filled = ? WHERE id = ?').run(maker.filled, maker.id);
  if (maker.filled >= maker.amount) {
    maker.status = 'filled';
    db.prepare("UPDATE orders SET status='filled' WHERE id = ?").run(maker.id);
    removeFromBook(book, maker.id);
  }
  book.last = price;
  db.prepare('INSERT INTO trades(security_id, price, amount, buyer_id, seller_id, created_at) VALUES(?,?,?,?,?,?)')
    .run(book.sec.id, price, qty, buyer.id, seller.id, Date.now());
  q.phIns.run(book.sec.id, Date.now(), price, qty);
  return { security_id: book.sec.id, price, amount: qty, buyer: buyer.username, seller: seller.username, ts: Date.now() };
}

// ---------- Matching (Price-Time-Priority, Maker-Preis gilt) ----------
function matchOrder(taker, book) {
  const trades = [];
  const opposite = () => taker.side === 'buy' ? book.asks : book.bids;
  let budget = null;
  if (taker.type === 'market' && taker.side === 'buy') {
    budget = q.userById.get(taker.user_id).cash - (taker.is_mm && getSettings().mm_fee_exempt ? 0 : getSettings().fee_cent);
    if (budget < 0) budget = 0;
  }
  while (taker.filled < taker.amount) {
    const arr = opposite();
    const maker = arr.find(o => o.user_id !== taker.user_id && o.amount - o.filled > 0); // Self-Trade-Prevention strikt; Levels mit Restmenge 0 ueberspringen
    if (!maker) break;
    if (taker.type === 'limit') {
      if (taker.side === 'buy' && maker.price > taker.price) break;
      if (taker.side === 'sell' && maker.price < taker.price) break;
    }
    let qty = Math.min(taker.amount - taker.filled, maker.amount - maker.filled);
    if (budget != null) {
      qty = Math.min(qty, Math.floor(budget / maker.price));
      if (qty <= 0) break;
    }
    if (qty <= 0) break;
    if (budget != null) budget -= qty * maker.price;
    trades.push(executeFill(taker, maker, maker.price, qty, book));
    taker.filled += qty;
  }
  db.prepare('UPDATE orders SET filled = ? WHERE id = ?').run(taker.filled, taker.id);
  if (taker.filled >= taker.amount) {
    taker.status = 'filled';
    db.prepare("UPDATE orders SET status='filled' WHERE id = ?").run(taker.id);
    removeFromBook(book, taker.id); // FIX: voll gefuellte Taker-Order aus dem Orderbuch nehmen (keine Phantom-Levels mit Restmenge 0)
  } else if (taker.type === 'market') {
    taker.status = 'canceled'; // Rest verfällt (XETRA: Market-Orders liegen nicht im Buch)
    db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(taker.id);
  }
  return trades;
}

// ---------- Order aufgeben ----------
function placeOrder(user, { security_id, side, type, price, amount }, opts = {}) {
  const sec = q.secById.get(security_id);
  if (!sec || sec.status !== 'active') throw new Error('Wertpapier nicht handelbar');
  const book = books.get(sec.id);
  if (!book) throw new Error('Orderbuch nicht initialisiert');
  side = side === 'buy' ? 'buy' : 'sell';
  amount = Math.floor(Number(amount));
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e6) throw new Error('Ungültige Stückzahl');
  const isMM = !!opts.mm;
  if (user.frozen && !isMM) throw new Error('Konto eingefroren – BaFin ermittelt');
  if (user.role === 'user' && !isMM) touch(user.id);

  // Founder-Lock-up: eigene Aktien in den ersten Wochen nicht verkaufen
  if (!isMM && sec.type === 'stock' && side === 'sell' && sec.founder_id === user.id && Date.now() < sec.lockup_until) {
    throw new Error(`Lock-up: Du darfst Deine Gründeraktien noch nicht verkaufen (bis ${new Date(sec.lockup_until).toLocaleString('de-DE')})`);
  }
  const s = getSettings();
  const feeReserve = (isMM && s.mm_fee_exempt) ? 0 : s.fee_cent;

  const order = {
    security_id: sec.id, user_id: user.id, side, type,
    price: null, amount, filled: 0, status: 'open', is_mm: isMM ? 1 : 0,
    fee_charged: 0, created_at: Date.now()
  };

  if (type === 'limit') {
    price = Math.round(Number(price));
    if (!Number.isInteger(price) || price <= 0 || price % tick(sec) !== 0)
      throw new Error(`Ungültiger Preis (Tick ${tick(sec) / 100} Credits)`);
    order.price = price;
    if (side === 'buy') {
      const cost = price * amount + feeReserve;
      if (user.cash < cost) throw new Error(`Nicht genug Credits (benötigt ${(cost / 100).toFixed(2)} inkl. Gebühr)`);
      db.prepare('UPDATE users SET cash = cash - ? WHERE id = ?').run(price * amount, user.id);
      user.cash -= price * amount;
    } else {
      if (holdingOf(user.id, sec.id) < amount) throw new Error('Nicht genug Aktien im Depot');
      addHolding(user.id, sec.id, -amount);
    }
    const r = db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(order.security_id, order.user_id, order.side, 'limit', price, amount, 0, 'open', isMM ? 1 : 0, order.created_at);
    order.id = r.lastInsertRowid;
    insertIntoBook(book, order);
  } else if (type === 'market') {
    if (side === 'sell' && holdingOf(user.id, sec.id) < amount) throw new Error('Nicht genug Aktien im Depot');
    const r = db.prepare(`INSERT INTO orders(security_id, user_id, side, type, price, amount, filled, status, is_mm, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(order.security_id, order.user_id, order.side, 'market', null, amount, 0, 'open', isMM ? 1 : 0, order.created_at);
    order.id = r.lastInsertRowid;
  } else throw new Error('Ungültiger Ordertyp');

  const trades = matchOrder(order, book);

  if (trades.length && !isMM) mmRecenter(book); // MM folgt dem Marktpreis – nur passive Liquidität
  if (trades.length) checkTakeover(book.sec);
  if (trades.length || order.status === 'open') broadcastChanges(book, trades, user.id);
  return { order: { ...order }, trades, last: book.last };
}

// ---------- Order löschen (Escrow zurück) ----------
function cancelOrder(user, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.user_id !== user.id) throw new Error('Order nicht gefunden');
  if (o.status !== 'open') throw new Error('Order ist nicht mehr offen');
  const book = books.get(o.security_id);
  removeFromBook(book, o.id);
  db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(o.id);
  const remaining = o.amount - o.filled;
  if (o.side === 'buy') db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(o.price * remaining, o.user_id);
  else addHolding(o.user_id, o.security_id, remaining);
  broadcastChanges(book, [], o.user_id);
  return { ok: true };
}

// ============================================================================
// Market-Maker: NUR Liquidität. Keine Meinungsrichtung, kein Random Walk.
// Quoten: last*(1±spread/2), kleine Stückzahl. Nach jedem Trade re-zentrieren.
// ============================================================================
function treasury() { return db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1").get(); }

function mmQuotes(book) {
  const s = getSettings();
  const half = s.mm_spread_bp / 10000 / 2;
  return {
    bid: Math.max(tick(book.sec), roundToTick(book.last * (1 - half), book.sec, 'down')),
    ask: roundToTick(book.last * (1 + half), book.sec, 'up')
  };
}
// Hebt MM-Quoten eines Werts auf (Escrow zurück ins Treasury-Depot/-Konto)
function mmCancelQuotes(book) {
  const mmOrders = db.prepare("SELECT id FROM orders WHERE security_id = ? AND status='open' AND is_mm = 1").all(book.sec.id);
  for (const { id } of mmOrders) {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    const remaining = o.amount - o.filled;
    if (o.side === 'buy') db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(o.price * remaining, o.user_id);
    else addHolding(o.user_id, o.security_id, remaining);
    removeFromBook(book, id);
    db.prepare("UPDATE orders SET status='canceled' WHERE id = ?").run(id);
  }
}
function mmRecenter(book) {
  if (!book.sec.mm_enabled) return;
  const t = treasury();
  if (!t) return;
  // alte MM-Quoten entfernen (Escrow fließt zurück)
  mmCancelQuotes(book);
  const { bid, ask } = mmQuotes(book);
  const size = getSettings().mm_size;
  const t2 = treasury();
  if (t2.cash >= bid * size) {
    try { placeOrder(t2, { security_id: book.sec.id, side: 'buy', type: 'limit', price: bid, amount: size }, { mm: true }); } catch (e) {}
  }
  const t3 = treasury();
  if (holdingOf(t3.id, book.sec.id) >= size) {
    try { placeOrder(t3, { security_id: book.sec.id, side: 'sell', type: 'limit', price: ask, amount: size }, { mm: true }); } catch (e) {}
  }
  broadcastChanges(book, [], null);
}
function mmRefreshAll() {
  for (const book of books.values()) mmRecenter(book);
}

// ---------- Feindliche Übernahme >50% ----------
function checkTakeover(sec) {
  if (sec.type !== 'stock' || sec.status !== 'active') return;
  const rows = db.prepare('SELECT user_id, amount FROM holdings WHERE security_id = ?').all(sec.id);
  for (const r of rows) {
    if (r.user_id !== sec.founder_id && r.amount * 2 > sec.total_shares && sec.majority_holder_id !== r.user_id) {
      db.prepare('UPDATE securities SET majority_holder_id = ? WHERE id = ?').run(r.user_id, sec.id);
      sec.majority_holder_id = r.user_id;
      const u = q.userById.get(r.user_id);
      const n = addNews('takeover', `🚨 FEINDLICHE ÜBERNAHME: ${u.username} übernimmt ${sec.name}!`,
        `${u.username} hält jetzt über 50% der Anteile an ${sec.name} (${sec.ticker}) und erhält Sonderrechte: Firmenumbenennung und Antrag auf Sonderdividende.`, sec.id);
      bus.emit({ type: 'news', news: n });
    }
  }
}

// ---------- Broadcasts ----------
function broadcastChanges(book, trades, touchedUserId) {
  if (trades.length) bus.emit({ type: 'ticker', ticker: tickerRow(book.sec.id) });
  bus.emit({ type: 'book', security_id: book.sec.id, book: bookSnapshot(book.sec.id) });
  for (const t of trades) bus.emit({ type: 'trade', ...t });
  if (touchedUserId) bus.emit({ type: 'dirty', user_id: touchedUserId, what: ['portfolio', 'orders'] });
}

function tickerRow(secId) {
  const b = books.get(secId);
  const t = tickerRowCached(secId, b);
  return t;
}
function tickerRowCached(secId, b) {
  const day = Date.now() - 24 * 3600 * 1000;
  const ref = db.prepare('SELECT price FROM price_history WHERE security_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1').get(secId, day);
  const refPrice = ref ? ref.price : b.sec.ipo_price;
  const bookSnap = bookSnapshot(secId, 1);
  const vol = db.prepare('SELECT SUM(amount) v FROM trades WHERE security_id = ? AND created_at >= ?').get(secId, day).v || 0;
  return {
    id: secId, ticker: b.sec.ticker, name: b.sec.name, type: b.sec.type,
    last: b.last, ref: refPrice, chg: refPrice ? Math.round((b.last / refPrice - 1) * 10000) / 100 : 0,
    bid: bookSnap.bids[0]?.[0] || null, ask: bookSnap.asks[0]?.[0] || null, vol
  };
}
function tickerAll() { return [...books.keys()].map(id => tickerRowCached(id, books.get(id))); }

// ---------- Book-Walk für ETF-Previews (VWAP-Kosten/erlös) ----------
function costToBuy(secId, qty) {
  const b = books.get(secId);
  let left = qty, cost = 0, fills = [];
  for (const o of b.asks) {
    if (left <= 0) break;
    const take = Math.min(left, o.amount - o.filled);
    cost += take * o.price; fills.push({ price: o.price, qty: take }); left -= take;
  }
  return { cost, shortfall: left, fills };
}
function proceedsToSell(secId, qty) {
  const b = books.get(secId);
  let left = qty, proceeds = 0, fills = [];
  for (const o of b.bids) {
    if (left <= 0) break;
    const take = Math.min(left, o.amount - o.filled);
    proceeds += take * o.price; fills.push({ price: o.price, qty: take }); left -= take;
  }
  return { proceeds, shortfall: left, fills };
}

// ---------- Wertpapier anlegen (IPO / ETF) ----------
function listSecurity({ type, ticker, name, description, founder_id, ipo_price, total_shares, mm_enabled = 1, shares_per_unit = null, initial_last = null }) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO securities(type, ticker, name, description, founder_id, ipo_price, total_shares, lockup_until, mm_enabled, shares_per_unit, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, ticker.toUpperCase(), name, description || '', founder_id || null, ipo_price, total_shares, founder_id ? now + getSettings().lockup_sec * 1000 : 0, mm_enabled, shares_per_unit, now);
  const sec = q.secById.get(r.lastInsertRowid);
  books.set(sec.id, { sec, bids: [], asks: [], last: initial_last || ipo_price, vol24: 0 });
  return sec;
}

module.exports = {
  books, loadEngine, placeOrder, cancelOrder, bookSnapshot, tickerAll, tickerRow,
  costToBuy, proceedsToSell, listSecurity, mmRecenter, mmCancelQuotes, mmRefreshAll, holdingOf,
  treasury, tick, checkTakeover, addHoldingPublic: addHolding
};
