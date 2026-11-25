// Markt: Liste aller Werte, live über den Ticker-Store.
// Jede Zeile liest nur useTickerRow(id) und rendert allein neu, wenn sich ihr Kurs ändert.
// Abfragen: nur /sparks (beim Öffnen, dann alle 60 s) — die Kurse kommen über den WebSocket.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconSearch } from '@tabler/icons-react';
import {
  Button, Chip, Empty, ErrorBox, Flash, LivePrice, Pct, Row, Segmented, SkelRows, Symbol,
} from '../ui.jsx';
import { Sparkline, usePoll, useTicker, useTickerRow } from '../hooks.jsx';
import { api } from '../api.js';
import './Market.css';

const FILTERS = [
  { value: 'all', label: 'Alle' },
  { value: 'up', label: 'Gewinner' },
  { value: 'down', label: 'Verlierer' },
];
const SPARK_MS = 60000; // Budget V4: /sparks alle 60 s
const WAIT_MS = 10000; // so lange wartet die Liste auf den ersten Ticker, danach Fehler mit erneutem Versuch
const EMPTY_MS = 2000; // kürzere Wartezeit, wenn /sparks schon sagt: keine Werte da
const SPARK_W = 56;
const SPARK_H = 28;

// Suchtext: Groß-/Kleinschreibung und Umlaute spielen keine Rolle ("munchen" findet "München").
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Filter und Suche werden je Zeile ausgewertet, weil nur die Zeile ihre Daten kennt.
function matches(row, filter, needle) {
  if (filter === 'up' && !(row.chg > 0)) return false;
  if (filter === 'down' && !(row.chg < 0)) return false;
  if (!needle) return true;
  return fold(row.ticker || '').includes(needle) || fold(row.name || '').includes(needle);
}

// Eine Zeile. Rendert nur neu, wenn sich ihr Kurs, der Filter, die Suche oder ihre Kurve ändert.
const SecurityRow = memo(function SecurityRow({ id, filter, needle, spark, report }) {
  const row = useTickerRow(id);
  const hit = !!row && matches(row, filter, needle);
  // Meldet der Liste, ob diese Zeile gerade sichtbar ist (für „Nichts gefunden“ und die Trefferzahl).
  useEffect(() => { report(id, hit); }, [id, hit, report]);
  if (!row || !hit) return null;

  return (
    <Flash value={row.last} className="mkt-flash">
      <Row
        className="mkt-row"
        to={`/security/${id}`}
        leading={(
          <div className="mkt-id">
            <Symbol
              ticker={row.ticker}
              name={row.name}
              sub={row.type === 'etf' ? <Chip tone="neutral">ETF</Chip> : undefined}
            />
          </div>
        )}
        trailing={(
          <div className="mkt-side">
            <div className="mkt-spark">
              {spark && spark.length > 1 && <Sparkline values={spark} w={SPARK_W} h={SPARK_H} />}
            </div>
            <div className="mkt-quote">
              <LivePrice value={row.last} className="mkt-last" />
              <Pct v={row.chg} signed colored className="mkt-chg" />
            </div>
          </div>
        )}
      />
    </Flash>
  );
});

export default function Market() {
  const { ready, ids } = useTicker();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [sparks, setSparks] = useState(null); // { "<id>": [Cent, …] }
  const [sparksErr, setSparksErr] = useState(false);
  const [waited, setWaited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [hits, setHits] = useState(() => new Set());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadSparks = useCallback(async () => {
    try {
      const r = await api('/api/sparks', { params: { points: 40 } });
      if (!alive.current) return;
      const s = r && r.sparks;
      setSparks(s && typeof s === 'object' ? s : {});
      setSparksErr(false);
    } catch {
      if (alive.current) setSparksErr(true);
    }
  }, []);

  usePoll(loadSparks, SPARK_MS, []);

  // `ready` heißt hier „mindestens ein Wert da“. Kommt nach der Wartezeit immer noch keiner,
  // steht Leer bzw. ein Fehler mit erneutem Versuch — nicht eine endlose Skelettliste.
  const sparksEmpty = sparks !== null && Object.keys(sparks).length === 0;
  useEffect(() => {
    if (ready) return undefined;
    setWaited(false);
    const t = setTimeout(() => setWaited(true), sparksEmpty ? EMPTY_MS : WAIT_MS);
    return () => clearTimeout(t);
  }, [ready, attempt, sparksEmpty]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    loadSparks();
  }, [loadSparks]);

  const report = useCallback((id, hit) => {
    setHits((prev) => {
      if (prev.has(id) === hit) return prev;
      const next = new Set(prev);
      if (hit) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const needle = useMemo(() => fold(q.trim()), [q]);
  const searching = needle !== '' || filter !== 'all';
  const shown = useMemo(() => ids.reduce((n, id) => n + (hits.has(id) ? 1 : 0), 0), [ids, hits]);
  // Alle Hooks stehen VOR den frühen Rückgaben: Ändert sich ihre Zahl zwischen zwei
  // Renderings, bricht React ab („Rendered fewer hooks than expected").
  const list = useMemo(
    () => ids.map((id) => (
      <SecurityRow
        key={id}
        id={id}
        filter={filter}
        needle={needle}
        spark={sparks && sparks[id]}
        report={report}
      />
    )),
    [ids, filter, needle, sparks, report],
  );

  if (!ready) {
    if (waited && sparksEmpty) {
      return (
        <div className="page mkt">
          <Empty title="Noch nichts an der Börse">
            Hier steht jeder Wert, sobald er zugelassen ist.
          </Empty>
        </div>
      );
    }
    return (
      <div className="page mkt">
        {waited ? (
          <ErrorBox onRetry={retry}>Die Kurse kommen nicht an. Prüf deine Verbindung.</ErrorBox>
        ) : (
          <SkelRows n={6} />
        )}
      </div>
    );
  }

  const noHitText = needle
    ? `Kein Wert passt zu „${q.trim()}“.`
    : filter === 'down'
      ? 'Heute hat noch kein Wert verloren.'
      : 'Heute hat noch kein Wert gewonnen.';

  return (
    <div className="page mkt">
      <div className="mkt-tools">
        <div className="search mkt-search">
          <IconSearch size={20} stroke={1.6} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Kürzel oder Name"
            aria-label="Wert suchen (Kürzel oder Name)"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="mkt-filter">
          <Segmented value={filter} onChange={setFilter} options={FILTERS} aria-label="Werte filtern" />
        </div>
      </div>

      <p className="mkt-sr" role="status">
        {searching ? `${shown} von ${ids.length} Werten` : `${ids.length} ${ids.length === 1 ? 'Wert' : 'Werte'}`}
      </p>

      {shown === 0 && (
        <Empty title="Nichts gefunden">
          {noHitText}
          {searching && (
            <Button variant="ghost" size="sm" onClick={() => { setQ(''); setFilter('all'); }}>
              Alle anzeigen
            </Button>
          )}
        </Empty>
      )}

      {/* Die Zeilen sind immer eingebaut: Jede meldet selbst, ob sie zum Filter passt.
          Erschiene die Liste erst ab einem Treffer, gäbe es nie einen. */}
      {list}

      {sparksErr && shown > 0 && (
        <div className="mkt-note">
          <span>Die Kurven fehlen gerade.</span>
          <Button variant="ghost" size="sm" onClick={loadSparks}>Erneut versuchen</Button>
        </div>
      )}
    </div>
  );
}
