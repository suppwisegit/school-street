// Login und Registrierung: eine Spalte, ein Formular.
import React, { useState } from 'react';
import { Button, ErrorBox, Field, Input, Segmented, useToast } from '../ui.jsx';
import { api, setToken } from '../api.js';
import './Player.css';

const MODES = [
  { value: 'login', label: 'Anmelden' },
  { value: 'register', label: 'Konto anlegen' },
];

export default function Login({ onLogin }) {
  const toast = useToast();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const name = username.trim();
  const registering = mode === 'register';

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (name.length < 3 || name.length > 20) { setErr('Dein Name braucht 3 bis 20 Zeichen.'); return; }
    if (password.length < 4) { setErr('Dein Passwort braucht mindestens 4 Zeichen.'); return; }
    setBusy(true);
    try {
      const r = await api(`/api/auth/${registering ? 'register' : 'login'}`, { method: 'POST', body: { username: name, password } });
      setToken(r.token);
      toast(registering ? 'Konto eröffnet. Viel Erfolg an der Börse.' : `Willkommen zurück, ${r.user.username}.`, 'ok');
      onLogin(r.user);
    } catch (e2) {
      setErr((e2 && e2.message) || 'Das ging nicht.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <div>
        <h1>School Street</h1>
        <p className="muted">Die Börse deiner Schule.</p>
      </div>
      <Segmented value={mode} onChange={setMode} options={MODES} aria-label="Anmelden oder Konto anlegen" />
      <Field label="Name" help="3 bis 20 Zeichen. Buchstaben, Zahlen, _ . -">
        <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </Field>
      <Field label="Passwort" help={registering ? 'Mindestens 4 Zeichen.' : undefined}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={registering ? 'new-password' : 'current-password'}
        />
      </Field>
      <ErrorBox>{err}</ErrorBox>
      <Button type="submit" variant="primary" size="lg" full loading={busy}>Rein</Button>
    </form>
  );
}
