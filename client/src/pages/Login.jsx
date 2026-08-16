// Login/Register-Karte für die Spieler-App.
import React, { useState } from 'react';
import { IconTrendingUp } from '@tabler/icons-react';
import { api, setToken } from '../api.js';
import { ErrorBox, Field, useToast } from '../ui.jsx';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const nameOk = username.trim().length >= 3 && username.trim().length <= 20;
  const pwOk = password.length >= 4;

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!nameOk) return setErr('Username: 3–20 Zeichen');
    if (mode === 'register' && !pwOk) return setErr('Passwort: min. 4 Zeichen');
    if (!pwOk) return setErr('Bitte Passwort eingeben (min. 4 Zeichen)');
    setBusy(true);
    try {
      const r = await api('/api/auth/' + (mode === 'login' ? 'login' : 'register'), {
        method: 'POST',
        body: { username: username.trim(), password }
      });
      setToken(r.token);
      toast((mode === 'login' ? 'Willkommen zurück, ' : 'Depot eröffnet: ') + r.user.username, 'ok');
      onLogin(r.user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginwrap">
      <div className="logincard">
        <div className="loginbrand">
          <div className="bigmark"><IconTrendingUp stroke={2.1} /></div>
          <h1>School<span className="street">Street</span></h1>
          <p>Die Börse deiner Schule</p>
        </div>
        <div className="card">
          <div className="tabs">
            <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(''); }}>Login</button>
            <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr(''); }}>Registrieren</button>
          </div>
          <div style={{ height: 12 }} />
          <ErrorBox>{err}</ErrorBox>
          <form onSubmit={submit}>
            <Field label="Username" help="3–20 Zeichen (Buchstaben, Zahlen, _ . -)">
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="z.B. warren_b" autoComplete="username" />
            </Field>
            <Field label="Passwort" help={mode === 'register' ? 'min. 4 Zeichen' : undefined}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            </Field>
            <button className={`btn ${mode === 'register' ? 'primary' : 'buy'} block xl`} disabled={busy} type="submit">
              {busy ? 'Bitte warten …' : mode === 'login' ? 'Einloggen' : 'Depot eröffnen'}
            </button>
          </form>
          <div className="small muted center" style={{ marginTop: 10 }}>
            Du startest mit 10.000 Credits Startkapital. <a href="/board">Zur Aula-Anzeige</a>
          </div>
        </div>
      </div>
    </div>
  );
}
