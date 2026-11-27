// News-Bausteine (Vertrag V7, PLAN.md): Einstieg für Seiten.
//   newsCategory, newsSource, hasValue → category.js
//   ago, NewsRow, NewsArt → NewsRow.jsx
//   NewsMini, NewsLines, useUnreadCount, markRead, markAllRead, isRead → hier (Liste: newsStore.js)
// Gelesen-Stand: Marke je News und Konto im localStorage (DESIGN 9.6), kein Serverstand.
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Section, SkelRows } from '../ui.jsx';
import { NewsMeta } from './NewsRow.jsx';
import { useNews } from '../newsStore.js';

export { newsCategory, newsSource, hasValue } from './category.js';
export { ago, NewsRow, NewsArt, impactInfo } from './NewsRow.jsx';

// ---------------------------------------------------------------------------
// Gelesen-Stand: `ss_news_read:<Konto-Id>` = Array der gelesenen News-Ids (neueste 500).
// ---------------------------------------------------------------------------
const readKey = (accountId) => `ss_news_read:${accountId}`;
const read = { sets: new Map(), listeners: new Set(), version: 0 };

const bump = () => {
  read.version++;
  for (const l of read.listeners) l();
};

function readSet(accountId) {
  let set = read.sets.get(accountId);
  if (set) return set;
  set = new Set();
  try {
    const raw = accountId != null ? JSON.parse(localStorage.getItem(readKey(accountId)) || '[]') : [];
    if (Array.isArray(raw)) for (const id of raw) if (Number.isFinite(id)) set.add(id);
  } catch {
    /* kein localStorage oder unlesbar: dann ist nichts gelesen */
  }
  read.sets.set(accountId, set);
  return set;
}

const subRead = (fn) => {
  read.listeners.add(fn);
  const onStorage = (e) => { // ein anderer Tab hat gelesen/gelöscht
    if (e.key === null || e.key.startsWith('ss_news_read:')) { // null = localStorage.clear()
      read.sets.clear();
      bump();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    read.listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
};

function remember(accountId, ids) {
  const set = new Set(readSet(accountId));
  let changed = false;
  for (const id of ids) {
    if (id !== null && id !== undefined && !set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  read.sets.set(accountId, set);
  try {
    localStorage.setItem(readKey(accountId), JSON.stringify([...set].slice(-500)));
  } catch {
    /* voll oder gesperrt: gilt bis zum Neuladen */
  }
  bump();
}

// Eine News als gelesen vermerken (Öffnen des Sheets).
export function markRead(accountId, newsId) {
  if (accountId == null) return;
  remember(accountId, [newsId]);
}

// Alle übergebenen News als gelesen vermarken („Alle gelesen“).
export function markAllRead(accountId, items = []) {
  if (accountId == null) return;
  remember(accountId, items.map((n) => n && n.id));
}

export function isRead(accountId, newsId) {
  return readSet(accountId).has(newsId);
}

// Zahl der ungelesenen News in `items`; neu, sobald jemand liest. Ohne Konto: alle.
export function useUnreadCount(accountId, items) {
  useSyncExternalStore(subRead, () => read.version);
  const ids = items ? items.map((n) => n && n.id).join(',') : '';
  return useMemo(
    () => (items || []).filter((n) => n && !readSet(accountId).has(n.id)).length,
    [read.version, accountId, ids],
  );
}

// ---------------------------------------------------------------------------
// Kurzformen: letzte News in Markt/Handel (NewsMini) und auf dem Board (NewsLines).
// ---------------------------------------------------------------------------
// Daten aus dem gemeinsamen Vorrat (newsStore.js): eine Abfrage je URL, Neue über den WebSocket;
// `failed` → Seite meldet es.
// Der Vorrat bleibt auf limit × 4 begrenzt (höchstens 100) — auch nach Stunden im Turbo-Modus.
// Mit `securityId` filtert der (`?security_id=`): die News des Werts kommen zuverlässig,
// auch wenn sie in der Gesamtliste längst untergegangen sind.
function useNewsFeed(limit, securityId) {
  const cap = feedCap(limit);
  const own = securityId != null;
  const ask = own ? Math.max(3, limit || 3) : cap;
  return useNews(own ? { security_id: securityId, limit: ask } : { limit: ask }, cap, own ? securityId : null);
}
const feedCap = (limit) => Math.min(100, Math.max(3, limit || 3) * 4);

const toList = (items, limit) => (items || []).slice(0, Math.max(0, limit || 0));

// Die Uhr für „vor 5 Min.“: steht beim Rendern fest und springt einmal je Minute weiter,
// damit „gerade eben“ nicht für immer stehen bleibt.
function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Abschnitt „News“ mit den letzten `limit` Zeilen in Kurzform (Markt, Handel).
 * `securityId` → nur News dieses Werts.
 * Vertrag: Zeilen und „Alle News“ führen immer nach `/news` — dort steht das Sheet; die
 * Kurzform öffnet kein eigenes Detail und kennt keine einzelne News.
 */
export function NewsMini({ limit = 3, securityId } = {}) {
  const { items, failed, load } = useNewsFeed(limit, securityId);
  const navigate = useNavigate();
  const now = useMinute();
  if (failed) {
    return (
      <Section title="News">
        <div className="news-note">
          <span>Die News kommen gerade nicht.</span>
          <Button variant="ghost" size="sm" onClick={load}>Erneut versuchen</Button>
        </div>
      </Section>
    );
  }
  if (!items) {
    return (
      <Section title="News"><SkelRows n={Math.min(limit, 3)} /></Section>
    );
  }
  const list = toList(items, limit);
  if (!list.length) return null;
  return (
    <Section title="News" action={<Button variant="ghost" size="sm" onClick={() => navigate('/news')}>Alle News</Button>}>
      {list.map((n) => (
        <button key={n.id} type="button" className="news-btn news-btn--mini" onClick={() => navigate('/news')}>
          <NewsMeta item={n} now={now} />
          <span className="news-title">{n.title || ''}</span>
        </button>
      ))}
    </Section>
  );
}

/**
 * Die letzten `limit` Schlagzeilen als Textzeilen fürs Board (keine Bedienelemente).
 * `items` (z. B. aus `/api/board`): lädt nur, wenn KEIN Array übergeben ist (undefined/null);
 * `[]` zeigt nichts. Lädt die Komponente selbst, meldet sie einen Fehler mit „Erneut versuchen“.
 */
export function NewsLines({ limit = 3, items: given } = {}) {
  // Liste übergeben (z. B. aus /api/board) → nur Darstellung, keine eigene Abfrage.
  return Array.isArray(given)
    ? <NewsLineList list={toList(given, limit)} />
    : <NewsLineFeed limit={limit} />;
}

function NewsLineFeed({ limit }) {
  const { items, failed, load } = useNewsFeed(limit, null);
  if (failed) {
    return (
      <div className="news-note">
        <span>Die News kommen gerade nicht.</span>
        <Button variant="ghost" size="sm" onClick={load}>Erneut versuchen</Button>
      </div>
    );
  }
  return <NewsLineList list={toList(items, limit)} />;
}

function NewsLineList({ list }) {
  const now = useMinute();
  if (!list.length) return null;
  return (
    <div className="news-lines">
      {list.map((n) => (
        <div key={n.id} className="news-btn news-btn--mini">
          <NewsMeta item={n} now={now} />
          <span className="news-title">{n.title || ''}</span>
        </div>
      ))}
    </div>
  );
}
