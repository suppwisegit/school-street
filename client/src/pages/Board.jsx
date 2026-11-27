// Beamer: der Index als große Zahl mit Kursverlauf, darunter links die Kurse —
// nach Tagesleistung sortiert, Gewinner zuerst — und rechts die Top 10.
// Die Kurse kommen live über den WebSocket (Gast-Verbindung); nur Indexverlauf,
// Rangliste (alle 30 s) und die Uhr (minütlich) werden erneut geholt.
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar, Money, Pct } from '../ui.jsx';
import { LineChart, getTickerRow, usePoll, useTicker, useTickerRow } from '../hooks.jsx';
import { api } from '../api.js';
import { useIpo } from './IpoSection.jsx';
import { untilText } from '../ipo.js';
import { NewsLines } from '../news/index.jsx';
import './Board.css';

const BOARD_MS = 30000;
// Zwei Nachkommastellen, wie in Spieler-App und Admin (DESIGN 0/7): 21,10 statt 21,1.
const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–');

// Eine Kurszeile. Rendert nur neu, wenn sich genau dieser Kurs ändert.
const Quote = memo(function Quote({ id, rank }) {
  const t = useTickerRow(id);
  if (!t) return null;
  return (
    <tr>
      <td className="bd-rank num">{rank}</td>
      <td className="bd-tk">{t.ticker}</td>
      <td className="num r">{fmt(t.last / 100)}</td>
      <td className="num r"><Pct v={t.chg} signed colored /></td>
    </tr>
  );
});

export default function Board() {
  const { ready, ids, version } = useTicker();
  const { list: newOnes } = useIpo();
  // Börsengänge (jüngster zuerst): Ticker, Kurs, Änderung — Werte ohne Ticker-Zeile fehlen noch.
  const ipoLines = newOnes.filter((ipo) => getTickerRow(ipo.securityId)).slice(0, 4);
  const ipoMore = newOnes.length - ipoLines.length;
  const [board, setBoard] = useState(null);
  const [clock, setClock] = useState(() => new Date());

  // Beamer-Fassung einschalten (größere Schrift über die Tokens)
  useEffect(() => {
    document.documentElement.dataset.view = 'board';
    return () => { delete document.documentElement.dataset.view; };
  }, []);

  const load = useCallback(async () => {
    try {
      if (!document.hidden) setBoard(await api('/api/board'));
    } catch {
      /* Index und Rangliste fehlen dann — die Kurse kommen weiter live über WS */
    }
  }, []);
  usePoll(load, BOARD_MS, [load]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // Tagesleistung:`version` ändert sich mit jedem Kurs, `ids` mit jedem Ticker
  const order = useMemo(
    () => ids.map((id) => getTickerRow(id)).filter(Boolean).sort((a, b) => b.chg - a.chg).map((r) => r.id),
    [ids, version],
  );
  const top = board && Array.isArray(board.leaderboard) ? board.leaderboard : [];
  const history = board && Array.isArray(board.index_history) ? board.index_history : [];
  // Die letzten Schlagzeilen kommen mit /api/board (alle 30 s) — keine eigene Abfrage.
  const news = board && Array.isArray(board.news) ? board.news : [];

  return (
    <div className="board" style={{ '--bd-rows': order.length }}>
      <header className="bd-head">
        <span className="bd-brand">School Street</span>
        <span className="bd-index num">{fmt(board ? board.index : null)}</span>
        <span className="bd-clock num">{clock.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
      </header>

      {!ready && (
        <div className="bd-off" role="status">Keine Verbindung zur Börse — es wird erneut versucht.</div>
      )}

      {/* Börsengang: eine Zeile unter der Kopfzeile, nur solange ein Wert als neu gilt */}
      {ipoLines.length > 0 && (
        <div className="bd-ipo">
          <span className="bd-ipo-label">Börsengang</span>
          {ipoLines.map((ipo) => {
            const t = getTickerRow(ipo.securityId);
            const until = untilText(ipo);
            return (
              <span className="bd-ipo-item" key={ipo.securityId}>
                <b>{t.ticker}</b>
                <span className="num">{fmt(t.last / 100)}</span>
                <Pct v={t.chg} signed colored />
                <span className={`bd-ipo-until${until.warn ? ' warn' : ''}`}>{until.text}</span>
              </span>
            );
          })}
          {ipoMore > 0 && <span className="bd-ipo-item">+{ipoMore} weitere</span>}
        </div>
      )}

      {/* Kursverlauf des Index */}
      <div className="bd-chart">
        <LineChart points={history} scale={1.6} />
      </div>

      <div className="bd-cols">
        <div className="bd-main">
          <div className="bd-quotes">
            <table className="table bd-table">
              <thead>
                <tr><th className="bd-rank">#</th><th>Wert</th><th className="r">Kurs</th><th className="r">Heute</th></tr>
              </thead>
              <tbody>
                {order.map((id, i) => <Quote key={id} id={id} rank={i + 1} />)}
              </tbody>
            </table>

            {/* News (T7c, DESIGN 9.4): die letzten drei Schlagzeilen als Textzeilen unter der Kursliste */}
            <section className="bd-news" aria-label="News">
              <h2>News</h2>
              <NewsLines limit={3} items={news} />
            </section>
          </div>
        </div>

        <section className="bd-top">
          <h2>Rangliste</h2>
          {top.map((u, i) => (
            <div className="bd-lb" key={u.username}>
              <span className="num bd-place">{i + 1}</span>
              <Avatar seed={u.username} label={u.username} size={40} />
              <span className="bd-name">{u.username}</span>
              <Money c={u.worth} className="num" />
            </div>
          ))}
        </section>
      </div>

    </div>
  );
}
