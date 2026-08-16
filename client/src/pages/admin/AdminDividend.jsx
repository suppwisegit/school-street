// Admin: Dividende ausschütten mit Live-Vorschau.
import React, { useEffect, useRef, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, ErrorBox, Field, useToast } from '../../ui.jsx';

export default function AdminDividend({ A, toast }) {
  const [secs, setSecs] = useState([]);
  const [secId, setSecId] = useState('');
  const [perShare, setPerShare] = useState('1.00');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    A('/api/securities')
      .then((r) => setSecs(r.securities || []))
      .catch((e) => setErr(e.message));
  }, []);

  // Live-Vorschau (debounced)
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!secId || !(parseFloat(perShare.replace(',', '.')) > 0)) { setPreview(null); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await A('/api/admin/dividend/preview', { params: { security_id: secId, per_share: perShare } });
        setPreview(r); setErr('');
      } catch (e) {
        setPreview(null);
        setErr(e.message);
      }
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [secId, perShare]);

  const pay = async () => {
    if (!secId) return setErr('Wertpapier wählen');
    const p = preview || {};
    if (!window.confirm(`Dividende ${fmtC(p.per_share || 0)} je Aktie an ${p.holders || 0} Aktionäre ausschütten?\nGesamt: ${fmtC(p.total || 0)} Credits (zahlt die Staatskasse).`)) return;
    setBusy(true);
    try {
      const r = await A('/api/admin/dividend', { method: 'POST', body: { security_id: Number(secId), per_share: parseFloat(String(perShare).replace(',', '.')), reason: reason.trim() } });
      toast(`Dividende ausgeschüttet: ${fmtC(r.total)} an ${r.holders} Aktionäre`, 'ok');
      setReason('');
    } catch (e) {
      toast('' + e.message, 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="panelgrid">
      <Card title="Dividende ausschütten">
        <ErrorBox>{err}</ErrorBox>
        <Field label="Wertpapier">
          <select className="select" value={secId} onChange={(e) => setSecId(e.target.value)}>
            <option value="">– wählen –</option>
            {secs.filter((s) => s.type === 'stock').map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}</option>)}
          </select>
        </Field>
        <Field label="Dividende je Aktie (Credits)">
          <input className="input num" type="number" min="0.01" step="0.1" value={perShare} onChange={(e) => setPerShare(e.target.value)} />
        </Field>
        <Field label="Begründung (optional, erscheint in der News)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z.B. Rekordgewinn im Wintersemester" />
        </Field>
        <button className="btn buy block" disabled={busy || !secId} onClick={pay}>{busy ? '…' : 'Ausschütten'}</button>
        <div className="small muted" style={{ marginTop: 8 }}>Achtung: Auch ETF-Körbe halten Aktien – die Dividende wird automatisch an ETF-Anleger weitergeleitet (Routing).</div>
      </Card>

      <Card title="Live-Vorschau">
        {!preview ? (
          <div className="muted small">Wertpapier und Betrag wählen …</div>
        ) : (
          <>
            <div className="kv"><span className="muted">Wertpapier</span><b>{preview.security?.ticker}</b></div>
            <div className="kv"><span className="muted">je Aktie</span><b className="num">{fmtC(preview.per_share)}</b></div>
            <div className="kv"><span className="muted">Stückzahl (im Depot der Trader)</span><span className="num">{(preview.total_shares || 0).toLocaleString('de-DE')}</span></div>
            <div className="kv"><span className="muted">Aktionäre</span><span className="num">{preview.holders || 0}</span></div>
            <div className="kv" style={{ fontSize: 16 }}><span className="muted">Gesamt (Staatskasse zahlt)</span><b className="num">{fmtC(preview.total)}</b></div>
          </>
        )}
      </Card>
    </div>
  );
}
