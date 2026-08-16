// News-Feed mit Kategorie-Icons, live via WS.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconBell, IconBuildingBank, IconBuildingFactory2, IconCoin, IconNews, IconScale } from '@tabler/icons-react';
import { api, dateTimeStr } from '../api.js';
import { useWS } from '../ws.jsx';
import { Card, Empty, ErrorBox, SkelRows } from '../ui.jsx';

const KIND_ICONS = {
  news: { Icon: IconNews, cls: 'news' },
  dividend: { Icon: IconCoin, cls: 'dividend' },
  bafin: { Icon: IconScale, cls: 'bafin' },
  ipo: { Icon: IconBell, cls: 'ipo' },
  system: { Icon: IconBuildingBank, cls: 'system' },
  takeover: { Icon: IconAlertTriangle, cls: 'takeover' },
  etf: { Icon: IconBuildingFactory2, cls: 'etf' }
};

export default function NewsTab() {
  const [news, setNews] = useState(null);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    api('/api/news')
      .then((r) => { if (alive) setNews(r.news || []); })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, []);

  useWS((m) => {
    if (m.type === 'news' && m.news) {
      setNews((list) => (list && list.some((n) => n.id === m.news.id) ? list : [m.news, ...(list || [])].slice(0, 100)));
    }
  });

  const open = (n) => { if (n.security_id) navigate(`/security/${n.security_id}`); };

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!news) return <SkelRows n={5} h={84} />;

  return (
    <div className="col enter" style={{ gap: 10 }}>
      {news.length === 0 && <Empty>Noch keine News.</Empty>}
      {news.map((n) => {
        const K = KIND_ICONS[n.kind] || KIND_ICONS.news;
        return (
          <Card key={n.id} className="hover newsitem tight" onClick={() => open(n)} role={n.security_id ? 'button' : undefined}>
            <span className={`icochip ${K.cls}`}><K.Icon stroke={1.8} /></span>
            <div className="grow">
              <div className="tt">{n.title}</div>
              {n.body ? <div className="bd">{n.body}</div> : null}
              <div className="meta">{dateTimeStr(n.created_at)}{n.security_id ? ' · zum Wertpapier ›' : ''}</div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
