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
    title: 'Market-Maker V2 (Liquidität)',
    wide: true,
    hint: 'Der Market Maker der Staatskasse quotet wie ein echter Liquidity Provider: Abstände & Größen je Stufe sind zufällig ausgefranst (Jitter), die Quotes wandern auf einem kleinen Random Walk um den letzten Kurs, und die Spreads skalieren KONTINUIERLICH mit der gemessenen Volatilität — ruhiger Markt = enge Quotes & große Stückzahlen (viel Handel), wilder Markt = breite Quotes & kleine Stückzahlen (Schutz), so wie bei großen Börsen. Dazu: Inventory-Skew (hoher Bestand drückt die Quotes, niedriger hebt sie), Momentum-Bremse als Extrem-Circuit-Breaker, automatische Nachplatzierung bei Float-Mangel und faires Cash-Budget je Wertpapier.',
    fields: [
      { key: 'mm_spread_bp', label: 'Basis-Spread (Basispunkte)', help: 'Abstand zwischen Geld- und Briefkurs auf Stufe 0 bei Normal-Volatilität. 300 = 3 % um den Referenzkurs (Default 300).' },
      { key: 'mm_levels', label: 'Stufen je Seite', help: 'Tiefe der Staffel: so viele Preisstufen bietet der MM je Seite an (Default 6).' },
      { key: 'mm_step_bp', label: 'Abstands-Zuwachs je Stufe (Basispunkte)', help: 'Jede weitere Stufe liegt im Mittel so viel weiter vom Kurs entfernt (Default 120).' },
      { key: 'mm_jitter_bp', label: 'Abstands-Jitter (Basispunkte)', help: 'Zufällige Extra-Abstände je Stufe: aus einer glatten Treppe wird ein realistisch ausgefranstes Buch (Default 60).' },
      { key: 'mm_size', label: 'Stückzahl auf Stufe 0', help: 'Menge, die der MM zum engesten Preis kauft und verkauft (Default 40).' },
      { key: 'mm_size_step', label: 'Stück-Zuwachs je Stufe', help: 'Jede weitere Stufe bietet im Mittel so viele Stück mehr (Default 25).' },
      { key: 'mm_size_jitter', label: 'Größen-Jitter (0–1)', help: 'Zufällige Abweichung der Stückzahlen je Stufe. 0.35 = ±35 % (Default 0.35).' },
      { key: 'mm_vol_ref', label: 'Referenz-Volatilität (0–1)', help: 'Gemessene Volatilität (σ der letzten Kursänderungen), bei der der Spread genau dem Basis-Spread entspricht. Kleinerer Wert = MM reagiert empfindlicher. Default 0.01 = 1 %.' },
      { key: 'mm_vol_mult_max', label: 'Max. Spread-Faktor', help: 'Obergrenze der Volatilitäts-Streckung: bei Sturm quotet der MM höchstens so viel mal so breit (Default 2.8; ruhig wird bis 0.7× enger).' },
      { key: 'mm_refresh_sec', label: 'Refresh-Intervall (Sekunden)', help: 'Mittlerer Takt je Wert — jedes Buch recentert gestaffelt (±30 %), nie alle gleichzeitig (Default 15).' },
      { key: 'mm_inv_skew_bp', label: 'Inventory-Skew (Basispunkte)', help: 'Maximale Quote-Verschiebung je nach Bestandslage: viel Bestand ⇒ tiefer quoten (abbauen), wenig Bestand ⇒ höher (Default 200).' },
      { key: 'mm_guard_pct', label: 'Momentum-Bremse ab (%)', help: 'Extrem-Circuit-Breaker: Hat sich der Kurs in 10 Minuten stärker bewegt, verbreitert der MM zusätzlich (Default 6 %).' },
      { key: 'mm_replenish_qty', label: 'Nachplatzierung: Stückzahl', help: 'Ist der Treasury-Bestand unter den Mindestwert gefallen UND der Kurs klar über dem IPO, platziert die Staatskasse so viele neue Aktien dazu (News-Event, Default 1000).' },
      { key: 'mm_replenish_price_mult', label: 'Nachplatzierung ab Faktor', help: 'Nachplatzierung nur, wenn Kurs > IPO-Preis × Faktor — schwache Kurse werden nicht verwässert (Default 1.15).' },
      { key: 'mm_cash_budget_pct', label: 'Cash-Anteil für Bid-Seite (0–1)', help: 'Anteil der Treasury-Cash, den der MM insgesamt in Kauf-Quotes (Escrow) bindet — fair verteilt auf alle Wertpapiere. Default 0.9.' },
      { key: 'mm_fee_exempt', label: 'MM gebührenfrei?', type: 'bool', boolLabels: ['Ja – gebührenfrei', 'Nein – Gebühr zahlen'], help: 'Zahlt die Staatskasse für ihre eigenen Liquiditäts-Orders keine Ordergebühr?' }
    ]
  },
  {
    title: 'ETF Auto-Arbitrage (AP-Automatik)',
    hint: 'Der AP-Algorithmus der Investment AG klebt ETF-Kurse an den NAV — mit zwei Instrumenten wie echte Authorized Participanten: (1) NAV-Pegging: Ab halber Schwelle platziert die Staatskasse AP-Kauforders unterhalb des NAV (bei Discount) bzw. AP-Verkauforders oberhalb (bei Premium) — Spieler, die dagegen handeln, ziehen den Kurs sofort Richtung NAV. (2) Creation/Redemption: Ab voller Schwelle passt der AP seinen Bestand an, mit dynamisch mit der Abweichung skalierenden Units. Jede Bestands-Aktion erscheint max. 1× pro Minute als News.',
    fields: [
      { key: 'etf_auto', label: 'Auto-Arbitrage aktiv?', type: 'bool', boolLabels: ['An – automatisch eingreifen', 'Aus – nur manuell (AP-Terminal)'], help: 'Prüft alle 5 Sekunden alle ETFs und greift automatisch ein.' },
      { key: 'etf_auto_threshold_pct', label: 'Schwelle (± %)', help: 'Ab dieser Abweichung zwischen Kurs und NAV wird vollständig eingegriffen; ab der Hälfte bereits NAV-Pegging-Quotes gesetzt (Default 10 %).' },
      { key: 'etf_auto_units', label: 'Basis-Units je Aktion', help: 'Grundgröße je Creation/Redemption — skaliert automatisch mit der Abweichung (Default 2).' },
      { key: 'etf_auto_max_units', label: 'Max. Units je Aktion', help: 'Obergrenze der dynamischen Skalierung: bei riesigen Abweichungen werden bis zu so viele Units auf einmal geschaffen/eingelöst (Default 25).' },
      { key: 'etf_auto_interval_sec', label: 'Mindestabstand (Sekunden)', help: 'Mindestens so lange wartet der Algorithmus zwischen zwei Creation/Redemption-Aktionen je ETF — die Peg-Quotes wirken unabhängig davon sofort (Default 10).' }
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
      { key: 'treasury_capital', label: 'Staatskasse: Startkapital (Cent)', help: (s) => `Startguthaben der Investment AG — die Liquiditäts-Reserve des Market Makers. Wirkt bei Neuanlage/Re-Seed. Aktueller Wert: ${fmtC(s.treasury_capital)} Credits.` },
      { key: 'inactivity_sec', label: 'Inaktivität bis Löschung (Sekunden)', help: 'Konten ohne Aktivität werden gelöscht, das Vermögen fällt an die Staatskasse. 1814400 = 3 Wochen. Virtuelle Trader (Bots) sind ausgenommen.' }
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
            {(f.boolLabels || ['Ja', 'Nein']).map((lbl, i) => (
              <option key={i} value={i === 0 ? '1' : '0'}>{lbl}</option>
            ))}
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
