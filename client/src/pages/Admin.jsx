// Admin-Panel „Börse verwalten": eigene Shell mit Login (nur role=admin) und Leiste oben.
// Die Routen legt App.jsx. Default-Export = Shell, die vier Bereiche sind benannte Exporte.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, ADMIN_TOKEN_KEY } from '../api.js';
import { Button, ErrorBox, Field, Input, Loading, useToast } from '../ui.jsx';
import AdminGame from './admin/AdminGame.jsx';
import AdminNews from './admin/AdminNews.jsx';
import AdminSecurities from './admin/AdminSecurities.jsx';
import AdminUsers from './admin/AdminUsers.jsx';
import './Admin.css';

export { AdminGame, AdminNews, AdminSecurities, AdminUsers };

const AREAS = [
  { key: 'spiel', to: '/admin/spiel', label: 'Spiel' },
  { key: 'news', to: '/admin/news', label: 'News' },
  { key: 'werte', to: '/admin/werte', label: 'Werte' },
  { key: 'nutzer', to: '/admin/nutzer', label: 'Nutzer' },
];

export default function AdminApp() {
  const toast = useToast();
  const { pathname } = useLocation();
  // Aktiver Bereich aus der Adresse; /admin allein zählt als Spiel
  const cur = pathname.replace(/\/+$/, '').split('/')[2] || 'spiel';
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Request-Wrapper mit Admin-Token (die Bereiche bekommen ihn über den Outlet-Context)
  const A = useCallback(
    (path, opts = {}) => api(path, { ...opts, token: localStorage.getItem(ADMIN_TOKEN_KEY) }),
    [],
  );

  // Fassung „admin" am <html>-Element (schaltet die Tokens); beim Verlassen wieder weg
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-view', 'admin');
    return () => root.removeAttribute('data-view');
  }, []);

  // Gespeicherten Sitzung prüfen
  useEffect(() => {
    let alive = true;
    const t = localStorage.getItem(ADMIN_TOKEN_KEY);
    if (!t) { setLoading(false); return undefined; }
    api('/api/auth/me', { token: t })
      .then((r) => {
        if (!alive) return;
        if (!r.user || r.user.role !== 'admin') {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          setErr('Dieses Konto darf die Börse nicht verwalten.');
        } else setUser(r.user);
      })
      .catch(() => localStorage.removeItem(ADMIN_TOKEN_KEY))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const login = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username: name.trim(), password } });
      if (!r.user || r.user.role !== 'admin') {
        // Sitzung eines Spieler-Kontos nicht offen lassen
        api('/api/auth/logout', { method: 'POST', token: r.token }).catch(() => {});
        setErr('Das ist ein Spieler-Konto. Nur die Investment-AG darf die Börse verwalten.');
      } else {
        localStorage.setItem(ADMIN_TOKEN_KEY, r.token);
        setUser(r.user);
        toast('Du bist drin.', 'ok');
      }
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try { await A('/api/auth/logout', { method: 'POST' }); } catch { /* Token wird sowieso verworfen */ }
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setUser(null);
    setName('');
    setPassword('');
    toast('Ausgeloggt.', 'info');
  };

  if (loading) return <div className="admin-shell"><Loading label="Dein Login wird geprüft …" /></div>;

  if (!user) {
    return (
      <div className="admin-shell">
        <main className="admin-login">
          <h1>Börse verwalten</h1>
          <form onSubmit={login}>
            <ErrorBox>{err}</ErrorBox>
            <Field label="Name" htmlFor="admin-name">
              <Input
                id="admin-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field label="Passwort" htmlFor="admin-pass">
              <Input
                id="admin-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Button type="submit" size="lg" full loading={busy} disabled={!name.trim() || !password}>
              Rein
            </Button>
          </form>
          <Link className="admin-back" to="/">Zur Spieler-App</Link>
        </main>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-head">
        <Link className="admin-brand" to="/admin/spiel">Börse verwalten</Link>
        <nav className="admin-nav" aria-label="Bereiche">
          {AREAS.map((a) => (
            <NavLink
              key={a.key}
              to={a.to}
              className={cur === a.key ? 'on' : ''}
              aria-current={cur === a.key ? 'page' : undefined}
            >
              {a.label}
            </NavLink>
          ))}
        </nav>
        <div className="admin-user">
          <span className="small muted">{user.username}</span>
          <Button variant="ghost" size="sm" onClick={logout}>Ausloggen</Button>
        </div>
      </header>
      <main className="admin-main">
        <Outlet context={{ A }} />
      </main>
    </div>
  );
}
