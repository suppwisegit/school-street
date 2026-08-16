// Board /board: TV-Ansicht für Aula/Beamer – ohne Login, ohne Scrollen, riesige Typo.
import React, { useEffect, useMemo, useState } from 'react';
import { IconTrendingDown, IconTrendingUp } from '@tabler/icons-react';
import { api, fmtC } from '../api.js';
import { useWS } from '../ws.jsx';
import { LineChart } from '../charts.jsx';
import { Loading, Pct } from '../ui.jsx';

const MEDAL_COLORS = ['#ffc24d', '#c7d2e4', '#d29a6a'];

export default function BoardPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());

  // Uhr
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Poll alle 10s
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/board')
      .then((r) => { if (alive) { setData(r); setErr(''); } })
      .catch((e) => { if (alive) setErr(e.message); });
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Live via WS: neue News + Kursticker
  useWS((m) => {
    if (m.type === 'news' && m.news) {
      setData((d) => (d ? { ...d, news: [m.news, ...(d.news || [])].filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i).slice(0, 12) } : d));
    } else if (m.type === 'tickerAll' && Array.isArray(m.ticker)) {
      setData((d) => {
        if (!d) return d;
        const withChg = m.ticker.filter((t) => t.type === 'stock' || t.type === 'etf');
        const sorted = [...withChg].sort((a, b) => b.chg - a.chg);
        const etfs = (d.etf || []).map((e) => {
          const t = m.ticker.find((x) => x.id === e.id);
          if (!t) return e;
          const nav = e.nav?.nav_per_share;
          const premium = e.nav && nav ? (t.last / nav - 1) * 100 : (e.nav?.premium_pct ?? 0);
          return { ...e, last: t.last, chg: t.chg, nav: e.nav ? { ...e.nav, last: t.last, premium_pct: premium } : e.nav };
        });
        return { ...d, tops: sorted.slice(0, 4), flops: [...sorted].reverse().filter((f) => f.chg < 0).slice(0, 4), etf: etfs };
      });
    }
  });

  const clock = useMemo(() => new Date(now).toLocaleTimeString('de-DE'), [now]);

  if (!data) {
    return (
      <div className="board" style={{ alignItems: 'center', justifyContent: 'center' }}>
        {err ? <div className="errbox">{err}</div> : <Loading label="School-Street Board lädt …" />}
      </div>
    );
  }

  const idxUp = (data.index_history || []).length > 1
    ? data.index_history[data.index_history.length - 1].v >= data.index_history[0].v
    : true;

  return (
    <div className="board">
      {/* Kopf */}
      <header className="board-head">
        <div>
          <div className="board-sub">SCHOOL-STREET · SCHULBÖRSE · LIVE</div>
          <div className="board-title">SCHOOL-STREET INDEX</div>
        </div>
        <div>
          <div className={`board-index num ${idxUp ? 'pos' : 'neg'}`}>{(data.index ?? 0).toLocaleString('de-DE')}</div>
        </div>
        <div className="board-clock num">{clock}</div>
      </header>

      {/* Index-Chart */}
      <div className="board-chart">
        <LineChart points={data.index_history} />
      </div>

      {/* Mitte: Tops/Flops + Leaderboard */}
      <div className="board-mid">
        <div className="board-col">
          <div className="board-panel grow">
            <h3 className="pos row" style={{ gap: 6 }}><IconTrendingUp size={15} stroke={2.2} /> TOPS</h3>
            <div className="tilegrid">
              {(data.tops || []).map((t) => (
                <div className="tile" key={'t' + t.id}>
                  <div className="row between"><span className="tk">{t.ticker}</span><span className="pc num pos">+{Number(t.chg || 0).toFixed(2)}%</span></div>
                  <div className="px num">{fmtC(t.last)}</div>
                </div>
              ))}
              {(!data.tops || data.tops.length === 0) && <div className="muted">Noch keine Kurse.</div>}
            </div>
          </div>
          <div className="board-panel">
            <h3 className="neg row" style={{ gap: 6 }}><IconTrendingDown size={15} stroke={2.2} /> FLOPS</h3>
            <div className="tilegrid">
              {(data.flops || []).map((t) => (
                <div className="tile" key={'f' + t.id}>
                  <div className="row between"><span className="tk">{t.ticker}</span><span className="pc num neg">{Number(t.chg || 0).toFixed(2)}%</span></div>
                  <div className="px num">{fmtC(t.last)}</div>
                </div>
              ))}
              {(!data.flops || data.flops.length === 0) && <div className="muted">Heute keine Verlierer.</div>}
            </div>
          </div>
        </div>

        <div className="board-col">
          <div className="board-panel grow">
            <h3>Leaderboard · Top 10</h3>
            {(data.leaderboard || []).map((u, i) => (
              <div className="lb-row" key={u.username}>
                <span className="un">
                  {i < 3
                    ? <b className="num" style={{ marginRight: 8, color: MEDAL_COLORS[i] }}>{i + 1}.</b>
                    : <span className="muted num" style={{ marginRight: 8 }}>{i + 1}.</span>}
                  {u.username}
                </span>
                <span className="wr num">{fmtC(u.worth)}</span>
              </div>
            ))}
            {(data.leaderboard || []).length === 0 && <div className="muted">Noch keine Trader.</div>}
          </div>
        </div>
      </div>

      {/* ETF-Kacheln + News-Ticker */}
      {(data.etf || []).length > 0 && (
        <div className="board-etfs">
          {data.etf.map((e) => (
            <div className="board-etf" key={e.id}>
              <span className="tk">{e.ticker}</span>
              <span className="v num">{fmtC(e.last)}</span>
              <span><span className="lbl">NAV </span><span className="v num">{fmtC(e.nav?.nav_per_share ?? 0)}</span></span>
              <span><Pct v={e.nav?.premium_pct ?? 0} /></span>
            </div>
          ))}
        </div>
      )}
      <footer className="marquee">
        <div className="marquee-inner">
          {[0, 1].map((dup) => (
            <span key={dup} style={{ display: 'inline-block' }}>
              {(data.news || []).map((n) => <span className="item" key={dup + '-' + n.id}>{n.title}</span>)}
              {(data.news || []).length === 0 && <span className="item">School-Street – die Börsen-Simulation deiner Schule</span>}
            </span>
          ))}
        </div>
      </footer>
    </div>
  );
}
