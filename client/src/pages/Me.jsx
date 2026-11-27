// Profil: Name, Rangtitel, Wert — und die eigene Firma. Hier meldet man sich ab.
// Abfrage (Budget V4): /portfolio und /companies/mine beim Öffnen, bei `dirty`, alle 60 s.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Avatar, Button, Chip, ErrorBox, Field, Input, Money, Row, Section, Sheet, SkelRows, Textarea, useToast,
} from '../ui.jsx';
import { useDirty, usePoll } from '../hooks.jsx';
import { api } from '../api.js';
import { rankTitle } from './Rank.jsx';
import './Player.css';

const EMPTY = { name: '', ticker: '', description: '' };
const REFRESH_MS = 60000;

export default function Me() {
  const { user, logout } = useOutletContext();
  const toast = useToast();
  const [pf, setPf] = useState(null);
  const [mine, setMine] = useState({ applications: [], companies: [] });
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api('/api/portfolio'), api('/api/companies/mine')]);
      if (!alive.current) return;
      setPf(p);
      setMine(m || {});
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    }
  }, []);

  useDirty(null, load);
  usePoll(load, REFRESH_MS, [load]);

  const apply = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/companies/apply', {
        method: 'POST',
        body: { name: form.name.trim(), ticker: form.ticker.trim().toUpperCase(), description: form.description.trim() },
      });
      toast('Antrag ist da. Die Investment-AG schaut drauf.', 'ok');
      setOpen(false);
      setForm(EMPTY);
      await load();
    } catch (err) {
      toast((err && err.message) || 'Das ging nicht.', 'err');
    } finally {
      setBusy(false);
    }
  };

  if (!pf) {
    return (
      <div className="page">
        {failed
          ? <ErrorBox onRetry={load}>Dein Profil konnte nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <SkelRows n={4} h={56} />}
      </div>
    );
  }

  const pending = (mine.applications || []).filter((a) => a.status === 'pending');
  const companies = mine.companies || [];

  return (
    <div className="page">
      <header className="me-head">
        <Avatar seed={user.username} label={user.username} size={56} />
        <div>
          <h1>{user.username}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            <Money c={pf.net_worth} /> · {rankTitle(pf.net_worth)}
          </p>
        </div>
      </header>

      <Section title="Meine Firma">
        {companies.map((c) => (
          <Row key={c.id} title={c.name} sub={c.ticker} to={`/security/${c.id}`} trailing={<Chip>an der Börse</Chip>} />
        ))}
        {pending.map((a) => (
          <Row key={`antrag-${a.id}`} title={a.name} sub={a.ticker} trailing={<Chip tone="warn">Antrag läuft</Chip>} />
        ))}
        {companies.length === 0 && pending.length === 0 && (
          <Row
            onClick={() => setOpen(true)}
            title="Firma an die Börse bringen"
            sub="Du bekommst 1.000 Gründeraktien. Die Investment-AG prüft den Antrag."
            trailing={<span aria-hidden="true">›</span>}
          />
        )}
      </Section>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Firma an die Börse bringen"
        footer={(
          <Button type="submit" form="ipo-form" variant="primary" size="lg" full loading={busy}>
            Antrag senden
          </Button>
        )}
      >
        <form id="ipo-form" onSubmit={apply} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Firmenname" help="Mindestens 3 Zeichen.">
            <Input value={form.name} onChange={set('name')} maxLength={60} />
          </Field>
          <Field label="Kürzel" help="3 bis 6 Buchstaben, z. B. MENSA.">
            <Input value={form.ticker} onChange={set('ticker')} maxLength={6} autoComplete="off" />
          </Field>
          <Field label="Worum geht es?" help="Ein bis zwei Sätze.">
            <Textarea rows={4} value={form.description} onChange={set('description')} maxLength={500} />
          </Field>
        </form>
      </Sheet>

      <Button variant="ghost" full onClick={logout} style={{ marginTop: 32 }}>Ausloggen</Button>
    </div>
  );
}
