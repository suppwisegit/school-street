// Gemeinsamer News-Vorrat (außerhalb von React): eine Abfrage je URL für alle Seiten —
// Zähler am Tab (Player.jsx), News-Seite, Kurzform auf Markt und Aktienseite (NewsMini).
// Früher lud jede davon `/api/news` selbst; auf /news waren es zwei gleiche Abfragen.
// Neues kommt über den WebSocket ({type:'news'}) einmal für alle Vorräte. Der Gelesen-Stand
// (news/index.jsx) und die Hervorhebung neuer Zeilen bleiben Sache der Seiten.
import { useMemo, useSyncExternalStore } from 'react';
import { api } from './api.js';
import { NEWS_CAP } from './pages/newsArrived.js';

const MAX_AGE_MS = 60000; // älter: beim nächsten Abo einmal neu laden (der Zwischenstand bleibt stehen)
const MAX_ENTRIES = 40;   // Werte-Auswahl je Aktienseite: die ältesten ohne Abo fliegen raus

const entries = new Map(); // Abfrage-Schlüssel -> Vorrat

const keyOf = (params) => JSON.stringify(Object.entries({ ...params }).sort(([a], [b]) => (a < b ? -1 : 1)));
// Passt die News zur Abfrage? Wie der Server: `security_id` und eine Komma-Liste `kind`.
function fits(item, params) {
  if (params.security_id != null && item.security_id !== Number(params.security_id)) return false;
  if (params.kind) {
    const kinds = String(params.kind).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!kinds.includes(item.kind)) return false;
  }
  return true;
}
// Neue News nach vorn; eine schon bekannte Id bleibt, wo sie ist (kein Springen durch Doppel-Pushes).
const put = (list, item, cap) => (list.some((n) => n.id === item.id) ? list : [item, ...list].slice(0, cap));

function entryFor(params) {
  const key = keyOf(params);
  let e = entries.get(key);
  if (e) return e;
  if (entries.size >= MAX_ENTRIES) {
    const old = [...entries.values()].find((x) => !x.listeners.size);
    if (old) entries.delete(old.key);
  }
  const cap = Math.min(NEWS_CAP, Math.max(1, Number(params.limit) || 40));
  e = {
    key, params, cap, items: null, failed: false, version: 0, at: 0, promise: null,
    pending: [],          // Pushes, die eintreffen, während die Abfrage läuft
    listeners: new Set(),
    subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
    snapshot() { return this.version; },
    load: () => loadEntry(e),
  };
  entries.set(key, e);
  return e;
}
function notify(e) { e.version++; for (const l of e.listeners) l(); }

function loadEntry(e) {
  e.failed = false;
  if (e.promise) return e.promise; // läuft schon: kein zweiter Aufruf für dieselbe Abfrage
  e.promise = api('/api/news', { params: e.params })
    .then((r) => {
      const list = Array.isArray(r && r.news) ? r.news : [];
      // Ein Push, der während des Ladens ankam, steht vor der Antwort — nicht dahinter.
      const known = new Set(list.map((n) => n.id));
      const pre = e.pending.filter((n) => !known.has(n.id));
      e.pending = [];
      e.items = [...pre, ...list].slice(0, e.cap);
      e.at = Date.now();
      notify(e);
    })
    .catch(() => { e.failed = true; notify(e); }) // die Seite meldet den Fehler
    .finally(() => { e.promise = null; });
  return e.promise;
}

// Abo: lädt beim ersten Abonnenten; nach Fehlern oder wenn der Stand älter als MAX_AGE_MS ist,
// noch einmal (der letzte Stand bleibt bis zur Antwort stehen).
export function subscribeNews(params, fn) {
  const e = entryFor(params);
  const off = e.subscribe(fn);
  if (e.listeners.size === 1 && (!e.at || e.failed || Date.now() - e.at > MAX_AGE_MS)) e.load();
  return off;
}
// Stand eines Vorrats (auch ohne Abo): { items, failed, at, load }.
export const readNews = (params) => entryFor(params);

// { items, failed, load }: items = null lädt, sonst jüngste zuerst (höchstens `cap`, nur News
// des Werts bei `securityId`); failed = die letzte Abfrage scheiterte; load = erneut laden.
export function useNews(params, cap = NEWS_CAP, securityId = null) {
  useSyncExternalStore((fn) => subscribeNews(params, fn), () => readNews(params).snapshot); // rendert neu bei jeder Änderung
  const entry = readNews(params);
  const items = entry.items;
  return useMemo(() => {
    const list = (items || []).filter((n) => securityId === null || n.security_id === securityId).slice(0, cap);
    return { items: items ? list : null, failed: entry.failed, load: entry.load };
  }, [items, entry.failed, cap, securityId]);
}

// Die eine WebSocket-Zustellung für alle Vorräte; hooks.jsx hängt sie an den Socket.
let lastMsg = null;
export function newsPush(m) {
  if (m === lastMsg) return; // mehrere Zuhörer hören dieselbe Nachricht
  lastMsg = m;
  const item = m && m.type === 'news' ? m.news : null;
  if (!item || item.id == null) return;
  for (const e of entries.values()) {
    if (!fits(item, e.params)) continue;
    const had = e.items ? e.items.some((n) => n.id === item.id) : e.pending.some((n) => n.id === item.id);
    if (e.items) e.items = put(e.items, item, e.cap); else e.pending = put(e.pending, item, e.cap);
    if (!had) notify(e);
  }
}
