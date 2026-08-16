// Profil: Rang-Emblem mit Fortschritt, Mini-Leaderboard, Trophäen,
// Gründer-Zentrale (IPO, Kapitalerhöhung, Übernahme-Rechte).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  IconBriefcase, IconBuildingBank, IconCircleCheck, IconCircleX, IconClock,
  IconCoin, IconCrown, IconDiamond, IconFlame, IconPencil, IconRocket, IconTrendingUp, IconUser, IconX
} from '@tabler/icons-react';
import { api, credsToCent, fmtC } from '../api.js';
import { Card, Chip, Empty, ErrorBox, Field, OkBox, Skel, SkelRows, Trophy, confetti, useToast } from '../ui.jsx';

const RANKS = [
  { min: 5000000, name: 'Whale', rarity: 'legendary', Icon: IconDiamond, tag: 'Top 0,1 % des Parketts' },
  { min: 2500000, name: 'Wolf', rarity: 'epic', Icon: IconFlame, tag: 'Jagt in jeder Marktlage' },
  { min: 1000000, name: 'Hustler', rarity: 'rare', Icon: IconBriefcase, tag: 'Erstes Vermögen aufgebaut' },
  { min: 500000, name: 'NPC', rarity: 'common', Icon: IconUser, tag: 'Mittendrin statt nur dabei' },
  { min: 0, name: 'Broke', rarity: 'common', Icon: IconCoin, tag: 'Unterschätzt, nie ausgezählt' }
];
const rankIndexOf = (worth) => RANKS.findIndex((r) => worth >= r.min);
const rankOf = (worth) => RANKS[rankIndexOf(worth)] || RANKS[RANKS.length - 1];

const APP_STATUS = {
  pending: { label: 'Prüfung läuft', tone: 'blue', Icon: IconClock },
  approved: { label: 'Freigegeben – Börsengang', tone: 'green', Icon: IconCircleCheck },
  rejected: { label: 'Abgelehnt', tone: 'red', Icon: IconCircleX }
};

export default function ProfileTab() {
  const { user, ver } = useOutletContext();
  const toast = useToast();
  const [pf, setPf] = useState(null);
  const [lb, setLb] = useState(null);
  const [mine, setMine] = useState(null);
  const [secs, setSecs] = useState([]);
  const [err, setErr] = useState('');
  const prevRankIdx = useRef(null);

  const load = useCallback(async () => {
    try {
      const [p, l, m, s] = await Promise.all([
        api('/api/portfolio'),
        api('/api/leaderboard'),
        api('/api/companies/mine'),
        api('/api/securities')
      ]);
      setPf(p); setLb(l); setMine(m); setSecs(s.securities || []);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load, ver]);

  // Übernahme-Firmen (Mehrheit >50%, nicht eigene Gründungen): Ids über Ticker finden
  const takeovers = useMemo(() => {
    if (!pf || !secs) return [];
    const ticks = pf.badges?.takeovers || [];
    return secs.filter((s) => ticks.includes(s.ticker));
  }, [pf, secs]);

  // Rang-Aufstieg feiern
  const rankIdx = pf ? rankIndexOf(pf.net_worth) : null;
  useEffect(() => {
    if (rankIdx == null) return;
    if (prevRankIdx.current != null && rankIdx < prevRankIdx.current) {
      confetti({ x: 0.5, y: 0.3 });
      toast(`Rang aufgestiegen: ${RANKS[rankIdx].name}!`, 'ok');
    }
    prevRankIdx.current = rankIdx;
  }, [rankIdx]); // eslint-disable-line

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!pf || !lb || !mine) return (
    <div className="col" style={{ gap: 12 }}>
      <Skel h={150} radius={20} />
      <SkelRows n={2} h={90} />
    </div>
  );

  const rank = rankOf(pf.net_worth);
  const next = rankIdx > 0 ? RANKS[rankIdx - 1] : null;
  const progress = next ? Math.min(1, (pf.net_worth - rank.min) / (next.min - rank.min)) : 1;
  const board = lb.leaderboard || [];
  const totalPlayers = Math.max(board.length, lb.my_rank || 0);

  return (
    <div className="col enter" style={{ gap: 12 }}>
      {/* Rang-Hero */}
      <div className="hero">
        <div className="rankhero">
          <RankEmblem rank={rank} progress={progress} />
          <div className="grow rankinfo">
            <div className="rname" style={{ color: `var(--rarity-${rank.rarity})` }}>{rank.name}</div>
            <div className="rsub">
              {user.username}{lb.my_rank ? ` · Platz #${lb.my_rank} von ${totalPlayers}` : ''}
            </div>
            <div className="rsub muted" style={{ marginTop: 2 }}>{rank.tag}</div>
          </div>
        </div>
        <div className="progressrow">
          <div className="progressbar">
            <div className="fill" style={{ width: `${progress * 100}%`, background: `var(--rarity-${rank.rarity})` }} />
          </div>
          <div className="progresslbl num">
            <span>{fmtC(pf.net_worth)} Credits</span>
            <span>{next ? `${next.name} ab ${fmtC(next.min)}` : 'Maximalrang erreicht'}</span>
          </div>
        </div>
      </div>

      {/* Mini-Leaderboard */}
      <Card title="Leaderboard" right={<span className="muted small">{user.username}</span>}>
        <MiniLeaderboard board={board} myId={user.id} />
      </Card>

      {/* Trophäen */}
      <Trophies pf={pf} />

      <FounderCenter mine={mine} reload={load} toast={toast} />
      {takeovers.length > 0 && <TakeoverCenter takeovers={takeovers} reload={load} toast={toast} />}
    </div>
  );
}

// ---------------- Rang-Emblem (SVG-Fortschrittsring) ----------------
function RankEmblem({ rank, progress }) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const color = `var(--rarity-${rank.rarity})`;
  return (
    <div className="emblem">
      <svg className="ring" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={R} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle
          cx="48" cy="48" r={R} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - progress)}
          style={{ transition: 'stroke-dashoffset 0.8s var(--ease-out)' }}
        />
      </svg>
      <div className="core" style={{ color }}><rank.Icon stroke={1.7} /></div>
    </div>
  );
}

// ---------------- Mini-Leaderboard ----------------
function MiniLeaderboard({ board, myId }) {
  const top = board.slice(0, 5);
  const meInTop = top.some((r) => r.id === myId);
  const me = board.find((r) => r.id === myId);
  return (
    <div>
      {top.map((r) => (
        <div key={r.id} className={`lb-row ${r.id === myId ? 'me' : ''} ${r.rank === 1 ? 'top1' : ''}`}>
          <span className="rk num">{r.rank}</span>
          <span className="un">{r.username}{r.id === myId ? ' (du)' : ''}</span>
          <span className="wr num">{fmtC(r.worth)}</span>
        </div>
      ))}
      {!meInTop && me && (
        <>
          <div className="center muted" style={{ fontSize: 12, padding: '2px 0' }}>···</div>
          <div className="lb-row me">
            <span className="rk num">{me.rank}</span>
            <span className="un">{me.username} (du)</span>
            <span className="wr num">{fmtC(me.worth)}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- Trophäen ----------------
function Trophies({ pf }) {
  const b = pf.badges || {};
  const items = [];
  for (const t of b.founder || []) {
    items.push(
      <Trophy key={'f' + t} rarity="rare" icon={<IconRocket stroke={1.8} />} title={`Gründer · ${t}`} desc="Unternehmen an die Börse gebracht" />
    );
  }
  if (b.takeover_king) {
    items.push(
      <Trophy key="tk" rarity="legendary" icon={<IconCrown stroke={1.8} />} title="Takeover-King" desc={`Mehrheit bei ${(b.takeovers || []).join(', ')}`} />
    );
  }
  if (b.bagholder) {
    items.push(
      <Trophy key="bag" rarity="shame" icon={<IconX stroke={1.8} />} title="Bagholder" desc="Position über 50 % unter Einstand" />
    );
  }
  if (!items.length) {
    items.push(
      <Trophy key="empty" rarity="common" icon={<IconRocket stroke={1.8} />} title="Noch keine Trophäen" desc="Gründe ein Unternehmen oder übernimm eine Mehrheit" />
    );
  }
  return (
    <Card title="Trophäen">
      <div className="trophygrid">{items}</div>
    </Card>
  );
}

// ---------------- Gründer-Zentrale ----------------
function FounderCenter({ mine, reload, toast }) {
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setErr(''); setOk('');
    const tick = ticker.trim().toUpperCase();
    if (name.trim().length < 3) return setErr('Firmenname: min. 3 Zeichen');
    if (!/^[A-Z]{3,6}$/.test(tick)) return setErr('Ticker: 3–6 Großbuchstaben (z.B. MENSA)');
    setBusy(true);
    try {
      await api('/api/companies/apply', { method: 'POST', body: { name: name.trim(), ticker: tick, description: description.trim() } });
      setOk('Antrag eingereicht! Die Investment AG prüft deinen Börsengang.');
      setName(''); setTicker(''); setDescription('');
      reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const requestCap = async (c) => {
    try {
      await api(`/api/companies/${c.id}/request-capital-increase`, { method: 'POST' });
      toast('Kapitalerhöhungs-Antrag gestellt', 'ok');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  return (
    <Card title="Gründer-Zentrale">
      <ErrorBox>{err}</ErrorBox>
      <OkBox>{ok}</OkBox>
      <div className="field">
        <label>IPO-Antrag stellen</label>
        <div className="inputpair">
          <input className="input" placeholder="Firmenname (min. 3)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" style={{ maxWidth: 110 }} placeholder="TICKER" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} />
        </div>
        <textarea className="input" rows={2} placeholder="Geschäftsmodell / Concept-Pitch (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={apply}>
          <IconRocket size={15} stroke={1.9} /> {busy ? 'Wird gesendet …' : 'Antrag einreichen'}
        </button>
      </div>

      <div className="divider" />
      <h3 style={{ margin: 0 }}>Meine Anträge</h3>
      {(mine.applications || []).length === 0 ? (
        <Empty>Noch keine IPO-Anträge.</Empty>
      ) : (
        mine.applications.map((a) => {
          const S = APP_STATUS[a.status];
          return (
            <div className="row between" key={a.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(30,42,65,0.5)' }}>
              <div>
                <b>{a.ticker}</b> <span className="muted small">{a.name}</span>
              </div>
              <Chip tone={S?.tone}>
                {S ? <S.Icon size={13} stroke={2} /> : null}
                {S?.label || a.status}
              </Chip>
            </div>
          );
        })
      )}

      <div className="divider" />
      <h3 style={{ margin: 0 }}>Meine Unternehmen</h3>
      {(mine.companies || []).length === 0 ? (
        <Empty>Du hast noch kein Unternehmen an die Börse gebracht.</Empty>
      ) : (
        mine.companies.map((c) => (
          <div key={c.id} className="card tight" style={{ background: 'var(--card2)', marginBottom: 8 }}>
            <div className="row between">
              <div>
                <b>{c.ticker}</b> <span className="muted small">{c.name}</span>
                <div className="small num" style={{ marginTop: 2 }}>Kurs {fmtC(c.last)} · Schwelle {fmtC(c.threshold_price)}</div>
              </div>
              <button className="btn sm primary" disabled={!c.cap_eligible} onClick={() => requestCap(c)}>
                <IconTrendingUp size={14} stroke={1.9} /> Kapitalerhöhung
              </button>
            </div>
            <div className="small muted row" style={{ marginTop: 6, gap: 6 }}>
              {c.cap_eligible
                ? <><IconCircleCheck size={14} stroke={1.9} style={{ color: 'var(--up)' }} /> Meilenstein erreicht – Antrag möglich.</>
                : <><IconClock size={14} stroke={1.9} /> Kurs muss {c.hours_needed}h über der Schwelle bleiben: aktuell {c.hours_above}h von {c.hours_needed}h.</>}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}

// ---------------- Übernahme-Sonderrechte (>50% einer fremden Firma) ----------------
function TakeoverCenter({ takeovers, reload, toast }) {
  return (
    <Card title="Übernahme-Zentrale · Mehrheitsrechte">
      <div className="muted small" style={{ marginBottom: 10 }}>Du hältst über 50% – du darfst die Firma umbenennen und Sonderdividenden beantragen.</div>
      {takeovers.map((s) => <TakeoverRow key={s.id} sec={s} reload={reload} toast={toast} />)}
    </Card>
  );
}

function TakeoverRow({ sec, reload, toast }) {
  const [newName, setNewName] = useState('');
  const [perShare, setPerShare] = useState('');
  const [err, setErr] = useState('');

  const rename = async () => {
    setErr('');
    if (newName.trim().length < 3) return setErr('Name zu kurz');
    try {
      await api(`/api/companies/${sec.id}/rename`, { method: 'POST', body: { name: newName.trim() } });
      toast(`${sec.ticker} umbenannt`, 'ok');
      setNewName('');
      reload();
    } catch (e) { setErr(e.message); }
  };

  const requestDiv = async () => {
    setErr('');
    const per = credsToCent(perShare);
    if (per <= 0) return setErr('Ungültige Dividende je Aktie');
    try {
      await api(`/api/companies/${sec.id}/request-special-dividend`, { method: 'POST', body: { per_share: per / 100 } });
      toast('Sonderdividenden-Antrag gestellt', 'ok');
      setPerShare('');
      reload();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="card tight" style={{ background: 'var(--card2)', marginBottom: 10 }}>
      <b>{sec.ticker}</b> <span className="muted small">{sec.name}</span>
      <ErrorBox>{err}</ErrorBox>
      <div className="inputpair" style={{ marginTop: 6 }}>
        <input className="input" placeholder="Neuer Firmenname" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn sm" style={{ whiteSpace: 'nowrap' }} onClick={rename}><IconPencil size={14} stroke={1.9} /> Umbenennen</button>
      </div>
      <div className="inputpair" style={{ marginTop: 8 }}>
        <input className="input num" type="number" min="0" step="0.01" placeholder="Sonderdividende/Aktie (Credits)" value={perShare} onChange={(e) => setPerShare(e.target.value)} />
        <button className="btn sm" style={{ whiteSpace: 'nowrap' }} onClick={requestDiv}><IconBuildingBank size={14} stroke={1.9} /> Beantragen</button>
      </div>
    </div>
  );
}
