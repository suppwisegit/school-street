// hooks.jsx — Live-Daten und Abfrage-Rhythmus für alle Seiten.
// Prinzip: Die Kurse liegen in EINEM Speicher außerhalb von React. Eine Zeile
// abonniert genau ihren Wert und rendert nur neu, wenn sich ihr Kurs ändert —
// nicht bei jedem Ticker, nicht mit der ganzen Liste.
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from './api.js';
import { addFeed, useWS } from './ws.jsx';
import { newsPush } from './newsStore.js';

export { Sparkline, LineChart } from './charts.jsx';

// Kerzenchart bringt die Chart-Bibliothek mit (~300 KB) → eigener Chunk, erst
// geladen, wenn ein Wert geöffnet wird.
const CandleChartImpl = lazy(() => import('./candle.jsx').then((m) => ({ default: m.CandleChart })));
export function CandleChart(props) {
  return (
    <Suspense fallback={<div className="chart-loading" />}>
      <CandleChartImpl {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Ticker-Speicher
// ---------------------------------------------------------------------------
const ticker = { rows: new Map(), ids: [], listeners: new Set(), version: 0 };
let lastMsg = null;

function sameRow(a, b) {
  for (const k in b) if (a[k] !== b[k]) return false;
  return true;
}

// `tickerAll` kommt beim Verbinden und alle 5 s, `ticker` nach jedem Trade.
// identicaler Inhalt bleibt dasselbe Objekt → keine unnötige Renderings.
function onTicker(m) {
  if (m === lastMsg) return; // mehrere Zeilen hören auf dieselbe Nachricht
  lastMsg = m;
  let changed = false;
  if (m.type === 'tickerAll' && Array.isArray(m.ticker)) {
    ticker.ids = m.ticker.map((r) => r.id);
    for (const row of m.ticker) changed = upsert(row) || changed;
  } else if (m.type === 'ticker' && m.ticker) {
    changed = upsert(m.ticker);
  } else {
    return;
  }
  if (changed) {
    ticker.version++;
    for (const l of ticker.listeners) l();
  }
}
function upsert(row) {
  if (!row || row.id == null) return false;
  const old = ticker.rows.get(row.id);
  if (old && sameRow(old, row)) return false;
  ticker.rows.set(row.id, row);
  return true;
}
const subTicker = (fn) => { ticker.listeners.add(fn); return () => { ticker.listeners.delete(fn); }; };

// Der Speicher wird unabhängig von sichtbaren Seiten gespeist: immer aktiv, nicht
// erst, wenn eine Seite `useTicker` aufruft.
addFeed(onTicker);
addFeed(newsPush); // neue News einmal für den gemeinsamen Vorrat (newsStore.js)

// Zeile außerhalb von React (z. B. beim Filtern einer Liste): gleicher Typ wie useTickerRow.
export const getTickerRow = (id) => ticker.rows.get(id) || null;

// Alle Wertpapiere in der Reihenfolge des Servers: { ready, ids }
export function useTicker() {
  const version = useSyncExternalStore(subTicker, () => ticker.version);
  return useMemo(() => ({ ready: ticker.ids.length > 0, ids: ticker.ids, version }), [version]);
}

// Eine Ticker-Zeile: { id, ticker, name, type, last, ref, chg, bid, ask, vol } oder null.
export function useTickerRow(id) {
  return useSyncExternalStore(subTicker, () => ticker.rows.get(id) || null);
}

// ---------------------------------------------------------------------------
// Spielzustand (Pause)
// ---------------------------------------------------------------------------
// ipoHighlightSec: wie lange ein Börsengang als „neu“ gilt (Sekunden, Wanduhr) — öffentlich aus
// GET /api/game; null, solange der Server es nicht geschickt hat.
const game = { paused: false, ready: false, ipoHighlightSec: null, listeners: new Set(), version: 0 };
let lastGameMsg = null;
let gameFetched = false;

function onGame(m) {
  if (m === lastGameMsg) return;
  lastGameMsg = m;
  const g = m && m.game;
  if (m && m.type === 'hello') {
    game.ready = true;
    if (g && typeof g.paused === 'boolean') game.paused = g.paused;
  } else if (m && m.type === 'game' && g && typeof g.paused === 'boolean') {
    game.paused = g.paused;
  } else {
    return;
  }
  game.version++;
  for (const l of game.listeners) l();
}
const subGame = (fn) => { game.listeners.add(fn); return () => { game.listeners.delete(fn); }; };
addFeed(onGame); // Pause/Weiterkommen kommt auch an, wenn gerade keine Seite zuhört

// { paused, ready } — gespeist aus `hello` und `game` (WebSocket), beim Start
// zusätzlich aus GET /api/game.
export function useGame() {
  useEffect(() => {
    if (gameFetched) return;
    gameFetched = true;
    api('/api/game')
      .then((g) => {
        if (g && typeof g.paused === 'boolean') onGame({ type: 'game', game: { paused: g.paused } });
        const sec = Number(g && g.ipo_highlight_sec);
        if (g && Number.isFinite(sec) && sec !== game.ipoHighlightSec) { game.ipoHighlightSec = sec; game.version++; for (const l of game.listeners) l(); }
      })
      .catch(() => { /* Endpunkt (noch) nicht da — WebSocket meldet den Zustand */ });
  }, []);
  const version = useSyncExternalStore(subGame, () => game.version);
  return useMemo(() => ({ paused: game.paused, ready: game.ready }), [version]);
}

// ipo_highlight_sec aus GET /api/game (null = noch nicht geladen oder der Server kennt es nicht).
export function useIpoHighlightSec() {
  useSyncExternalStore(subGame, () => game.ipoHighlightSec);
  return game.ipoHighlightSec;
}

// ---------------------------------------------------------------------------
// Abfragen
// ---------------------------------------------------------------------------
// Holt in einem Rhythmus — aber nur, sichtbar, nie überlappend, nie unter 5 s.
// `fn` darf async sein und seine eigenen Fehler behandeln.
export function usePoll(fn, ms, deps = []) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  const key = JSON.stringify(deps);
  useEffect(() => {
    let alive = true, busy = false, timer = null;
    const run = async () => {
      if (!alive || document.hidden || busy) return;
      busy = true;
      try { await ref.current(); } catch { /* meldet die Seite selbst */ } finally { busy = false; }
    };
    const schedule = () => {
      timer = setTimeout(async () => { await run(); if (alive) schedule(); }, Math.max(5000, ms || 0));
    };
    run();
    schedule();
    const onVisible = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
}

// Reagiert auf `dirty` (Depot/Orders haben sich geändert), entprellt.
// what: 'portfolio' | 'orders' | null (null = alles)
export function useDirty(what, fn, wait = 400) {
  const ref = useRef(fn);
  const timer = useRef(null);
  useEffect(() => { ref.current = fn; });
  useEffect(() => () => clearTimeout(timer.current), []);
  const handler = useCallback((m) => {
    if (!m || m.type !== 'dirty' || !Array.isArray(m.what)) return;
    if (what && !m.what.includes(what)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), wait);
  }, [what, wait]);
  useWS(handler);
}
