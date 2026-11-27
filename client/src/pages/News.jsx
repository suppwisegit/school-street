// News-Seite (DESIGN §9): Liste mit NewsRow, Detail-Sheet, Gelesen-Marke, „Alle gelesen“.
// Die Liste kommt aus dem gemeinsamen Vorrat (newsStore.js), Neues über den WebSocket
// ({type:'news'}) — ohne Neuladen.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { IconNews } from '@tabler/icons-react';
import { Button, Chip, Empty, ErrorBox, LivePrice, Pct, Row, Sheet, SkelRows, Symbol, useToast } from '../ui.jsx';
import { useTickerRow } from '../hooks.jsx';
import { useWS } from '../ws.jsx';
import { dateTimeStr } from '../api.js';
import {
  NewsArt, NewsRow, ago, hasValue, impactInfo, isRead, markAllRead, markRead, newsCategory, newsSource, useUnreadCount,
} from '../news/index.jsx';
import { NEWS_CAP, hasReadState, useArrivedNews } from './newsArrived.js';
import { useNews } from '../newsStore.js';
import './Player.css';

const NEW_MS = 600; // DESIGN 9.6: Hintergrund der neuen Zeile, dieselbe Dauer wie Flash
const TICK_MS = 60000; // Zeitangaben („vor 5 Min.“) bleiben richtig, ohne jede Zeile zu takten

export default function News() {
  const { user } = useOutletContext() || {};
  const navigate = useNavigate();
  const toast = useToast();
  const accountId = user && user.id;

  const { items: news, failed, load } = useNews({ limit: NEWS_CAP }); // news = null: lädt
  const [open, setOpen] = useState(null); // News im Sheet
  const [fresh, setFresh] = useState(() => new Set()); // per WebSocket eingetroffen → 600-ms-Hinweis
  const [now, setNow] = useState(Date.now);
  const arrivedIds = useArrivedNews();
  const arrivedSet = useMemo(() => new Set(arrivedIds), [arrivedIds]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Eine neue Nachricht steht oben (im Vorrat); ihre Zeile hebt sich 600 ms hervor (kein Flash:
  // das hieße Geld). Die Liste bleibt bei 100 Zeilen — auch nach Stunden im Turbo-Modus.
  useWS((m) => {
    if (m.type !== 'news' || !m.news || !m.news.id) return;
    const id = m.news.id;
    setFresh((set) => new Set([...set, id]));
  });

  // 600 ms nach dem ersten Push ist die Hervorhebung vorbei; weitere Pushes starten keinen neuen Timer.
  useEffect(() => {
    if (!fresh.size) return undefined;
    const t = setTimeout(() => setFresh(new Set()), NEW_MS);
    return () => clearTimeout(t);
  }, [fresh.size > 0]);

  // Ohne Gelesen-Stand des Kontos gelten vorhandene News als gelesen; ungelesen ist nur,
  // was in dieser Sitzung angekommen ist (gleiche Regel wie der Zähler am Tab).
  const base = hasReadState(accountId);
  const counted = useMemo(
    () => (base ? news || [] : (news || []).filter((n) => arrivedSet.has(n.id))),
    [base, news, arrivedIds],
  );
  const unread = useUnreadCount(accountId, counted);
  const quote = useTickerRow(open ? open.security_id : -1);

  const show = (item) => {
    // Erstes Lesen ohne Gelesen-Stand: der Rest gilt ab jetzt als ungelesen, nicht rückwirkend.
    if (base) markRead(accountId, item.id);
    else markAllRead(accountId, news || []);
    setOpen(item);
  };
  const readAll = () => {
    markAllRead(accountId, news || []);
    toast('Alle gelesen.', 'info');
  };

  if (!news) {
    return (
      <div className="page news-page">
        <div className="news-top">
          <h1>News</h1>
        </div>
        {failed
          ? <ErrorBox onRetry={load}>Die News konnten nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <SkelRows n={5} h={96} />}
      </div>
    );
  }

  if (!news.length) {
    return (
      <div className="page">
        <Empty icon={IconNews} title="Noch keine News.">Sobald an der Börse etwas passiert, steht es hier.</Empty>
      </div>
    );
  }

  const cat = open ? newsCategory(open) : null;
  const item = open;
  const tick = quote && quote.ticker;
  return (
    <div className="page news-page">
      <div className="news-top">
        <h1>News</h1>
        {unread > 0 && (
          <Button variant="ghost" size="sm" onClick={readAll}>Alle gelesen</Button>
        )}
      </div>
      {failed && (
        <ErrorBox onRetry={load}>Die News konnten nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
      )}
      {news.map((n) => (
        <div key={n.id} className={fresh.has(n.id) ? 'news-line is-new' : 'news-line'}>
          <NewsRow item={n} now={now} unread={accountId != null && (base || arrivedSet.has(n.id)) && !isRead(accountId, n.id)} onOpen={show} />
        </div>
      ))}

      <Sheet
        open={Boolean(item)}
        onClose={() => setOpen(null)}
        title={item ? `${cat.label} · ${newsSource(item, quote)}` : undefined}
        footer={item && quote && hasValue(item) ? (
          <Button variant="primary" full onClick={() => { setOpen(null); navigate(`/security/${item.security_id}`); }}>
            <span className="news-sheet-go">Zu {tick}</span>
          </Button>
        ) : undefined}
      >
        {item && (
          <div className="news-sheet">
            <NewsArt item={item} ticker={tick} wide />
            <h2 className="news-sheet-title">{item.title || ''}</h2>
            <p className="news-sheet-time">
              {dateTimeStr(item.created_at)} · {ago(item.created_at, now)}
            </p>
            {item.body ? <p className="news-sheet-text">{item.body}</p> : null}
            {hasValue(item) ? (
              <p className="news-sheet-fx">
                <Chip tone={impactInfo(item.impact).tone} className="news-fx-impact">
                  <span className="news-fx-cap">Wirkung:</span>{impactInfo(item.impact).label}
                </Chip>
              </p>
            ) : null}
            {hasValue(item) && quote ? (
                <Row
                  className="news-sheet-quote"
                  leading={<Symbol ticker={quote.ticker} name={quote.name} />}
                  trailing={(
                    <span className="news-sheet-px">
                      <LivePrice value={quote.last} />
                      <span className="news-sheet-px-chg">
                        <span className="news-fx-cap">heute</span>
                        <Pct v={quote.chg} signed />
                      </span>
                    </span>
                  )}
                />
            ) : null}
          </div>
        )}
      </Sheet>
    </div>
  );
}
