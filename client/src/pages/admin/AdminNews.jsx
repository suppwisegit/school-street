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
  // Art und Kurswirkung: der Server nimmt news | rumor | bafin | dividend und impact −3…3 (routes.js).
  const [kind, setKind] = useState('news');
  const [impact, setImpact] = useState('0');
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
    const wirkung = Number(impact);
    if (!Number.isInteger(wirkung) || wirkung < -3 || wirkung > 3) { setFormErr('Die Kurswirkung muss zwischen −3 und +3 liegen.'); return; }
    setFormErr('');
    setBusy(true);
    try {
      await A('/api/admin/news', {
        method: 'POST',
        body: { title: t, body: body.trim(), kind, security_id: secId ? Number(secId) : null, impact: wirkung },
      });
      toast(`Veröffentlicht: ${t}`, 'ok');
      setTitle('');
      setBody('');
      setSecId('');
      setKind('news');
      setImpact('0');
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
          <Field label="Art" help="Gerüchte sind unbestätigt und tragen ein eigenes Etikett." htmlFor="news-kind">
            <Select id="news-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="news">Nachricht</option>
              <option value="rumor">Gerücht</option>
              <option value="bafin">BaFin-Hinweis</option>
              <option value="dividend">Dividende</option>
            </Select>
          </Field>
          <Field
            label="Kurswirkung"
            help={kind === 'rumor' ? 'Bei einem Gerücht würfelt der Server das Vorzeichen.' : 'Wie stark der Kurs des Werts auf die News reagieren soll.'}
            htmlFor="news-impact"
          >
            <Select id="news-impact" value={impact} onChange={(e) => setImpact(e.target.value)}>
              <option value="0">Ohne Wirkung</option>
              <option value="1">Leicht positiv</option>
              <option value="2">Positiv</option>
              <option value="3">Stark positiv</option>
              <option value="-1">Leicht negativ</option>
              <option value="-2">Negativ</option>
              <option value="-3">Stark negativ</option>
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
              sub={[dateTimeStr(n.created_at), n.kind === 'rumor' ? 'Gerücht' : '', n.impact ? `Wirkung ${n.impact > 0 ? '+' : ''}${n.impact}` : '', n.body].filter(Boolean).join(' · ')}
              trailing={n.security_id ? <Chip tone={n.kind === 'rumor' ? 'warn' : 'neutral'}>{n.kind === 'rumor' ? 'Gerücht · ' : ''}{tickerOf(n.security_id)}</Chip> : n.kind === 'rumor' ? <Chip tone="warn">Gerücht</Chip> : undefined}
            />
          ))
        )}
      </Section>
    </div>
  );
}
