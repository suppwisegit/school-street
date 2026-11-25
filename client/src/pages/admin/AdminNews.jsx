// Admin, Bereich „News": Formular (Titel, Text, Wert optional) und die letzten 30.
// Stand: GET /api/news?limit=30 + GET /api/securities alle 10 s (nur sichtbar) und nach dem Veröffentlichen.
import React, { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { dateTimeStr } from '../../api.js';
import { IconNews } from '@tabler/icons-react';
import {
  Button, Chip, Empty, ErrorBox, Field, Input, Row, Section, Select, SkelRows, Textarea, useToast,
} from '../../ui.jsx';
import { usePoll } from '../../hooks.jsx';

export default function AdminNews() {
  const { A } = useOutletContext();
  const toast = useToast();
  const [news, setNews] = useState(null);
  const [secs, setSecs] = useState([]);
  const [err, setErr] = useState('');
  const [ver, setVer] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [secId, setSecId] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  const bump = () => setVer((v) => v + 1);

  const load = async () => {
    const [n, s] = await Promise.all([
      A('/api/news', { params: { limit: 30 } }).catch((e) => ({ error: e.message })),
      A('/api/securities').catch((e) => ({ error: e.message })),
    ]);
    if (n.error || s.error) { setErr(n.error || s.error); return; }
    setErr('');
    setNews(Array.isArray(n.news) ? n.news : []);
    setSecs(Array.isArray(s.securities) ? s.securities : []);
  };
  usePoll(load, 10000, [ver]);

  const publish = async (e) => {
    e.preventDefault();
    const t = title.trim();
    if (t.length < 3) { setFormErr('Der Titel braucht mindestens 3 Zeichen.'); return; }
    setFormErr('');
    setBusy(true);
    try {
      await A('/api/admin/news', {
        method: 'POST',
        body: { title: t, body: body.trim(), kind: 'news', security_id: secId ? Number(secId) : null },
      });
      toast(`Veröffentlicht: ${t}`, 'ok');
      setTitle('');
      setBody('');
      setSecId('');
      bump();
    } catch (er) {
      setFormErr(er.message);
    } finally {
      setBusy(false);
    }
  };

  const tickerOf = (id) => (secs.find((s) => s.id === id) || {}).ticker || 'Wert';
  const errBox = <ErrorBox onRetry={bump}>{`Das ging nicht. ${err}`}</ErrorBox>;

  return (
    <div className="admin-areas">
      <Section title="News schreiben">
        <form className="admin-form" onSubmit={publish}>
          <ErrorBox>{formErr}</ErrorBox>
          <Field label="Titel" htmlFor="news-title">
            <Input
              id="news-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Worum geht es?"
            />
          </Field>
          <Field label="Text" htmlFor="news-body">
            <Textarea
              id="news-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={2000}
              placeholder="Was ist passiert?"
            />
          </Field>
          <Field label="Wert (optional)" help="Gehört die News zu einem bestimmten Wert? Wähl ihn hier aus." htmlFor="news-sec">
            <Select id="news-sec" value={secId} onChange={(e) => setSecId(e.target.value)}>
              <option value="">Kein bestimmter Wert</option>
              {secs.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}</option>)}
            </Select>
          </Field>
          <Button type="submit" loading={busy} disabled={!title.trim()}>Veröffentlichen</Button>
        </form>
      </Section>

      <Section title="Letzte News">
        {!news ? (err ? errBox : <SkelRows n={6} />) : news.length === 0 ? (
          <Empty icon={IconNews} title="Noch keine News">Schreib oben die erste.</Empty>
        ) : (
          news.map((n) => (
            <Row
              key={n.id}
              title={n.title}
              sub={[dateTimeStr(n.created_at), n.body].filter(Boolean).join(' · ')}
              trailing={n.security_id ? <Chip>{tickerOf(n.security_id)}</Chip> : undefined}
            />
          ))
        )}
      </Section>
    </div>
  );
}
