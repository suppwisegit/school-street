// Wertpapier-Detail im Neo-Broker-Look (Trade-Republic-Familie):
// großer Kurs-Hero, Candle-Chart, Handels-Panel mit MARKET als Default
// und Live-Kostenvorschau per echtem Book-Walk (10@50 + 10@55 = 1050),
// ETF-NAV, Pro-Terminal (Kennzahlen, Orderbuch, Tape, Volumenprofil).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  IconAlertTriangle, IconChevronRight, IconLock, IconTerminal2, IconTrendingDown, IconTrendingUp
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

  const [data, setData] = useState(null); // {security, book, tape, mine, stats, band, founder, is_founder, lockup_until}
  const [err, setErr] = useState('');
  const [pro, setPro] = useState(false);
  const [rangeKey, setRangeKey] = useState('1T');
  const [candles, setCandles] = useState(null);
  const [bookVer, setBookVer] = useState(0); // ändert sich bei jedem Orderbuch-Update -> Preview refresht

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

  // Live: immer abonnieren (Kurs-Ticker + Orderbuch -> sofortige Kalkulation)
  useSubscribe(data ? secId : null);
  useWS((m) => {
    if (m.type === 'ticker' && m.ticker && m.ticker.id === secId) {
      setData((d) => (d ? { ...d, security: { ...d.security, ...m.ticker } } : d));
    } else if (m.type === 'book' && m.security_id === secId && m.book) {
      setData((d) => (d ? { ...d, book: m.book } : d));
      setBookVer((v) => v + 1);
      const bestBid = m.book.bids && m.book.bids[0] && m.book.bids[0][0];
      const bestAsk = m.book.asks && m.book.asks[0] && m.book.asks[0][0];
      if (bestBid != null || bestAsk != null) {
        setData((d) => (d ? { ...d, security: { ...d.security, bid: bestBid ?? d.security.bid, ask: bestAsk ?? d.security.ask } } : d));
      }
    } else if (m.type === 'trade' && m.security_id === secId) {
      setData((d) => (d ? { ...d, tape: [{ ...m, id: 'ws' + m.ts + Math.random(), created_at: m.ts }, ...d.tape].slice(0, 40) } : d));
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
    <div className="col enter" style={{ gap: 14 }}>
      {/* Kopf: Kurs ist die Dominante (TR-Stil: kein Kartenrahmen) */}
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
        <div className="pricehero" style={{ marginTop: 14 }}>
          <div className="last"><LivePrice value={sec.last} countMs={350} /></div>
          <div className="sub"><Pct v={sec.chg} /> <span className="muted">24h</span></div>
        </div>
        <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
          <Chip>Geld {sec.bid != null ? fmtC(sec.bid) : '–'}</Chip>
          <Chip>Brief {sec.ask != null ? fmtC(sec.ask) : '–'}</Chip>
          <Chip>Vol {(sec.vol || 0).toLocaleString('de-DE')}</Chip>
          {mine && mine.amount > 0 && <Chip blue>{mine.amount} Stück · Ø {fmtC(mine.avg_cost)}</Chip>}
        </div>
        {sec.description ? <div className="muted small" style={{ marginTop: 10 }}>{sec.description}</div> : null}
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

      {/* Handels-Panel: Market ist Default — schnell kaufen ohne Klicks */}
      <TradeBox
        sec={sec} book={book} mine={mine} bookVer={bookVer}
        onDone={() => { load(); bump(); }} toast={toast} user={user}
      />

      {/* ETF: NAV-Kachel */}
      {sec.type === 'etf' && sec.nav && <NavTile nav={sec.nav} last={sec.last} />}

      {/* Offene Orders */}
      {mine && mine.open_orders && mine.open_orders.length > 0 && <OpenOrders mine={mine} onDone={() => { load(); bump(); }} toast={toast} />}

      {/* Pro-Terminal */}
      <div className="row between">
        <span className="small muted">{pro ? 'Terminal aktiv – Kennzahlen, Orderbuch & Tape live' : 'Kennzahlen, Orderbuch, Volumen & Trades'}</span>
        <button className={`btn sm ${pro ? 'primary' : ''}`} onClick={() => setPro((p) => !p)}>
          <IconTerminal2 size={15} stroke={1.9} /> Terminal
        </button>
      </div>
      {pro && (
        <div className="progrid">
          <div className="span2"><StatsGrid stats={data.stats} sec={sec} /></div>
          <div className="terminal">
            <div className="thead"><span>Orderbuch</span><span className="live">LIVE</span></div>
            <OrderBook book={book} sec={sec} />
          </div>
          <div className="terminal">
            <div className="thead"><span>Letzte Trades</span><span className="live">TAPE</span></div>
            <Tape tape={tape} />
          </div>
          <div className="span2 terminal">
            <div className="thead"><span>Volumenprofil</span><span className="live">nach Preis</span></div>
            <VolumeProfile tape={tape} mid={data.stats?.mid ?? sec.last} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Kennzahlen-Grid (Pro) ----------------
function StatsGrid({ stats, sec }) {
  const s = stats || {};
  const fmtQty = (v) => (v == null ? '–' : Number(v).toLocaleString('de-DE'));
  const cells = [
    { k: 'Spread', v: s.spread != null ? fmtC(s.spread) : '–', sub: s.spread_bp != null ? `${s.spread_bp} bp` : '' },
    { k: 'Mid', v: s.mid != null ? fmtC(s.mid) : '–' },
    { k: 'VWAP 24h', v: s.vwap24 != null ? fmtC(s.vwap24) : '–', cls: 'cyan' },
    { k: 'Volumen 24h', v: `${fmtQty(s.vol24)} Stk`, cls: 'amber' },
    { k: 'Umsatz 24h', v: s.turnover24 != null ? `${fmtC(s.turnover24)} Cr` : '–' },
    { k: 'Trades 24h', v: fmtQty(s.trades24) },
    { k: 'Hoch 24h', v: s.high24 != null ? fmtC(s.high24) : '–', cls: 'pos' },
    { k: 'Tief 24h', v: s.low24 != null ? fmtC(s.low24) : '–', cls: 'neg' },
    { k: 'Volatilität', v: s.volatility_pct != null ? `${s.volatility_pct.toFixed(2)}%` : '–' },
    { k: 'Marktkapital.', v: s.mcap != null ? `${fmtC(s.mcap)} Cr` : '–' },
    { k: 'Tiefe Bid', v: fmtQty(s.bid_depth), sub: 'Stück' },
    { k: 'Tiefe Ask', v: fmtQty(s.ask_depth), sub: 'Stück' },
  ];
  return (
    <div className="pstats">
      {cells.map((c) => (
        <div className="pstat" key={c.k}>
          <div className="k">{c.k}</div>
          <div className={`v ${c.cls || ''}`}>{c.v}{c.sub ? <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 4 }}>{c.sub}</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Offene Orders ----------------
function OpenOrders({ mine, onDone, toast }) {
  const cancel = async (o) => {
    try {
      await api(`/api/orders/${o.id}`, { method: 'DELETE' });
      toast('Order storniert – Escrow zurückerstattet', 'ok');
      onDone();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Card title="Deine offenen Orders">
      {(mine.open_orders || []).map((o) => (
        <div className="row between" key={o.id} style={{ padding: '7px 0', borderBottom: '1px solid #17171d' }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`num ${o.side === 'buy' ? 'pos' : 'neg'}`} style={{ fontWeight: 800 }}>
              {o.side === 'buy' ? 'KAUF' : 'VERKAUF'}
            </span>
            <span className="num">{o.amount - o.filled} Stk</span>
            <span className="muted small">{o.type === 'limit' ? `Limit ${fmtC(o.price)}` : 'Market'}</span>
          </div>
          <button className="btn sm ghost" onClick={() => cancel(o)}>Storno</button>
        </div>
      ))}
    </Card>
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

// ---------------- Handels-Panel ----------------
// MARKET ist vorausgewählt (Schüler wollen schnell handeln). Die Kosten-
// vorschau läuft über den Server-Book-Walk: 10@50 + 10@55 = 1050, nie n×Bestpreis.
function TradeBox({ sec, book, mine, bookVer, onDone, toast, user }) {
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('market'); // Market-Order zuerst: null Klicks bis zum Kauf
  const [amount, setAmount] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);

  const tick = tickOf(sec.type);
  const amt = Math.floor(Number(amount) || 0);
  const cents = credsToCent(priceStr);
  const snapped = snapToTick(cents, sec.type);
  const invalidTick = type === 'limit' && cents > 0 && cents !== snapped;

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

  // Live-Preview (debounced 250 ms): exakter Book-Walk vom Server
  useEffect(() => {
    if (amt < 1 || (type === 'limit' && invalidTick)) { setPreview(null); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const params = { side, type, amount: amt };
        if (type === 'limit') params.price = snapped;
        const r = await api(`/api/securities/${sec.id}/preview`, { params });
        if (alive) setPreview(r);
      } catch { if (alive) setPreview(null); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [sec.id, side, type, amt, snapped, invalidTick, bookVer]); // eslint-disable-line

  const band = preview?.band;
  const outsideBand = type === 'limit' && band && cents > 0 && (snapped < band.min || snapped > band.max);
  const notEnoughLiquidity = type === 'market' && preview && preview.available != null && amt > preview.available;

  const gross = preview ? preview.gross : 0; // market: Walk-Kosten/-Erlös, limit: worst-case
  const fee = preview?.fee ?? 2000;
  const total = side === 'buy' ? gross + fee : gross - fee;
  const avg = preview?.avg_price;

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
        const cost = trades.reduce((a, t) => a + t.price * t.amount, 0);
        toast(`${qty} ${sec.ticker} ${side === 'buy' ? 'gekauft' : 'verkauft'} – ${fmtC(cost)} Credits`, 'ok');
        confetti();
      } else {
        toast(`Limit-Order im Buch (${amt} ${sec.ticker} @ ${fmtC(snapped)})`, 'info');
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
  const step = (d) => setAmount(String(Math.max(1, amt + d)));
  const disabled = busy || amt < 1 || invalidTick || outsideBand || notEnoughLiquidity;

  return (
    <div className="tradepanel">
      <div className={`tabs ${side === 'buy' ? 'tabs-buy' : 'tabs-sell'}`}>
        <button type="button" className={side === 'buy' ? 'on buytab' : ''} onClick={() => { setSide('buy'); setErr(''); }}>KAUFEN</button>
        <button type="button" className={side === 'sell' ? 'on selltab' : ''} onClick={() => { setSide('sell'); setErr(''); }}>VERKAUFEN</button>
      </div>
      <div style={{ height: 10 }} />
      <div className="tabs">
        <button type="button" className={type === 'market' ? 'on' : ''} onClick={() => setType('market')}>
          Market {type === 'market' && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>· sofort zum besten Kurs</span>}
        </button>
        <button type="button" className={type === 'limit' ? 'on' : ''} onClick={() => setType('limit')}>
          Limit {type === 'limit' && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>· eigener Preis</span>}
        </button>
      </div>
      <div style={{ height: 12 }} />
      <ErrorBox>{err}</ErrorBox>

      <Field label="Stückzahl">
        <div className="qtyrow">
          <button type="button" className="steppr" onClick={() => step(-1)} aria-label="Weniger">−</button>
          <input
            className="input num" type="number" min="1" step="1" inputMode="numeric"
            value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0"
          />
          <button type="button" className="steppr" onClick={() => step(1)} aria-label="Mehr">+</button>
        </div>
      </Field>
      <div className="quickrow">
        {[5, 10, 25].map((n) => (
          <button key={n} type="button" onClick={() => setAmount(String(n))}>{n}</button>
        ))}
        <button type="button" onClick={() => setAmount(String(Math.max(1, side === 'sell' ? maxSell : Math.min(preview?.available || 9999, 100))))}>
          {side === 'sell' ? `Max ${maxSell}` : 'Max'}
        </button>
      </div>

      {type === 'limit' && (
        <div style={{ marginTop: 10 }}>
          <Field label="Limit-Preis (Credits)" help={invalidTick ? `wird auf Tick ${(tick / 100).toFixed(2)} gerundet` : `Tick: ${(tick / 100).toFixed(2)}`}>
            <input className="input num" type="number" min="0" step={tick / 100} inputMode="decimal" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} />
          </Field>
          {band && (
            <div className={`bandnote ${outsideBand ? 'err' : ''}`}>
              {outsideBand
                ? `Außerhalb des erlaubten Bands – erlaubt: ${fmtC(band.min)} bis ${fmtC(band.max)} (Kurs ±15 %)`
                : `Erlaubter Bereich: ${fmtC(band.min)} – ${fmtC(band.max)} (Schutz vor Kurs-Manipulation)`}
            </div>
          )}
        </div>
      )}

      {/* Kosten-Vorschau aus dem echten Orderbuch */}
      <div style={{ height: 8 }} />
      {preview && amt >= 1 && (
        <>
          {type === 'market' && preview.fills && preview.fills.length > 0 && (
            <div className="priceline">
              <span className="muted">Fills aus dem Buch</span>
              <span className="num" style={{ fontSize: 12.5 }}>
                {preview.fills.slice(0, 4).map((f, i) => (
                  <span key={i}>{i > 0 && ' + '}<span className={side === 'buy' ? 'neg' : 'pos'}>{f.qty}@{fmtC(f.price)}</span></span>
                ))}
                {preview.fills.length > 4 && <span className="muted"> +{preview.fills.length - 4} weitere</span>}
              </span>
            </div>
          )}
          {avg != null && (
            <div className="priceline">
              <span className="muted">Ø-Ausführungspreis</span>
              <b className="num">{fmtC(avg)}</b>
            </div>
          )}
          <div className="priceline">
            <span className="muted">{side === 'buy' ? 'Gesamtkosten' : 'Netto-Erlös'} <span className="muted" style={{ fontSize: 11 }}>(inkl. Gebühr {fmtC(fee)})</span></span>
            <b className={`num ${total > 0 ? '' : ''}`} style={{ fontSize: 18 }}>{fmtC(Math.abs(total))} <span style={{ fontSize: 11, fontWeight: 600 }}>Credits</span></b>
          </div>
          {type === 'market' && preview.available != null && (
            <div className={`bandnote ${notEnoughLiquidity ? 'err' : ''}`}>
              {notEnoughLiquidity
                ? `Nur ${preview.available} Stück verfügbar – reduziere die Stückzahl`
                : `Verfügbar: ${preview.available.toLocaleString('de-DE')} Stück${preview.fills && preview.fills.length > 1 ? ' (über mehrere Preisstufen)' : ''}`}
            </div>
          )}
        </>
      )}
      {type === 'limit' && !invalidTick && amt >= 1 && (
        <div className="priceline">
          <span className="muted">Escrow (worst case)</span>
          <b className="num">{fmtC(snapped * amt)} <span style={{ fontSize: 11, fontWeight: 600 }}>Credits</span></b>
        </div>
      )}
      {side === 'sell' && maxSell === 0 && (
        <div className="bandnote err">Du besitzt keine {sec.ticker}-Anteile.</div>
      )}

      <div style={{ height: 10 }} />
      <button className={`btn block xl ${side === 'buy' ? 'buy' : 'sell'}`} disabled={disabled} onClick={submit}>
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
    </div>
  );
}

// ---------------- Orderbuch (Terminal-Stil, mit kumulierter Tiefe) ----------------
function OrderBook({ book, sec }) {
  const bids = (book && book.bids) || [];
  const asks = (book && book.asks) || [];
  if (!bids.length && !asks.length) return <Empty>Orderbuch leer – keine offenen Orders.</Empty>;
  const maxQ = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]));
  const bestBid = bids.length ? bids[0][0] : null;
  const bestAsk = asks.length ? asks[0][0] : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  const Row = ({ p, q, cum, tone }) => (
    <div className="ob-row">
      <div className="fillbar" style={{ width: `${(q / maxQ) * 100}%`, background: tone === 'bid' ? 'var(--up)' : 'var(--down)' }} />
      <span className={`p num ${tone === 'bid' ? 'pos' : 'neg'}`}>{fmtC(p)}</span>
      <span className="q num">{q}</span>
      <span className="d num">Σ{cum}</span>
    </div>
  );

  let cum = 0;
  const askRows = [...asks].reverse().map(([p, q]) => { cum += q; return { p, q, cum }; });
  cum = 0;
  const bidRows = bids.map(([p, q]) => { cum += q; return { p, q, cum }; });

  return (
    <div>
      <div className="ob-row" style={{ color: 'var(--muted)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        <span>Preis</span><span style={{ textAlign: 'right' }}>Stück</span><span style={{ textAlign: 'right' }}>Tiefe</span>
      </div>
      {askRows.map((r, i) => <Row key={'a' + r.p + i} {...r} tone="ask" />)}
      <div className="ob-mid num">
        {spread != null
          ? <>Spread {fmtC(spread)} · Mitte {fmtC((bestBid + bestAsk) / 2)}</>
          : 'Spread –'}
      </div>
      {bidRows.map((r, i) => <Row key={'b' + r.p + i} {...r} tone="bid" />)}
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

// ---------------- Volumenprofil (gehandelte Stück je Preis-Level) ----------------
function VolumeProfile({ tape, mid }) {
  const levels = useMemo(() => {
    const m = new Map();
    for (const t of tape || []) m.set(t.price, (m.get(t.price) || 0) + t.amount);
    return [...m.entries()].sort((a, b) => b[0] - a[0]).slice(0, 12);
  }, [tape]);
  if (!levels.length) return <Empty>Noch keine Umsätze.</Empty>;
  const maxQ = Math.max(...levels.map((l) => l[1]));
  return (
    <div>
      {levels.map(([p, q]) => (
        <div className="volrow" key={p}>
          <span className={`px num ${p >= mid ? 'pos' : 'neg'}`}>{fmtC(p)}</span>
          <div className="barwrap">
            <div className="bar" style={{ width: `${(q / maxQ) * 100}%`, background: p >= mid ? 'var(--up)' : 'var(--down)', opacity: 0.75 }} />
          </div>
          <span className="qty num">{q}</span>
        </div>
      ))}
      <div className="muted small" style={{ marginTop: 6 }}>Grün = über Mitte gehandelt, rot = darunter (letzte {tape.length} Trades).</div>
    </div>
  );
}
