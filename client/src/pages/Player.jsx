// Spieler-Shell: Login-Zwang, Kopfzeile, Ticker-Band, Pausen-Streifen, vier Tabs.
// Ab hier gehen alle Seiten davon aus, dass sie in diese Shell eingebettet sind.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { IconChartCandle, IconNews, IconTrophy, IconWallet } from '@tabler/icons-react';
import { Avatar, Chip, Loading, TabBar } from '../ui.jsx';
import { getTickerRow, useGame, useTicker } from '../hooks.jsx';
import { api, fmtC, getToken, setToken } from '../api.js';
import { useWS } from '../ws.jsx';
import { useUnreadCount } from '../news/index.jsx';
import { useNews } from '../newsStore.js';
import { NEWS_CAP, arriveNews, hasReadState, useArrivedNews } from './newsArrived.js';
import Login from './Login.jsx';
import Market from './Market.jsx';
import './Player.css';

const TABS = [
  { to: '/', label: 'Markt', icon: IconChartCandle },
  { to: '/depot', label: 'Depot', icon: IconWallet },
  { to: '/news', label: 'News', icon: IconNews },
  { to: '/rank', label: 'Rang', icon: IconTrophy },
];
const PCT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function useWide() {
  const query = '(min-width: 1024px)';
  const read = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setOn(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return on;
}

// Zähler am Tab „News“: Zahl der ungelesenen News, höchstens „9+“, still. Der Chip ist für
// die Sprachausgabe versteckt, der Text „n ungelesene News“ steht als versteckter Text daneben
// (die Leiste nimmt den Tab-Namen aus ihrem Inhalt).
function NewsTabLabel({ count }) {
  return (
    <span className="tab-news">
      News
      {count > 0 && (
        <>
          <Chip className="tab-news-count" aria-hidden="true">{count > 9 ? '9+' : count}</Chip>
          <span className="tab-news-sr">{count > 9 ? 'mehr als 9' : count} ungelesene News</span>
        </>
      )}
    </span>
  );
}

// Die letzten 100 News als reine Id-Liste: reicht für den Zähler. Die Liste kommt aus dem
// gemeinsamen Vorrat (dieselbe Abfrage wie die News-Seite); die Zähler-Regel ohne
// Gelesen-Stand braucht zusätzlich die in dieser Sitzung angekommenen Ids.
function useNewsIds() {
  const { items } = useNews({ limit: NEWS_CAP });
  useWS((m) => {
    if (m.type !== 'news' || !m.news || m.news.id == null) return;
    arriveNews(m.news.id);
  });
  return items ? items.map((n) => ({ id: n.id })) : []; // ohne Antwort (Laden, Fehler) bleibt der Zähler aus
}

// Ticker-Band: Kürzel, Kurs und Veränderung aller Werte — die Signatur der App.
function Tape() {
  const { ids, version } = useTicker();
  const items = useMemo(() => ids.map((id) => getTickerRow(id)).filter(Boolean).map((r) => (
    <span className="tape-item" key={r.id}>
      <span className="tk">{r.ticker}</span>
      <span className="num">{fmtC(r.last)}</span>
      <span className={`num ${r.chg >= 0 ? 'pos' : 'neg'}`}>
        {r.chg >= 0 ? '+' : ''}{PCT.format(r.chg)} %
      </span>
    </span>
  )), [ids, version]);
  if (!items.length) return null;
  return (
    <div className="tape" aria-hidden="true">
      <div className="tape-track">
        <div className="tape-half">{items}</div>
        <div className="tape-half tape-dup">{items}</div>
      </div>
    </div>
  );
}

export default function PlayerApp() {
  const [user, setUser] = useState(null);
  const [state, setState] = useState('loading'); // loading | guest | in
  const [ver, setVer] = useState(0); // zählt hoch, wenn der Server „dirty" meldet
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useWide();
  const { paused } = useGame();
  const newsIds = useNewsIds();
  const arrivedIds = useArrivedNews();
  // Ohne Gelesen-Stand zählen nur die in dieser Sitzung angekommenen News.
  const counted = hasReadState(user && user.id)
    ? (newsIds || [])
    : arrivedIds.map((id) => ({ id }));
  const unread = useUnreadCount(user && user.id, counted);
  const bump = useCallback(() => setVer((v) => v + 1), []);

  useEffect(() => { delete document.documentElement.dataset.view; }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) { if (alive) setState('guest'); return; }
      try {
        const r = await api('/api/auth/me');
        if (!alive) return;
        if (!r.user || r.user.role !== 'user') { setToken(null); setState('guest'); return; }
        setUser(r.user);
        setState('in');
      } catch {
        if (alive) { setToken(null); setState('guest'); }
      }
    })();
    return () => { alive = false; };
  }, []);

  // Depot oder Orders haben sich geändert → Seiten laden neu
  useWS((m) => { if (m.type === 'dirty' && user && m.user_id === user.id) bump(); });

  const logout = useCallback(async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* Session läuft sonst nach 7 Tagen ab */ }
    setToken(null);
    setUser(null);
    setState('guest');
  }, []);

  if (state === 'loading') return <Loading label="School Street lädt …" />;
  if (state !== 'in' || !user) {
    return <Login onLogin={(u) => { setUser(u); setState('in'); bump(); }} />;
  }

  // Auf breiten Bildschirmen steht der Handel rechts neben der Markt-Liste.
  const onDetail = /^\/security\/\d+/.test(location.pathname);
  const tabs = TABS.map((t) => (t.to === '/news' ? { ...t, label: <NewsTabLabel count={unread} /> } : t));
  const outlet = <Outlet context={{ user, ver, bump, logout }} />;
  return (
    <div className="shell">
      <header className="shell-head">
        <span className="shell-brand">School Street</span>
        <button type="button" className="shell-me" onClick={() => navigate('/me')} aria-label="Profil">
          <Avatar seed={user.username} label={user.username} size={36} />
        </button>
      </header>
      <Tape />
      {paused && <div className="banner">Börse pausiert — gerade keine Orders.</div>}
      <main className="shell-body">
        {wide && onDetail ? (
          <div className="shell-wide">
            <aside><Market /></aside>
            <div className="shell-detail">{outlet}</div>
          </div>
        ) : outlet}
      </main>
      <TabBar items={tabs} active={onDetail ? '/' : location.pathname} />
    </div>
  );
}
