// Admin: Nutzerverwaltung (Suche, Einfrieren, Löschen).
import React, { useEffect, useState } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { dateTimeStr, fmtC } from '../../api.js';
import { Card, Chip, Empty, ErrorBox, Loading, Money, useToast } from '../../ui.jsx';

export default function AdminUsers({ A, toast }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [botFilter, setBotFilter] = useState(''); // '' = alle, '0' = echte, '1' = Bots

  const load = async (query, bots) => {
    try {
      const r = await A('/api/admin/users', { params: { q: query ?? q, bots: bots ?? botFilter } });
      setUsers(r.users || []);
      setErr('');
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => { load('', ''); }, []);

  const setFilter = (f) => { setBotFilter(f); load('', f); };

  const search = (e) => {
    e.preventDefault();
    load();
  };

  const freeze = async (u) => {
    try {
      await A(`/api/admin/users/${u.id}/freeze`, { method: 'POST', body: { freeze: !u.frozen } });
      toast(u.frozen ? `${u.username} entsperrt` : `${u.username} eingefroren`, 'ok');
      load();
    } catch (e) { toast('' + e.message, 'err'); }
  };

  const del = async (u) => {
    if (!window.confirm(`${u.username} endgültig löschen?\nVermögen (${fmtC(u.cash)} Credits + Positionen) fällt an die Staatskasse.`)) return;
    setBusy(true);
    try {
      await A(`/api/admin/users/${u.id}/delete`, { method: 'POST' });
      toast(`${u.username} gelöscht`, 'ok');
      load();
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Nutzerverwaltung">
      <form className="inputpair" onSubmit={search} style={{ marginBottom: 12 }}>
        <div className="searchwrap grow">
          <IconSearch size={16} stroke={1.9} />
          <input className="input" placeholder="Username suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="tabs" style={{ margin: 0 }}>
          <button type="button" className={botFilter === '' ? 'on' : ''} onClick={() => setFilter('')}>Alle</button>
          <button type="button" className={botFilter === '0' ? 'on' : ''} onClick={() => setFilter('0')}>Echte</button>
          <button type="button" className={botFilter === '1' ? 'on' : ''} onClick={() => setFilter('1')}>Bots</button>
        </div>
        <button className="btn" style={{ whiteSpace: 'nowrap' }} type="submit">Suchen</button>
      </form>
      <ErrorBox>{err}</ErrorBox>
      {!users ? <Loading /> : users.length === 0 ? <Empty>Keine Nutzer gefunden.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Name</th><th className="r">Cash</th><th className="r">Real. G/V</th><th>Last Active</th><th>Status</th><th className="r">Aktionen</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.username}</b>{u.is_bot ? ' ' : ''}{u.is_bot ? <Chip blue>Bot</Chip> : null}</td>
                  <td className="r num">{fmtC(u.cash)}</td>
                  <td className="r"><Money c={u.realized_pl} colored signed /></td>
                  <td className="muted small">{dateTimeStr(u.last_active)}</td>
                  <td>{u.frozen ? <Chip red>eingefroren</Chip> : <Chip green>aktiv</Chip>}</td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" disabled={busy} onClick={() => freeze(u)}>{u.frozen ? 'Entsperren' : 'Einfrieren'}</button>{' '}
                    <button className="btn sm danger" disabled={busy} onClick={() => del(u)}>Löschen</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
