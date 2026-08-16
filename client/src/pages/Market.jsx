// Markt-Tab: Liste aller Wertpapiere, live via WS (tickerAll alle 5s, ticker-Events).
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconSearch } from '@tabler/icons-react';
import { api, fmtC } from '../api.js';
import { useWS } from '../ws.jsx';
import { AvatarTile, Empty, ErrorBox, LivePrice, Pct, SkelRows } from '../ui.jsx';

export default function MarketTab() {
  const [secs, setSecs] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/securities')
      .then((r) => { if (alive) setSecs(r.securities || []); })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, []);

  useWS((m) => {
    if (m.type === 'tickerAll' && Array.isArray(m.ticker)) setSecs(m.ticker);
    else if (m.type === 'ticker' && m.ticker && m.ticker.id != null) {
      setSecs((list) => (list || []).map((s) => (s.id === m.ticker.id ? { ...s, ...m.ticker } : s)));
    }
  });

  const filtered = useMemo(() => {
    const list = secs || [];
    if (!q.trim()) return list;
    const needle = q.trim().toLowerCase();
    return list.filter((s) => s.ticker.toLowerCase().includes(needle) || (s.name || '').toLowerCase().includes(needle));
  }, [secs, q]);

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!secs) return (
    <div className="col" style={{ gap: 10 }}>
      <div className="skel" style={{ height: 46, borderRadius: 12 }} />
      <SkelRows n={5} />
    </div>
  );

  return (
    <div className="col enter" style={{ gap: 10 }}>
      <div className="searchwrap">
        <IconSearch size={16} stroke={1.9} />
        <input className="input" placeholder="Ticker oder Name suchen …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Wertpapiere durchsuchen" />
      </div>
      {filtered.length === 0 && <Empty>Keine Wertpapiere gefunden.</Empty>}
      {filtered.map((s) => (
        <Link key={s.id} to={`/security/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="card tight hover secrow">
            <AvatarTile seed={s.ticker} label={s.ticker} />
            <div className="grow">
              <div className="row" style={{ gap: 6 }}>
                <span className="tk">{s.ticker}</span>
                {s.type === 'etf' && <span className="etfchip">ETF</span>}
              </div>
              <div className="nm">{s.name}</div>
              <div className="ba num">
                Geld {s.bid != null ? fmtC(s.bid) : '–'} · Brief {s.ask != null ? fmtC(s.ask) : '–'} · Vol {(s.vol || 0).toLocaleString('de-DE')}
              </div>
            </div>
            <div className="px">
              <div className="last"><LivePrice value={s.last} /></div>
              <Pct v={s.chg} className="chg" />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
