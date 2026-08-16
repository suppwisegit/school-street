// Admin: Anträge (Kapitalerhöhung / Sonderdividende) genehmigen oder ablehnen.
import React, { useEffect, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, Chip, Empty, ErrorBox, Loading, useToast } from '../../ui.jsx';

const TYPE_LABEL = {
  capital_increase: { label: 'Kapitalerhöhung', tone: 'blue' },
  special_dividend: { label: 'Sonderdividende', tone: 'green' }
};

export default function AdminRequests({ A, toast }) {
  const [reqs, setReqs] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const r = await A('/api/admin/requests');
      setReqs(r.requests || []);
      setErr('');
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const decide = async (r, approve) => {
    const label = r.type === 'special_dividend' ? `Sonderdividende ${fmtC(r.amount || 0)}/Aktie für ${r.ticker}` : `Kapitalerhöhung +20% für ${r.ticker}`;
    if (!window.confirm(`${approve ? 'Genehmigen' : 'Ablehnen'}: ${label}?`)) return;
    try {
      await A(`/api/admin/requests/${r.id}/decide`, { method: 'POST', body: { approve } });
      toast(approve ? 'Antrag genehmigt' : 'Antrag abgelehnt', approve ? 'ok' : 'err');
      load();
    } catch (e) { toast('' + e.message, 'err'); }
  };

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!reqs) return <Loading />;

  return (
    <div className="col" style={{ gap: 12 }}>
      <Card title={`Offene Anträge (${reqs.length})`}>
        {reqs.length === 0 ? <Empty>Keine offenen Anträge.</Empty> : null}
      </Card>
      {reqs.map((r) => (
        <Card key={r.id}>
          <div className="row between wrap">
            <div className="grow">
              <div className="row wrap" style={{ gap: 8 }}>
                <Chip tone={TYPE_LABEL[r.type]?.tone}>{TYPE_LABEL[r.type]?.label || r.type}</Chip>
                <b style={{ fontSize: 16 }}>{r.ticker}</b> <span className="muted">{r.name}</span>
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                von {r.username || '?'} · {new Date(r.created_at).toLocaleString('de-DE')}
                {r.type === 'special_dividend' && r.amount ? ` · ${fmtC(r.amount)} je Aktie` : ' · +20% neue Aktien für den Gründer'}
              </div>
            </div>
            <div className="row">
              <button className="btn buy" onClick={() => decide(r, true)}>Genehmigen</button>
              <button className="btn danger" onClick={() => decide(r, false)}>Ablehnen</button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
