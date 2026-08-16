// WebSocket-Layer: Context mit Auto-Reconnect und Ref-Count-Subscriptions.
// Server-Push: tickerAll / ticker / book / trade / news / dirty / hello
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const WSContext = createContext(null);

export function WSProvider({ children }) {
  const [status, setStatus] = useState('connecting');
  const wsRef = useRef(null);
  const listenersRef = useRef(new Set());
  const subsRef = useRef(new Map()); // security_id -> Anzahl aktiver Komponenten
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    let timer = null;
    const connect = () => {
      if (closedRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = localStorage.getItem('ss_token');
      let ws;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`);
      } catch {
        timer = setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus('open');
        // Nach Reconnect: Subscriptions erneuern
        for (const id of subsRef.current.keys()) {
          try { ws.send(JSON.stringify({ type: 'subscribe', security_id: id })); } catch {}
        }
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        for (const fn of listenersRef.current) {
          try { fn(m); } catch {}
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) setStatus('closed');
        if (wsRef.current === ws && !closedRef.current) timer = setTimeout(connect, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();
    // Token-Änderung (Login/Logout): sofort neu verbinden, damit dirty-Events ankommen
    const onToken = () => {
      clearTimeout(timer);
      try { wsRef.current && wsRef.current.close(); } catch {}
      connect();
    };
    window.addEventListener('ss-token-changed', onToken);
    return () => {
      closedRef.current = true;
      clearTimeout(timer);
      window.removeEventListener('ss-token-changed', onToken);
      try { wsRef.current && wsRef.current.close(); } catch {}
    };
  }, []);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
  }, []);

  const subscribe = useCallback((secId) => {
    const n = (subsRef.current.get(secId) || 0) + 1;
    subsRef.current.set(secId, n);
    if (n === 1) send({ type: 'subscribe', security_id: secId });
  }, [send]);

  const unsubscribe = useCallback((secId) => {
    const n = (subsRef.current.get(secId) || 0) - 1;
    if (n <= 0) { subsRef.current.delete(secId); send({ type: 'unsubscribe', security_id: secId }); }
    else subsRef.current.set(secId, n);
  }, [send]);

  const addListener = useCallback((fn) => { listenersRef.current.add(fn); }, []);
  const removeListener = useCallback((fn) => { listenersRef.current.delete(fn); }, []);

  return (
    <WSContext.Provider value={{ status, subscribe, unsubscribe, addListener, removeListener }}>
      {children}
    </WSContext.Provider>
  );
}

// useWS(handler): handler wird bei jeder WS-Nachricht aufgerufen (immer aktuell, kein Stale-Closure).
export function useWS(handler) {
  const ctx = useContext(WSContext);
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    const fn = (m) => ref.current(m);
    ctx.addListener(fn);
    return () => ctx.removeListener(fn);
  }, [ctx]);
  return ctx;
}

// Hilfs-Hook: Abonnement eines Wertpapiers (book/trade-Events) für die Lebensdauer der Komponente
export function useSubscribe(secId) {
  const ctx = useContext(WSContext);
  useEffect(() => {
    if (secId == null) return;
    ctx.subscribe(secId);
    return () => ctx.unsubscribe(secId);
  }, [ctx, secId]);
}
