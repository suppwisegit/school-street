// Handel: Kurs groß, Kerzenchart, die wichtigsten Zahlen, unten Kaufen und Verkaufen.
// Das Handels-Sheet geht in drei Schritten: Menge → Vorschau → Bestätigen. Konfetti
// gibt es erst nach einer echt ausgeführten Order.
// Abfragen (Budget V4): Wert beim Öffnen, bei `dirty` und alle 60 s; Kerzen beim
// Öffnen und beim Umschalten des Zeitraums; Vorschau nur im offenen Sheet.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { IconChevronLeft } from '@tabler/icons-react';
import {
  Button, Chip, ErrorBox, Field, Input, LivePrice, Money, Num, Pct, Row, Section, Segmented, Sheet, Skel,
  Stepper, confetti, useToast,
} from '../ui.jsx';
import { CandleChart, useDirty, useGame, usePoll, useTickerRow } from '../hooks.jsx';
import { api, credsToCent, fmtC, snapToTick, tickOf } from '../api.js';
import './SecurityDetail.css';

const RANGES = [
  { value: '1d', label: '1T', range: 86400000, bucket: 300000 },
  { value: '1w', label: '1W', range: 7 * 86400000, bucket: 3600000 },
  { value: '1m', label: '1M', range: 30 * 86400000, bucket: 86400000 },
];
const QUICK = [{ label: '¼', part: 0.25 }, { label: '½', part: 0.5 }, { label: 'Alles', part: 1 }];
const SIDE_WORD = { buy: 'Kaufen', sell: 'Verkaufen' };
const REFRESH_MS = 60000;
const PREVIEW_MS = 300;

// Das Handels-Sheet. `onDone` meldet der Seite, dass gehandelt wurde.
function TradeSheet({ open, side, onSide, onClose, sec, last, holding, band, onDone }) {
  const navigate = useNavigate();
  const [type, setType] = useState('market');
  const [amount, setAmount] = useState(0);
  const [price, setPrice] = useState('');
  const [cash, setCash] = useState(0);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0); // 0 = Menge und Vorschau, 1 = Bestätigen
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const buy = side === 'buy';
  const tick = tickOf(sec.type);

  // Beim Öffnen oder Richtungswechsel: alles auf Anfang, Kontostand frisch holen
  useEffect(() => {
    if (!open) return undefined;
    setType('market');
    setAmount(0);
    setPrice('');
    setPreview(null);
    setError('');
    setStep(0);
    setDone(null);
    let alive = true;
    api('/api/portfolio').then((p) => { if (alive) setCash(p.cash); }).catch(() => {});
    return () => { alive = false; };
  }, [open, side]);

  const priceCent = type === 'limit' ? snapToTick(credsToCent(price), sec.type) : null;
  const priceOk = type === 'market' || credsToCent(price) >= tick;
  const inBand = type === 'market' || !band || (priceCent >= band.min && priceCent <= band.max);
  const fee = preview && Number.isFinite(preview.fee) ? preview.fee : 0;
  const unit = type === 'limit' ? priceCent : last;
  const max = buy ? (unit > 0 ? Math.floor((cash - fee) / unit) : 0) : holding;
  const tooMany = !buy && amount > holding;

  // Vorschau: nur im offenen Sheet, entprellt, bei jeder Änderung der Eingabe
  useEffect(() => {
    setPreview(null);
    if (!open || amount < 1 || !priceOk) return undefined;
    let off = false;
    const timer = setTimeout(async () => {
      try {
        const r = await api(`/api/securities/${sec.id}/preview`, {
          params: { side, type, amount, price: type === 'limit' ? priceCent : undefined },
        });
        if (!off) { setPreview(r); setError(''); }
      } catch (e) {
        if (!off) setError((e && e.message) || 'Das ging nicht.');
      }
    }, PREVIEW_MS);
    return () => { off = true; clearTimeout(timer); };
  }, [open, side, type, amount, price, sec.id, sec.type, priceOk, priceCent]);

  const matched = preview ? preview.matched_qty : 0;
  const lacks = type === 'market' && preview != null && preview.rest > 0;
  let total = null;
  if (preview && amount >= 1) {
    total = type === 'market'
      ? (buy ? preview.gross + fee : preview.gross - fee)
      : (buy ? priceCent * amount + fee : priceCent * amount - fee);
  }
  const over = buy && total != null && total > cash;
  const problem = !priceOk
    ? `Preis in Credits, mindestens ${fmtC(tick)}.`
    : !inBand
      ? `Außerhalb des erlaubten Bereichs: ${fmtC(band.min)} bis ${fmtC(band.max)}.`
      : tooMany
        ? `Du hast nur ${holding} Stück.`
        : lacks
          ? `Nur ${matched} Stück verfügbar. Wähl weniger.`
          : over
            ? 'Du hast zu wenig Geld.'
            : '';
  const ready = amount >= 1 && preview != null && !problem;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/orders', {
        method: 'POST',
        body: { security_id: sec.id, side, type, price: type === 'limit' ? priceCent : undefined, amount },
      });
      const trades = Array.isArray(r.trades) ? r.trades : [];
      const filled = trades.reduce((n, t) => n + t.amount, 0);
      const gross = trades.reduce((n, t) => n + t.price * t.amount, 0);
      setDone({ filled, gross, rest: amount - filled });
      if (filled > 0) confetti({ x: window.innerWidth / 2, y: window.innerHeight * 0.8 }, 'trade');
      onDone();
    } catch (e) {
      setError((e && e.message) || 'Das ging nicht.');
      setStep(0);
    } finally {
      setBusy(false);
    }
  };

  const verb = SIDE_WORD[side] || 'Kaufen';
  const tone = buy ? 'buy' : 'sell';
  const totalLabel = buy ? 'Du zahlst' : 'Du erhältst';
  const totalCell = <span className="num trade-total">{fmtC(Math.max(0, total || 0))}</span>;

  let body = null;
  let footer = null;

  if (done) {
    body = (
      <div className="trade-done">
        <p className="trade-done-title">
          {done.filled > 0
            ? `${buy ? 'Gekauft' : 'Verkauft'}. ${done.filled} × ${sec.ticker}`
            : `Limit gesetzt. ${done.rest} × ${sec.ticker} warten im Buch.`}
        </p>
        <p className="num trade-total">{fmtC(done.gross)}</p>
        <p className="muted small">
          {done.filled > 0
            ? `${buy ? 'gezahlt' : 'erhalten'}${type === 'limit' ? ` · Limit ${fmtC(priceCent)}` : ''}`
            : `zu ${fmtC(priceCent)}`}
        </p>
      </div>
    );
    footer = (
      <>
        <Button variant="primary" size="lg" full onClick={onClose}>Fertig</Button>
        <Button variant="ghost" size="lg" full onClick={() => { onClose(); navigate('/depot'); }}>Im Depot ansehen</Button>
      </>
    );
  } else if (step === 0) {
    body = (
      <div className="trade-form">
        <Segmented
          value={side}
          onChange={onSide}
          options={[{ value: 'buy', label: 'Kaufen' }, { value: 'sell', label: 'Verkaufen' }]}
          aria-label="Kaufen oder Verkaufen"
        />
        <Segmented
          value={type}
          onChange={setType}
          options={[{ value: 'market', label: 'Markt' }, { value: 'limit', label: 'Limit' }]}
          aria-label="Orderart"
        />
        <p className="muted small">{type === 'market' ? 'Zum besten verfügbaren Preis, sofort.' : 'Nur zu deinem Preis oder besser.'}</p>
        <Field
          label="Stückzahl"
          help={max > 0 ? `Möglich: bis ${max} Stück` : undefined}
          error={tooMany ? `Du hast nur ${holding} Stück.` : undefined}
        >
          <Stepper value={amount} onChange={setAmount} min={0} max={max > 0 ? max : undefined} suffix="Stück" label="Stückzahl" />
        </Field>
        <div className="trade-quick">
          {QUICK.map((q) => (
            <Button
              key={q.label}
              variant="ghost"
              size="sm"
              disabled={max < 1}
              onClick={() => setAmount(Math.max(1, Math.floor(max * q.part)))}
            >
              {q.label}
            </Button>
          ))}
        </div>
        {type === 'limit' && (
          <Field
            label="Dein Preis"
            help={band ? `Erlaubt: ${fmtC(band.min)} bis ${fmtC(band.max)}` : undefined}
            error={!priceOk || !inBand ? problem : undefined}
          >
            <Input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0,00"
              autoComplete="off"
            />
          </Field>
        )}
        {preview && (
          <div className="trade-preview">
            <Row title={totalLabel} trailing={totalCell} />
            <Row title="Stück" trailing={<Num v={type === 'market' ? matched : amount} />} />
            {preview.avg_price != null && <Row title="Ø-Preis" trailing={<span className="num">{fmtC(preview.avg_price)}</span>} />}
            <Row title="Gebühr" trailing={<span className="num">{fmtC(preview.fee)}</span>} />
            {type === 'limit' && <Row title="Wartet im Buch" trailing={<Num v={amount - matched} />} />}
          </div>
        )}
        <ErrorBox>{problem || error}</ErrorBox>
      </div>
    );
    footer = <Button variant={tone} size="lg" full disabled={!ready} onClick={() => setStep(1)}>Weiter</Button>;
  } else {
    const avg = preview && preview.avg_price != null ? preview.avg_price : (type === 'limit' ? priceCent : last);
    body = (
      <div className="trade-form">
        <p className="num trade-total"><Num v={amount} /> × {sec.ticker}</p>
        <p className="muted small">{type === 'market' ? 'Markt-Order' : `Limit ${fmtC(priceCent)}`}</p>
        <div className="trade-preview">
          <Row title={totalLabel} trailing={totalCell} />
          <Row title="Ø-Preis" trailing={<span className="num">{fmtC(avg)}</span>} />
          <Row title="Gebühr" trailing={<span className="num">{fmtC(fee)}</span>} />
        </div>
        {type === 'market' && <p className="muted small">Der Kurs kann sich bis zur Ausführung kurz ändern.</p>}
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
    footer = (
      <>
        <Button variant={tone} size="lg" full loading={busy} onClick={submit}>
          {verb} · {amount} × {sec.ticker}
        </Button>
        <Button variant="ghost" size="lg" full disabled={busy} onClick={() => setStep(0)}>Ändern</Button>
      </>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={done ? undefined : `${verb} · ${sec.ticker}`} footer={footer}>
      {body}
    </Sheet>
  );
}

export default function SecurityDetail() {
  const { id } = useParams();
  const secId = Number(id);
  const { bump } = useOutletContext();
  const navigate = useNavigate();
  const toast = useToast();
  const { paused } = useGame();
  const t = useTickerRow(secId);
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState('1d');
  const [candles, setCandles] = useState([]);
  const [sheet, setSheet] = useState(null); // 'buy' | 'sell' | null
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setInfo(null);
    setCandles([]);
    setSheet(null);
    return () => { alive.current = false; };
  }, [secId]);

  const loadInfo = useCallback(async () => {
    try {
      const r = await api(`/api/securities/${secId}`);
      if (alive.current) { setInfo(r); setFailed(false); }
    } catch {
      if (alive.current) setFailed(true);
    }
  }, [secId]);

  const loadCandles = useCallback(async () => {
    const rg = RANGES.find((x) => x.value === range) || RANGES[0];
    try {
      const r = await api(`/api/securities/${secId}/candles`, { params: { range: rg.range, bucket: rg.bucket } });
      if (alive.current) setCandles((r && r.candles) || []);
    } catch {
      /* ohne Kerzen bleibt das Chart leer, die Seite läuft weiter */
    }
  }, [secId, range]);

  useEffect(() => { loadInfo(); loadCandles(); }, [loadInfo, loadCandles]);
  useDirty(null, loadInfo);
  usePoll(() => { loadInfo(); loadCandles(); }, REFRESH_MS, [loadInfo, loadCandles]);

  const afterTrade = useCallback(() => { bump(); loadInfo(); }, [bump, loadInfo]);

  const cancel = useCallback(async (orderId) => {
    try {
      await api(`/api/orders/${orderId}`, { method: 'DELETE' });
      toast('Order storniert.', 'ok');
      bump();
      await loadInfo();
    } catch (e) {
      toast((e && e.message) || 'Das ging nicht.', 'err');
    }
  }, [bump, loadInfo, toast]);

  if (!info && !t) {
    return (
      <div className="page">
        {failed
          ? <ErrorBox onRetry={loadInfo}>Dieser Wert konnte nicht geladen werden. Prüf deine Verbindung.</ErrorBox>
          : <Skel h={360} />}
      </div>
    );
  }

  const s = (info && info.security) || t;
  const last = t && t.last != null ? t.last : s.last;
  const mine = (info && info.mine) || null;
  const stats = (info && info.stats) || {};
  const holding = mine ? mine.amount : 0;
  const open = (mine && mine.open_orders) || [];
  const pnl = holding > 0 ? (last - mine.avg_cost) * holding : 0;

  return (
    <div className="page trade">
      <Button variant="ghost" size="sm" className="trade-back" onClick={() => navigate('/')}>
        <IconChevronLeft size={18} />Zurück
      </Button>

      <header className="trade-head">
        <div className="trade-id">
          <span className="trade-tk num">{s.ticker}</span>
          {s.type === 'etf' && <Chip>ETF</Chip>}
          <span className="muted">{s.name}</span>
        </div>
        <div className="trade-quote">
          <LivePrice value={last} className="num-xl" />
          <Pct v={t ? t.chg : 0} signed colored className="num-lg" />
        </div>
      </header>

      <div className="trade-chart">
        <Segmented
          value={range}
          onChange={setRange}
          options={RANGES.map(({ value, label }) => ({ value, label }))}
          aria-label="Zeitraum"
        />
        <div className="trade-canvas"><CandleChart candles={candles} /></div>
      </div>

      <Section>
        <Row
          title="Hoch / Tief (24 h)"
          trailing={stats.high24 ? <span className="num">{fmtC(stats.high24)} / {fmtC(stats.low24)}</span> : <span className="muted">–</span>}
        />
        <Row title="Volumen (24 h)" trailing={<Num v={stats.vol24 || 0} />} />
        <Row
          title="Dein Bestand"
          sub={holding > 0 ? `gekauft zu ${fmtC(mine.avg_cost)} · ${pnl >= 0 ? '+' : '−'}${fmtC(Math.abs(pnl))}` : undefined}
          trailing={holding > 0 ? <Money c={holding * last} className="num" /> : <span className="muted">–</span>}
        />
      </Section>

      {open.length > 0 && (
        <Section title="Offene Orders">
          {open.map((o) => (
            <Row
              key={o.id}
              title={`${o.side === 'buy' ? 'Kauf' : 'Verkauf'} ${o.amount} ${s.ticker}`}
              sub={`Limit ${fmtC(o.price)} · ${o.filled > 0 ? `${o.filled} ausgeführt` : 'offen'}`}
              trailing={<Button variant="ghost" size="sm" onClick={() => cancel(o.id)}>Storno</Button>}
            />
          ))}
        </Section>
      )}

      {paused && <p className="muted small trade-pause">Börse pausiert — gerade keine Orders.</p>}

      <div className="sticky-actions">
        <Button variant="buy" size="lg" disabled={paused} onClick={() => setSheet('buy')}>Kaufen</Button>
        <Button variant="sell" size="lg" disabled={paused || holding < 1} onClick={() => setSheet('sell')}>Verkaufen</Button>
      </div>

      <TradeSheet
        open={sheet != null}
        side={sheet || 'buy'}
        onSide={setSheet}
        onClose={() => setSheet(null)}
        sec={s}
        last={last}
        holding={holding}
        band={info && info.band}
        onDone={afterTrade}
      />
    </div>
  );
}
