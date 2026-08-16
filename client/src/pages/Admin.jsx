// Admin-Panel der Investment AG: eigenes Login (nur role=admin), Tab-Navigation.
import React, { useCallback, useEffect, useState } from 'react';
import {
  IconBuildingBank, IconCoin, IconFileText, IconNews, IconRocket, IconSettings, IconTrendingUp, IconUsers
} from '@tabler/icons-react';
import { api, ADMIN_TOKEN_KEY } from '../api.js';
import { ErrorBox, Field, Loading, useToast } from '../ui.jsx';
import AdminOverview from './admin/AdminOverview.jsx';
import AdminIpo from './admin/AdminIpo.jsx';
import AdminRequests from './admin/AdminRequests.jsx';
import AdminNews from './admin/AdminNews.jsx';
import AdminDividend from './admin/AdminDividend.jsx';
import AdminEtf from './admin/AdminEtf.jsx';
import AdminUsers from './admin/AdminUsers.jsx';
import AdminSettings from './admin/AdminSettings.jsx';

const TABS = [
  { key: 'overview', label: 'Übersicht', Icon: IconTrendingUp, comp: AdminOverview },
  { key: 'ipo', label: 'IPO', Icon: IconRocket, comp: AdminIpo },
  { key: 'requests', label: 'Anträge', Icon: IconFileText, comp: AdminRequests },
  { key: 'news', label: 'News', Icon: IconNews, comp: AdminNews },
  { key: 'dividend', label: 'Dividende', Icon: IconCoin, comp: AdminDividend },
  { key: 'etf', label: 'ETF / AP', Icon: IconBuildingBank, comp: AdminEtf },
  { key: 'users', label: 'Nutzer', Icon: IconUsers, comp: AdminUsers },
  { key: 'settings', label: 'Einstellungen', Icon: IconSettings, comp: AdminSettings }
];

export default function AdminApp() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const A = useCallback((path, opts = {}) => api(path, { ...opts, token: localStorage.getItem(ADMIN_TOKEN_KEY) }), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const t = localStorage.getItem(ADMIN_TOKEN_KEY);
      if (!t) { setLoading(false); return; }
      try {
        const r = await api('/api/auth/me', { token: t });
        if (!alive) return;
        if (r.user.role !== 'admin') { localStorage.removeItem(ADMIN_TOKEN_KEY); setErr('Dieser Zugang ist kein Admin-Konto.'); }
        else setUser(r.user);
      } catch {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const login = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      if (r.user.role !== 'admin') {
        setErr('Kein Admin-Zugang. Dieses Konto ist ein Trader-Konto – hier langt nur die Investment AG.');
      } else {
        localStorage.setItem(ADMIN_TOKEN_KEY, r.token);
        setUser(r.user);
        toast('Investment AG eingeloggt', 'ok');
      }
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try { await A('/api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setUser(null);
  };

  if (loading) return <Loading label="Investment AG …" />;

  if (!user) {
    return (
      <div className="loginwrap">
        <div className="logincard">
          <div className="loginbrand">
            <div className="bigmark"><IconBuildingBank stroke={2} /></div>
            <h1>INVESTMENT AG</h1>
            <p>Börsenaufsicht · Zentralbank · ETF-AP</p>
          </div>
          <div className="card">
            <ErrorBox>{err}</ErrorBox>
            <form onSubmit={login}>
              <Field label="Admin-Username">
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
              </Field>
              <Field label="Passwort">
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <button className="btn primary block xl" disabled={busy} type="submit">{busy ? 'Bitte warten …' : 'Anmelden'}</button>
            </form>
            <div className="small muted center" style={{ marginTop: 10 }}><a href="/">← Zur Spieler-App</a></div>
          </div>
        </div>
      </div>
    );
  }

  const Active = TABS.find((t) => t.key === tab)?.comp || AdminOverview;
  return (
    <div className="admin-shell">
      <header className="admin-head">
        <div className="title">
          <span className="brandmark"><IconBuildingBank stroke={1.9} /></span>
          Investment AG <span className="muted small">| School-Street</span>
        </div>
        <nav className="admin-nav">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              <t.Icon size={15} stroke={1.9} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip">{user.username}</span>
          <button className="btn sm ghost" onClick={logout}>Logout</button>
        </div>
      </header>
      <main className="admin-body">
        <Active A={A} toast={toast} />
      </main>
    </div>
  );
}
