// News: Zeilen mit Zeit, Titel, Text und Kürzel — ohne Bilder.
// Lädt beim Öffnen und bei jeder neuen Nachricht über den WebSocket; sonst nichts.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Chip, Empty, ErrorBox, SkelRows } from '../ui.jsx';
import { useWS } from '../ws.jsx';
import { api } from '../api.js';
import './Player.css';

const KIND = { dividend: 'Dividende', ipo: 'Börsengang', bafin: 'Einfrieren', takeover: 'Übernahme', etf: 'ETF', system: 'Börse' };

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
}

export default function News() {
  const [news, setNews] = useState(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/news');
      if (!alive.current) return;
      setNews((r && r.news) || []);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Eine neue Nachricht kommt über den WebSocket — keine Wiederholungsabfrage nötig.
  useWS((m) => {
    if (m.type !== 'news' || !m.news) return;
    setNews((list) => [m.news, ...(list || []).filter((n) => n.id !== m.news.id)]);
  });

  if (!news) {
    return (
      <div className="page">
        {failed
          ? <ErrorBox onRetry={load}>Die News konnten nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <SkelRows n={5} h={88} />}
      </div>
    );
  }

  if (!news.length) {
    return (
      <div className="page">
        <Empty title="Noch keine News.">Sobald an der Börse etwas passiert, steht es hier.</Empty>
      </div>
    );
  }

  return (
    <div className="page">
      {news.map((n) => (
        <article className="news-item" key={n.id}>
          <div className="news-meta">
            <span>{ago(n.created_at)}</span>
            {KIND[n.kind] && <Chip>{KIND[n.kind]}</Chip>}
            {n.security_id && (
              <Link className="news-link" to={`/security/${n.security_id}`}>Wert ansehen</Link>
            )}
          </div>
          <h2>{n.title}</h2>
          {n.body && <p>{n.body}</p>}
        </article>
      ))}
    </div>
  );
}
