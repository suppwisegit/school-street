// Admin: Übersicht (Staatskasse, Stats, Einkommens-Countdown).
import React, { useEffect, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, Empty, ErrorBox, Loading, useToast } from '../../ui.jsx';

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export default function AdminOverview({ A, toast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [incomeAt, setIncomeAt] = useState(null); // absoluter Ziel-Zeitpunkt
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await A('/api/admin/overview');
      setData(r);
      setIncomeAt(Date.now() + r.next_income_in);
      setErr('');
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const payNow = async () => {
    if (!window.confirm('Wocheneinkommen jetzt an alle aktiven Trader ausschütten?')) return;
    setBusy(true);
    try {
      const r = await A('/api/admin/income/now', { method: 'POST' });
      setData(r);
      setIncomeAt(Date.now() + r.next_income_in);
      toast('Wocheneinkommen ausgezahlt', 'ok');
    } catch (e) {
      toast('' + e.message, 'err');
    } finally { setBusy(false); }
  };

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <Loading />;

  const c = data.counts || {};
  const positions = data.treasury?.positions || [];

  return (
    <div className="panelgrid">
      <Card title="Staatskasse (Treasury)" className="span2">
        <div className="huge num">{fmtC(data.treasury?.cash ?? 0)} <span className="muted" style={{ fontSize: 16 }}>Credits</span></div>
        <div className="divider" />
        <h3 style={{ margin: 0 }}>Treasury-Positionen</h3>
        {positions.length === 0 ? <Empty>Keine Positionen.</Empty> : (
          <table className="tbl">
            <thead><tr><th>Ticker</th><th className="r">Stück</th></tr></thead>
            <tbody>
              {positions.map((p, i) => (
                <tr key={i}><td><b>{p.ticker}</b></td><td className="r num">{p.amount.toLocaleString('de-DE')}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Stats" className="span2">
        <div className="statgrid admin">
          <div className="stat"><div className="lbl">Trader</div><div className="val">{c.users ?? '–'}</div></div>
          <div className="stat"><div className="lbl">Eingefroren</div><div className="val">{c.frozen ?? '–'}</div></div>
          <div className="stat"><div className="lbl">Wertpapiere</div><div className="val">{c.securities ?? '–'}</div></div>
          <div className="stat"><div className="lbl">Trades (24h)</div><div className="val">{c.trades_today ?? '–'}</div></div>
          <div className="stat"><div className="lbl">Verbrannte Gebühren</div><div className="val num">{fmtC(c.fees_burned ?? 0)}</div></div>
        </div>
      </Card>

      <Card title="Wocheneinkommen">
        <div className="muted small">Nächstes Wocheneinkommen in</div>
        <div className="countdown num">{incomeAt != null ? mmss(incomeAt - now) : '–:--'}</div>
        <button className="btn primary block" style={{ marginTop: 10 }} disabled={busy} onClick={payNow}>
          {busy ? '…' : 'Einkommen jetzt ausschütten'}
        </button>
      </Card>

      <Card title="Rolle der Investment AG">
        <div className="small muted">
          Die AG ist Börsenaufsicht (BaFin), Zentralbank (Staatskasse, Einkommen, Dividenden) und Authorized Participant
          (ETF-Arbitrage) in einem. Über den ETF-Tab hältst du Kurse am NAV, über Nutzer frierst du Manipulatoren ein.
        </div>
      </Card>
    </div>
  );
}
