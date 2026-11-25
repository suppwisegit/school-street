// Admin, Bereich „Nutzer": Suche und Liste (ohne Bots). Je Zeile: Passwort zurücksetzen (Sheet),
// Guthaben aufladen (Sheet), Einfrieren/Auftauen, Löschen (nur über Confirm).
// Stand: GET /api/admin/users?q= alle 10 s (nur sichtbar), bei neuer Suche und nach jeder Aktion.
import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { dateTimeStr, fmtC } from '../../api.js';
import { IconSearch } from '@tabler/icons-react';
import {
  Avatar, Button, Chip, Confirm, Empty, ErrorBox, Field, Input, Money, Row, Section, Sheet, SkelRows, useToast,
} from '../../ui.jsx';
import { usePoll } from '../../hooks.jsx';

const TOPUP_MAX = 1000000; // Credits, Obergrenze des Backend
// Eingabe in Credits → Zahl; NaN, wenn leer oder keine Zahl
const credit = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  return s === '' ? NaN : Number(s);
};

export default function AdminUsers() {
  const { A } = useOutletContext();
  const toast = useToast();
  const [q, setQ] = useState(''); // Eingabe im Suchfeld
  const [query, setQuery] = useState(''); // Suche, nach kurzer Ruhepause gestellt
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState('');
  const [ver, setVer] = useState(0);
  const [busy, setBusy] = useState('');
  // Offener Dialog: { kind: 'pass' | 'cash' | 'del', user }
  const [dlg, setDlg] = useState(null);
  const [password, setPassword] = useState('');
  const [amount, setAmount] = useState('');
  const [dlgErr, setDlgErr] = useState('');

  const bump = () => setVer((v) => v + 1);

  // Erst suchen, wenn die Eingabe 250 ms ruhig ist
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = async () => {
    try {
      const r = await A('/api/admin/users', { params: { q: query } });
      setUsers(Array.isArray(r.users) ? r.users : []);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  };
  usePoll(load, 10000, [ver, query]);

  const patchUser = (id, patch) => {
    setUsers((list) => (list ? list.map((u) => (u.id === id ? { ...u, ...patch } : u)) : list));
    setDlg((d) => (d && d.user.id === id ? { ...d, user: { ...d.user, ...patch } } : d));
  };

  const freeze = async (u) => {
    setBusy(`f${u.id}`);
    try {
      await A(`/api/admin/users/${u.id}/freeze`, { method: 'POST', body: { freeze: !u.frozen } });
      toast(u.frozen ? `${u.username} kann wieder handeln.` : `${u.username} ist eingefroren und kann nicht mehr handeln.`, 'ok');
      bump();
    } catch (e) {
      toast(`Das ging nicht. ${e.message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const openDlg = (kind, user) => {
    setPassword('');
    setAmount('');
    setDlgErr('');
    setDlg({ kind, user });
  };
  const close = () => { if (!busy) setDlg(null); };

  // --- Passwort ----------------------------------------------------------
  const passErr = password.length >= 4 && password.length <= 64 ? '' : 'Das Passwort braucht 4 bis 64 Zeichen.';

  const setPwd = async () => {
    if (passErr || !dlg?.user) return;
    const { id, username } = dlg.user;
    setBusy('pass');
    try {
      await A(`/api/admin/users/${id}/reset-password`, { method: 'POST', body: { password } });
      toast(`Neues Passwort für ${username} gesetzt.`, 'ok');
      setDlg(null);
    } catch (e) {
      setDlgErr(e.message);
    } finally {
      setBusy('');
    }
  };

  // --- Guthaben ----------------------------------------------------------
  const amt = credit(amount);
  const amtWrong = !(amt > 0) || amt > TOPUP_MAX;
  const amtErr = `Gib einen Betrag über 0 ein, höchstens ${TOPUP_MAX.toLocaleString('de-DE')}.`;

  const topup = async () => {
    if (amtWrong || !dlg?.user) return;
    const { id, username } = dlg.user;
    setBusy('cash');
    try {
      const r = await A(`/api/admin/users/${id}/topup`, { method: 'POST', body: { amount: amt } });
      toast(`${username} hat ${fmtC(amt * 100)} Credits bekommen.`, 'ok');
      if (Number.isFinite(Number(r?.cash))) patchUser(id, { cash: Number(r.cash) });
      setDlg(null);
      bump();
    } catch (e) {
      setDlgErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const del = async (u) => {
    try {
      await A(`/api/admin/users/${u.id}/delete`, { method: 'POST' });
    } catch (e) {
      throw new Error(`Das ging nicht. ${e.message}`);
    }
    toast(`${u.username} gelöscht.`, 'ok');
    bump();
  };

  const du = dlg && dlg.user ? dlg.user : null;
  const blocked = busy !== '';
  const errBox = <ErrorBox onRetry={bump}>{`Das ging nicht. ${err}`}</ErrorBox>;

  return (
    <div className="admin-areas">
      <Section
        title={query ? `Nutzer mit „${query}“` : 'Nutzer'}
        action={(
          <form
            className="search admin-search"
            role="search"
            onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}
          >
            <IconSearch size={20} stroke={1.9} aria-hidden="true" />
            <input
              aria-label="Nutzer suchen"
              type="search"
              placeholder="Name suchen"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </form>
        )}
      >
        {!users ? (err ? errBox : <SkelRows n={6} />) : users.length === 0 ? (
          <Empty title={query ? 'Niemand gefunden' : 'Noch keine Nutzer'}>
            {query ? 'Probiere einen anderen Teil des Namens.' : 'Sobald sich jemand anmeldet, steht das Konto hier.'}
          </Empty>
        ) : (
          users.map((u) => (
            <Row
              key={u.id}
              leading={<Avatar seed={u.username} label={u.username} />}
              title={u.username}
              sub={`Cash ${fmtC(u.cash)} · zuletzt aktiv ${u.last_active ? dateTimeStr(u.last_active) : 'noch nie'}`}
              trailing={(
                <div className="admin-ctl">
                  {u.frozen ? <Chip tone="warn">Eingefroren</Chip> : <Chip>Aktiv</Chip>}
                  <Money c={u.worth ?? u.cash} />
                  <Button variant="ghost" size="sm" disabled={blocked} onClick={() => openDlg('pass', u)}>Passwort</Button>
                  <Button variant="ghost" size="sm" disabled={blocked} onClick={() => openDlg('cash', u)}>Guthaben</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === `f${u.id}`}
                    disabled={blocked}
                    onClick={() => freeze(u)}
                  >
                    {u.frozen ? 'Auftauen' : 'Einfrieren'}
                  </Button>
                  <Button variant="danger" size="sm" disabled={blocked} onClick={() => setDlg({ kind: 'del', user: u })}>
                    Löschen
                  </Button>
                </div>
              )}
            />
          ))
        )}
      </Section>

      <Sheet
        open={dlg?.kind === 'pass'}
        onClose={close}
        title="Neues Passwort"
        footer={(
          <>
            <Button variant="ghost" onClick={close}>Abbrechen</Button>
            <Button variant="primary" onClick={setPwd} loading={busy === 'pass'} disabled={Boolean(passErr)}>Passwort setzen</Button>
          </>
        )}
      >
        {du ? (
          <div className="admin-form">
            <p className="admin-note">
              Du legst ein neues Passwort für {du.username} fest. Es steht im Klartext da, damit du es aufschreiben kannst.
            </p>
            <Field
              label="Neues Passwort"
              help="Mindestens 4 Zeichen. Sag es dem Schüler."
              htmlFor="user-pass"
              error={dlgErr || passErr}
            >
              <Input
                id="user-pass"
                value={password}
                onChange={(e) => { setDlgErr(''); setPassword(e.target.value); }}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={dlg?.kind === 'cash'}
        onClose={close}
        title="Guthaben aufladen"
        footer={(
          <>
            <Button variant="ghost" onClick={close}>Abbrechen</Button>
            <Button variant="primary" onClick={topup} loading={busy === 'cash'} disabled={amtWrong}>Aufladen</Button>
          </>
        )}
      >
        {du ? (
          <div className="admin-form">
            <p className="admin-note">{du.username} hat gerade {fmtC(du.cash)} Credits.</p>
            <Field
              label="Betrag (Credits)"
              help="Dieser Betrag kommt oben drauf. Abziehen geht hier nicht."
              htmlFor="user-amount"
              error={dlgErr || (amount !== '' && amtWrong ? amtErr : '')}
            >
              <Input
                id="user-amount"
                className="num"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="1"
                value={amount}
                onChange={(e) => { setDlgErr(''); setAmount(e.target.value); }}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>

      <Confirm
        open={dlg?.kind === 'del'}
        title={`${du?.username} löschen?`}
        confirmLabel="Löschen"
        danger
        onClose={close}
        onConfirm={() => del(du)}
      >
        Das Konto verschwindet für immer. Geld und Aktien gehen an die Börse. Das kannst du nicht
        zurücknehmen.
      </Confirm>
    </div>
  );
}
