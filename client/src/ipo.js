// Börsengang: welches Wertpapier gilt als „neu an der Börse“ (PLAN v2 T8, V1).
// Rein, ohne React — per `node --test` prüfbar. Alter einer Aktie = jüngste IPO-News
// zu ihrer security_id; `securities` trägt kein Listing-Datum und GET /api/securities keins.
// Zwei IPO-News-Arten teilen sich `kind = 'ipo'`: ein Börsengang („IPO: … startet …“) und
// eine Nachplatzierung („Nachplatzierung: …“). Nur der Börsengang macht eine Aktie neu.

// So lange (Sekunden) gilt ein Wert als neu, wenn der Client `ipo_highlight_sec` nicht kennt.
// Steht nur in GET /api/admin/settings (Admin-only) — Spieler und Beamer sehen den Default hier.
// `ipo_highlight_sec` und `news.created_at` sind Wanduhr-Sekunden (keine Sim-Sekunden): der
// Beamer zeigt Wanduhr, und im Fast-Modus (× 100) würde ein Sim-Fenster auf 3 Real-Minuten schrumpfen.
export const IPO_HIGHLIGHT_SEC = 10800;

// So lange vor Ablauf steht die Zeitangabe in der Warnfarbe (DESIGN 11.5: mehr passiert nicht).
export const IPO_WARN_SEC = 300;

// Nachrichten, die einen Börsengang melden (nicht Nachplatzierung, mit Wertpapier).
export function isListingNews(item) {
  return Boolean(item) && item.kind === 'ipo'
    && item.security_id !== null && item.security_id !== undefined
    && !/^\s*Nachplatzierung/i.test(String(item.title || ''));
}

const clockFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
export const clock = (ts) => clockFmt.format(new Date(ts));

// „12 Min.“ · „2 Std. 5 Min.“ — abgerundet, nie negativ.
export function duration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} Min.`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} Std.${m ? ` ${m} Min.` : ''}`;
}

// Aus der News-Liste (jüngste zuerst, wie GET /api/news) die neuen Werte.
// → [{ securityId, at, ageSec, leftSec, progress, soon }] — jüngster Börsengang zuerst,
// progress = verstrichener Anteil des Fensters (0 … 1), soon = Ablauf in IPO_WARN_SEC.
// Ein leeres/ungültiges Fenster (0) schaltet die Hervorhebung aus.
export function ipoHighlights(news, now = Date.now(), highlightSec = IPO_HIGHLIGHT_SEC) {
  const win = Number(highlightSec);
  if (!Array.isArray(news) || !Number.isFinite(win) || win <= 0) return [];
  const latest = new Map();
  for (const n of news) {
    if (!isListingNews(n)) continue;
    const at = Number(n.created_at);
    if (!Number.isFinite(at) || at <= 0) continue;
    const id = n.security_id;
    if (!latest.has(id) || at > latest.get(id)) latest.set(id, Math.max(at, 0));
  }
  const out = [];
  for (const [securityId, at] of latest) {
    const ageSec = Math.max(0, (now - at) / 1000);
    if (ageSec >= win) continue;
    out.push({
      securityId, at, ageSec,
      leftSec: Math.max(0, win - ageSec),
      progress: Math.min(1, Math.max(0, ageSec / win)),
      soon: win - ageSec <= Math.min(IPO_WARN_SEC, win),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// Marker für die Marktliste: Map securityId → Eintrag aus ipoHighlights.
export function ipoById(list) {
  return new Map((Array.isArray(list) ? list : []).map((h) => [h.securityId, h]));
}

// Ablauf als Uhrzeit, nie als Countdown (DESIGN 11.5). Kurz vor Ende wechselt der Wortlaut
// und die Farbe: „Läuft gleich ab (11:32)“ in --ss-warn, sonst „Neu bis 11:32“.
export function untilText(ipo) {
  // Ablauf = Listing-Zeitpunkt + Fenster. Das Fenster ist Alter + Restzeit (beide zum selben
  // Zeitpunkt gerechnet), also bleibt die Uhrzeit gleich, während der Wert altert.
  const windowSec = (Number(ipo.ageSec) || 0) + (Number(ipo.leftSec) || 0);
  const t = clock(ipo.at + windowSec * 1000);
  return ipo.soon ? { text: `Läuft gleich ab (${t})`, warn: true } : { text: `Neu bis ${t}`, warn: false };
}
