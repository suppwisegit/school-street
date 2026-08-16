// Hintergrund-Jobs: Wocheneinkommen, Market-Maker-Refresh, Ghost-Accounts,
// Kapitalerhöhungs-Beobachtung (Kurs über Schwelle), Preis-Sampler für Charts.
const { db, getSettings, q, addNews } = require('./db');
const bus = require('./bus');
const engine = require('./engine');

const state = { last_income: 0, timers: [] };

function payIncome() {
  const s = getSettings();
  const users = db.prepare("SELECT id, username FROM users WHERE role='user' AND frozen=0").all();
  if (!users.length) return;
  const pay = db.transaction(() => {
    for (const u of users) {
      db.prepare('UPDATE users SET cash = cash + ? WHERE id = ?').run(s.income_cent, u.id);
      bus.emit({ type: 'dirty', user_id: u.id, what: ['portfolio'] });
    }
  });
  pay();
  state.last_income = Date.now();
  const n = addNews('system', '💰 Wocheneinkommen ausgezahlt',
    `Alle ${users.length} Trader haben ${(s.income_cent / 100).toFixed(0)} Credits erhalten. Viel Erfolg an der School-Street!`);
  bus.emit({ type: 'news', news: n });
}

function ghostCleanup() {
  const s = getSettings();
  const cutoff = Date.now() - s.inactivity_sec;
  const ghosts = db.prepare("SELECT * FROM users WHERE role='user' AND last_active < ?").all(cutoff);
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
  const n = addNews('system', '👻 Ghost-Accounts entfernt',
    `${ghosts.length} inaktive Konten wurden gelöscht. Das Vermögen fällt an die Investment AG (den Staat) und fließt als Streubesitz zurück in den Markt: ${ghosts.map(g => g.username).join(', ')}`);
  bus.emit({ type: 'news', news: n });
}

function capitalWatch() { // stündlich: Kurs über Schwelle?
  for (const book of engine.books.values()) {
    const sec = book.sec;
    if (sec.type !== 'stock' || !sec.threshold_price) continue;
    if (book.last >= sec.threshold_price) {
      db.prepare('UPDATE securities SET hours_above = hours_above + 1 WHERE id = ?').run(sec.id);
      sec.hours_above++;
    } else if (sec.hours_above > 0) {
      db.prepare('UPDATE securities SET hours_above = 0 WHERE id = ?').run(sec.id);
      sec.hours_above = 0;
    }
  }
}

function priceSampler() {
  const now = Date.now();
  for (const book of engine.books.values()) q.phIns.run(book.sec.id, now, book.last, 0);
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
  state.timers = [
    setInterval(safe('income', () => {
      if (Date.now() - state.last_income >= getSettings().income_sec * 1000) payIncome();
    }), 1000),
    setInterval(safe('mm-refresh', () => engine.mmRefreshAll()), getSettings().mm_refresh_sec * 1000),
    setInterval(safe('ghost-cleanup', ghostCleanup), 10 * 60 * 1000),
    setInterval(safe('capital-watch', capitalWatch), 60 * 60 * 1000),
    setInterval(safe('price-sampler', priceSampler), 30 * 1000)
  ];
  engine.mmRefreshAll();
}

module.exports = { startJobs, payIncome, ghostCleanup, state };
