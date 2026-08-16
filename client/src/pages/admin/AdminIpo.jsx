// Admin: IPO-Anträge freigeben/ablehnen.
import React, { useEffect, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, Empty, ErrorBox, Field, Loading, useToast } from '../../ui.jsx';

const DEFAULTS = { ipo_price: '20', founder_shares: '1000', float_shares: '400', threshold_mult: '1.5' };

export default function AdminIpo({ A, toast }) {
  const [apps, setApps] = useState(null);
  const [err, setErr] = useState('');
  const [forms, setForms] = useState({}); // id -> {ipo_price, founder_shares, float_shares, threshold_mult}
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await A('/api/admin/ipo');
      setApps(r.applications || []);
      setErr('');
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const formOf = (id) => forms[id] || DEFAULTS;
  const setForm = (id, k, v) => setForms((f) => ({ ...f, [id]: { ...formOf(id), [k]: v } }));

  const approve = async (a) => {
    const f = formOf(a.id);
    setBusy(true);
    try {
      await A(`/api/admin/ipo/${a.id}/approve`, {
        method: 'POST',
        body: { ipo_price: Number(f.ipo_price), founder_shares: Number(f.founder_shares), float_shares: Number(f.float_shares), threshold_mult: Number(f.threshold_mult) }
      });
      toast(`IPO freigegeben: ${a.ticker}`, 'ok');
      load();
    } catch (e) {
      toast('' + e.message, 'err');
    } finally { setBusy(false); }
  };

  const reject = async (a) => {
    if (!window.confirm(`${a.name} (${a.ticker}) ablehnen?`)) return;
    try {
      await A(`/api/admin/ipo/${a.id}/reject`, { method: 'POST' });
      toast(`${a.ticker} abgelehnt`, 'ok');
      load();
    } catch (e) { toast('' + e.message, 'err'); }
  };

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!apps) return <Loading />;

  return (
    <div className="col" style={{ gap: 14 }}>
      <Card title={`IPO-Anträge (offen: ${apps.length})`}>
        {apps.length === 0 ? <Empty>Keine offenen IPO-Anträge.</Empty> : null}
      </Card>
      {apps.map((a) => {
        const f = formOf(a.id);
        const ipo = Math.round(Number(f.ipo_price) * 100) || 0;
        const threshold = Math.round(ipo * (Number(f.threshold_mult) || 1.5));
        const payout = Math.round(ipo * (Number(f.float_shares) || 0));
        return (
          <Card key={a.id}>
            <div className="row between wrap">
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{a.name} <span className="muted">({a.ticker})</span></div>
                <div className="muted small">von {a.username || 'Unbekannt'} · {new Date(a.created_at).toLocaleString('de-DE')}</div>
              </div>
              <div className="row">
                <button className="btn buy" disabled={busy} onClick={() => approve(a)}>Freigeben</button>
                <button className="btn danger" disabled={busy} onClick={() => reject(a)}>Ablehnen</button>
              </div>
            </div>
            {a.description ? <div className="hintbox" style={{ margin: '10px 0' }}>„{a.description}“</div> : null}
            <div className="inputpair" style={{ marginTop: 8 }}>
              <Field label="IPO-Preis (Credits)" help={`= ${fmtC(ipo)} je Aktie`}>
                <input className="input num" type="number" min="0.01" step="0.5" value={f.ipo_price} onChange={(e) => setForm(a.id, 'ipo_price', e.target.value)} />
              </Field>
              <Field label="Gründeraktien">
                <input className="input num" type="number" min="1" step="1" value={f.founder_shares} onChange={(e) => setForm(a.id, 'founder_shares', e.target.value)} />
              </Field>
              <Field label="Streubesitz → Treasury">
                <input className="input num" type="number" min="0" step="1" value={f.float_shares} onChange={(e) => setForm(a.id, 'float_shares', e.target.value)} />
              </Field>
              <Field label="Schwellen-Faktor" help={`Kapitalerhöhungs-Schwelle: ${fmtC(threshold)}`}>
                <input className="input num" type="number" min="1" step="0.1" value={f.threshold_mult} onChange={(e) => setForm(a.id, 'threshold_mult', e.target.value)} />
              </Field>
            </div>
            <div className="small muted">
              Gründer erhält {f.founder_shares} Aktien (Lock-up) + {fmtC(payout)} Credits für den Streubesitz ({f.float_shares} Stück zahlt die Staatskasse).
            </div>
          </Card>
        );
      })}
    </div>
  );
}
