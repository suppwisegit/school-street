// Admin: Einstellungen (Spiel-Parameter) – thematisch gruppiert, deutsche Labels + Hilfetexte.
// Werte sind rohe Zahlen: Cent-Beträge (fee_cent, income_cent, start_capital, limit_band_cents)
// und Basispunkte (mm_spread_bp, mm_step_bp). GET/PUT /api/admin/settings.
import React, { useEffect, useState } from 'react';
import { fmtC } from '../../api.js';
import { Card, ErrorBox, Field, Loading, OkBox, useToast } from '../../ui.jsx';

// help: String oder Funktion (s) -> String für Live-Anzeige des aktuellen Werts.
const SECTIONS = [
  {
    title: 'Handel & Gebühren',
    fields: [
      { key: 'fee_cent', label: 'Ordergebühr (Cent)', help: (s) => `Wird pro ausgeführter Order fällig und verbrannt (Geldvernichtung). Aktueller Wert: ${fmtC(s.fee_cent)} Credits.` },
      { key: 'lockup_sec', label: 'Founder-Lock-up (Sekunden)', help: 'Gründer dürfen so lange keine eigenen Aktien verkaufen. 1209600 = 2 Wochen.' },
      { key: 'cap_hours_needed', label: 'Kapitalerhöhung: Stunden über Schwelle', help: 'So lange muss der Kurs über der IPO-Schwelle bleiben, bevor der Gründer 20 % neue Aktien beantragen kann.' }
    ]
  },
  {
    title: 'Wocheneinkommen',
    fields: [
      { key: 'income_cent', label: 'Ausschüttung (Cent)', help: (s) => `Fällt für alle aktiven Trader an. Aktueller Wert: ${fmtC(s.income_cent)} Credits.` },
      { key: 'income_sec', label: 'Intervall (Sekunden)', help: '300 = 5 Min zum Testen · 604800 = 7 Tage (realistische Woche).' }
    ]
  },
  {
    title: 'Market-Maker (Liquidität)',
    wide: true,
    hint: 'Der Market Maker der Staatskasse legt eine Preistreppe (Ladder) um den letzten Kurs: Stufe 0 notiert direkt am Kurs, jede weitere Stufe liegt weiter außen und bietet mehr Stück. So finden auch große Orders Gegenparteien.',
    fields: [
      { key: 'mm_spread_bp', label: 'Basis-Spread (Basispunkte)', help: 'Abstand zwischen Geld- und Briefkurs auf Stufe 0. 350 = 3,5 % um den letzten Kurs.' },
      { key: 'mm_levels', label: 'Stufen je Seite', help: 'Tiefe der Treppe: so viele Preisstufen bietet der MM je Seite an (Default 5).' },
      { key: 'mm_step_bp', label: 'Abstands-Zuwachs je Stufe (Basispunkte)', help: 'Jede weitere Stufe liegt so viel weiter vom Kurs entfernt. 120 = 1,2 % mehr Abstand pro Stufe (Default 120).' },
      { key: 'mm_size', label: 'Stückzahl auf Stufe 0', help: 'Menge, die der MM zum engesten Preis kauft und verkauft (Default 15). Kleine Werte = dünnere Liquidität.' },
      { key: 'mm_size_step', label: 'Stück-Zuwachs je Stufe', help: 'Jede weitere Stufe bietet so viele Stück mehr: Stufe i hat mm_size + i × mm_size_step (Default 10).' },
      { key: 'mm_refresh_sec', label: 'Refresh-Intervall (Sekunden)', help: 'Wie oft der MM seine Quoten um den letzten Kurs neu zentriert.' },
      { key: 'mm_fee_exempt', label: 'MM gebührenfrei?', type: 'bool', help: 'Zahlt die Staatskasse für ihre eigenen Liquiditäts-Orders keine Ordergebühr?' }
    ]
  },
  {
    title: 'Preis-Band (Manipulationsschutz)',
    hint: 'Limit-Orders müssen innerhalb des Preis-Bands liegen: höchstens den Prozentwert über/unter dem aktuellen Kurs – aber mindestens den Absolutbetrag (sonst wären bei sehr niedrigen Kursen gar keine Limits möglich).',
    fields: [
      { key: 'limit_band_pct', label: 'Max. Abstand vom Kurs (%)', help: 'Limits dürfen höchstens so weit über/unter dem aktuellen Kurs liegen. 15 = ±15 % (Default 15).' },
      { key: 'limit_band_cents', label: 'Mindest-Spielraum (Cent)', help: (s) => `Absoluter Mindest-Spielraum um den Kurs. Aktueller Wert: ${fmtC(s.limit_band_cents)} Credits.` }
    ]
  },
  {
    title: 'Sonstiges',
    fields: [
      { key: 'start_capital', label: 'Startkapital (Cent)', help: (s) => `Guthaben bei Registrierung. Aktueller Wert: ${fmtC(s.start_capital)} Credits.` },
      { key: 'inactivity_sec', label: 'Inaktivität bis Löschung (Sekunden)', help: 'Konten ohne Aktivität werden gelöscht, das Vermögen fällt an die Staatskasse. 1814400 = 3 Wochen.' }
    ]
  }
];
const FIELDS = SECTIONS.flatMap((s) => s.fields);

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

  const changedKeys = FIELDS
    .filter((f) => String(settings[f.key] ?? '') !== String(orig?.[f.key] ?? ''))
    .map((f) => f.key);
  const dirty = changedKeys.length > 0;

  const renderField = (f) => {
    const val = settings[f.key] ?? '';
    const changed = changedKeys.includes(f.key);
    const help = typeof f.help === 'function' ? f.help(settings) : f.help;
    const label = (
      <>
        {f.label}
        {changed ? <span style={{ color: 'var(--accent-hi)' }}> · geändert</span> : null}
      </>
    );
    const editStyle = changed ? { borderColor: 'var(--accent)' } : undefined;
    return (
      <Field key={f.key} label={label} help={help}>
        {f.type === 'bool' ? (
          <select
            className="select"
            style={editStyle}
            value={Number(val) === 1 ? '1' : '0'}
            onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
          >
            <option value="1">Ja – gebührenfrei</option>
            <option value="0">Nein – Gebühr zahlen</option>
          </select>
        ) : (
          <input
            className="input num"
            style={editStyle}
            type="number" step="any"
            value={val}
            onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
          />
        )}
      </Field>
    );
  };

  return (
    <div className="panelgrid">
      {SECTIONS.map((sec) => (
        <Card key={sec.title} title={sec.title} className={sec.wide ? 'span2' : ''}>
          {sec.hint ? <div className="hintbox" style={{ marginBottom: 12 }}>{sec.hint}</div> : null}
          {sec.wide
            ? <div className="panelgrid">{sec.fields.map(renderField)}</div>
            : sec.fields.map(renderField)}
        </Card>
      ))}

      <Card className="span2 tight">
        <ErrorBox>{err}</ErrorBox>
        <OkBox>{ok}</OkBox>
        <div className="row between wrap">
          <span className="muted small">
            Gebühr {fmtC(settings.fee_cent)} Credits · Einkommen {fmtC(settings.income_cent)} alle {settings.income_sec}s ·
            MM-Treppe {settings.mm_levels} Stufen · Preis-Band ±{settings.limit_band_pct}% (mind. {fmtC(settings.limit_band_cents)} Credits)
          </span>
          <div className="row">
            {dirty ? <span className="chip blue">{changedKeys.length} geändert</span> : null}
            <button className="btn primary" disabled={busy || !dirty} onClick={save}>
              {busy ? 'Speichern …' : 'Speichern'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
