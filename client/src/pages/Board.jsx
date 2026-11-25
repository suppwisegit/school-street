// Beamer: der Index als große Zahl, links die Kurse, rechts die Top 10.
// Die Kurse kommen live über den WebSocket (Gast-Verbindung); nur die Rangliste
// (alle 30 s) und die Uhr (minütlich) werden erneut geholt.
import React, { memo, useCallback, useEffect, useState } from 'react';
import { Avatar, Money, Pct } from '../ui.jsx';
import { usePoll, useTicker, useTickerRow } from '../hooks.jsx';
import { api } from '../api.js';
import './Board.css';

const BOARD_MS = 30000;
const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '–');

// Eine Kurszeile. Rendert nur neu, wenn sich genau dieser Kurs ändert.
const Quote = memo(function Quote({ id }) {
  const t = useTickerRow(id);
  if (!t) return null;
  return (
    <tr>
      <td className="bd-tk">{t.ticker}</td>
      <td className="num r">{fmt(t.last / 100)}</td>
      <td className="num r"><Pct v={t.chg} signed colored /></td>
    </tr>
  );
});

export default function Board() {
  const { ready, ids } = useTicker();
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

  const top = board && Array.isArray(board.leaderboard) ? board.leaderboard : [];

  return (
    <div className="board">
      <header className="bd-head">
        <span className="bd-brand">School Street</span>
        <span className="bd-index num">{fmt(board ? board.index : null)}</span>
        <span className="bd-clock num">{clock.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
      </header>

      {!ready && (
        <div className="bd-off" role="status">Keine Verbindung zur Börse — es wird erneut versucht.</div>
      )}

      <div className="bd-cols">
        <table className="table bd-table">
          <thead>
            <tr><th>Wert</th><th className="r">Kurs</th><th className="r">Heute</th></tr>
          </thead>
          <tbody>
            {ids.map((id) => <Quote key={id} id={id} />)}
          </tbody>
        </table>

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
