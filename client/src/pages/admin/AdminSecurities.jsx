// Admin, Bereich „Werte": Anträge an die Börse (Freigeben/Ablehnen) und die Liste aller Werte
// mit „Dividende" je Aktie. Der Streubesitz ist beim Freigeben 2000 — damit hat eine neue Aktie
// immer etwas zum Kaufen (F5). Dividenden gibt es nur für Aktien; ETFs leiten sie selbst weiter.
// Stand: GET /api/securities + GET /api/admin/ipo alle 10 s (nur sichtbar) und nach jeder Aktion.
import React, { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { credsToCent, fmtC } from '../../api.js';
import {
  Button, Chip, Confirm, Empty, ErrorBox, Field, Input, LivePrice, Money, Num, Pct, Row, Section,
  Sheet, SkelRows, Stepper, Symbol, useToast,
} from '../../ui.jsx';
import { usePoll } from '../../hooks.jsx';

const fmtI = (n) => (Number(n) || 0).toLocaleString('de-DE');
// Streubesitz: so viele Aktien kann die Klasse kaufen. Der Rest gehört dem Gründer.
const DEFAULT_FLOAT = 2000;
const FOUNDER_SHARES = 1000;

export default function AdminSecurities() {
  const { A } = useOutletContext();
  const toast = useToast();
  const [secs, setSecs] = useState(null);
  const [apps, setApps] = useState(null);
  const [err, setErr] = useState('');
  const [ver, setVer] = useState(0);
  const [busy, setBusy] = useState('');
  // Offener Dialog: { kind: 'ipo' | 'reject', app } oder { kind: 'div', sec }
  const [dlg, setDlg] = useState(null);
  const [ipoPrice, setIpoPrice] = useState('20');
  const [floatShares, setFloatShares] = useState(DEFAULT_FLOAT);
  const [perShare, setPerShare] = useState('1');
  const [preview, setPreview] = useState(null);
  const [dlgErr, setDlgErr] = useState('');
  const lastPreview = useRef(0);

  const bump = () => setVer((v) => v + 1);

  const load = async () => {
    const [s, a] = await Promise.all([
      A('/api/securities').catch((e) => ({ error: e.message })),
      A('/api/admin/ipo').catch((e) => ({ error: e.message })),
    ]);
    if (s.error || a.error) { setErr(s.error || a.error); return; }
    setErr('');
    setSecs(Array.isArray(s.securities) ? s.securities : []);
    setApps(Array.isArray(a.applications) ? a.applications : []);
  };
  usePoll(load, 10000, [ver]);

  // --- Freigeben ---------------------------------------------------------
  const ipoCent = credsToCent(ipoPrice);
  const ipoErr = ipoCent > 0 ? '' : 'Der Startpreis muss größer als 0 sein.';
  const floatErr = floatShares >= 1 ? '' : 'Die Klasse braucht mindestens 1 Aktie zum Kaufen.';

  const openIpo = (app) => {
    setIpoPrice('20');
    setFloatShares(DEFAULT_FLOAT);
    setDlgErr('');
    setDlg({ kind: 'ipo', app });
  };

  const approve = async () => {
    if (ipoErr || floatErr || !dlg?.app) return;
    const app = dlg.app;
    setBusy('ipo');
    try {
      await A(`/api/admin/ipo/${app.id}/approve`, {
        method: 'POST',
        body: {
          ipo_price: ipoCent / 100,
          founder_shares: FOUNDER_SHARES,
          float_shares: floatShares,
          threshold_mult: 1.5,
        },
      });
      toast(`${app.ticker} ist jetzt an der Börse.`, 'ok');
      setDlg(null);
      bump();
    } catch (e) {
      setDlgErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const reject = async (app) => {
    try {
      await A(`/api/admin/ipo/${app.id}/reject`, { method: 'POST' });
    } catch (e) {
      throw new Error(`Das ging nicht. ${e.message}`);
    }
    toast(`${app.ticker} kommt nicht an die Börse.`, 'ok');
    bump();
  };

  // --- Dividende ---------------------------------------------------------
  const divSec = dlg && dlg.sec ? dlg.sec : null;
  const divCent = credsToCent(perShare);

  // Vorschau nur bei offenem Sheet und geänderter Eingabe: 300 ms ruhig, höchstens alle 5 s.
  useEffect(() => {
    if (!divSec || !(divCent > 0)) { setPreview(null); return undefined; }
    const sec = divSec;
    const cents = divCent;
    let alive = true;
    const wait = Math.max(300, 5000 - (Date.now() - lastPreview.current));
    const t = setTimeout(async () => {
      lastPreview.current = Date.now();
      try {
        const r = await A('/api/admin/dividend/preview', {
          params: { security_id: sec.id, per_share: cents / 100 },
        });
        if (alive) setPreview(r);
      } catch (e) {
        if (alive) { setPreview(null); setDlgErr(e.message); }
      }
    }, wait);
    return () => { alive = false; clearTimeout(t); };
  }, [divSec, divCent, A]);

  const openDiv = (sec) => {
    setPerShare('1');
    setPreview(null);
    setDlgErr('');
    setDlg({ kind: 'div', sec });
  };

  // Erst auszahlen, wenn die Vorschau genau zum eingegebenen Betrag passt.
  const ready = Boolean(divSec) && divCent > 0 && preview?.per_share === divCent;

  const pay = async () => {
    if (!ready || !divSec) return;
    const sec = divSec;
    setBusy('div');
    try {
      const r = await A('/api/admin/dividend', {
        method: 'POST',
        body: { security_id: sec.id, per_share: divCent / 100 },
      });
      toast(`Dividende gezahlt: ${fmtC(r.total)} Credits an ${fmtI(r.holders)} Konten.`, 'ok');
      setDlg(null);
      bump();
    } catch (e) {
      setDlgErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const close = () => { if (!busy) setDlg(null); };
  const blocked = busy !== '';
  const secList = secs || [];
  const appList = apps || [];
  const app = dlg && dlg.app ? dlg.app : null;
  const errBox = <ErrorBox onRetry={bump}>{`Das ging nicht. ${err}`}</ErrorBox>;

  return (
    <div className="admin-areas">
      {!secs || !apps ? (
        <Section title="Werte">{err ? errBox : <SkelRows n={6} />}</Section>
      ) : (
        <>
          {err ? errBox : null}

          <Section title="Anträge an die Börse">
            {appList.length === 0 ? (
              <Empty title="Keine offenen Anträge">
                Bringt jemand eine eigene Firma an die Börse, steht der Antrag hier.
              </Empty>
            ) : appList.map((a) => (
              <Row
                key={a.id}
                title={`${a.name} (${a.ticker})`}
                sub={`Von ${a.username || 'Unbekannt'}. ${a.description || ''}`}
                trailing={(
                  <div className="admin-ctl">
                    <Button variant="primary" size="sm" disabled={blocked} onClick={() => openIpo(a)}>
                      Freigeben
                    </Button>
                    <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setDlg({ kind: 'reject', app: a })}>
                      Ablehnen
                    </Button>
                  </div>
                )}
              />
            ))}
          </Section>

          <Section title="Werte">
            {secList.length === 0 ? (
              <Empty title="Noch keine Werte">Nach der ersten freigegebenen Firma stehen sie hier.</Empty>
            ) : secList.map((s) => (
              <Row
                key={s.id}
                leading={<Symbol ticker={s.ticker} name={s.name} />}
                trailing={(
                  <div className="admin-ctl admin-quote">
                    <LivePrice value={s.last} />
                    <Pct v={s.chg} signed colored />
                    {s.type === 'etf' ? <Chip>ETF</Chip> : null}
                    {s.type === 'stock' ? (
                      <Button variant="ghost" size="sm" disabled={blocked} onClick={() => openDiv(s)}>
                        Dividende
                      </Button>
                    ) : null}
                  </div>
                )}
              />
            ))}
          </Section>
        </>
      )}

      <Sheet
        open={Boolean(app && dlg.kind === 'ipo')}
        onClose={close}
        title="Firma an die Börse bringen"
        footer={(
          <>
            <Button variant="ghost" onClick={close}>Abbrechen</Button>
            <Button variant="primary" onClick={approve} loading={busy === 'ipo'} disabled={Boolean(ipoErr || floatErr)}>
              Freigeben
            </Button>
          </>
        )}
      >
        {app ? (
          <div className="admin-form">
            <p className="admin-note">
              {app.name} ({app.ticker}) kommt mit diesem Startpreis in die Werteliste. Danach bestimmt der Handel den Kurs.
            </p>
            <Field
              label="Startpreis je Aktie (Credits)"
              help="Zu diesem Preis beginnt die Aktie. Der Gründer bekommt 1.000 eigene Aktien."
              htmlFor="ipo-price"
              error={ipoErr}
            >
              <Input
                id="ipo-price"
                className="num"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.5"
                value={ipoPrice}
                onChange={(e) => setIpoPrice(e.target.value)}
              />
            </Field>
            <Field
              label="Streubesitz"
              help="So viele Aktien kann die Klasse kaufen. Dafür zahlt die Börse dem Gründer den Betrag unten."
              htmlFor="ipo-float"
              error={floatErr}
            >
              <Stepper
                id="ipo-float"
                value={floatShares}
                onChange={setFloatShares}
                min={0}
                max={100000}
                step={100}
                label="Streubesitz"
                suffix="Aktien"
              />
            </Field>
            <div className="admin-kv">
              <div>
                <span>Zahlung an den Gründer</span>
                <Money c={ipoCent > 0 ? ipoCent * floatShares : 0} />
              </div>
              <div>
                <span>Aktien insgesamt</span>
                <Num v={FOUNDER_SHARES + Math.max(0, floatShares)} />
              </div>
            </div>
            <ErrorBox>{dlgErr}</ErrorBox>
          </div>
        ) : null}
      </Sheet>

      <Confirm
        open={Boolean(app && dlg.kind === 'reject')}
        title={`${app?.name} ablehnen?`}
        confirmLabel="Ablehnen"
        danger
        onClose={close}
        onConfirm={() => reject(app)}
      >
        {app?.name} ({app?.ticker}) kommt nicht an die Börse. Der Antrag wird geschlossen, das kannst du nicht
        zurücknehmen.
      </Confirm>

      <Sheet
        open={Boolean(divSec)}
        onClose={close}
        title="Dividende zahlen"
        footer={(
          <>
            <Button variant="ghost" onClick={close}>Abbrechen</Button>
            <Button variant="primary" onClick={pay} loading={busy === 'div'} disabled={!ready}>Auszahlen</Button>
          </>
        )}
      >
        {divSec ? (
          <div className="admin-form">
            <p className="admin-note">
              Eine Dividende ist eine Auszahlung an alle, die {divSec.name} ({divSec.ticker}) besitzen. Die Börse zahlt.
            </p>
            <Field
              label="Betrag je Aktie (Credits)"
              help="Jedes Konto bekommt diesen Betrag für jede Aktie, die es besitzt."
              htmlFor="div-amount"
              error={dlgErr}
            >
              <Input
                id="div-amount"
                className="num"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.1"
                value={perShare}
                onChange={(e) => { setDlgErr(''); setPerShare(e.target.value); }}
              />
            </Field>
            {ready && preview ? (
              <div className="admin-kv">
                <div><span>Aktien bei den Besitzern</span><Num v={preview.total_shares} /></div>
                <div><span>Konten, die Geld bekommen</span><Num v={preview.holders} /></div>
                <div><span>Gesamt</span><Money c={preview.total} /></div>
              </div>
            ) : (
              <p className="small muted">{divCent > 0 ? 'Vorschau wird geladen …' : 'Gib einen Betrag über 0 ein.'}</p>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
