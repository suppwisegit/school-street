// Admin, Bereich „Spiel": Pause, Bots, Einkommen, Startkapital, Gebühr.
// Jede Einstellung ist eine Zeile mit Hilfesatz; Geld wird in Credits eingegeben.
// Stand: GET /api/game + GET /api/admin/bots alle 10 s (nur sichtbar) und nach jeder Aktion.
import React, { useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { credsToCent, dateTimeStr, fmtC } from '../../api.js';
import {
  Button, Chip, ErrorBox, Input, Row, Section, Select, SkelRows, Stepper, useToast,
} from '../../ui.jsx';
import { usePoll } from '../../hooks.jsx';

// Abstand des Einkommens in Sekunden; 0 = nur von Hand.
const EVERY = [
  { value: '0', label: 'Aus', done: 'Das Einkommen kommt jetzt nur noch, wenn du es auszahlst.' },
  { value: '300', label: 'Alle 5 Minuten', done: 'Das Einkommen kommt jetzt alle 5 Minuten.' },
  { value: '3600', label: 'Jede Stunde', done: 'Das Einkommen kommt jetzt jede Stunde.' },
  { value: '86400', label: 'Jeden Tag', done: 'Das Einkommen kommt jetzt jeden Tag.' },
  { value: '604800', label: 'Jede Woche', done: 'Das Einkommen kommt jetzt jede Woche.' },
];

const MONEY = [
  {
    key: 'income_cent', title: 'Einkommen',
    help: 'So viel Guthaben bekommt jedes Konto, wenn das Einkommen ausgezahlt wird.',
    done: (c) => `Gespeichert. Das Einkommen ist jetzt ${fmtC(c)} Credits.`,
  },
  {
    key: 'start_capital', title: 'Startkapital',
    help: 'So viel Guthaben bekommt jedes neue Konto am Anfang.',
    done: (c) => `Gespeichert. Neue Konten starten mit ${fmtC(c)} Credits.`,
  },
  {
    key: 'fee_cent', title: 'Gebühr',
    help: 'So viel kostet jeder Kauf und jeder Verkauf. Das Geld ist danach aus dem Spiel.',
    done: (c) => `Gespeichert. Ein Kauf oder Verkauf kostet jetzt ${fmtC(c)} Credits.`,
  },
];

const fmtI = (n) => (Number(n) || 0).toLocaleString('de-DE');
const numOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// Eingabe in Credits → Zahl; NaN, wenn leer oder keine Zahl
const credit = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  return s === '' ? NaN : Number(s);
};

export default function AdminGame() {
  const { A } = useOutletContext();
  const toast = useToast();
  const [game, setGame] = useState(null);
  const [bots, setBots] = useState(null);
  const [err, setErr] = useState('');
  const [ver, setVer] = useState(0);
  // Eingaben in Credits als Text; fehlender Schlüssel = noch nichts getippt
  const [edit, setEdit] = useState({});
  const [act, setAct] = useState(null);
  const [busy, setBusy] = useState('');
  const lastGame = useRef(null);
  const lastBots = useRef(null);

  const bump = () => setVer((v) => v + 1);

  const load = async () => {
    const [g, b] = await Promise.all([
      A('/api/game').catch((e) => ({ error: e.message })),
      A('/api/admin/bots').catch((e) => ({ error: e.message })),
    ]);
    if (g.error && b.error) { setErr(g.error); return; }
    setErr(g.error || b.error || '');
    if (!g.error) {
      const was = lastGame.current;
      lastGame.current = g;
      setGame(g);
      // Nur übernehmen, was niemand gerade tippt: noch nie editiert oder unverändert seit dem letzten Stand
      setEdit((e) => {
        const next = { ...e };
        for (const f of MONEY) {
          if (e[f.key] == null || credsToCent(e[f.key]) === was?.[f.key]) next[f.key] = String(numOf(g[f.key]) / 100);
        }
        return next;
      });
    }
    if (!b.error) {
      const was = lastBots.current?.activity;
      lastBots.current = b;
      setBots(b);
      setAct((a) => (a == null || a === was ? numOf(b.activity) : a));
    }
  };
  usePoll(load, 10000, [ver]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(`Das ging nicht. ${e.message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const patchGame = (patch) => {
    if (lastGame.current) lastGame.current = { ...lastGame.current, ...patch };
    setGame((g) => (g ? { ...g, ...patch } : g));
  };

  const setPaused = (paused) => run('pause', async () => {
    await A(`/api/admin/game/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
    patchGame({ paused });
    toast(paused ? 'Pause. Niemand kann gerade kaufen oder verkaufen.' : 'Die Börse läuft wieder.', 'ok');
    bump();
  });

  const toggleBots = () => run('bots', async () => {
    const turnOn = !bots.running;
    const r = await A(`/api/admin/bots/${turnOn ? 'start' : 'stop'}`, { method: 'POST' });
    lastBots.current = r;
    setBots(r);
    setAct(numOf(r.activity));
    toast(turnOn
      ? `Bots sind an. ${fmtI(r.bots)} erfundene Mitspieler handeln jetzt.`
      : 'Bots sind aus. Sie handeln nicht mehr.', 'ok');
  });

  const saveActivity = () => run('act', async () => {
    const r = await A('/api/admin/bots/settings', { method: 'PUT', body: { bot_activity: act } });
    lastBots.current = r;
    setBots(r);
    setAct(numOf(r.activity));
    toast(`Gespeichert. Die Bots handeln jetzt mit ${numOf(r.activity)} von 100.`, 'ok');
  });

  const saveEvery = (value) => run('every', async () => {
    const r = await A('/api/admin/settings', { method: 'PUT', body: { income_sec: Number(value) } });
    const saved = numOf(r.settings?.income_sec);
    patchGame({ income_sec: saved });
    const hit = EVERY.find((o) => o.value === String(saved));
    toast(hit ? `Gespeichert. ${hit.done}` : `Gespeichert. Der Abstand ist jetzt ${saved} Sekunden.`, 'ok');
  });

  const payNow = () => run('now', async () => {
    const r = await A('/api/admin/income/now', { method: 'POST' });
    const inMs = Number(r?.next_income_in);
    if (Number.isFinite(inMs)) patchGame({ income_next_at: Date.now() + inMs });
    toast(`Ausgezahlt. Das Einkommen war ${fmtC(game.income_cent)} Credits je Konto.`, 'ok');
    bump();
  });

  const moneyErr = (key) => (credit(edit[key]) >= 0 ? '' : 'Gib eine Zahl ab 0 ein.');

  const saveMoney = (f) => run(f.key, async () => {
    const cents = credsToCent(edit[f.key]);
    const r = await A('/api/admin/settings', { method: 'PUT', body: { [f.key]: cents } });
    const saved = numOf(r.settings?.[f.key]);
    patchGame({ [f.key]: saved });
    setEdit((e) => ({ ...e, [f.key]: String(saved / 100) }));
    toast(f.done(saved), 'ok');
  });

  const blocked = busy !== '';

  const moneyRow = (f) => {
    const wrong = moneyErr(f.key);
    const typed = edit[f.key] != null && edit[f.key] !== '';
    return (
      <Row
        key={f.key}
        className="admin-set"
        title={f.title}
        sub={typed && wrong ? wrong : f.help}
        trailing={(
          <div className="admin-ctl">
            <Input
              className="num admin-money"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              aria-label={`${f.title} in Credits`}
              aria-invalid={typed && wrong ? true : undefined}
              value={edit[f.key] ?? ''}
              onChange={(e) => setEdit((s) => ({ ...s, [f.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (!wrong) saveMoney(f); }
              }}
            />
            <span className="small muted">Credits</span>
            <Button
              variant="primary"
              size="sm"
              loading={busy === f.key}
              disabled={blocked || Boolean(wrong) || credsToCent(edit[f.key]) === game[f.key]}
              onClick={() => saveMoney(f)}
            >
              Speichern
            </Button>
          </div>
        )}
      />
    );
  };

  const errBox = <ErrorBox onRetry={bump}>{`Das ging nicht. ${err}`}</ErrorBox>;
  if (!game || !bots) {
    return <Section title="Spiel">{err ? errBox : <SkelRows n={5} />}</Section>;
  }

  const paused = Boolean(game.paused);
  const running = Boolean(bots.running);
  const every = String(numOf(game.income_sec));
  const everyOptions = EVERY.some((o) => o.value === every)
    ? EVERY
    : [...EVERY, { value: every, label: `${every} Sekunden (so eingestellt)`, done: '' }];
  // Zeitstempel in Millisekunden; liegt er in der Vergangenheit, kennen wir den nächsten Termin nicht
  const nextRaw = Number(game.income_next_at);
  const nextAt = Number.isFinite(nextRaw) && nextRaw > Date.now() ? nextRaw : null;

  return (
    <div className="admin-areas">
      {err ? errBox : null}

      <Section title="Spiel">
        <Row
          leading={<Chip tone={paused ? 'warn' : 'neutral'}>{paused ? 'Pausiert' : 'Läuft'}</Chip>}
          title={paused ? 'Die Börse macht Pause' : 'Die Börse läuft'}
          sub={paused ? 'Niemand kann gerade kaufen oder verkaufen.' : 'Alle können kaufen und verkaufen.'}
          trailing={(
            <Button variant={paused ? 'primary' : 'ghost'} size="sm" loading={busy === 'pause'} onClick={() => setPaused(!paused)}>
              {paused ? 'Weiter' : 'Pause'}
            </Button>
          )}
        />
      </Section>

      <Section title="Bots">
        <Row
          title={running ? 'Bots sind an' : 'Bots sind aus'}
          sub={`Bots sind erfundene Mitspieler. Sie kaufen und verkaufen, damit sich die Kurse bewegen.${
            running ? ` Gerade sind ${fmtI(bots.bots)} Bots dabei.` : ''}`}
          trailing={(
            <Button variant={running ? 'ghost' : 'primary'} size="sm" loading={busy === 'bots'} onClick={toggleBots}>
              {running ? 'Bots ausschalten' : 'Bots einschalten'}
            </Button>
          )}
        />
        <Row
          className="admin-set"
          title="Wie viel die Bots handeln"
          sub="Von 0 bis 100. Bei 0 tun die Bots nichts, bei 100 handeln sie jedes Mal."
          trailing={(
            <div className="admin-ctl">
              <Stepper value={act ?? 0} onChange={setAct} min={0} max={100} step={5} label="Wie viel die Bots handeln" />
              <Button
                variant="primary"
                size="sm"
                loading={busy === 'act'}
                disabled={blocked || act == null || act === numOf(bots.activity)}
                onClick={saveActivity}
              >
                Speichern
              </Button>
            </div>
          )}
        />
      </Section>

      <Section title="Einkommen">
        {moneyRow(MONEY[0])}
        <Row
          className="admin-set"
          title="Wie oft das Einkommen kommt"
          sub="Nach diesem Abstand wird das Einkommen von selbst ausgezahlt. Bei „Aus“ nur, wenn du es selbst auszahlst."
          trailing={(
            <Select
              aria-label="Wie oft das Einkommen kommt"
              value={every}
              disabled={blocked}
              onChange={(e) => saveEvery(e.target.value)}
            >
              {everyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        />
        <Row
          title={every !== '0' && nextAt ? `Nächste Auszahlung ${dateTimeStr(nextAt)}` : 'Auszahlung von Hand'}
          sub="Mit einem Klick bekommen alle das Einkommen sofort."
          trailing={(
            <Button variant="ghost" size="sm" loading={busy === 'now'} onClick={payNow}>Jetzt auszahlen</Button>
          )}
        />
      </Section>

      <Section title="Startkapital und Gebühr">
        {MONEY.slice(1).map(moneyRow)}
      </Section>
    </div>
  );
}
