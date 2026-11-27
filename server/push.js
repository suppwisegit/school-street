// ============================================================================
// Push-Pipeline: alle WebSocket-Broadcasts (tickerAll, ticker, book, trade,
// news, dirty, game). Jede Nachricht wird GENAU EINMAL serialisiert und der
// selbe Puffer geht an alle Empfänger (E002). Der tickerAll-Snapshot wird alle
// 5 s neu gebaut; neue Verbindungen bekommen genau diesen Puffer.
// ============================================================================
const { WebSocketServer } = require('ws');

const TICK_MS = 5000;               // Ticker-Snapshot
const PING_MS = 30000;              // Herzschlag: Server-Ping
const MAX_PAYLOAD = 1024;           // Client-Nachrichten: höchstens 1 KB
const MAX_BUFFERED = 1024 * 1024;   // Sendestau: ab 1 MB wird nicht weiter gefüttert (F14)
const MAX_SUBS = 500;               // Orderbuch-Abos je Verbindung

// Intervall, das einen Fehler protokolliert statt den Prozess zu beenden (F13).
function safeInterval(name, fn, ms, log = console.error) {
  return setInterval(() => {
    try { fn(); } catch (e) { log(`[Timer ${name}] Fehler:`, e); }
  }, ms);
}

function encode(msg) {
  const text = JSON.stringify(msg);
  return text === undefined ? null : Buffer.from(text);
}

// Spielzustand immer in Vertragsform (V2), egal wer ihn emittet.
function gameEvent(msg) {
  const g = msg.game || {};
  return { type: 'game', game: { ...g, paused: !!(g.paused ?? msg.paused) } };
}

// Einzige Schreibstelle: Text-Frame, damit Browser event.data als String
// bekommen. Ein Sendefehler darf niemanden mitreißen.
function write(ws, buf, log) {
  try { ws.send(buf, { binary: false }); return true; } catch (e) { log('[WS] Senden fehlgeschlagen:', e); return false; }
}

// `buf` an alle Sockets in `clients` (ws -> Zustand), die `will(c)` erlauben.
// Ein Socket mit Sendestau wird ausgelassen und bekommt beim Aufholen zuerst
// `last` (den aktuellen Kurs), damit es nicht auf veralteten Daten sitzt.
function fanout(clients, buf, will, last, log = console.error) {
  let sent = 0;
  for (const [ws, c] of clients) {
    if (ws.readyState !== 1) { clients.delete(ws); continue; }
    if (will && !will(c)) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) { c.stalled = true; continue; }
    if (c.stalled) { c.stalled = false; if (last && last !== buf) write(ws, last, log); }
    if (write(ws, buf, log)) sent++;
  }
  return sent;
}

// identify(token) -> {id, username, role} | null · tickerAll() -> TickerZeilen
// game() -> {paused} · tickMs/pingMs nur für Tests kürzer.
function createHub({ server, identify, tickerAll, game, tickMs = TICK_MS, pingMs = PING_MS, log = console.error }) {
  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
  const clients = new Map(); // ws -> { userId, subs:Set, alive, stalled }
  let lastTicker = null;     // letzter tickerAll-Snapshot (Puffer)

  wss.on('error', (e) => log('[WS] Server-Fehler:', e));

  function snapshot() {
    lastTicker = encode({ type: 'tickerAll', ticker: tickerAll() });
    return lastTicker;
  }

  function broadcast(msg) {
    const m = msg.type === 'game' ? gameEvent(msg) : msg;
    const buf = encode(m);
    if (!buf) return;
    const will = m.type === 'dirty' ? (c) => c.userId === m.user_id
      : (m.type === 'book' || m.type === 'trade') ? (c) => c.subs.has(m.security_id)
        : null;
    fanout(clients, buf, will, lastTicker, log);
  }

  wss.on('connection', (ws, req) => {
    const c = { userId: null, subs: new Set(), alive: true, stalled: false };
    clients.set(ws, c);
    ws.on('error', (e) => log('[WS] Socket-Fehler:', e));
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => { clients.delete(ws); if (!clients.size) lastTicker = null; });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; } // ungültiges JSON wird still verworfen
      const id = m && m.security_id;
      if (!Number.isInteger(id) || id <= 0) return;   // ID muss eine Zahl sein
      if (m.type === 'subscribe' && c.subs.size < MAX_SUBS) c.subs.add(id);
      else if (m.type === 'unsubscribe') c.subs.delete(id);
    });

    let user = null;
    try {
      user = identify(new URL(req.url, 'http://x').searchParams.get('token'));
    } catch (e) {
      log('[WS] Verbindung kann nicht zugeordnet werden:', e);
      ws.terminate();
      return;
    }
    c.userId = user ? user.id : null; // bestimmt, wer dirty bekommt
    write(ws, encode({ type: 'hello', user: user ? { id: user.id, username: user.username, role: user.role } : null, game: game() }), log);
    // Kurse sofort — sonst wartet der Client bis zu 5 s auf den ersten Ticker.
    try { write(ws, lastTicker || snapshot(), log); } catch (e) { log('[WS] Ticker-Snapshot fehlgeschlagen:', e); }
  });

  // Ticker: ein Snapshot je Takt, derselbe Puffer für alle.
  const tickTimer = safeInterval('ticker', () => fanout(clients, snapshot(), null, null, log), tickMs, log);

  // Herzschlag: ohne Pong seit dem letzten Takt gilt die Verbindung als tot.
  const pingTimer = safeInterval('ping', () => {
    for (const [ws, c] of clients) {
      if (ws.readyState !== 1) { clients.delete(ws); continue; }
      if (!c.alive) { ws.terminate(); clients.delete(ws); continue; }
      c.alive = false;
      try { ws.ping(); } catch (e) { log('[WS] Ping fehlgeschlagen:', e); }
    }
  }, pingMs, log);

  function close() {
    clearInterval(tickTimer);
    clearInterval(pingTimer);
    for (const ws of clients.keys()) ws.terminate();
    clients.clear();
    wss.close();
  }

  return { broadcast, snapshot, close, get size() { return clients.size; } };
}

module.exports = { createHub, fanout, safeInterval, TICK_MS, PING_MS, MAX_PAYLOAD, MAX_BUFFERED };
