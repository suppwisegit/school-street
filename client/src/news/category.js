// News-Kategorie (DESIGN.md §9.1) — reine Funktion, kein JSX, damit sie per `node --test`
// prüfbar ist. Die technischen Arten des Servers bleiben, wie sie sind.
//   rumor → Gerücht · system, ipo, etf → Börse
//   dividend, bafin, takeover, news mit Wert → Firma · news ohne Wert → Wirtschaft
// Quelle: Firma-News mit Wert nennen die Firma; dividend/bafin/takeover ohne (geladene) Firma
// nennen den Anlass (Ausschüttung · BaFin · Übernahme) statt „Firma“ erneut.
// `tone` = Ton des Chips (`official` steht in styles.css als `.chip.official`), `source` = feste
// Quelle der Metazeile; Firma hat keine (dort steht der Firmenname).

// `key` ist zugleich der Seed-Teil der Grafik (newsArt).
export const NEWS_CATEGORIES = Object.freeze({
  boerse: Object.freeze({ key: 'boerse', label: 'Börse', tone: 'official', source: 'School Street' }),
  firma: Object.freeze({ key: 'firma', label: 'Firma', tone: 'neutral', source: null }),
  wirtschaft: Object.freeze({ key: 'wirtschaft', label: 'Wirtschaft', tone: 'neutral', source: 'Markt' }),
  geruecht: Object.freeze({ key: 'geruecht', label: 'Gerücht', tone: 'warn', source: 'Flurfunk' }),
});
const OFFICIAL = ['system', 'ipo', 'etf'];
const FIRM = ['dividend', 'bafin', 'takeover'];

// News mit Wert (security_id vorhanden, auch 0)
export const hasValue = (item) => Boolean(item) && item.security_id !== null && item.security_id !== undefined;

// → { key, label, tone, source }, abgeleitet aus der technischen Art `kind` und `security_id`:
// rumor → Gerücht · system/ipo/etf → Börse · dividend/bafin/takeover → Firma · news mit Wert → Firma ·
// alles andere, auch news ohne Wert → Wirtschaft.
export function newsCategory(item) {
  const kind = item && item.kind;
  if (kind === 'rumor') return NEWS_CATEGORIES.geruecht;
  if (OFFICIAL.includes(kind)) return NEWS_CATEGORIES.boerse;
  if (FIRM.includes(kind) || (kind === 'news' && hasValue(item))) return NEWS_CATEGORIES.firma;
  return NEWS_CATEGORIES.wirtschaft;
}

// Quelle der Metazeile: Firma-News nennen die Firma (Name oder Kürzel aus dem Ticker-Speicher),
// alle anderen die feste Quelle ihrer Kategorie.
export function newsSource(item, quote) {
  const kind = item && item.kind;
  const cat = newsCategory(item);
  if (cat === NEWS_CATEGORIES.firma) {
    const firm = quote && (quote.name || quote.ticker);
    if (firm) return firm;
    // Nie „Firma · Firma“: der Chip sagt schon Firma, hier steht der Anlass.
    if (kind === 'dividend') return 'Ausschüttung';
    if (kind === 'bafin') return 'BaFin';
    if (kind === 'takeover') return 'Übernahme';
    return 'Firma';
  }
  return cat.source;
}
