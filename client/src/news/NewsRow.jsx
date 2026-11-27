// News-Zeile (DESIGN.md §9.2/9.3): Grafik links, rechts Metazeile, Schlagzeile, Text und —
// bei News mit Wert — die Wirkungszeile: Wirkung der Nachricht und, gekennzeichnet, der Tageskurs.
// Mit `onOpen` ist die ganze Zeile eine Schaltfläche (→ Sheet in der Seite). Aufbau nach
// HTML-Regel (nur Phraseninhalt in <button>): article > h2 > button. Tastatur und Sprachausgabe
// gehen über den Button im Titel; ein Klick irgendwo im Artikel öffnet ebenfalls — außer der
// Nutzer markiert gerade Text (Schlagzeile und Text bleiben markier- und kopierbar).
import React, { createElement, memo } from 'react';
import { IconBuildingBank, IconBuildingSkyscraper, IconMist, IconWorld } from '@tabler/icons-react';
import { Chip, Pct } from '../ui.jsx';
import { useTickerRow } from '../hooks.jsx';
import { newsArt } from './newsArt.js';
import { hasValue, newsCategory, newsSource } from './category.js';
import './news.css';

const cls = (...parts) => parts.filter(Boolean).join(' ');

// Icon je Kategorie (14 px im Chip, DESIGN 9.1); außerhalb des Chips gibt es keins.
const ICON = { boerse: IconBuildingBank, firma: IconBuildingSkyscraper, wirtschaft: IconWorld, geruecht: IconMist };
// Icon-Element oder null — unbekannte Kategorie-Key gibt kein Icon, wirft aber nie.
const catIcon = (cat, size) => {
  const Icon = cat && ICON[cat.key];
  return Icon ? createElement(Icon, { size, stroke: 1.8 }) : null;
};

// „vor 5 Min.“ — `now` injizierbar (Seiten ticken einmal je Minute).
export function ago(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
}

const CategoryChip = ({ cat }) => (
  cat ? <Chip tone={cat.tone}>{catIcon(cat, 14)}{cat.label}</Chip> : null
);

// Metazeile: Marke (Ungelesen) · Kategorie-Chip · Quelle oder Firma · Zeit rechts.
// Liest die Ticker-Zeile des Werts selbst (Name, Kürzel); ohne Wert gibt es keine Zeile.
// Einziger Abnehmer außerhalb dieser Datei: die Kurzformen in index.jsx.
export function NewsMeta({ item, unread = false, now, className = '' }) {
  const quote = useTickerRow((item && item.security_id) ?? -1);
  if (!item) return null;
  const time = ago(item.created_at, now);
  return (
    <span className={cls('news-head', className)}>
      <span className={cls('news-mark', unread && 'on')} aria-hidden="true" />
      <CategoryChip cat={newsCategory(item)} />
      <span className="news-src">{newsSource(item, quote)}</span>
      {time ? (
        <span className="news-time">
          <time dateTime={new Date(item.created_at).toISOString()}>{time}</time>
        </span>
      ) : null}
    </span>
  );
}

// Wirkung der Nachricht (Feld `impact`, −3 … +3) als Wort und Ton. Die Farbe folgt der
// Wirkung, nie dem Tageskurs; ohne Wirkung (0 oder fehlend) bleibt der Chip neutral. Das Wort
// steht immer dabei — die Farbe ist nie die einzige Information.
export function impactInfo(impact) {
  const v = Math.max(-3, Math.min(3, Math.round(Number(impact) || 0)));
  if (v === 3) return { label: 'stark positiv', tone: 'up' };
  if (v === 2) return { label: 'positiv', tone: 'up' };
  if (v === 1) return { label: 'leicht positiv', tone: 'up' };
  if (v === -1) return { label: 'leicht negativ', tone: 'down' };
  if (v === -2) return { label: 'negativ', tone: 'down' };
  if (v === -3) return { label: 'stark negativ', tone: 'down' };
  return { label: 'ohne Wirkung', tone: 'neutral' };
}

// Wirkungszeile: links die Wirkung der Nachricht (aus `impact`), rechts der Tageskurs des Werts
// ausdrücklich als „heute“ gekennzeichnet und ungefärbt — sonst liest ein Schüler „die Nachricht
// war gut“, nur weil der Kurs heute zufällig im Plus steht. Die Firma steht in der Metazeile,
// hier nicht noch einmal.
function NewsEffect({ item, securityId }) {
  const q = useTickerRow(securityId);
  const fx = impactInfo(item && item.impact);
  return (
    <div className="news-fx">
      <Chip tone={fx.tone} className="news-fx-impact">
        <span className="news-fx-cap">Wirkung:</span>{fx.label}
      </Chip>
      {q ? (
        <Chip tone="neutral" className="news-fx-chip">
          <span className="news-fx-cap">heute</span>
          <span className="num"><Pct v={q.chg} signed /></span>
        </Chip>
      ) : null}
    </div>
  );
}

// Die Grafik steht sofort: sie entsteht beim Rendern. Wirft sie oder fehlt die Kategorie,
// steht die Kategorie-Kachel in derselben Box — Breite und Höhe bleiben gleich.
// `wide` = volle Breite im Verhältnis 16:9 (Sheet, DESIGN 9.3).
export function NewsArt({ item, ticker, wide = false }) {
  const cat = newsCategory(item) || {};
  let markup = '';
  try {
    markup = newsArt(cat.key, item && item.id, ticker, item && item.impact);
  } catch {
    markup = '';
  }
  // Fallback: Kategorie-Kachel — mit Icon, ohne Icon nur die Fläche. Wirft nie.
  return (
    <span className={cls('news-art', wide && 'news-art--wide')} role="presentation" aria-hidden="true">
      {markup
        ? <span className="news-art-svg" dangerouslySetInnerHTML={{ __html: markup }} />
        : <span className="news-art-tile">{catIcon(cat, 22)}</span>}
    </span>
  );
}

/**
 * Eine News. `unread` = Marke vor der Metazeile, helle Schlagzeile und der versteckte Text
 * „Ungelesen:“ vor der Schlagzeile. `onOpen` macht die Zeile zur Schaltfläche (article >
 * h2 > button; Klick auf den Artikel zählt mit, Markieren nicht); ohne `onOpen` statisch.
 */
export const NewsRow = memo(function NewsRow({ item, unread = false, onOpen, now }) {
  // Ticker-Zeile des Werts: liefert Firma, Kürzel fürs Monogramm und den Prozentwert.
  const quote = useTickerRow((item && item.security_id) ?? -1);
  if (!item) return null;
  const title = item.title || '';
  return (
    <article
      className={cls('news-item', unread && 'is-unread', onOpen && 'is-link')}
      onClick={onOpen ? () => { if (!String(getSelection?.() || '').trim()) onOpen(item); } : undefined}
    >
      <div className="news-btn">
        <NewsArt item={item} ticker={quote && quote.ticker} />
        <span className="news-body">
          <NewsMeta item={item} unread={unread} now={now} />
          <h2 className="news-title">
            {unread ? <span className="news-sr">Ungelesen: </span> : null}
            {onOpen
              // kein eigener Handler: der Klick blubbert zum Artikel, Enter/Leertaste ebenfalls
              ? <button type="button" className="news-btn-hit">{title}</button>
              : title}
          </h2>
          {item.body ? <p className="news-text">{item.body}</p> : null}
          {hasValue(item) ? <NewsEffect item={item} securityId={item.security_id} /> : null}
        </span>
      </div>
    </article>
  );
});

