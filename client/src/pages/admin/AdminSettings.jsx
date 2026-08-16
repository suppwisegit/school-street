// Admin: Einstellungen (Spiel-Parameter) mit deutschen Labels + Hilfetexten.
import React, { useEffect, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, ErrorBox, Field, Loading, OkBox, useToast } from '../../ui.jsx';

const FIELDS = [
  { key: 'fee_cent', label: 'Ordergebühr (Cent)', help: '2000 = 20.00 Credits pro ausgeführter Order – wird verbrannt (Geldvernichtung).' },
  { key: 'income_cent', label: 'Wocheneinkommen (Cent)', help: '100000 = 1.000 Credits für alle aktiven Trader.' },
  { key: 'income_sec', label: 'Sekunden zwischen Wocheneinkommen', help: '300 = 5 Min zum Testen (real: 7 Tage = 604800).' },
  { key: 'start_capital', label: 'Startkapital (Cent)', help: '1000000 = 10.000 Credits bei Registrierung.' },
  { key: 'inactivity_sec', label: 'Inaktivität bis Ghost-Löschung (Sekunden)', help: 'Konten ohne Aktivität werden gelöscht, Vermögen fällt an den Staat.' },
  { key: 'lockup_sec', label: 'Founder-Lock-up (Sekunden)', help: '1209600 = 2 Wochen: Gründer dürfen eigene Aktien nicht verkaufen.' },
  { key: 'mm_spread_bp', label: 'Market-Maker-Spread (Basispunkte)', help: '350 = 3,5% Abstand zwischen Geld- und Briefkurs des MM.' },
  { key: 'mm_size', label: 'MM-Stückzahl pro Quote', help: 'Kleine Werte = dünne Liquidität = größere Kurssprünge möglich.' },
  { key: 'mm_refresh_sec', label: 'MM-Refresh-Intervall (Sekunden)', help: 'Wie oft der MM seine Quoten um den letzten Kurs re-zentriert.' },
  { key: 'mm_fee_exempt', label: 'MM gebührenfrei (1 = ja, 0 = nein)', help: 'Soll die Staatskasse für ihre Liquidität keine Gebühr zahlen?' },
  { key: 'cap_hours_needed', label: 'Stunden über Schwelle für Kapitalerhöhung', help: 'Kurs muss so lange über der IPO-Schwelle bleiben, bevor der Gründer 20% neue Aktien beantragen kann.' }
];

export default function AdminSettings({ A, toast }) {
  const [settings, setSettings] = useState(null);
  const [orig, setOrig] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    A('/api/admin/settings')
      .then((r) => { setSettings(r.settings || {}); setOrig(r.settings || {}); })
      .catch((e) => setErr(e.message));
  }, []);

  const save = async () => {
    setBusy(true); setOk(''); setErr('');
    try {
      const body = {};
      for (const f of FIELDS) body[f.key] = Number(settings[f.key]);
      const r = await A('/api/admin/settings', { method: 'PUT', body });
      setSettings(r.settings || {});
      setOrig(r.settings || {});
      setOk('Einstellungen gespeichert.');
      toast('Einstellungen gespeichert', 'ok');
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  if (err && !settings) return <ErrorBox>{err}</ErrorBox>;
  if (!settings) return <Loading />;

  const dirty = FIELDS.some((f) => String(settings[f.key]) !== String(orig?.[f.key]));

  return (
    <div className="panelgrid">
      <Card title="Spiel-Einstellungen" className="span2">
        <ErrorBox>{err}</ErrorBox>
        <OkBox>{ok}</OkBox>
        <div className="panelgrid">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} help={f.help}>
              <input
                className={`input num ${String(settings[f.key]) !== String(orig?.[f.key]) ? 'err' : ''}`}
                type="number" step="any"
                value={settings[f.key] ?? ''}
                onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="muted small">
            Gebühr aktuell: {fmtC(settings.fee_cent)} · Einkommen: {fmtC(settings.income_cent)} alle {settings.income_sec}s
          </span>
          <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? '…' : ' Speichern'}</button>
        </div>
      </Card>
    </div>
  );
}
