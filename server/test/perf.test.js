// Tests für T11 (Performance, ohne Zeitmessung): der Ticker-Cache fragt bei unverändertem
// Buch nicht nach, der `ticker`-Push kommt je Wert gedrosselt, und die Rangliste rechnet das
// Vermögen wie vorher (Cash + Bestände zum aktuellen Kurs) — jetzt mit einer Abfrage für alle.
// Eigene, frisch geseedete DB (server/data/perf-<pid>.db), HTTP auf Loopback ab Port 3290.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB_NAME = `perf-${process.pid}.db`;
process.env.DB_NAME = DB_NAME;
const DBFILE = path.join(__dirname, '..', 'data', DB_NAME);
const clean = () => {
  for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
};

let db, q, auth, bus, engine;
before(() => {
  clean();
  execFileSync(process.execPath, [path.join(__dirname, '..', 'seed.js')],
    { env: { ...process.env, DB_NAME, ADMIN_PASSWORD: 'ag123' }, stdio: 'ignore' });
  ({ db, q } = require('../db'));
  auth = require('../auth');
  bus = require('../bus');
  engine = require('../engine');
  engine.loadEngine();
});
after(clean);

// Zählt die über `db.prepare` begonnenen Abfragen, während `fn` läuft.
function sqlCount(fn) {
  const orig = db.prepare;
  let n = 0;
  db.prepare = (...a) => { n++; return orig.apply(db, a); };
  try { fn(); } finally { db.prepare = orig; }
  return n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const newUser = async (cash = 1_000_000) => auth.createUser(`perf-test-${++n}`, 'pw1234', 'user', cash);

test('T11: tickerAll und tickerRow fragen bei unverändertem Buch keine SQL-Abfragen ab', () => {
  const secId = engine.books.keys().next().value;
  const warm = sqlCount(() => engine.tickerAll());
  assert.ok(warm > 0, 'der erste Aufruf lädt Bezugswert und Volumen');
  assert.equal(sqlCount(() => engine.tickerAll()), 0, 'zweiter Aufruf ohne Handel: 0 Abfragen für alle Werte');
  assert.equal(sqlCount(() => engine.tickerRow(secId)), 0, 'einzelne Zeile aus dem Cache');
});

test('T11: je Wert höchstens ein ticker-Push je 250 ms — der erste sofort, danach der letzte Stand', async () => {
  const secId = engine.books.keys().next().value;
  const u = await newUser();
  let tickers = 0, last = 0, on = true;
  bus.on((m) => { if (on && m.type === 'ticker' && m.ticker && m.ticker.id === secId) { tickers++; last = m.ticker.last; } }); // der Bus kennt kein Abo-Ende
  try {
    const t0 = performance.now();
    const ORDERS = 20;
    for (let i = 0; i < ORDERS; i++) {
      const r = engine.placeOrder(q.userById.get(u.id), { security_id: secId, side: 'buy', type: 'market', amount: 1 });
      assert.ok(r.trades.length >= 1, 'jede Order füllt — sonst gäbe es keinen Anlass für einen Push');
    }
    const elapsed = performance.now() - t0;
    assert.ok(tickers >= 1, 'der erste Push geht sofort');
    assert.ok(tickers <= 1 + Math.ceil(elapsed / 250), `${ORDERS} Orders in ${elapsed.toFixed(0)} ms: ${tickers} ticker-Pushes statt ${ORDERS}`);
    const burst = tickers;
    await sleep(400); // Frist abgelaufen: genau der gesammelte Stand kommt nach
    const after = tickers;
    assert.equal(after, burst + 1, 'ein gesammelter Push am Fristende');
    assert.equal(last, engine.books.get(secId).last, 'der Push trägt den letzten Kurs');
    await sleep(350);
    assert.equal(tickers, after, 'danach kommt nichts mehr nach');
  } finally { on = false; }
});

const listenFrom = async (srv, first) => {
  for (let port = first; port < first + 10; port++) {
    srv.listen(port, '127.0.0.1');
    const outcome = await Promise.race([
      once(srv, 'listening').then(() => 'open'),
      once(srv, 'error').then((e) => (e.code === 'EADDRINUSE' ? 'busy' : Promise.reject(e))),
    ]);
    if (outcome === 'open') return port;
  }
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return srv.address().port;
};

test('T11: Rangliste, Board und /api/game — Vermögen je Nutzer wie einzeln gerechnet, Fenster öffentlich', async () => {
  const secId = engine.books.keys().next().value;
  const alice = await newUser(50_000), bob = await newUser(70_000), carol = await newUser(); // Carol: nur Cash
  engine.placeOrder(q.userById.get(alice.id), { security_id: secId, side: 'buy', type: 'market', amount: 4 });
  engine.placeOrder(q.userById.get(bob.id), { security_id: secId, side: 'buy', type: 'market', amount: 2 });
  const worth = (id) => {
    const row = q.userById.get(id);
    let w = row.cash;
    for (const h of db.prepare('SELECT * FROM holdings WHERE user_id=?').all(id)) { const b = engine.books.get(h.security_id); if (b) w += h.amount * b.last; }
    return w;
  };
  const app = require('express')();
  app.use('/api', require('../routes'));
  const srv = require('node:http').createServer(app);
  const port = await listenFrom(srv, 3290);
  const get = async (pth) => { const r = await fetch(`http://127.0.0.1:${port}/api${pth}`); assert.equal(r.status, 200, pth); return r.json(); };
  try {
    const lb = (await get('/leaderboard')).leaderboard;
    for (const u of [alice, bob, carol]) {
      const row = lb.find((r) => r.id === u.id);
      assert.ok(row, `${u.username} steht in der Rangliste`);
      assert.equal(row.worth, worth(u.id), `Vermögen von ${u.username}`);
    }
    const board = (await get('/board')).leaderboard;
    for (const r of board) assert.equal(r.worth, worth(db.prepare('SELECT id FROM users WHERE username=?').get(r.username).id), r.username);
    const admin = db.prepare("SELECT username FROM users WHERE role='admin'").get().username;
    assert.ok(!board.some((r) => r.username === admin), 'die Staatskasse und Bots bleiben draußen');

    const game = await get('/game');
    assert.equal(game.ipo_highlight_sec, require('../db').getSettings().ipo_highlight_sec, 'Fenster lesbar ohne Login');
    assert.equal(Object.keys(game).some((k) => /^bot_|^mm_|^treasury|admin_pw|password/i.test(k)), false, 'keine Admin-Werte in /api/game');
    const anon = await fetch(`http://127.0.0.1:${port}/api/admin/settings`);
    assert.equal(anon.status, 401, 'die Admin-Einstellungen bleiben geschützt');
  } finally { srv.close(); }
});
