// Depot: Der Depotwert ist die eine große Zahl, live mit den Kursen. Darunter
// Cash und Investiert, die Positionen, offene Orders und der Verlauf.
// Abfragen (Budget V4): /portfolio und /orders beim Öffnen, bei `dirty` und
// sicherheitshalber alle 60 s — die Kurse selbst kommen aus dem Ticker-Speicher
// und kosten keine Abfrage.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Empty, ErrorBox, LivePrice, Money, Num, Pct, Row, Section, SkelRows, Symbol, useToast,
} from '../ui.jsx';
import { getTickerRow, useDirty, usePoll, useTicker, useTickerRow } from '../hooks.jsx';
import { api, dateTimeStr, fmtC } from '../api.js';
import './Depot.css';

const REFRESH_MS = 60000;
const sign = (v) => (v >= 0 ? '+' : '−');
const lastOf = (p) => {
  const t = getTickerRow(p.security_id);
  return t && t.last != null ? t.last : p.last;
};

// Eine Position. Rendert nur neu, wenn sich genau ihr Kurs ändert.
const PositionRow = memo(function PositionRow({ p }) {
  const t = useTickerRow(p.security_id);
  const last = t && t.last != null ? t.last : p.last;
  const pnl = (last - p.avg_cost) * p.amount;
  const up = pnl >= 0;
  return (
    <Row
      to={`/security/${p.security_id}`}
      leading={(
        <div className="dep-id">
          <Symbol ticker={p.ticker} name={p.name} />
          <span className="muted small">
            <Num v={p.amount} /> Stück · gekauft zu {fmtC(p.avg_cost)}
          </span>
        </div>
      )}
      trailing={(
        <>
          <LivePrice value={p.amount * last} className="dep-value" />
          <span className={`num small ${up ? 'pos' : 'neg'}`}>
            {sign(pnl)}{fmtC(Math.abs(pnl))} · <Pct v={p.avg_cost > 0 ? ((last / p.avg_cost - 1) * 100) : 0} signed />
          </span>
        </>
      )}
    />
  );
});

// Depotwert und offener Gewinn: rechnet mit den Live-Kursen aller Positionen.
function Worth({ positions, cash }) {
  const { version } = useTicker(); // ändert sich, sobald irgendein Kurs springt
  let value = cash;
  let pnl = 0;
  for (const p of positions) {
    const last = lastOf(p);
    value += p.amount * last;
    pnl += (last - p.avg_cost) * p.amount;
  }
  const basis = value - pnl;
  const pct = basis > 0 ? (pnl / basis) * 100 : 0;
  void version;
  return (
    <header className="dep-hero">
      <p className="muted small">Depotwert</p>
      <LivePrice value={value} className="num-hero" />
      <p className={`dep-pnl ${pnl >= 0 ? 'pos' : 'neg'}`}>
        {sign(pnl)}{fmtC(Math.abs(pnl))} · <Pct v={pct} signed /> im Depot
      </p>
    </header>
  );
}

const SIDE = { buy: 'Kauf', sell: 'Verkauf' };
const orderTitle = (o) => `${SIDE[o.side] || o.side} ${o.amount} ${o.ticker || ''}`.trim();
function orderSub(o) {
  const px = o.type === 'limit' ? `Limit ${fmtC(o.price)}` : 'Markt';
  const part = o.status === 'open' && o.filled > 0 ? `, ${o.filled} ausgeführt` : '';
  const state = o.status === 'open' ? `offen${part}` : o.status === 'filled' ? 'ausgeführt' : 'storniert';
  return `${px} · ${state} · ${dateTimeStr(o.created_at)}`;
}

export default function Depot() {
  const toast = useToast();
  const navigate = useNavigate();
  const [pf, setPf] = useState(null);
  const [orders, setOrders] = useState([]);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const [p, o] = await Promise.all([api('/api/portfolio'), api('/api/orders')]);
      if (!alive.current) return;
      setPf(p);
      setOrders((o && o.orders) || []);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true); // ohne Daten: Fehlerzustand; mit alten Daten: weiter anzeigen
    }
  }, []);

  useDirty(null, load);
  usePoll(load, REFRESH_MS, [load]);

  const cancel = useCallback(async (id) => {
    try {
      await api(`/api/orders/${id}`, { method: 'DELETE' });
      toast('Order storniert.', 'ok');
      await load();
    } catch (e) {
      toast(e && e.message ? e.message : 'Das ging nicht.', 'err');
    }
  }, [load, toast]);

  if (!pf) {
    return (
      <div className="page depot">
        {failed
          ? <ErrorBox onRetry={load}>Das Depot konnte nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <SkelRows n={6} h={56} />}
      </div>
    );
  }

  const open = orders.filter((o) => o.status === 'open');
  const history = orders.filter((o) => o.status !== 'open').slice(0, 20);
  const invested = pf.positions.reduce((s, p) => s + p.value, 0);

  return (
    <div className="page depot">
      <Worth positions={pf.positions} cash={pf.cash} />
      {failed && <ErrorBox onRetry={load}>Die Zahlen sind nicht mehr aktuell. Prüf deine Verbindung.</ErrorBox>}

      <Section>
        <Row title="Cash" trailing={<Money c={pf.cash} className="dep-fact" />} />
        <Row title="Investiert" trailing={<Money c={invested} className="dep-fact" />} />
      </Section>

      <Section title="Positionen">
        {pf.positions.length === 0 ? (
          <Empty title="Noch nichts im Depot." className="dep-empty">
            Kauf deine erste Aktie — im Markt.
            <Button variant="primary" onClick={() => navigate('/')}>Zum Markt</Button>
          </Empty>
        ) : (
          pf.positions.map((p) => <PositionRow key={p.security_id} p={p} />)
        )}
      </Section>

      {open.length > 0 && (
        <Section title="Offene Orders">
          {open.map((o) => (
            <Row
              key={o.id}
              title={orderTitle(o)}
              sub={orderSub(o)}
              trailing={<Button variant="ghost" size="sm" onClick={() => cancel(o.id)}>Storno</Button>}
            />
          ))}
        </Section>
      )}

      {history.length > 0 && (
        <Section title="Verlauf">
          {history.map((o) => (
            <Row
              key={o.id}
              title={orderTitle(o)}
              sub={orderSub(o)}
              to={o.security_id ? `/security/${o.security_id}` : undefined}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
