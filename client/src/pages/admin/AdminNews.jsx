// Admin: News veröffentlichen.
import React, { useEffect, useState } from 'react';
import { IconAlertTriangle, IconBell, IconBuildingBank, IconBuildingFactory2, IconCoin, IconNews, IconScale, IconSend } from '@tabler/icons-react';
import { dateTimeStr } from '../../api.js';
import { Card, Empty, ErrorBox, Field, Loading, useToast } from '../../ui.jsx';

const KINDS = [
  { value: 'news', label: 'News' },
  { value: 'bafin', label: 'BaFin' },
  { value: 'dividend', label: 'Dividende' }
];
const KIND_ICONS = {
  news: { Icon: IconNews, cls: 'news' },
  dividend: { Icon: IconCoin, cls: 'dividend' },
  bafin: { Icon: IconScale, cls: 'bafin' },
  ipo: { Icon: IconBell, cls: 'ipo' },
  system: { Icon: IconBuildingBank, cls: 'system' },
  takeover: { Icon: IconAlertTriangle, cls: 'takeover' },
  etf: { Icon: IconBuildingFactory2, cls: 'etf' }
};

export default function AdminNews({ A, toast }) {
  const [secs, setSecs] = useState([]);
  const [news, setNews] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [securityId, setSecurityId] = useState('');
  const [kind, setKind] = useState('news');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [s, n] = await Promise.all([api_public_securities(), A('/api/news')]);
      setSecs(s);
      setNews(n.news || []);
    } catch (e) { setErr(e.message); }
  };
  const api_public_securities = async () => {
    const r = await A('/api/securities');
    return r.securities || [];
  };
  useEffect(() => { load(); }, []);

  const publish = async () => {
    setErr('');
    if (title.trim().length < 3) return setErr('Titel zu kurz');
    setBusy(true);
    try {
      await A('/api/admin/news', {
        method: 'POST',
        body: { title: title.trim(), body: body.trim(), kind, security_id: securityId ? Number(securityId) : null }
      });
      toast('News veröffentlicht', 'ok');
      setTitle(''); setBody(''); setSecurityId('');
      load();
    } catch (e) {
      setErr(e.message);
    } finally { setBusy(false); }
  };

  if (err && !news) return <ErrorBox>{err}</ErrorBox>;

  return (
    <div className="panelgrid">
      <Card title="News veröffentlichen">
        <ErrorBox>{err}</ErrorBox>
        <Field label="Kategorie">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Titel">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="z.B. Mensa-Preise steigen dramatisch!" />
        </Field>
        <Field label="Text">
          <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Details, Gerüchte, Zahlen …" />
        </Field>
        <Field label="Bezug zu Wertpapier (optional)">
          <select className="select" value={securityId} onChange={(e) => setSecurityId(e.target.value)}>
            <option value="">– kein Bezug –</option>
            {secs.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}</option>)}
          </select>
        </Field>
        <button className="btn primary block" disabled={busy} onClick={publish}>
          <IconSend size={15} stroke={1.9} /> {busy ? 'Wird veröffentlicht …' : 'Veröffentlichen'}
        </button>
      </Card>

      <Card title="Letzte News">
        {!news ? <Loading /> : news.length === 0 ? <Empty>Noch keine News.</Empty> : (
          news.slice(0, 15).map((n) => {
            const K = KIND_ICONS[n.kind] || KIND_ICONS.news;
            return (
              <div key={n.id} className="row" style={{ gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(30,42,65,0.5)' }}>
                <span className={`icochip ${K.cls}`}><K.Icon stroke={1.8} /></span>
                <div className="grow">
                  <b>{n.title}</b>
                  <div className="muted small">{dateTimeStr(n.created_at)}</div>
                </div>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
