// ============================================================================
// School-Street Server: ein Prozess für alles (HTTP + WebSocket + statisches
// React-Frontend). Läuft im WLAN auf dem Server-PC:  npm start
//   http://serverip:port/        Spieler-Interface
//   http://serverip:port/admin   Investment-AG (Aufsicht, ETF-Arbitrage, ...)
//   http://serverip:port/board   Board/TV-Ansicht (Index, Tops/Flops, News)
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { db, q, getSettings } = require('./db');
const auth = require('./auth');
const engine = require('./engine');
const jobs = require('./jobs');
const bus = require('./bus');
const routes = require('./routes');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// ---------- Bootstrap: Admin + Treasury ----------
function bootstrap() {
  let admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  if (!admin) {
    const pw = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(6).toString('hex').toUpperCase();
    admin = auth.createUser(process.env.ADMIN_USER || 'admin', pw, 'admin');
    console.log('==========================================================');
    console.log('  Investment-AG Admin-Zugang (BITTE NOTIEREN/ÄNDERN):');
    console.log(`  Username: ${admin.username}   Passwort: ${pw}`);
    console.log(`  Login unter:  http://<serverip>:${PORT}/admin`);
    console.log('==========================================================');
  }
  if (!db.prepare("SELECT * FROM users WHERE role='bank' LIMIT 1").get()) {
    auth.createUser('AG-Treasury', require('crypto').randomBytes(16).toString('hex'), 'bank', 5000000);
  }
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use('/api', routes);

// Statisches Frontend (React-Build)
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const index = path.join(PUB, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).send('Frontend noch nicht gebaut: erst <b>npm run build</b> ausführen. Die API läuft unter /api.');
});

const server = http.createServer(app);

// ---------- WebSocket: Live-Kurse, Orderbücher, News ----------
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> {userId, subs:Set}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const user = auth.userForToken(url.searchParams.get('token'));
  clients.set(ws, { userId: user ? user.id : null, subs: new Set() });
  ws.send(JSON.stringify({ type: 'hello', user: user ? { id: user.id, username: user.username, role: user.role } : null }));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      const c = clients.get(ws);
      if (m.type === 'subscribe' && m.security_id) c.subs.add(m.security_id);
      if (m.type === 'unsubscribe' && m.security_id) c.subs.delete(m.security_id);
    } catch {}
  });
  ws.on('close', () => clients.delete(ws));
});

bus.on((msg) => {
  const dead = [];
  for (const [ws, c] of clients) {
    if (ws.readyState !== 1) { dead.push(ws); continue; }
    if (msg.type === 'dirty' && msg.user_id !== c.userId) continue;
    if ((msg.type === 'book' || msg.type === 'trade') && !c.subs.has(msg.security_id)) continue;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
  dead.forEach(ws => clients.delete(ws));
});

//.periodischer Ticker-/Leaderboard-Push
setInterval(() => {
  const ticker = engine.tickerAll();
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tickerAll', ticker }));
  }
}, 5000);

// ---------- Start ----------
bootstrap();
engine.loadEngine();
if (getSettings().idx_base_mcap === 0) {
  const stocks = db.prepare("SELECT * FROM securities WHERE type='stock' AND status='active'").all();
  let mcap = 0;
  for (const s of stocks) { const b = engine.books.get(s.id); if (b) mcap += b.last * s.total_shares; }
  if (mcap > 0) {
    const { setSetting } = require('./db');
    setSetting('idx_base_mcap', mcap);
  }
}
jobs.startJobs();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   🏦  SCHOOL-STREET — Börsensimulation läuft!     ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Spieler :  http://<serverip>:${PORT}/`.padEnd(52) + '║');
  console.log(`  ║  AG/Admin:  http://<serverip>:${PORT}/admin`.padEnd(52) + '║');
  console.log(`  ║  Board/TV:  http://<serverip>:${PORT}/board`.padEnd(52) + '║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log(`  Lokal: http://localhost:${PORT}   (DB: server/data/schoolstreet.db)`);
  if (!fs.existsSync(path.join(PUB, 'index.html')))
    console.log('  ⚠️  Frontend fehlt — bitte einmal `npm run build` ausführen.');
});
