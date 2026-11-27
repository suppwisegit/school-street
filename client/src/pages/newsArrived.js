// Gemeinsamer Stand für den Zähler am Tab (Player.jsx) und die Gelesen-Marken der News-Seite:
// die in dieser Sitzung per WebSocket angekommenen News-Ids und die Frage, ob ein Konto schon
// einen Gelesen-Stand hat (DESIGN 9.6). Reines Modul ohne React-Elemente.
import { useSyncExternalStore } from 'react';

export const NEWS_CAP = 100; // Obergrenze der Liste und des Zählers — auch nach Stunden im Turbo-Modus

// Neueste zuerst, höchstens 100.
const arrived = { ids: [], version: 0, listeners: new Set() };
export function arriveNews(id) {
  arrived.ids = [id, ...arrived.ids.filter((x) => x !== id)].slice(0, NEWS_CAP);
  arrived.version++;
  for (const l of arrived.listeners) l();
}
const subscribe = (fn) => {
  arrived.listeners.add(fn);
  return () => { arrived.listeners.delete(fn); };
};
export function useArrivedNews() {
  useSyncExternalStore(subscribe, () => arrived.version);
  return arrived.ids;
}

// Ohne gespeicherten Gelesen-Stand gelten die vorhandenen News als gelesen; gezählt wird erst,
// was danach ankommt — ein neues Konto startet so mit 0 statt „9+“. Schlüssel wie in news/index.jsx.
export function hasReadState(accountId) {
  if (accountId == null) return false;
  try {
    return localStorage.getItem(`ss_news_read:${accountId}`) !== null;
  } catch {
    return false;
  }
}
