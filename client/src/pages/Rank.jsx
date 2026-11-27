// Rang: „Platz n" ist die eine große Zahl. Darunter die Liste; die eigene Zeile
// bleibt unten sichtbar, wenn man nicht mehr darin steht.
// Abfrage (Budget V4): /leaderboard und /portfolio alle 15 s.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Avatar, Empty, ErrorBox, LivePrice, Money, Row, Section, SkelRows, confetti, useToast } from '../ui.jsx';
import { usePoll } from '../hooks.jsx';
import { api } from '../api.js';
import './Player.css';

// Rangtitel nach Depotwert (Cent) — Schwellen unverändert aus der bisherigen Profil-Seite.
const RANKS = [
  { min: 5000000, name: 'Whale' },
  { min: 2500000, name: 'Wolf' },
  { min: 1000000, name: 'Hustler' },
  { min: 500000, name: 'NPC' },
  { min: 0, name: 'Broke' },
];
export const rankTitle = (worth) => (RANKS.find((r) => worth >= r.min) || RANKS[RANKS.length - 1]).name;
const rankIndex = (worth) => RANKS.findIndex((r) => worth >= r.min);
const place = (v) => (v > 0 ? `Platz ${v}` : '–');
const RANK_MS = 15000;

export default function Rank() {
  const { user } = useOutletContext();
  const toast = useToast();
  const [data, setData] = useState(null); // { leaderboard, my_rank }
  const [mine, setMine] = useState(null); // { worth }
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const lastRank = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const [lb, pf] = await Promise.all([api('/api/leaderboard'), api('/api/portfolio')]);
      if (!alive.current) return;
      setData(lb);
      setMine({ worth: pf.net_worth });
      setFailed(false);
      // Rangaufstieg (Broke → NPC → …): einmal feiern
      const idx = rankIndex(pf.net_worth);
      if (lastRank.current != null && idx >= 0 && idx < lastRank.current) {
        confetti(undefined, 'rank');
        toast(`Du bist jetzt ${RANKS[idx].name}.`, 'ok');
      }
      if (idx >= 0) lastRank.current = idx;
    } catch {
      if (alive.current) setFailed(true);
    }
  }, [toast]);

  usePoll(load, RANK_MS, [load]);

  if (!data) {
    return (
      <div className="page">
        {failed
          ? <ErrorBox onRetry={load}>Die Rangliste konnte nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <SkelRows n={6} h={56} />}
      </div>
    );
  }

  const rows = Array.isArray(data.leaderboard) ? data.leaderboard : [];
  const my = data.my_rank || null;
  const inList = my != null && rows.some((r) => r.rank === my);
  const line = (r) => (
    <Row
      key={r.rank}
      leading={<Avatar seed={r.username} label={r.username} size={36} />}
      title={`${r.rank}. ${r.username}`}
      sub={rankTitle(r.worth)}
      trailing={<Money c={r.worth} />}
    />
  );

  return (
    <div className="page">
      <header className="rank-hero">
        <p className="muted small">Dein Platz</p>
        <LivePrice value={my || 0} format={place} className="num-hero" />
        {mine && (
          <p className="muted">
            <Money c={mine.worth} /> · {rankTitle(mine.worth)}
          </p>
        )}
      </header>

      <Section title="Rangliste">
        {rows.length === 0 ? (
          <Empty title="Noch niemand an der Börse.">Sobald jemand handelt, steht hier die Liste.</Empty>
        ) : rows.map(line)}
      </Section>

      {my != null && !inList && (
        <div className="rank-sticky">
          {line({ rank: my, username: user.username, worth: mine ? mine.worth : 0 })}
        </div>
      )}
    </div>
  );
}
