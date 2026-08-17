// Admin: Bot-Modus (Testspiel) — 100 virtuelle Trader starten/stoppen und die
// Handels-Aktivität regeln. GET/POST /api/admin/bots, PUT /api/admin/bots/settings.
import React, { useEffect, useState } from 'react';
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { Card, Chip, Empty, ErrorBox, Field, Loading, useToast } from '../../ui.jsx';

const PRESETS = [
  { label: 'Ruhig', v: 5 },
  { label: 'Balanced', v: 10 },
  { label: 'Lebhaft', v: 25 },
  { label: 'Hektisch', v: 50 }
];

const sinceStr = (ts) => {
  if (!ts) return '–';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

export default function AdminBots({ A, toast }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(null); // Slider-Wert (lokal editierbar)
  const [tickSec, setTickSec] = useState(null);

  const apply = (r) => { setSt(r); setActivity(r.activity); setTickSec(r.tick_sec); };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await A('/api/admin/bots');
        if (!alive) return;
        setSt(r);
        setActivity((a) => a ?? r.activity);
        setTickSec((t) => t ?? r.tick_sec);
        setErr('');
      } catch (e) { if (alive) setErr(e.message); }
    };
    load();
    const p = setInterval(load, 5000);
    return () => { alive = false; clearInterval(p); };
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await A(`/api/admin/bots/${st.running ? 'stop' : 'start'}`, { method: 'POST' });
      apply(r);
      toast(st.running ? 'Testspiel-Modus gestoppt' : 'Testspiel-Modus gestartet', 'ok');
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  const toggleFast = async () => {
    const turnOn = !st.fast;
    if (turnOn && !window.confirm('🚀 Fast-Mode aktivieren?\n\nDie Bots traden mit 100× Geschwindigkeit (Deckel 200 Trades/Tick), um in Minuten Chart-Muster zu erzeugen und den Market Maker zu stressen. Für den normalen Spielbetrieb wieder ausschalten!'))
      return;
    setBusy(true);
    try {
      const r = await A('/api/admin/bots/settings', { method: 'PUT', body: { bot_fast: turnOn ? 1 : 0 } });
      apply(r);
      toast(turnOn ? 'Fast-Mode AN (×100)' : 'Fast-Mode aus', 'ok');
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await A('/api/admin/bots/settings', { method: 'PUT', body: { bot_activity: Number(activity), bot_tick_sec: Number(tickSec) } });
      apply(r);
      toast('Bot-Einstellungen gespeichert', 'ok');
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  if (err && !st) return <ErrorBox>{err}</ErrorBox>;
  if (!st) return <Loading />;

  const dirty = Number(activity) !== st.activity || Number(tickSec) !== st.tick_sec;
  const tradesPerMin = (Number(activity) / 100) * 2 * (60 / Math.max(1, Number(tickSec) || 3)) * (st.fast ? 100 : 1);

  return (
    <div className="panelgrid">
      <Card
        title="Testspiel-Modus (virtuelle Trader)"
        className="span2"
        right={st.running ? <Chip green>läuft · seit {sinceStr(st.started_at)}</Chip> : <Chip red>gestoppt</Chip>}
      >
        <div className="hintbox" style={{ marginBottom: 12 }}>
          Ideal für Ferien-Testspiele mit wenigen echten Spielern: {st.count} virtuelle Schüler („Alex (Bot 5)“, „Mia (Bot 23)“, …)
          erhalten normales Startkapital — <b>ohne Aktien im Depot</b>, genau wie echte Trader. Einige gründen beim Start per IPO eine
          eigene Firma und halten dafür Gründeraktien (mit Lock-up). Die Bots handeln überwiegend mit Market-Orders, reagieren auf
          News &amp; Dividenden und fahren Kurs-Trends nach — Escrow, Gebühren und Preis-Band gelten für sie wie für alle anderen.
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className={st.running ? 'btn danger xl' : 'btn buy xl'} disabled={busy} onClick={toggle}>
            {st.running ? <><IconPlayerPause size={16} stroke={2} /> Modus stoppen</> : <><IconPlayerPlay size={16} stroke={2} /> Modus starten</>}
          </button>
          <button className={`btn xl ${st.fast ? 'danger' : 'ghost'}`} disabled={busy || !st.running} onClick={toggleFast}
            title="100× Handelsgeschwindigkeit — für MM-/Pattern-Tests">
            🚀 Fast-Mode {st.fast ? 'AN (×100)' : 'aus'}
          </button>
        </div>
        <div className="statgrid admin" style={{ marginTop: 14 }}>
          <div className="stat"><div className="lbl">Virtuelle Trader</div><div className="val num">{st.bots}</div></div>
          <div className="stat"><div className="lbl">Bot-Firmen</div><div className="val num">{st.bot_companies.length}</div></div>
          <div className="stat"><div className="lbl">Trades seit Start</div><div className="val num">{st.trades_this_run}</div></div>
          <div className="stat"><div className="lbl">Trades (letzte Std.)</div><div className="val num">{st.trades_last_hour}</div></div>
          <div className="stat"><div className="lbl">Verworfene Versuche</div><div className="val num">{st.errors}</div></div>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          „Verworfene Versuche“ sind harmlos: pleite Bots, leere Bücher oder Lock-up-Verkäufe werden still übersprungen.
          Der Modus überlebt einen Server-Neustart und läuft dann automatisch weiter.
        </div>
      </Card>

      <Card title="Handels-Aktivität">
        <div className="row between">
          <span className="muted small">ruhig</span>
          <b className="num" style={{ fontSize: 22 }}>{activity ?? 0}</b>
          <span className="muted small">hektisch</span>
        </div>
        <input
          type="range" min="0" max="100" step="1"
          style={{ width: '100%', margin: '6px 0 10px' }}
          value={activity ?? 0}
          onChange={(e) => setActivity(Number(e.target.value))}
        />
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {PRESETS.map((p) => (
            <button key={p.v} className={`btn sm ${Number(activity) === p.v ? 'primary' : ''}`} onClick={() => setActivity(p.v)}>{p.label}</button>
          ))}
        </div>
        <Field label="Tick-Intervall (Sekunden)" help="Alle X Sekunden würfelt der Modus neue Bot-Trades aus (live änderbar).">
          <input className="input num" type="number" min="1" step="1" value={tickSec ?? ''} onChange={(e) => setTickSec(e.target.value)} />
        </Field>
        <div className="small muted" style={{ margin: '8px 0 12px' }}>
          ≈ <b className="num">{tradesPerMin.toFixed(1)}</b> Trades/Minute über alle {st.bots} Bots hinweg
          {st.fast ? <span style={{ color: 'var(--down)', fontWeight: 800 }}> (FAST-MODE ×100!)</span> : ' (Default 40 = lebhaftes Testspiel)'}.
        </div>
        <ErrorBox>{err}</ErrorBox>
        <button className="btn primary block" disabled={busy || !dirty} onClick={save}>
          {busy ? 'Speichern …' : 'Übernehmen'}
        </button>
      </Card>

      <Card title={`Bot-Firmen (${st.bot_companies.length})`}>
        {st.bot_companies.length === 0
          ? <Empty>Noch keine Bot-Firmen — sie entstehen beim nächsten Start (solange der Ticker-Pool reicht).</Empty>
          : (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {st.bot_companies.map((c) => <Chip key={c.ticker} blue>{c.ticker} · {c.name}</Chip>)}
            </div>
          )}
        <div className="small muted" style={{ marginTop: 10 }}>
          Gründer-Bots halten je Firma 1.000 Gründeraktien (Lock-up). Mögliche Ticker:
          KICK, TAXI, BIO, TAB, BAND, MERCH, SCOOT, LERN, AULA, PRINT.
        </div>
      </Card>
    </div>
  );
}
