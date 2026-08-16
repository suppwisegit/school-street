// Depot: Hero-Zahl Gesamtvermögen, Sub-Stats, Positionen als Karten mit
// 24h-Sparkline, Trophäen, offene Orders + Historie.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { IconCrown, IconSchool, IconSnowflake } from '@tabler/icons-react';
import { api, dateTimeStr, fmtC } from '../api.js';
import { Sparkline } from '../charts.jsx';
import {
  Card, Empty, ErrorBox, HeroMoney, Money, Pct, Skel, SkelRows, Trophy, usePriceFlash, useToast
} from '../ui.jsx';
import { AvatarTile } from '../ui.jsx';

const STATUS = { open: 'offen', filled: 'ausgeführt', canceled: 'storniert' };

export default function DepotTab() {
  const { ver, bump } = useOutletContext();
  const toast = useToast();
  const [pf, setPf] = useState(null);
  const [orders, setOrders] = useState(null);
  const [sparks, setSparks] = useState({});
  const [err, setErr] = useState('');
  const heroFlash = usePriceFlash(pf ? pf.net_worth : 0);

  const load = useCallback(async () => {
    try {
      const [p, o] = await Promise.all([api('/api/portfolio'), api('/api/orders')]);
      setPf(p);
      setOrders(o.orders || []);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load, ver]);

  // 24h-Sparklines für alle Positionen (ein Request pro Wertpapier)
  useEffect(() => {
    if (!pf) return;
    let alive = true;
    for (const p of pf.positions || []) {
      if (sparks[p.security_id]) continue;
      api(`/api/securities/${p.security_id}/candles`, { params: { bucket: 1800000, range: 86400000 } })
        .then((r) => { if (alive) setSparks((s) => ({ ...s, [p.security_id]: (r.candles || []).map((c) => c.c) })); })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [pf]); // eslint-disable-line

  const cancel = async (o) => {
    try {
      await api(`/api/orders/${o.id}`, { method: 'DELETE' });
      toast(`Order ${o.ticker} storniert`, 'ok');
      load(); bump();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!pf) return (
    <div className="col" style={{ gap: 12 }}>
      <Skel h={130} radius={20} />
      <SkelRows n={3} h={70} />
    </div>
  );

  const openOrders = (orders || []).filter((o) => o.status === 'open');
  const history = (orders || []).filter((o) => o.status !== 'open').slice(0, 12);
  const unreal = (pf.positions || []).reduce((a, p) => a + p.pnl, 0);
  const posValue = (pf.positions || []).reduce((a, p) => a + p.value, 0);
  const unrealPct = posValue > 0 ? (unreal / (posValue - unreal)) * 100 : 0;

  return (
    <div className="col enter" style={{ gap: 12 }}>
      {/* Hero: Gesamtvermögen */}
      <div className={`hero ${heroFlash}`}>
        <div className="lbl">Gesamtvermögen</div>
        <div className="heronum"><HeroMoney cents={pf.net_worth} /></div>
        <div className="herosub">
          <span className={`chip ${unreal > 0 ? 'green' : unreal < 0 ? 'red' : ''}`}>
            <Money c={unreal} signed /> <Pct v={unrealPct} />
          </span>
          <span className="muted small">unrealisiert</span>
        </div>
      </div>

      {/* Sub-Stats */}
      <div className="statgrid">
        <div className="stat">
          <div className="lbl">Kontostand</div>
          <div className="val num">{fmtC(pf.cash)}</div>
        </div>
        <div className="stat">
          <div className="lbl">Depotwert</div>
          <div className="val num">{fmtC(posValue)}</div>
        </div>
        <div className="stat">
          <div className="lbl">Realisiert</div>
          <div className="val num" style={{ color: pf.realized_pl > 0 ? 'var(--up)' : pf.realized_pl < 0 ? 'var(--down)' : undefined }}>
            {pf.realized_pl > 0 ? '+' : ''}{fmtC(pf.realized_pl)}
          </div>
        </div>
      </div>

      <Badges pf={pf} />

      <Card title={`Positionen · ${(pf.positions || []).length}`}>
        {(pf.positions || []).length === 0 ? (
          <Empty>Noch keine Positionen – <Link to="/">am Markt kaufen</Link>.</Empty>
        ) : (
          (pf.positions || []).map((p) => (
            <Link key={p.security_id} to={`/security/${p.security_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="poscard">
                <AvatarTile seed={p.ticker} label={p.ticker} size={36} radius={11} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="tkr">{p.ticker}</span>
                    {p.type === 'etf' && <span className="etfchip">ETF</span>}
                  </div>
                  <div className="meta num">{p.amount} Stück · Ø {fmtC(p.avg_cost)}</div>
                </div>
                <div className="spark">
                  {sparks[p.security_id]?.length > 1
                    ? <Sparkline values={sparks[p.security_id]} />
                    : <Skel w={76} h={30} />}
                </div>
                <div className="px">
                  <div className="v num">{fmtC(p.value)}</div>
                  <div className="g"><Money c={p.pnl} colored signed /></div>
                </div>
              </div>
            </Link>
          ))
        )}
      </Card>

      <Card title={`Offene Orders · ${openOrders.length}`}>
        {openOrders.length === 0 ? (
          <Empty>Keine offenen Orders.</Empty>
        ) : (
          openOrders.map((o) => (
            <div className="row between" key={o.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(30,42,65,0.5)' }}>
              <div>
                <b>{o.ticker}</b> <span className="muted small">{o.side === 'buy' ? 'Kauf' : 'Verkauf'} · {o.type === 'limit' ? fmtC(o.price) : 'Market'} · {o.filled}/{o.amount}</span>
              </div>
              <button className="btn sm danger" onClick={() => cancel(o)}>Storno</button>
            </div>
          ))
        )}
      </Card>

      <Card title="Order-Historie">
        {history.length === 0 ? (
          <Empty>Noch keine abgeschlossenen Orders.</Empty>
        ) : (
          history.map((o) => (
            <div className="row between small" key={o.id} style={{ padding: '5px 0', borderBottom: '1px solid rgba(30,42,65,0.4)' }}>
              <span>
                <b>{o.ticker}</b> <span className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side === 'buy' ? 'K' : 'V'}</span>
                <span className="muted"> {o.filled}/{o.amount} {o.type === 'limit' ? '@ ' + fmtC(o.price) : 'Market'}</span>
              </span>
              <span className="muted num">{STATUS[o.status] || o.status} · {dateTimeStr(o.created_at)}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function Badges({ pf }) {
  const b = pf.badges || {};
  const items = [];
  for (const t of b.founder || []) {
    items.push(
      <Trophy
        key={'f' + t}
        rarity="rare"
        icon={<IconSchool stroke={1.8} />}
        title={`Gründer · ${t}`}
        desc="Unternehmen an die Börse gebracht"
      />
    );
  }
  if (b.bagholder) {
    items.push(
      <Trophy
        key="bag"
        rarity="shame"
        icon={<IconSnowflake stroke={1.8} />}
        title="Bagholder"
        desc="Position über 50 % unter Einstand"
      />
    );
  }
  if (b.takeover_king) {
    items.push(
      <Trophy
        key="tk"
        rarity="legendary"
        icon={<IconCrown stroke={1.8} />}
        title="Takeover-King"
        desc={`Mehrheit bei ${(b.takeovers || []).join(', ')}`}
      />
    );
  }
  if (!items.length) return null;
  return (
    <Card title="Trophäen">
      <div className="trophygrid">{items}</div>
    </Card>
  );
}
