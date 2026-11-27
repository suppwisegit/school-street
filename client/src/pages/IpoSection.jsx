// Börsengang: Abschnitt „Neu an der Börse“ im Markt (PLAN v2 T8, DESIGN 11.2–11.5).
// Zustand „erster Handel“ — eine Zeile je jungem Wert: Kürzel und Name, seit wann er
// notiert, sein erster Kurs, der aktuelle Kurs mit Änderung; darunter die Leiste, die
// zeigt, wie viel der Zeit als „neu“ verstrichen ist. Klick öffnet die Aktie.
// Daten: IPO-News aus GET /api/news?kind=ipo (alle 30 s) und dem WebSocket (sofort); die Kurse
// kommen live aus dem Ticker-Store. Fehlt die Abfrage, bleibt der Abschnitt weg —
// die Werte stehen weiter in der Liste.
import React, { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Chip, LivePrice, Pct, Row, Section, Symbol } from '../ui.jsx';
import { getTickerRow, useIpoHighlightSec, usePoll, useTickerRow } from '../hooks.jsx';
import { fmtC } from '../api.js';
import { addFeed } from '../ws.jsx';
import { api } from '../api.js';
import { duration, ipoById, ipoHighlights, isListingNews, untilText, IPO_HIGHLIGHT_SEC } from '../ipo.js';
import './Market.css';

const POLL_MS = 30000;
const IPO_LIMIT = 20; // GET /api/news?kind=ipo — ein Börsengang je Wert genügt, 20 deckt das Spiel
const MAX_ROWS = 3; // mehr verschiebt die Werteliste zu weit nach unten (bei 390 px sonst kaum sichtbar)
const TICK_MS = 60000; // Alter und Ablauf werden minütlich neu gerechnet

// News-Speicher außerhalb von React: eine Abfrage und ein Abo für alle Seiten.
// Die Abfrage ist auf Börsengänge gefiltert (`kind=ipo`), damit andere News sie nie verdrängen.
// Dazu kommen neue News aus dem WebSocket (`listings`: jüngste IPO-News je Wert), damit ein
// Börsengang sofort steht und bis zur nächsten Abfrage nicht verloren geht. Fenster vorbei
// (ipo_highlight_sec) fliegt er wieder heraus.
const store = { feed: null, listings: new Map(), version: 0, listeners: new Set() };
const sub = (fn) => { store.listeners.add(fn); return () => { store.listeners.delete(fn); }; };
// Beide Quellen, jede News höchstens einmal: gemerkte Börsengänge, dann die Abfrage.
function newsOf(now, windowSec) {
  if (store.feed === null) return null;
  const seen = new Set();
  const out = [];
  for (const n of store.listings.values()) {
    if (now - n.created_at < windowSec * 1000) {
      if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
    } else {
      store.listings.delete(n.security_id); // Fenster vorbei: nicht mehr gemerkt
    }
  }
  for (const n of store.feed) if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
  return out;
}
function remember(n) {
  if (!isListingNews(n) || !Number.isFinite(Number(n.created_at))) return;
  const old = store.listings.get(n.security_id);
  if (!old || Number(n.created_at) > Number(old.created_at)) store.listings.set(n.security_id, n);
}
const notify = () => {
  store.version++;
  for (const l of store.listeners) l();
};
let lastNewsMsg = null;
function onNews(m) {
  if (m === lastNewsMsg) return; // mehrere Zuhörer hören dieselbe Nachricht
  lastNewsMsg = m;
  const n = m && m.type === 'news' ? m.news : null;
  if (!n || n.id == null || store.feed === null) return; // noch keine Liste: die nächste Abfrage holt sie nach
  remember(n);
  if (isListingNews(n)) notify();
}
function setFeed(list) {
  store.feed = list;
  for (const n of list) remember(n);
  notify();
}

// Minütlicher Zeitstand: Alter, Ablauf und Leiste werden ohne neue Abfrage aktuell.
const tickers = new Set();
let tickTimer = null;
function useMinuteTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    tickers.add(setNow);
    if (!tickTimer) {
      tickTimer = setInterval(() => { for (const t of tickers) t(Date.now()); }, TICK_MS);
    }
    return () => {
      tickers.delete(setNow);
      if (!tickers.size && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    };
  }, []);
  return now;
}

// { list, byId }: list = neue Werte (jüngster zuerst), byId = Map securityId → Eintrag.
// `settings.ipo_highlight_sec` (Sekunden, Wanduhr) ist ein optionaler Wert; ohne ihn gilt der
// Default aus ipo.js. Niemand übergibt `settings`: der Hook liest das öffentliche Fenster selbst
// aus GET /api/game (useIpoHighlightSec in hooks.jsx).
export function useIpo({ settings: given } = {}) {
  const now = useMinuteTick();
  const settings = given || { ipo_highlight_sec: useIpoHighlightSec() };
  const highlightSec = Number(settings && settings.ipo_highlight_sec);
  const windowSec = highlightSec > 0 ? highlightSec : IPO_HIGHLIGHT_SEC;
  useEffect(() => addFeed(onNews), []); // ein Abo je eingebauter Hook, wird beim Aushängen gelöst
  const version = useSyncExternalStore(sub, () => store.version);
  const load = useCallback(async () => {
    try {
      const r = await api('/api/news', { params: { kind: 'ipo', limit: IPO_LIMIT } });
      const list = r && Array.isArray(r.news) ? r.news : null;
      if (list) {
        setFeed(list);
      }
    } catch {
      /* Liste bleibt beim letzten Stand; die Werte stehen weiter in der Marktliste */
    }
  }, []);
  usePoll(load, POLL_MS, [load]);
  return useMemo(
    () => {
      const list = ipoHighlights(newsOf(now, windowSec), now, windowSec);
      return { list, byId: ipoById(list) };
    },
    // `version` meldet neue News, `now` den minutlichen Stand
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, now, windowSec],
  );
}

// Eine Zeile. Rendert nur neu, wenn sich ihr Kurs oder ihr Eintrag ändert.
// Zeilentext: Alter, dazu der Bezugskurs. Unter 720 px fehlt „an der Börse“ (der Abschnitt
// sagt es), damit Alter und Kurs neben der Schaltfläche Platz haben.
function sinceSince(ipo, ref) {
  return (
    <>
      Seit {duration(ipo.ageSec)}
      <span className="ipo-since-long"> an der Börse</span>
      {ref ? ` · Bezugskurs ${fmtC(ref)}` : ''}
    </>
  );
}

const IpoRow = memo(function IpoRow({ ipo }) {
  const id = ipo.securityId;
  const navigate = useNavigate();
  const q = useTickerRow(id);
  // Der Wert ist noch nicht im Ticker-Store (Verbindung baut gerade auf): die nächste
  // Ticker-Nachricht bringt ihn, bis dahin bleibt die Zeile weg statt zu crashen.
  if (!q) return null;
  // `ref` ist der erste Kurs der letzten 24 h — für einen jungen Wert der Kurs aus den ersten
  // Minuten, nicht der Startkurs (ipo_price fehlt in /api/securities). Deshalb heißt es hier
  // „Bezugskurs“; die Zahl darunter ist die Änderung dagegen. Fällt `ref` weg (kein Kurs in den
  // letzten 24 h), fehlt beides, statt etwas Falsches zu zeigen.
  const sinceFirst = q.ref > 0;
  const until = untilText(ipo);
  return (
    <div className="ipo-item">
      <Row
        className="ipo-row"
        to={`/security/${id}`}
        leading={(
          <Symbol
            ticker={q.ticker}
            name={q.name}
            sub={<Chip tone="neutral">Erster Handel</Chip>}
          />
        )}
        sub={sinceSince(ipo, sinceFirst ? q.ref : null)}
        trailing={(
          <div className="ipo-side">
            <div className="ipo-quote">
              <LivePrice value={q.last} className="ipo-last" />
              {sinceFirst ? <Pct v={q.chg} signed colored className="ipo-chg" /> : null}
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/security/${id}`)} aria-label={`${q.ticker} handeln`}>
              Handeln
            </Button>
          </div>
        )}
      />
      <div className="ipo-life">
        <span className={`ipo-until${until.warn ? ' warn' : ''}`}>{until.text}</span>
        <span
          className="ipo-bar"
          role="img"
          aria-label={`${Math.round(ipo.progress * 100)} % der Zeit als neuer Wert verstrichen`}
        >
          <span className="ipo-bar-fill" style={{ width: `${(ipo.progress * 100).toFixed(1)}%` }} />
        </span>
      </div>
    </div>
  );
});

// Der Block. Ohne neuen Wert rendert er nichts (kein Platzhalter).
function IpoBlock({ list }) {
  // Zeilen nur für Werte, die im Ticker-Store sind — sonst stünde ein Kopf ohne Zeile da.
  const rows = list.filter((ipo) => getTickerRow(ipo.securityId)).slice(0, MAX_ROWS);
  if (!rows.length) return null;
  const more = list.length - rows.length;
  return (
    <Section
      title="Börsengang"
      action={<span className="ipo-count">{list.length} {list.length === 1 ? 'Wert' : 'Werte'} neu an der Börse</span>}
      className="ipo"
    >
      {rows.map((ipo) => <IpoRow key={ipo.securityId} ipo={ipo} />)}
      {more > 0 && <p className="ipo-more">und {more} {more === 1 ? 'weiterer Wert' : 'weitere Werte'} in der Liste</p>}
    </Section>
  );
}

function IpoOwn() {
  const { list } = useIpo();
  return <IpoBlock list={list} />;
}

// Abschnitt im Markt. Kommt `list` mit (der Markt holt sie für den Marker), fragt und abonniert
// hier nichts — sonst liefe die Abfrage doppelt. Sonst holt sich der Abschnitt die Liste selbst.
export default function IpoSection({ list: given }) {
  return given ? <IpoBlock list={given} /> : <IpoOwn />;
}
