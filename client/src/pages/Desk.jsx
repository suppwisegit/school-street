// Trading Desk (/desk): Markt-Übersicht für den PC — Kerzen-Grid über alle
// Werte, Markt-Scanner, Breadth, News & Leaderboard. Öffentlich wie /board,
// aber dicht & interaktiv statt Beamer-tauglich. Live via WS + Poll.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconLayoutDashboard, IconNews, IconTrophy } from '@tabler/icons-react';
import { api, fmtC, timeStr } from '../api.js';
import { useWS } from '../ws.jsx';
import { CandleChart } from '../charts.jsx';
import { Chip, Empty, ErrorBox, Loading, LivePrice, Pct } from '../ui.jsx';

const RANGES = [
  { label: '1H', ms: 3600000 },
  { label: '6H', ms: 6 * 3600000 },
  { label: '24H', ms: 24 * 3600000 },
  { label: '7D', ms: 7 * 86400000 }
];
const SORTS = [
  { key: 'default', label: 'Standard' },
  { key: 'chg_desc', label: 'Aufsteiger' },
  { key: 'chg_asc', label: 'Absteiger' },
  { key: 'vol', label: 'Volumen' },
  { key: 'mcap', label: 'Marktkapital' }
];

const KIND_TONE = { news: '', dividend: 'green', bafin: 'red', ipo: 'blue', system: 'blue', takeover: 'gold', etf: 'blue' };

export default function DeskPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [range, setRange] = useState(RANGES[2].ms);
  const [sort, setSort] = useState('default');
  const [now, setNow] = useState(Date.now());
  const [live, setLive] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    let alive = true;
    const load = () => api('/api/desk', { params: { range: rangeRef.current } })
      .then((r) => { if (alive) { setData(r); setErr(''); } })
      .catch((e) => { if (alive) setErr(e.message); });
    load();
    const t = setInterval(load, 12000);
    return () => { alive = false; clearInterval(t); };
  }, [range]);

  // Live-Kurse direkt in die Karten rieseln lassen (Charts kommen per Poll).
  useWS((m) => {
    setLive(true);
    if (m.type === 'tickerAll' && Array.isArray(m.ticker)) {
      setData((d) => d && { ...d, securities: d.securities.map((s) => {
        const t = m.ticker.find((x) => x.id === s.id);
        return t ? { ...s, last: t.last, chg: t.chg, bid: t.bid, ask: t.ask, vol: t.vol } : s;
      }) });
    } else if (m.type === 'news' && m.news) {
      setData((d) => d && { ...d, news: [m.news, ...(d.news || [])].filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i).slice(0, 15) });
    }
  });

  const secs = useMemo(() => {
    const list = [...(data?.securities || [])];
    if (sort === 'chg_desc') list.sort((a, b) => b.chg - a.chg);
    if (sort === 'chg_asc') list.sort((a, b) => a.chg - b.chg);
    if (sort === 'vol') list.sort((a, b) => (b.vol || 0) - (a.vol || 0));
    if (sort === 'mcap') list.sort((a, b) => (b.stats?.mcap || 0) - (a.stats?.mcap || 0));
    return list;
  }, [data, sort]);

  if (!data) {
    return <div className="desk"><div className="desk-center">{err ? <ErrorBox>{err}</ErrorBox> : <Loading label="Trading Desk lädt …" />}</div></div>;
  }

  const idxHist = data.index_history || [];
  const idxChg = idxHist.length > 1 ? (idxHist[idxHist.length - 1].v / idxHist[0].v - 1) * 100 : 0;
  const b = data.breadth || { advancers: 0, decliners: 0, unchanged: 0, stocks: 0 };
  const advPct = b.advancers + b.decliners > 0 ? (b.advancers / (b.advancers + b.decliners)) * 100 : 50;

  return (
    <div className="desk">
      {/* ---------- Kopf: Index, Breadth, Markt-KPIs, Zeitraum ---------- */}
      <header className="desk-head">
        <div className="desk-brand">
          <IconLayoutDashboard size={20} stroke={2} />
          SCHOOL-STREET <span className="street">DESK</span>
          <span className={`livedot ${live ? 'on' : ''}`} title="Live-Verbindung" />
        </div>

        <div className="desk-kpi big">
          <div className="lbl">SCHOOL-STREET INDEX</div>
          <div className="val num">{(data.index || 0).toLocaleString('de-DE')} <Pct v={idxChg} /></div>
        </div>

        <div className="desk-kpi">
          <div className="lbl">MARKT-BREITE · {b.advancers}▲ / {b.decliners}▼</div>
          <div className="desk-breadth" title={`${b.advancers} Aufsteiger, ${b.decliners} Absteiger, ${b.unchanged} unverändert`}>
            <div className="adv" style={{ width: `${advPct}%` }} />
            <div className="dec" style={{ width: `${100 - advPct}%` }} />
          </div>
        </div>

        <div className="desk-kpi">
          <div className="lbl">VOLUMEN 24H</div>
          <div className="val num">{(data.totals?.volume24 || 0).toLocaleString('de-DE')} St.</div>
        </div>
        <div className="desk-kpi">
          <div className="lbl">UMSATZ 24H</div>
          <div className="val num">{fmtC(data.totals?.turnover24 || 0)}</div>
        </div>
        <div className="desk-kpi">
          <div className="lbl">TRADES 24H</div>
          <div className="val num">{(data.totals?.trades24 || 0).toLocaleString('de-DE')}</div>
        </div>

        <div className="desk-head-right">
          <div className="desk-range tabs">
            {RANGES.map((r) => (
              <button key={r.label} className={range === r.ms ? 'on' : ''} onClick={() => setRange(r.ms)}>{r.label}</button>
            ))}
          </div>
          <div className="desk-links">
            <a href="/">App</a>{' · '}<a href="/board">Board</a>{' · '}<span className="num">{timeStr(now)}</span>
          </div>
        </div>
      </header>

      {err && <ErrorBox>{err}</ErrorBox>}

      <div className="desk-body">
        {/* ---------- Kerzen-Grid ---------- */}
        <div className="desk-main">
          <div className="row between wrap" style={{ marginBottom: 10 }}>
            <h2 className="desk-h2">Kurse · {secs.length} Wertpapiere</h2>
            <label className="row small muted" style={{ gap: 8 }}>
              Sortierung
              <select className="select sm" value={sort} onChange={(e) => setSort(e.target.value)}>
                {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className="desk-grid">
            {secs.map((s) => {
              const st = s.stats || {};
              return (
                <Link to={`/security/${s.id}`} key={s.id} className={`desk-card ${s.type}`}>
                  <div className="desk-card-head">
                    <div className="tkwrap">
                      <span className="tk">{s.ticker}</span>
                      <span className="typ">{s.type === 'etf' ? 'ETF' : 'AKTIE'}</span>
                      <div className="nm" title={s.name}>{s.name}</div>
                    </div>
                    <div className="price">
                      <LivePrice value={s.last} />
                      <Pct v={s.chg} />
                    </div>
                  </div>
                  <div className="desk-chart"><CandleChart candles={s.candles} /></div>
                  <div className="desk-stats">
                    <span className="k">Vol</span><span className="v num">{(s.vol || 0).toLocaleString('de-DE')}</span>
                    <span className="v num" title="Marktkapitalisierung">{fmtC(st.mcap ?? 0)}</span>
                    <span className="k">Ø (VWAP)</span><span className="v num">{st.vwap24 != null ? fmtC(st.vwap24) : '–'}</span>
                    <span className="v num" title="Spread">{st.spread_bp != null ? `${st.spread_bp} bp` : '–'}</span>
                    <span className="k">H / T</span>
                    <span className="v num">{st.high24 != null ? fmtC(st.high24) : '–'}</span>
                    <span className="v num">{st.low24 != null ? fmtC(st.low24) : '–'}</span>
                    {s.type === 'etf' && s.nav
                      ? <><span className="k">NAV</span><span className="v num">{fmtC(s.nav.nav_per_share)}</span>
                          <Pct v={s.nav.premium_pct ?? 0} /></>
                      : <><span className="k">Volatilität</span><span className="v num">{st.volatility_pct != null ? `${st.volatility_pct.toFixed(2)}%` : '–'}</span>
                          <span className="v num" title="Tiefe Bid / Ask">{(st.bid_depth ?? 0)} / {(st.ask_depth ?? 0)} St.</span></>}
                  </div>
                </Link>
              );
            })}
          </div>
          {secs.length === 0 && <Empty>Keine Wertpapiere gelistet.</Empty>}
        </div>

        {/* ---------- Seitenleiste: Scanner, News, Leaderboard ---------- */}
        <aside className="desk-side">
          <div className="desk-panel">
            <h3>MARKT-SCANNER</h3>
            <div className="scan">
              {secs.map((s) => (
                <Link to={`/security/${s.id}`} key={s.id} className="scan-row">
                  <span className="tk">{s.ticker}</span>
                  <span className="num ba"><span className="muted">B</span> {s.bid != null ? fmtC(s.bid) : '–'} <span className="muted">A</span> {s.ask != null ? fmtC(s.ask) : '–'}</span>
                  <span className="num px">{fmtC(s.last)}</span>
                  <Pct v={s.chg} />
                </Link>
              ))}
            </div>
          </div>

          <div className="desk-panel">
            <h3 className="row" style={{ gap: 6 }}><IconNews size={14} stroke={2} /> NEWS</h3>
            <div className="desk-news">
              {(data.news || []).map((n) => (
                <div className="news-row" key={n.id}>
                  <div className="row between">
                    <Chip tone={KIND_TONE[n.kind] || ''}>{n.kind}</Chip>
                    <span className="muted small num">{timeStr(n.created_at)}</span>
                  </div>
                  <div className="t">{n.title}</div>
                  {n.security_id && <div className="muted small">→ Wertpapier #{n.security_id}</div>}
                </div>
              ))}
              {(data.news || []).length === 0 && <Empty>Noch keine News.</Empty>}
            </div>
          </div>

          <div className="desk-panel">
            <h3 className="row" style={{ gap: 6 }}><IconTrophy size={14} stroke={2} /> LEADERBOARD · TOP 10</h3>
            {(data.leaderboard || []).map((u, i) => (
              <div className="scan-row" key={u.username}>
                <span className="num muted rk">{i + 1}</span>
                <span className="un">{u.username}</span>
                <span className="num px">{fmtC(u.worth)}</span>
              </div>
            ))}
            {(data.leaderboard || []).length === 0 && <Empty>Noch keine Trader.</Empty>}
          </div>
        </aside>
      </div>
    </div>
  );
}
