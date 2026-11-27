// Admin, Bereich „Werte", oberster Abschnitt: neuen ETF anlegen (Vertrag V6, DESIGN §12).
// Der Korb wird nicht gekauft: Die Staatskasse muss die Aktien für die Anteile bei Start im Depot
// haben. Der Server verlangt das (server/etf.js createEtf) — das Formular zeigt den Bestand je
// Aktie und sperrt „Anlegen“, bevor etwas fehlschlägt.
// Stand: GET /api/admin/etf (Aktien, Treasury-Positionen) + GET /api/securities (Kurse, Kürzel) alle 10 s.
import React, { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useOutletContext } from 'react-router-dom';
import {
  Button, Empty, ErrorBox, Field, Input, Money, Num, Pct, Row, Section, Sheet, SkelRows, Stepper, Symbol,
  Textarea, useToast,
} from '../../ui.jsx';
import { usePoll } from '../../hooks.jsx';

const DEFAULT_UNITS = 100;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const TICKER = /^[A-Z]{3,6}$/;

const fmtI = (n) => (Number(n) || 0).toLocaleString('de-DE');
const EMPTY_FORM = { name: '', ticker: '', desc: '', spu: 1, units: DEFAULT_UNITS, qty: {} };

// Bedarf und Besitz je Korbposition. `treasury`: Kürzel → Stück im Depot der Staatskasse.
function holdingsOf(basket, units, treasury, nameOf) {
  return basket.map((b) => {
    const need = b.qty * units;
    const have = treasury[b.ticker] || 0;
    return { ticker: b.ticker, name: nameOf(b), qty: b.qty, need, have, short: Math.max(0, need - have) };
  });
}
// Meldung bei Bestandsmangel, je Position ein Satz — dieselben Worte wie der Server.
const shortageOf = (holdings) => holdings.filter((h) => h.short > 0)
  .map((h) => `Die Staatskasse hat zu wenig ${h.ticker}: es fehlen ${fmtI(h.short)} Stück.`).join(' ');

export default function AdminEtf({ onCreated }) {
  const { A } = useOutletContext();
  const toast = useToast();
  const [data, setData] = useState(null);      // { stocks, treasury } aus /api/admin/etf
  const [secs, setSecs] = useState([]);        // Kurse und vergebene Kürzel aus /api/securities
  const [err, setErr] = useState('');
  const [ver, setVer] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState({});  // Feld wurde verlassen: Fehler ab jetzt zeigen
  const [tried, setTried] = useState(false);   // erster Versuch abzusenden
  const [draft, setDraft] = useState(null);    // Bestätigungsdialog: der eingefrorene Antrag
  const [dlgErr, setDlgErr] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);              // zweite Anfrage, solange die erste läuft (Doppel-Klick)

  const bump = () => setVer((v) => v + 1);

  // Antworten einer älteren Abfrage dürfen eine neuere nicht überschreiben (Poll und Neuladen parallel)
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    const [e, s] = await Promise.all([
      A('/api/admin/etf').catch((x) => ({ error: x.message })),
      A('/api/securities').catch((x) => ({ error: x.message })),
    ]);
    if (seq !== loadSeq.current) return;
    if (e.error || s.error) { setErr(e.error || s.error); return; }
    setErr('');
    setData({
      stocks: Array.isArray(e.stocks) ? e.stocks : [],
      treasury: Object.fromEntries((Array.isArray(e.treasury_positions) ? e.treasury_positions : [])
        .map((p) => [p.ticker, p.amount])),
    });
    setSecs(Array.isArray(s.securities) ? s.securities : []);
  };
  usePoll(load, 10000, [ver]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const touch = (key) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const setQty = (stock, value) => {
    setForm((f) => ({ ...f, qty: { ...f.qty, [stock.id]: value } }));
    touch('basket');
  };

  const stocks = data ? data.stocks : [];
  const treasury = data ? data.treasury : {};
  const priceOf = useMemo(() => new Map(secs.map((s) => [s.id, Number(s.last) || 0])), [secs]);
  const tickers = useMemo(() => new Set(secs.map((s) => s.ticker)), [secs]);

  // Korb: jede Aktie mit Stück > 0, dazu Kurs und Wert je Anteil
  const basket = stocks
    .filter((s) => (form.qty[s.id] || 0) > 0)
    .map((s) => ({ ...s, qty: form.qty[s.id], price: priceOf.get(s.id) || 0 }))
    .map((s) => ({ ...s, value: s.qty * s.price }));
  const basketValue = basket.reduce((a, s) => a + s.value, 0);

  // Fehler je Feld; '' heißt in Ordnung.
  const nm = form.name.trim();
  const tk = form.ticker.trim();
  const nameErr = !nm ? 'Gib einen Namen ein.' : nm.length > MAX_NAME ? `Der Name braucht höchstens ${MAX_NAME} Zeichen.`
    : nm.length < 3 ? 'Der Name braucht mindestens 3 Zeichen.' : '';
  const tickerErr = !tk ? 'Gib ein Kürzel ein.'
    : !TICKER.test(tk) ? 'Das Kürzel braucht 3 bis 6 Buchstaben.'
      : tickers.has(tk) ? 'Dieses Kürzel gibt es schon.' : '';
  const descErr = form.desc.length > MAX_DESCRIPTION ? `Die Beschreibung hat höchstens ${MAX_DESCRIPTION} Zeichen.` : '';
  const holdings = holdingsOf(basket, form.units, treasury, (b) => b.name);
  const shortage = shortageOf(holdings);
  const basketErr = basket.length ? '' : 'Wähl mindestens eine Aktie aus.';
  const invalid = Boolean(nameErr || tickerErr || descErr || basketErr);
  const show = (key) => touched[key] || tried;

  // Pflichtfelder leer: der Knopf ist ausgegraut, bleibt aber bedienbar — der Klick zeigt die Sätze
  // an den Feldern. Ein deaktivierter Knopf würde nichts erklären.
  const missing = [
    ...(nm ? [] : ['Name']), ...(tk ? [] : ['Kürzel']), ...(basket.length ? [] : ['mindestens eine Aktie']),
  ];
  const incomplete = missing.length > 0;
  const missingHint = incomplete
    ? `${missing.join(', ').replace(/^./, (c) => c.toUpperCase())} ${missing.length === 1 ? 'fehlt noch.' : 'fehlen noch.'}`
    : '';

  const openDialog = () => {
    if (inFlight.current) return;
    setTried(true);
    if (invalid) return;
    setDlgErr('');
    setDraft({
      name: nm, ticker: tk, desc: form.desc.trim(), spu: form.spu, units: form.units,
      basket: basket.map((s) => ({ stock_id: s.id, ticker: s.ticker, qty: s.qty })),
    });
  };

  // Absenden: Eine getippte Zahl im Stepper zählt erst, wenn das Feld verlassen wird. Steht der
  // Cursor noch in einem Stepper (Enter im Stepper oder ein Klick, der den Fokus nicht bewegt),
  // wird es hier verlassen und der Stand sofort übernommen — sonst prüfte der Dialog die Zahl
  // von vor der Eingabe.
  const submitRef = useRef(null);
  submitRef.current = openDialog;
  const submitForm = (e) => {
    e.preventDefault();
    const el = document.activeElement;
    if (el instanceof HTMLElement && e.currentTarget.contains(el) && el.closest('.stepper')) flushSync(() => el.blur());
    submitRef.current();
  };

  // Bestätigungsdialog: Bedarf und Besitz gegen den jeweils aktuellen Treasury-Stand
  const dHoldings = draft ? holdingsOf(draft.basket, draft.units, treasury, (b) => b.ticker) : [];
  const dShort = dHoldings.filter((h) => h.short > 0);
  const dShortage = shortageOf(dHoldings);
  const dValue = draft ? draft.basket.reduce((a, b) => a + b.qty * (priceOf.get(b.stock_id) || 0), 0) : 0;

  const submit = async () => {
    if (inFlight.current || dShort.length) return;
    inFlight.current = true;
    setSaving(true);
    setDlgErr('');
    try {
      await A('/api/admin/etf/create-fund', {
        method: 'POST',
        body: {
          ticker: draft.ticker, name: draft.name, description: draft.desc,
          shares_per_unit: draft.spu, initial_units: draft.units,
          basket: draft.basket.map(({ stock_id, qty }) => ({ stock_id, qty })),
        },
      });
      toast(`${draft.ticker} ist jetzt an der Börse.`, 'ok');
      setDraft(null);
      setForm(EMPTY_FORM);
      setTouched({});
      setTried(false);
      bump();            // vergebene Kürzel und Bestand sofort neu lesen
      onCreated?.();
    } catch (e) {
      // Der Dialog bleibt offen; der Satz steht darin und als Toast.
      setDlgErr(e.message);
      toast(e.message, 'err');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const close = () => { if (!saving) setDraft(null); };
  const errBox = <ErrorBox onRetry={bump}>{`Das ging nicht. ${err}`}</ErrorBox>;

  return (
    <div className="admin-etf">
      <Section title="Neuer ETF">
        {!data ? (
          err ? errBox : <SkelRows n={6} />
        ) : (
          <>
            {err ? errBox : null}
            {stocks.length === 0 ? (
              <Empty title="Noch keine Aktien">
                Ein ETF braucht mindestens eine Aktie im Korb. Sobald eine Firma an der Börse ist, kannst du anlegen.
              </Empty>
            ) : (
              <div className="admin-etf-grid">
                <form
                  className="admin-form"
                  noValidate
                  onSubmit={submitForm}
                >
                  <Field label="Name" help="Steht neben dem Kürzel." htmlFor="etf-name" error={show('name') ? nameErr : ''}>
                    <Input id="etf-name" value={form.name} maxLength={MAX_NAME} autoComplete="off"
                      onChange={(e) => set('name')(e.target.value)} onBlur={() => touch('name')} />
                  </Field>
                  <Field label="Kürzel" help="3 bis 6 Buchstaben, z. B. SCHUL." htmlFor="etf-ticker" error={show('ticker') ? tickerErr : ''}>
                    <Input id="etf-ticker" className="num" value={form.ticker} maxLength={6} autoComplete="off" spellCheck={false}
                      onChange={(e) => set('ticker')(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                      onBlur={() => touch('ticker')} />
                  </Field>
                  <Field label="Beschreibung" help={`Ein Satz, was der ETF abbildet. Optional, bis ${MAX_DESCRIPTION} Zeichen.`}
                    htmlFor="etf-desc" error={show('desc') ? descErr : ''}>
                    <Textarea id="etf-desc" value={form.desc} maxLength={MAX_DESCRIPTION} rows={3}
                      onChange={(e) => set('desc')(e.target.value)} onBlur={() => touch('desc')} />
                  </Field>
                  <Field label="Aktien je Anteil" help="So viele Aktien liegen in einem Anteil. 1 ist am einfachsten." htmlFor="etf-spu">
                    <Stepper id="etf-spu" value={form.spu} min={1} max={100} onChange={set('spu')} label="Aktien je Anteil" suffix="Aktien" />
                  </Field>
                  <Field label="Anteile bei Start" help="So viele Anteile gibt es am Anfang. Die Staatskasse muss die Aktien dafür besitzen."
                    htmlFor="etf-units">
                    <Stepper id="etf-units" value={form.units} min={1} max={100000} onChange={set('units')} label="Anteile bei Start" suffix="Anteile" />
                  </Field>
                  <Field label="Zusammensetzung" help="Stück je Anteil: wie viele Aktien jedes Werts in einem Anteil liegen."
                    error={show('basket') ? (basketErr || shortage) : ''}>
                    <div id="etf-basket" className="admin-etf-basket">
                      {stocks.map((s) => {
                        const q = form.qty[s.id] || 0;
                        const need = q * form.units;
                        const have = treasury[s.ticker] || 0;
                        return (
                          <Row
                            key={s.id}
                            className="admin-etf-pos"
                            leading={(
                              <Symbol ticker={s.ticker} name={s.name}
                                sub={q > 0 ? `Braucht ${fmtI(need)} · Staatskasse hat ${fmtI(have)}` : `Staatskasse hat ${fmtI(have)} Stück`} />
                            )}
                            trailing={<Stepper value={q} min={0} max={100000} label={`Stück je Anteil ${s.ticker}`} onChange={(v) => setQty(s, v)} />}
                          />
                        );
                      })}
                    </div>
                  </Field>
                  <div className="admin-etf-submit">
                    <Button
                      type="submit"
                      full
                      loading={saving}
                      className={incomplete ? 'admin-etf-incomplete' : ''}
                    >
                      ETF anlegen
                    </Button>
                    {incomplete && !saving ? (
                      <p className="admin-note" role="status">{missingHint}</p>
                    ) : null}
                  </div>
                </form>

                <Section title="So sieht der ETF aus" className="admin-etf-preview">
                  {basket.length === 0 ? (
                    <Empty title="Noch leer">Wähl eine Aktie aus, dann steht der Korb hier.</Empty>
                  ) : (
                    <>
                      <div className="admin-etf-head">
                        <div className="admin-etf-title">
                          <div className="num num-lg">{tk || 'Kürzel'}</div>
                          <div className="admin-etf-name">{nm || 'Name'}</div>
                        </div>
                        <div className="admin-etf-nav">
                          <Money c={form.spu ? basketValue / form.spu : basketValue} className="num-lg" />
                          <div className="small muted">bei {fmtI(form.units)} Anteilen</div>
                        </div>
                      </div>
                      {basket.map((s) => (
                        <Row
                          key={s.id}
                          leading={<Symbol ticker={s.ticker} name={s.name} />}
                          trailing={(
                            <>
                              <span><Num v={s.qty} /> Stück · <Money c={s.value} /></span>
                              <span className="small muted"><Pct v={basketValue ? (s.value / basketValue) * 100 : 0} /></span>
                            </>
                          )}
                        />
                      ))}
                      <div className="admin-etf-sum">
                        <span>Korb je Anteil</span>
                        <Money c={basketValue} />
                      </div>
                    </>
                  )}
                  <p className="admin-note">Die Kurse stehen still; der NAV wird beim Anlegen neu berechnet.</p>
                </Section>
              </div>
            )}
          </>
        )}
      </Section>

      <Sheet
        open={Boolean(draft)}
        onClose={close}
        title={`${draft ? draft.ticker : ''} anlegen?`}
        footer={(
          <>
            <Button variant="ghost" onClick={close} disabled={saving}>Abbrechen</Button>
            <Button onClick={submit} loading={saving} disabled={dShort.length > 0}>Anlegen</Button>
          </>
        )}
      >
        {draft ? (
          <div className="admin-form">
            <div className="admin-kv admin-etf-kv">
              <div><span>Kürzel und Name</span><strong>{draft.ticker} · {draft.name}</strong></div>
              {draft.desc ? <div><span>Beschreibung</span><span>{draft.desc}</span></div> : null}
              <div><span>Aktien je Anteil · Anteile bei Start</span><span>{fmtI(draft.spu)} · {fmtI(draft.units)}</span></div>
              <div><span>Gesamtwert des Korbs je Anteil</span><Money c={dValue} /></div>
              <div><span>Bei {fmtI(draft.units)} Anteilen</span><Money c={dValue * draft.units} /></div>
              <div>
                <span>Davon besitzt die Staatskasse</span>
                <span className={dShort.length ? 'neg' : undefined}>
                  {dHoldings.map((h) => `${fmtI(Math.min(h.have, h.need))} von ${fmtI(h.need)} Stück ${h.ticker}`).join(', ')}
                </span>
              </div>
            </div>
            {dShort.length ? (
              <p className="admin-etf-lock" role="alert">
                Anlegen ist gesperrt. {dShortage} Gib die Anteile bei Start kleiner oder wähl weniger Stück.
              </p>
            ) : (
              <p className="admin-note">Die Staatskasse besitzt den Korb. Beim Anlegen werden die Aktien aus ihrem Depot in den ETF gelegt.</p>
            )}
            <ErrorBox>{dlgErr}</ErrorBox>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
