// Wertpapier-Detail: Kurs-Hero, Candle-Chart (Lightweight-Charts), Handels-Box
// mit Trade-Feedback (Konfetti), ETF-NAV, Pro-Modus (Orderbuch/Tape).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  IconAlertTriangle, IconBrain, IconChevronRight, IconLock, IconTrendingDown, IconTrendingUp
} from '@tabler/icons-react';
import { api, credsToCent, fmtC, snapToTick, tickOf, timeStr } from '../api.js';
import { useSubscribe, useWS } from '../ws.jsx';
import { CandleChart } from '../charts.jsx';
import {
  AvatarTile, Card, Chip, Empty, ErrorBox, Field, LivePrice, Money, Pct, confetti, useToast
} from '../ui.jsx';

const RANGES = [
  { key: '1h', label: '1H', bucket: 60000, range: 3600000 },
  { key: '4h', label: '4H', bucket: 300000, range: 14400000 },
  { key: '1T', label: '1T', bucket: 300000, range: 86400000 },
  { key: '1W', label: '1W', bucket: 3600000, range: 604800000 }
];

export default function SecurityDetail() {
  const { id } = useParams();
  const secId = Number(id);
  const navigate = useNavigate();
  const { user, ver, bump } = useOutletContext();
  const toast = useToast();

  const [data, setData] = useState(null); // {security, book, tape, mine, founder, is_founder, lockup_until}
  const [err, setErr] = useState('');
  const [pro, setPro] = useState(false);
  const [rangeKey, setRangeKey] = useState('1T');
  const [candles, setCandles] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/securities/${secId}`);
      setData(r);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [secId]);

  // Bei Wertpapierwechsel: neu laden; bei Daten-Bump (dirty): nur aktualisieren
  useEffect(() => { setData(null); setCandles(null); load(); }, [secId]); // eslint-disable-line
  useEffect(() => { if (ver > 0) load(); }, [load, ver]);

  // Candle-Daten + Auto-Refresh alle 15s
  const range = RANGES.find((r) => r.key === rangeKey);
  useEffect(() => {
    let alive = true;
    const fetchC = async () => {
      try {
        const r = await api(`/api/securities/${secId}/candles`, { params: { bucket: range.bucket, range: range.range } });
        if (alive) setCandles(r.candles || []);
      } catch { /* Chart bleibt alt */ }
    };
    fetchC();
    const t = setInterval(fetchC, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [secId, range.bucket, range.range]);

  // Live: Kurs-Ticker; im Pro-Modus zusätzlich Orderbuch + Trades
  useSubscribe(pro && data ? secId : null);
  useWS((m) => {
    if (m.type === 'ticker' && m.ticker && m.ticker.id === secId) {
      setData((d) => (d ? { ...d, security: { ...d.security, ...m.ticker } } : d));
    } else if (m.type === 'book' && m.security_id === secId && m.book) {
      setData((d) => (d ? { ...d, book: m.book } : d));
      const bestBid = m.book.bids && m.book.bids[0] && m.book.bids[0][0];
      const bestAsk = m.book.asks && m.book.asks[0] && m.book.asks[0][0];
      if (bestBid != null || bestAsk != null) {
        setData((d) => (d ? { ...d, security: { ...d.security, bid: bestBid ?? d.security.bid, ask: bestAsk ?? d.security.ask } } : d));
      }
    } else if (m.type === 'trade' && m.security_id === secId) {
      setData((d) => (d ? { ...d, tape: [{ ...m, id: 'ws' + m.ts + Math.random(), created_at: m.ts }, ...d.tape].slice(0, 25) } : d));
    }
  });

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return (
    <div className="col" style={{ gap: 12 }}>
      <div className="skel" style={{ height: 76, borderRadius: 14 }} />
      <div className="skel" style={{ height: 320, borderRadius: 16 }} />
    </div>
  );

  const { security: sec, book, tape, mine, founder, is_founder, lockup_until } = data;
  const lockedUp = is_founder && lockup_until > Date.now();

  return (
    <div className="col enter" style={{ gap: 12 }}>
      {/* Kopf: Kurs ist die Dominante */}
      <div className="detail-head">
        <div className="row" style={{ gap: 4 }}>
          <button className="backbtn" onClick={() => navigate(-1)} aria-label="Zurück">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6l6 6" /></svg>
          </button>
          <div className="grow">
            <div className="row" style={{ gap: 8 }}>
              <AvatarTile seed={sec.ticker} label={sec.ticker} size={34} radius={10} />
              <div>
                <div className="row" style={{ gap: 6 }}>
                  <span style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)' }}>{sec.ticker}</span>
                  {sec.type === 'etf' && <span className="etfchip">ETF</span>}
                </div>
                <div className="muted small">{sec.name}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="pricehero" style={{ marginTop: 12 }}>
          <div className="last"><LivePrice value={sec.last} countMs={350} /></div>
          <div className="sub"><Pct v={sec.chg} /> <span className="muted">24h</span></div>
        </div>
        <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
          <Chip>Geld {sec.bid != null ? fmtC(sec.bid) : '–'}</Chip>
          <Chip>Brief {sec.ask != null ? fmtC(sec.ask) : '–'}</Chip>
          <Chip>Vol {(sec.vol || 0).toLocaleString('de-DE')}</Chip>
          {mine && mine.amount > 0 && <Chip blue>{mine.amount} Stück · Ø {fmtC(mine.avg_cost)}</Chip>}
        </div>
        {sec.description ? <div className="muted small" style={{ marginTop: 8 }}>{sec.description}</div> : null}
        {founder && !is_founder && (
          <div style={{ marginTop: 10 }}>
            <span className="founderchip">
              <span className="ava">{founder.username.slice(0, 2).toUpperCase()}</span>
              <span>Gründer · {founder.username}</span>
            </span>
          </div>
        )}
        {lockedUp && (
          <div className="warnbox row" style={{ marginTop: 10, gap: 8 }}>
            <IconLock size={15} stroke={1.9} />
            <span>Gründer-Lock-up: Verkauf deiner Gründeraktien erst ab {new Date(lockup_until).toLocaleString('de-DE')}.</span>
          </div>
        )}
      </div>

      {/* Chart */}
      <Card>
        <div className="ranges" style={{ marginBottom: 8 }}>
          {RANGES.map((r) => (
            <button key={r.key} className={rangeKey === r.key ? 'on' : ''} onClick={() => setRangeKey(r.key)}>{r.label}</button>
          ))}
        </div>
        <div className="chartbox"><CandleChart candles={candles} /></div>
      </Card>

      {/* ETF: NAV-Kachel */}
      {sec.type === 'etf' && sec.nav && <NavTile nav={sec.nav} last={sec.last} />}

      {/* Handels-Box */}
      <TradeBox sec={sec} mine={mine} onDone={() => { load(); bump(); }} toast={toast} user={user} />

      {/* Pro-Modus */}
      <div className="row between">
        <span className="small muted">{pro ? 'Pro-Modus aktiv – Orderbuch & Tape live' : 'Orderbuch & letzte Trades'}</span>
        <button className={`btn sm ${pro ? 'primary' : ''}`} onClick={() => setPro((p) => !p)}>
          <IconBrain size={15} stroke={1.9} /> Pro-Modus
        </button>
      </div>
      {pro && (
        <div className="col" style={{ gap: 12 }}>
          <Card title="Orderbuch"><OrderBook book={book} sec={sec} /></Card>
          <Card title="Letzte Trades"><Tape tape={tape} /></Card>
        </div>
      )}
    </div>
  );
}

// ---------------- ETF-NAV-Kachel ----------------
function NavTile({ nav, last }) {
  const pct = Number(nav.premium_pct) || 0;
  const width = Math.min(Math.abs(pct), 10) / 10 * 50; // max ±10% darstellen
  return (
    <Card title="ETF – Nettoinventarwert (NAV)">
      <div className="navgrid">
        <div className="navtile">
          <div className="lbl">ETF-Kurs</div>
          <div className="val num">{fmtC(last)}</div>
        </div>
        <div className="navtile">
          <div className="lbl">NAV je Anteil</div>
          <div className="val num">{fmtC(nav.nav_per_share)}</div>
        </div>
      </div>
      <div className="center row" style={{ justifyContent: 'center', gap: 8, marginTop: 6 }}>
        <span className="muted small">Prämium/Discount</span>
        <Pct v={pct} />
      </div>
      <div className="prembar">
        <div className="mid" />
        <div
          className="fill"
          style={{
            left: pct >= 0 ? '50%' : `${50 - width}%`,
            width: `${width}%`,
            background: pct >= 0 ? 'var(--up)' : 'var(--down)'
          }}
        />
      </div>
      <table className="tbl" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>Korb</th><th className="r">Stück/Unit</th><th className="r">Kurs</th><th className="r">Wert</th></tr>
        </thead>
        <tbody>
          {(nav.items || []).map((it) => (
            <tr key={it.stock_id}>
              <td className="num"><b>{it.ticker}</b></td>
              <td className="r num">{it.qty}</td>
              <td className="r num">{fmtC(it.price)}</td>
              <td className="r num">{fmtC(it.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row between small muted" style={{ marginTop: 6 }}>
        <span>Korb-Gesamtwert</span>
        <Money c={nav.basket_value} />
      </div>
      <div className="row between small muted">
        <span>ETF-Anteile pro Creation Unit</span>
        <span className="num">{nav.shares_per_unit}</span>
      </div>
      <div className="hintbox" style={{ marginTop: 8 }}>
        Handelt der ETF über dem NAV (Prämium), schafft die Investment AG neue Anteile (Creation) und verkauft sie – das drückt den Kurs Richtung NAV. Unter dem NAV (Discount) vernichtet sie Anteile (Redemption).
      </div>
    </Card>
  );
}

// ---------------- Handels-Box ----------------
function TradeBox({ sec, mine, onDone, toast, user }) {
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('limit');
  const [amount, setAmount] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Limit-Preis mit Ask/Bid vorbelegen – nur bei Seiten-/Wertpapierwechsel oder leerem Feld
  const prefillKey = useRef('');
  useEffect(() => {
    const key = `${sec.id}:${side}`;
    const ref = side === 'buy' ? (sec.ask ?? sec.last) : (sec.bid ?? sec.last);
    if (ref != null && (prefillKey.current !== key || !priceStr)) {
      setPriceStr((snapToTick(ref, sec.type) / 100).toFixed(2));
    }
    prefillKey.current = key;
  }, [sec.id, side, sec.ask, sec.bid]); // eslint-disable-line

  const tick = tickOf(sec.type);
  const amt = Math.floor(Number(amount) || 0);
  const cents = credsToCent(priceStr);
  const snapped = snapToTick(cents, sec.type);
  const estRef = type === 'limit' ? snapped : side === 'buy' ? (sec.ask ?? sec.last) : (sec.bid ?? sec.last);
  const est = amt > 0 ? estRef * amt : 0;
  const invalidTick = type === 'limit' && cents > 0 && cents !== snapped;

  const submit = async () => {
    setErr('');
    if (amt < 1) return setErr('Ungültige Stückzahl');
    const body = { security_id: sec.id, side, type, amount: amt };
    if (type === 'limit') body.price = snapped;
    setBusy(true);
    try {
      const r = await api('/api/orders', { method: 'POST', body });
      const trades = r.trades || [];
      if (trades.length) {
        const qty = trades.reduce((a, t) => a + t.amount, 0);
        const px = trades[trades.length - 1].price;
        toast(`${qty} ${sec.ticker} ${side === 'buy' ? 'gekauft' : 'verkauft'} @ ${fmtC(px)}`, 'ok');
        confetti();
      } else {
        toast(`${type === 'limit' ? 'Limit-Order' : 'Order'} im Buch platziert (${amt} ${sec.ticker})`, 'info');
      }
      onDone();
    } catch (e) {
      setErr(e.message);
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const maxSell = mine ? mine.amount : 0;

  return (
    <Card>
      <Tabs2 side={side} setSide={(v) => { setSide(v); setErr(''); }} />
      <div style={{ height: 12 }} />
      <div className="tabs">
        <button type="button" className={type === 'limit' ? 'on' : ''} onClick={() => setType('limit')}>Limit</button>
        <button type="button" className={type === 'market' ? 'on' : ''} onClick={() => setType('market')}>Market</button>
      </div>
      <div style={{ height: 12 }} />
      <ErrorBox>{err}</ErrorBox>
      <div className="inputpair">
        <Field label="Stückzahl">
          <input className="input num" type="number" min="1" step="1" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>
        {type === 'limit' && (
          <Field label="Limit-Preis (Credits)" help={invalidTick ? `wird auf Tick ${(tick / 100).toFixed(2)} gerundet` : `Tick: ${(tick / 100).toFixed(2)} Credits`}>
            <input className="input num" type="number" min="0" step={tick / 100} inputMode="decimal" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} />
          </Field>
        )}
      </div>
      {side === 'sell' && maxSell > 0 && (
        <button className="btn sm ghost" style={{ marginBottom: 8 }} onClick={() => setAmount(String(maxSell))}>Max: {maxSell} Stück</button>
      )}
      <div className="kv"><span className="muted">{side === 'buy' ? 'Geschätzte Kosten' : 'Geschätzter Erlös'}</span><b className="num">{fmtC(est)} Credits</b></div>
      <div className="kv"><span className="muted">Ordergebühr</span><span className="num muted">kommt hinzu</span></div>
      <div style={{ height: 10 }} />
      <button className={`btn block xl ${side === 'buy' ? 'buy' : 'sell'}`} disabled={busy || amt < 1} onClick={submit}>
        {busy
          ? 'Wird ausgeführt …'
          : <>{side === 'buy' ? <IconTrendingUp size={17} stroke={2.1} /> : <IconTrendingDown size={17} stroke={2.1} />}{amt > 0 ? `${amt} ${sec.ticker} ` : ''}{side === 'buy' ? 'kaufen' : 'verkaufen'}</>}
      </button>
      {user && user.frozen && (
        <div className="errbox row" style={{ marginTop: 10, gap: 8 }}>
          <IconAlertTriangle size={15} stroke={1.9} />
          <span>Dein Konto ist eingefroren (BaFin) – Handeln nicht möglich.</span>
        </div>
      )}
    </Card>
  );
}

// Kauf/Verkauf-Segment mit Farb-States
function Tabs2({ side, setSide }) {
  return (
    <div className={`tabs ${side === 'buy' ? 'tabs-buy' : 'tabs-sell'}`}>
      <button type="button" className={side === 'buy' ? 'on buytab' : ''} onClick={() => setSide('buy')}>KAUFEN</button>
      <button type="button" className={side === 'sell' ? 'on selltab' : ''} onClick={() => setSide('sell')}>VERKAUFEN</button>
    </div>
  );
}

// ---------------- Orderbuch ----------------
function OrderBook({ book, sec }) {
  const bids = (book && book.bids) || [];
  const asks = (book && book.asks) || [];
  if (!bids.length && !asks.length) return <Empty>Orderbuch leer – keine offenen Orders.</Empty>;
  const maxQ = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]));
  const bestBid = bids.length ? bids[0][0] : null;
  const bestAsk = asks.length ? asks[0][0] : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  const Row = ({ p, q, tone }) => (
    <div className="ob-row">
      <div className="fillbar" style={{ width: `${(q / maxQ) * 100}%`, background: tone === 'bid' ? 'var(--up)' : 'var(--down)' }} />
      <span className={`p num ${tone === 'bid' ? 'pos' : 'neg'}`}>{fmtC(p)}</span>
      <span className="q num">{q}</span>
    </div>
  );

  return (
    <div>
      <div className="row between muted small" style={{ padding: '0 10px 4px' }}><span>Preis</span><span>Stück</span></div>
      {[...asks].reverse().map(([p, q], i) => <Row key={'a' + p + i} p={p} q={q} tone="ask" />)}
      <div className="ob-mid num">
        {spread != null ? `Spread ${fmtC(spread)} (${fmtC((bestBid + bestAsk) / 2)} Mitte)` : 'Spread –'}
      </div>
      {bids.map(([p, q], i) => <Row key={'b' + p + i} p={p} q={q} tone="bid" />)}
      <div className="muted small center" style={{ marginTop: 8 }}>Letzter Kurs: <b className="num">{fmtC(sec.last)}</b></div>
    </div>
  );
}

// ---------------- Tape (letzte Trades) ----------------
function Tape({ tape }) {
  const rows = tape || [];
  if (!rows.length) return <Empty>Noch keine Trades.</Empty>;
  return (
    <div>
      {rows.map((t, i) => (
        <div className="tape-row" key={t.id ?? i}>
          <span className="num" style={{ fontWeight: 700 }}>{fmtC(t.price)}</span>
          <span className="num muted">×{t.amount}</span>
          <span className="muted grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.buyer || '?'} → {t.seller || '?'}</span>
          <span className="muted num small">{timeStr(t.created_at || t.ts)}</span>
        </div>
      ))}
    </div>
  );
}
