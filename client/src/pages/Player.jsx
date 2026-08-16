// Spieler-App-Shell: Login-Gate, Header, Tab-Leiste, Live-Refresh via WS 'dirty'.
import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { IconBriefcase, IconChartCandle, IconLogout, IconNews, IconTrendingUp, IconUser } from '@tabler/icons-react';
import { api, getToken, setToken } from '../api.js';
import { useWS } from '../ws.jsx';
import { Loading } from '../ui.jsx';
import Login from './Login.jsx';

const TABS = [
  { to: '/', end: true, label: 'Markt', Icon: IconChartCandle },
  { to: '/depot', end: false, label: 'Depot', Icon: IconBriefcase },
  { to: '/news', end: false, label: 'News', Icon: IconNews },
  { to: '/profile', end: false, label: 'Profil', Icon: IconUser }
];

export default function PlayerApp() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ver, setVer] = useState(0); // Daten-Version: Bump => Tabs laden Portfolio/Orders neu
  const navigate = useNavigate();

  const bump = useCallback(() => setVer((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) { setLoading(false); return; }
      try {
        const r = await api('/api/auth/me');
        if (!alive) return;
        if (r.user.role === 'admin') { setToken(null); setLoading(false); return; }
        setUser(r.user);
      } catch {
        setToken(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Portfolio/Orders neu laden, wenn der Server "dirty" für mich meldet
  useWS((m) => {
    if (m.type === 'dirty' && user && m.user_id === user.id) bump();
  });

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    setUser(null);
    navigate('/');
  };

  if (loading) return <Loading label="School-Street lädt …" />;
  if (!user) return <Login onLogin={(u) => { setUser(u); bump(); }} />;

  return (
    <div className="shell">
      <header className="shell-head">
        <div className="brand">
          <span className="brandmark"><IconTrendingUp stroke={2.1} /></span>
          <div className="wordmark">
            School<span className="street">Street</span>
            <small>Börse</small>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip">{user.username}</span>
          <button className="btn sm ghost" onClick={logout} title="Logout" aria-label="Logout"><IconLogout size={15} stroke={1.9} /></button>
        </div>
      </header>
      <main className="shell-body">
        <Outlet context={{ user, ver, bump }} />
      </main>
      <nav className="tabbar">
        {TABS.map(({ to, end, label, Icon }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'on' : '')}>
            <span className="ico tabglyph"><Icon stroke={1.8} /></span>
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
