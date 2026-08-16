// Seed: Demo-Daten für sofortiges Testen (npm run seed).
// Achtung: setzt die Datenbank zurück! Alle Trades laufen über die echte Engine,
// damit Kursverläufe/Orderbücher authentisch sind.
process.env.SEED = '1';
const fs = require('fs');
const path = require('path');
const DBFILE = path.join(__dirname, 'data', process.env.DB_NAME || 'schoolstreet.db');
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

const { db, setSetting, getSettings, q, addNews } = require('./db');
const auth = require('./auth');
const engine = require('./engine');
const etf = require('./etf');

// Test-freundliche Defaults
setSetting('income_sec', 300);          // 5 Minuten
setSetting('lockup_sec', 120);          // 2 Minuten Lock-up für Tests
setSetting('inactivity_sec', 3600 * 24 * 21);

const C = (x) => Math.round(x * 100);

// --- Konten ---
const adminPw = process.env.ADMIN_PASSWORD || 'ag123';
const admin = auth.createUser('admin', adminPw, 'admin');
console.log(`Admin: admin / ${adminPw}`);
const treasury = auth.createUser('AG-Treasury', 'x', 'bank', 5000000);

const founders = [
  ['Max', 'Mensa Gourmet SE', 'MENSA', 'Frische(ere) Gerichte, secretly Bio. Die Kantine mit Anspruch.', 50, 1.18],
  ['Lena', 'Hausaufgaben-Service GmbH', 'HAUSA', 'Hausaufgaben-Hilfe von Oberstufencracks. Skalierbar bis Abi.', 35, 0.92],
  ['Tim', 'Event & Party AG', 'EVENT', 'Schulfeste, Turniere, Festival-Feeling. High Risk, High Fun.', 20, 1.35],
  ['Zoe', 'Eis am Stiela', 'EIS', 'Eisverkauf im Sommer. Hitzefrei = Sonderdividende.', 15, 1.06],
];
const founderUsers = {};
const dummies = ['Anna', 'Ben', 'Chloe', 'David', 'Emre', 'Fiona', 'Gustav', 'Hannah'];
const dummyUsers = dummies.map((n, i) => auth.createUser(n, 'demo123', 'user', C(20000 + i * 3000)));

// --- IPOs ---
const stocks = [];
for (const [fname, name, ticker, desc, ipo, drift] of founders) {
  const u = auth.createUser(fname, 'demo123', 'user', C(10000));
  founderUsers[ticker] = u;
  const sec = engine.listSecurity({ type: 'stock', ticker, name, description: desc, founder_id: u.id, ipo_price: C(ipo), total_shares: 1000 + 400 });
  db.prepare('UPDATE securities SET threshold_price=?, lockup_until=? WHERE id=?').run(C(ipo * 1.5), Date.now() + getSettings().lockup_sec * 1000, sec.id);
  sec.threshold_price = C(ipo * 1.5);
  engine.addHoldingPublic(u.id, sec.id, 1000, C(ipo));
  engine.addHoldingPublic(treasury.id, sec.id, 400, C(ipo));
  db.prepare('UPDATE users SET cash = cash + ? WHERE id=?').run(C(ipo) * 400, u.id);
  db.prepare('UPDATE users SET cash = cash - ? WHERE id=?').run(C(ipo) * 400, treasury.id);
  engine.mmRecenter(engine.books.get(sec.id));
  stocks.push({ sec, drift, founder: u });
  const n = addNews('ipo', `🔔 IPO: ${name} (${ticker}) notiert zum Kurs ${ipo.toFixed(2)}`,
    `${fname} geht mit ${name} an die Börse. 1.000 Gründeraktien, 400 Stück Streubesitz. Konzept: ${desc}`, sec.id);
}

// --- Kursverlauf durch echte Trades erzeugen (MM liefert nur Liquidität) ---
function simTrades(sec, drift, n) {
  const rand = (a) => a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < n; i++) {
    const trader = rand(dummyUsers);
    const buy = Math.random() < 0.5 + (drift - 1) / 2; // drift>1 = leichtes Übergewicht Käufe
    try {
      engine.placeOrder(trader, {
        security_id: sec.id, side: buy ? 'buy' : 'sell',
        type: 'market', amount: 3 + Math.floor(Math.random() * 10)
      });
    } catch (e) { /* Depot kann leer sein – egal */ }
  }
}
for (const s of stocks) simTrades(s.sec, s.drift, 45);

// --- Schul-ETF: Treasury kauft Korb am Markt, dann Creation ---
const mensa = q.secByTicker.get('MENSA'), hausa = q.secByTicker.get('HAUSA'), event = q.secByTicker.get('EVENT');
const etfBasket = [
  { stock_id: mensa.id, qty: 2 },
  { stock_id: hausa.id, qty: 1 },
  { stock_id: event.id, qty: 3 }
];
// Dummies stellen echte, ruhende Verkaufsorders (Staffelung nach oben),
// damit der AP (Treasury) den Korb am Markt von SPIELERN kaufen kann.
for (const b of etfBasket) {
  const need = b.qty * 25;
  const sellers = [dummyUsers[0], dummyUsers[1], dummyUsers[2]];
  const per = Math.ceil(need / sellers.length);
  sellers.forEach((s, level) => {
    const book = engine.books.get(b.stock_id);
    const price = book.last + (1 + level) * engine.tick(book.sec);
    engine.addHoldingPublic(s.id, b.stock_id, per, price);
    engine.placeOrder(s, { security_id: b.stock_id, side: 'sell', type: 'limit', price, amount: per });
  });
  let attempts = 0;
  while (engine.holdingOf(treasury.id, b.stock_id) < need && attempts++ < 30) {
    try { engine.placeOrder(treasury, { security_id: b.stock_id, side: 'buy', type: 'market', amount: need }); }
    catch (e) { break; }
  }
}
const etfSec = etf.createEtf({ ticker: 'SETF', name: 'SCHUL-ETF', basket: etfBasket, shares_per_unit: 10, initial_units: 25 });
// etwas ETF-Handel
for (let i = 0; i < 15; i++) {
  const trader = dummyUsers[Math.floor(Math.random() * dummyUsers.length)];
  try {
    engine.placeOrder(trader, { security_id: etfSec.id, side: Math.random() < 0.5 ? 'buy' : 'sell', type: 'market', amount: 2 + Math.floor(Math.random() * 6) });
  } catch (e) {}
}

// --- Dividenden-Event (News steuert Verhalten, Ausschüttung ist echt) ---
const eis = q.secByTicker.get('EIS');
(() => {
  const holders = db.prepare('SELECT user_id, amount FROM holdings WHERE security_id=?').all(eis.id);
  let total = 0;
  for (const h of holders) { const pay = h.amount * C(0.5); db.prepare('UPDATE users SET cash=cash+? WHERE id=?').run(pay, h.user_id); total += pay; }
  db.prepare('UPDATE users SET cash=cash-? WHERE id=?').run(total, treasury.id);
  addNews('dividend', `☀️ Hitzefrei! EIS schüttet 0,50 Sonderdividende je Aktie`,
    `Der Sommer ist da: "Eis am Stiela" zahlt allen Aktionären 0,50 Credits je Aktie aus. Wer sehen will, wie News den Kurs bewegen, sollte jetzt zuschauen.`, eis.id);
})();

addNews('news', '📣 Willkommen an der School-Street!',
  'Die Börse ist eröffnet: 4 Unternehmen, 1 ETF, echtes Orderbuch. Tipp: Lies die News — gute Geschichten bewegen Kurse.');
addNews('bafin', '⚖️ BaFin-Hinweis', 'Die Börsenaufsicht beobachtet ungewöhnliche Kursbewegungen. Pump & Dump führt zum Konto-Einfrieren.');
addNews('news', '📈 Q11 Mathe-Desaster', 'Der schlechte Mathe-Schnitt der Q11 lässt die HAUSA-Aktie begehrt erscheinen — Nachhilfe gefragt!', hausa.id);
addNews('news', '🎉 Event & Party AG plant Sommerfestival', 'EVENT arbeitet an einem Festival auf dem Schulhof. Anleger spekulieren auf Rekordumsätze.', event.id);

// Handelsverläufe zeitlich über die letzten 6h verteilen (schönere Charts/Board)
{
  const span = 6 * 3600 * 1000, now = Date.now();
  const spread = (table, col) => {
    const rows = db.prepare(`SELECT rowid FROM ${table} ORDER BY rowid`).all();
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    db.transaction(() => {
      rows.forEach((r, i) => upd.run(now - Math.round((rows.length - 1 - i) * span / Math.max(1, rows.length)), r.rowid));
    })();
  };
  spread('price_history', 'ts');
  spread('trades', 'created_at');
}

console.log('Seed fertig:');
console.log(`  Admin login : admin / ${adminPw}  (/admin)`);
console.log('  Demo-Trader : Anna..Hannah / demo123, Max/Lena/Tim/Zoe (Gründer) / demo123');
console.log(`  Aktien      : ${stocks.map(s => s.sec.ticker).join(', ')} + ETF SETF`);
