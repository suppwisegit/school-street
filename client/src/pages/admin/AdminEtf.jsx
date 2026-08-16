// Admin: ETF-Zentrale – Creation/Redemption-Arbitrage, Treasury-Depot & AP-Terminal.
// Eigenes Neo-Terminal-Design (etfx.css), bewusst ohne ui.jsx-Bausteine.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { credsToCent, fmtC, snapToTick, tickOf } from '../../api.js';
import '../../etfx.css';

const fmtI = (n) => (Number(n) || 0).toLocaleString('de-DE');
const clsSign = (v) => (v > 0 ? 'etfx-pos' : v < 0 ? 'etfx-neg' : '');

// Betrag (Cents) – optional farbig/signed
const Money = ({ c, colored = false, signed = false, big = false }) => {
  const v = Number(c) || 0;
  const cls = colored ? (v > 0 ? 'etfx-pos' : v < 0 ? 'etfx-neg' : '') : '';
  return <b className={`etfx-num ${cls} ${big ? 'etfx-big' : ''}`.trim()}>{signed && v > 0 ? '+' : ''}{fmtC(v)}</b>;
};

// Wert erst nach Ruhephase weiterreichen (Live-Vorschau beim Tippen)
function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Button mit Inline-Doppelklick-Bestätigung: 1. Klick rüstet, 2. Klick führt aus, 3 s Reset.
function ConfirmBtn({ label, armedLabel = 'Sicher? Erneut klicken', onConfirm, className = '', disabled = false, timeout = 3000 }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), timeout);
    return () => clearTimeout(t);
  }, [armed, timeout]);
  useEffect(() => { setArmed(false); }, [label]); // Kontext (z. B. Units) geändert -> neu bestätigen
  return (
    <button
      type="button"
      className={`etfx-btn ${className} ${armed ? 'armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

export default function AdminEtf({ A, toast }) {
  const [etfData, setEtfData] = useState(null); // {etfs, stocks, treasury_positions}
  const [allSecs, setAllSecs] = useState([]);
  const [etfId, setEtfId] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([A('/api/admin/etf'), A('/api/securities')]);
      setEtfData(e);
      setAllSecs(s.securities || []);
      setEtfId((cur) => cur || String(e.etfs?.[0]?.id || ''));
      setErr('');
    } catch (e2) { setErr(e2.message); }
  }, [A]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const etfs = etfData?.etfs || [];
  const etf = etfs.find((x) => String(x.id) === String(etfId)) || null;

  return (
    <div className="etfx-wrap">
      <header className="etfx-head">
        <div className="etfx-brand">
          <span className="etfx-logo" />
          <div>
            <h2>ETF &amp; AP Terminal</h2>
            <span className="etfx-sub">Authorized Participant · NAV-Arbitrage · Marktdata alle 20 s</span>
          </div>
        </div>
        {etfs.length > 0 && (
          <select className="etfx-select etfx-headsel" value={etfId} onChange={(e) => setEtfId(e.target.value)}>
            {etfs.map((e) => <option key={e.id} value={e.id}>{e.ticker} · {e.name}</option>)}
          </select>
        )}
        <a className="etfx-btn ghost sm" href="/board" target="_blank" rel="noreferrer">Board ↗</a>
      </header>

      {err && <div className="etfx-note err">{err}</div>}
      {!etfData && !err && <div className="etfx-loading"><i />Lade Marktdaten …</div>}
      {etfData && !etf && etfs.length === 0 && (
        <div className="etfx-note">Noch kein ETF vorhanden – unten einen neuen ETF anlegen.</div>
      )}

      {etf && <EtfStrip etf={etf} />}
      {etf && <ArbTool etf={etf} A={A} toast={toast} reload={load} />}

      {etfData && (
        <div className="etfx-split">
          {etf ? <BasketPanel etf={etf} treasury={etfData.treasury_positions || []} /> : <span />}
          <TreasuryPanel positions={etfData.treasury_positions || []} />
        </div>
      )}

      {etfData && (
        <div className="etfx-split">
          <ApTerminal A={A} toast={toast} allSecs={allSecs} reload={load} />
          <CreateFund A={A} toast={toast} stocks={etfData.stocks || []} reload={load} />
        </div>
      )}
    </div>
  );
}

// ---------------- Kurs vs. NAV (Kopfzeile) ----------------
function EtfStrip({ etf }) {
  const last = etf.ticker_data?.last ?? etf.last ?? 0;
  const nav = etf.nav_per_share || 0;
  const pct = Number(etf.premium_pct) || 0;
  const w = Math.min(Math.abs(pct), 10) / 10 * 50; // Balken skaliert bis ±10 %
  return (
    <div className="etfx-strip">
      <div className="etfx-stat"><span>ETF-Kurs</span><b className="etfx-num">{fmtC(last)}</b></div>
      <div className="etfx-stat"><span>NAV / Anteil</span><b className="etfx-num">{fmtC(nav)}</b></div>
      <div className="etfx-stat etfx-stat-prem">
        <span>
          Prämium / Discount{' '}
          <b className={`etfx-num ${clsSign(pct)}`}>{pct > 0 ? '+' : ''}{pct.toFixed(2)} %</b>
        </span>
        <div className="etfx-prembar">
          <i className="zero" />
          <i
            className={`fill ${pct >= 0 ? 'up' : 'down'}`}
            style={pct >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
          />
        </div>
      </div>
      <div className="etfx-stat"><span>Anteile im Umlauf</span><b className="etfx-num">{fmtI(etf.total_shares)}</b></div>
      <div className="etfx-stat"><span>Anteile / Unit</span><b className="etfx-num">{fmtI(etf.shares_per_unit)}</b></div>
    </div>
  );
}

// ---------------- Creation/Redemption mit Live-Vorschau ----------------
function ArbTool({ etf, A, toast, reload }) {
  const [unitsText, setUnitsText] = useState('1');
  const [preview, setPreview] = useState(null);
  const [perr, setPerr] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0); // erzwingt Vorschau-Refresh nach Ausführung
  const debounced = useDebounced(unitsText, 250);

  const raw = Number(debounced);
  const valid = debounced.trim() !== '' && raw >= 1;
  const units = Math.max(1, Math.floor(raw || 0));
  const shares = units * (etf.shares_per_unit || 1);
  const pct = Number(etf.premium_pct) || 0;

  // Auto-Vorschau: 250 ms nach letzter Eingabe bzw. bei neuen Kursen
  useEffect(() => {
    if (!valid) { setPreview(null); return; }
    let alive = true;
    setLoading(true); setPerr('');
    A(`/api/admin/etf/${etf.id}/preview`, { params: { units } })
      .then((r) => { if (alive) setPreview(r); })
      .catch((e) => { if (alive) { setPerr(e.message); setPreview(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [A, etf.id, units, valid, etf.last, etf.nav_per_share, etf.basket_value, nonce]);

  const step = (d) => setUnitsText(String(Math.max(1, Math.floor(Number(unitsText) || 0) + d)));

  const execute = async (kind) => {
    setBusy(true);
    try {
      const r = await A(`/api/admin/etf/${etf.id}/${kind === 'create' ? 'create-units' : 'redeem-units'}`, {
        method: 'POST',
        body: { units },
      });
      const sh = kind === 'create' ? r.shares_created : r.shares_redeemed;
      toast(
        kind === 'create'
          ? `Creation: ${fmtI(sh)} ETF-Anteile geschaffen (NAV ${fmtC(r.nav_per_share)})`
          : `Redemption: ${fmtI(sh)} ETF-Anteile vernichtet (NAV ${fmtC(r.nav_per_share)})`,
        'ok',
      );
      reload();
      setNonce((n) => n + 1);
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  const c = preview?.creation;
  const r = preview?.redemption;

  return (
    <section className="etfx-panel">
      <div className="etfx-panel-head">
        <h3>Creation / Redemption</h3>
        {loading
          ? <span className="etfx-live"><i />rechnet …</span>
          : (
            <span className="etfx-head-hint">
              {pct > 0 ? 'Prämium → Creation lohnt sich' : pct < 0 ? 'Discount → Redemption lohnt sich' : 'Kurs notiert am NAV'}
            </span>
          )}
      </div>

      <div className="etfx-units">
        <div className="etfx-stepper">
          <button type="button" onClick={() => step(-1)} disabled={units <= 1} aria-label="weniger Units">−</button>
          <input
            className="etfx-unitsinput" type="number" min="1" step="1" inputMode="numeric"
            value={unitsText} onChange={(e) => setUnitsText(e.target.value)} aria-label="Creation Units"
          />
          <button type="button" onClick={() => step(1)} aria-label="mehr Units">+</button>
        </div>
        <div className="etfx-quick">
          {[1, 5, 10].map((n) => (
            <button key={n} type="button" className={Number(unitsText) === n ? 'on' : ''} onClick={() => setUnitsText(String(n))}>{n}</button>
          ))}
        </div>
        <div className="etfx-unitseq">= <b className="etfx-num">{fmtI(shares)}</b> ETF-Anteile</div>
      </div>

      {perr && <div className="etfx-note err">{perr}</div>}
      {!valid && <div className="etfx-note">Anzahl Units (≥ 1) eingeben – die Vorschau rechnet automatisch mit.</div>}

      {valid && c && r && (
        <div className="etfx-arbgrid">
          <div className="etfx-side create">
            <div className="etfx-side-head">
              <h4>Creation</h4>
              {pct > 0 && <span className="etfx-tag green">empfohlen</span>}
            </div>
            <p className="etfx-side-sub">Korb kaufen → {fmtI(shares)} Anteile schaffen → am Markt verkaufen</p>
            <div className="etfx-kv"><span>Korb-Kauf</span><b className="etfx-num">− {fmtC(c.buy_basket_cost)}</b></div>
            <div className="etfx-kv"><span>ETF-Verkauf</span><b className="etfx-num">+ {fmtC(c.etf_sell_proceeds)}</b></div>
            <div className="etfx-profit"><span>geschätzter Profit</span><Money c={c.est_profit} colored signed big /></div>
            {c.basket_shortfalls?.length > 0 && (
              <div className="etfx-note warn">
                Treasury-Fehlbestand – erst im AP-Terminal nachkaufen:{' '}
                {c.basket_shortfalls.map((s) => `${s.ticker} ${fmtI(s.have)}/${fmtI(s.need)}`).join(', ')}
              </div>
            )}
            {c.etf_sell_shortfall > 0 && (
              <div className="etfx-note warn">Orderbuch zu dünn: {fmtI(c.etf_sell_shortfall)} ETF-Anteile bleiben unverkauft liegen.</div>
            )}
            <ConfirmBtn
              className="buy block" disabled={busy}
              label={`${fmtI(units)} Unit${units === 1 ? '' : 's'} erstellen`}
              onConfirm={() => execute('create')}
            />
          </div>

          <div className="etfx-side redeem">
            <div className="etfx-side-head">
              <h4>Redemption</h4>
              {pct < 0 && <span className="etfx-tag red">empfohlen</span>}
            </div>
            <p className="etfx-side-sub">ETF-Anteile zurückkaufen → einlösen → Korb verkaufen</p>
            <div className="etfx-kv"><span>ETF-Kauf</span><b className="etfx-num">− {fmtC(r.etf_buy_cost)}</b></div>
            <div className="etfx-kv"><span>Korb-Verkauf</span><b className="etfx-num">+ {fmtC(r.basket_sell_proceeds)}</b></div>
            <div className="etfx-profit"><span>geschätzter Profit</span><Money c={r.est_profit} colored signed big /></div>
            {r.etf_buy_shortfall > 0 && (
              <div className="etfx-note warn">Nicht genug ETF-Verkäufe im Buch: {fmtI(r.etf_buy_shortfall)} Anteile fehlen.</div>
            )}
            {r.basket_sell_shortfalls?.length > 0 && (
              <div className="etfx-note warn">
                Korb nur teils verkäuflich: {r.basket_sell_shortfalls.map((s) => s.ticker).join(', ')}.
              </div>
            )}
            <ConfirmBtn
              className="sell block" disabled={busy}
              label={`${fmtI(units)} Unit${units === 1 ? '' : 's'} einlösen`}
              onConfirm={() => execute('redeem')}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- Korb-Zusammensetzung ----------------
function BasketPanel({ etf, treasury }) {
  const have = useMemo(() => {
    const m = new Map();
    (treasury || []).forEach((p) => m.set(p.ticker, p.amount));
    return m;
  }, [treasury]);

  return (
    <section className="etfx-panel">
      <div className="etfx-panel-head">
        <h3>Korb · {etf.ticker}</h3>
        <span className="etfx-head-hint">Wert pro Unit <b className="etfx-num">{fmtC(etf.basket_value)}</b></span>
      </div>
      <table className="etfx-tbl">
        <thead>
          <tr><th>Aktie</th><th className="r">Stück/Unit</th><th className="r">Kurs</th><th className="r">Wert/Unit</th><th className="r">Treasury</th></tr>
        </thead>
        <tbody>
          {(etf.items || []).map((it) => {
            const dep = have.get(it.ticker) || 0;
            return (
              <tr key={it.ticker}>
                <td><b>{it.ticker}</b></td>
                <td className="r etfx-num">{fmtI(it.qty)}</td>
                <td className="r etfx-num">{fmtC(it.price)}</td>
                <td className="r etfx-num">{fmtC(it.value)}</td>
                <td className={`r etfx-num ${dep < it.qty ? 'etfx-neg' : 'etfx-muted'}`}>{fmtI(dep)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------- Treasury-Depot ----------------
function TreasuryPanel({ positions }) {
  return (
    <section className="etfx-panel">
      <div className="etfx-panel-head">
        <h3>Treasury-Depot</h3>
        <span className="etfx-head-hint">{positions.length} {positions.length === 1 ? 'Position' : 'Positionen'}</span>
      </div>
      {positions.length === 0
        ? <div className="etfx-empty">Leer. Über das AP-Terminal Korb-Aktien kaufen – ohne Bestand keine Creation.</div>
        : (
          <div className="etfx-chips">
            {positions.map((p, i) => (
              <span className="etfx-chip" key={i}><b>{p.ticker}</b><span className="etfx-num">{fmtI(p.amount)}</span></span>
            ))}
          </div>
        )}
    </section>
  );
}

// ---------------- AP-Handelsterminal ----------------
function ApTerminal({ A, toast, allSecs, reload }) {
  const [orders, setOrders] = useState([]);
  const [secId, setSecId] = useState('');
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const loadOrders = useCallback(async () => {
    try { const r = await A('/api/admin/treasury/orders'); setOrders(r.orders || []); } catch { /* ignoriert */ }
  }, [A]);
  useEffect(() => { loadOrders(); const t = setInterval(loadOrders, 10000); return () => clearInterval(t); }, [loadOrders]);

  const sec = allSecs.find((s) => String(s.id) === String(secId));
  const amt = Math.floor(Number(amount) || 0);
  const cents = credsToCent(price);

  const submit = async () => {
    setErr('');
    if (!secId) return setErr('Wertpapier wählen');
    if (amt < 1) return setErr('Ungültige Stückzahl');
    const body = { security_id: Number(secId), side, type, amount: amt };
    if (type === 'limit') {
      if (cents <= 0) return setErr('Limit-Preis fehlt');
      body.price = snapToTick(cents, sec?.type);
    }
    setBusy(true);
    try {
      const res = await A('/api/admin/treasury/order', { method: 'POST', body });
      const trades = res.trades || [];
      toast(trades.length ? `Treasury: ${fmtI(trades.reduce((a, t) => a + t.amount, 0))} Stück gehandelt` : 'Treasury-Order im Buch', 'ok');
      setAmount('');
      loadOrders();
      reload();
    } catch (e) {
      setErr(e.message);
      toast('' + e.message, 'err');
    } finally { setBusy(false); }
  };

  const cancel = async (o) => {
    try {
      await A(`/api/admin/treasury/cancel/${o.id}`, { method: 'POST' });
      toast('Treasury-Order storniert', 'ok');
      loadOrders();
      reload();
    } catch (e) { toast('' + e.message, 'err'); }
  };

  return (
    <section className="etfx-panel">
      <div className="etfx-panel-head">
        <h3>AP-Handelsterminal</h3>
        <span className="etfx-head-hint">Staatskasse handelt am Markt</span>
      </div>

      <div className="etfx-apform">
        <select className="etfx-select grow" value={secId} onChange={(e) => setSecId(e.target.value)}>
          <option value="">Wertpapier …</option>
          {allSecs.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}{s.type === 'etf' ? ' (ETF)' : ''}</option>)}
        </select>
        <div className={`etfx-seg ${side === 'buy' ? 'seg-buy' : 'seg-sell'}`}>
          <button type="button" className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Kaufen</button>
          <button type="button" className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Verkaufen</button>
        </div>
        <div className="etfx-seg">
          <button type="button" className={type === 'limit' ? 'on' : ''} onClick={() => setType('limit')}>Limit</button>
          <button type="button" className={type === 'market' ? 'on' : ''} onClick={() => setType('market')}>Market</button>
        </div>
        <input
          className="etfx-input num amt" type="number" min="1" step="1" placeholder="Stück"
          value={amount} onChange={(e) => setAmount(e.target.value)}
        />
        {type === 'limit' && (
          <input
            className="etfx-input num px" type="number" min="0" step="0.1"
            placeholder={sec ? `Limit · Tick ${(tickOf(sec.type) / 100).toFixed(2)}` : 'Limit'}
            value={price} onChange={(e) => setPrice(e.target.value)}
          />
        )}
        <button type="button" className={`etfx-btn ${side === 'buy' ? 'buy' : 'sell'}`} disabled={busy} onClick={submit}>
          {busy ? '…' : side === 'buy' ? 'Kaufen' : 'Verkaufen'}
        </button>
      </div>
      {err && <div className="etfx-note err">{err}</div>}

      <div className="etfx-subhead">Offene Orders ({orders.length})</div>
      {orders.length === 0
        ? <div className="etfx-empty">Keine offenen Treasury-Orders.</div>
        : orders.map((o) => (
          <div className="etfx-ordrow" key={o.id}>
            <span>
              <b>{o.ticker}</b>{' '}
              <b className={o.side === 'buy' ? 'etfx-pos' : 'etfx-neg'}>{o.side === 'buy' ? 'Kauf' : 'Verkauf'}</b>{' '}
              <span className="etfx-muted etfx-num">{fmtI(o.filled)}/{fmtI(o.amount)} {o.type === 'limit' ? '@ ' + fmtC(o.price) : 'Market'}</span>
            </span>
            <button type="button" className="etfx-btn sm ghost danger" onClick={() => cancel(o)}>Storno</button>
          </div>
        ))}
    </section>
  );
}

// ---------------- Neuen ETF anlegen ----------------
function CreateFund({ A, toast, stocks, reload }) {
  const [open, setOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  const [spu, setSpu] = useState('10');
  const [units, setUnits] = useState('5');
  const [basket, setBasket] = useState([{ stock_id: '', qty: '' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = basket.map((b) => ({
    ...b,
    qtyN: Math.floor(Number(b.qty) || 0),
  }));

  // Live-Inline-Validierung
  const problems = [];
  if (!/^[A-Z]{3,6}$/.test(ticker.trim())) problems.push('Ticker: 3–6 Großbuchstaben');
  if (!(Number(spu) >= 1)) problems.push('Anteile pro Unit ≥ 1');
  if (!(Number(units) >= 1)) problems.push('Initiale Units ≥ 1');
  if (!rows.some((x) => x.stock_id && x.qtyN > 0)) problems.push('Korb: mind. eine Aktie mit Stückzahl');
  const started = ticker.trim() !== '' || name.trim() !== '' || rows.some((x) => x.stock_id || x.qty);

  const needLine = rows
    .filter((x) => x.stock_id && x.qtyN > 0)
    .map((x) => {
      const s = stocks.find((y) => String(y.id) === String(x.stock_id));
      return s ? `${s.ticker} ${fmtI(x.qtyN * Math.floor(Number(units) || 0))}` : null;
    })
    .filter(Boolean)
    .join(', ');

  const submit = async () => {
    if (problems.length) return;
    const tick = ticker.trim().toUpperCase();
    setErr('');
    setBusy(true);
    try {
      await A('/api/admin/etf/create-fund', {
        method: 'POST',
        body: {
          ticker: tick,
          name: name.trim() || tick,
          shares_per_unit: Number(spu),
          initial_units: Number(units),
          basket: rows.filter((x) => x.stock_id && x.qtyN > 0).map((x) => ({ stock_id: Number(x.stock_id), qty: x.qtyN })),
        },
      });
      toast(`ETF ${tick} gestartet`, 'ok');
      setTicker(''); setName(''); setSpu('10'); setUnits('5'); setBasket([{ stock_id: '', qty: '' }]);
      setOpen(false);
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="etfx-panel">
      <button type="button" className="etfx-foldbtn" onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'} Neuen ETF anlegen</span>
        {!open && <span className="etfx-head-hint">Ticker · Korb · Start-Units</span>}
      </button>

      {open && (
        <>
          <div className="etfx-note">Der Treasury braucht die Korb-Aktien für alle initialen Units <b>vorher</b> im Depot (AP-Terminal).</div>
          {needLine && <div className="etfx-note">Benötigt im Treasury-Depot: <b className="etfx-num">{needLine}</b> Stück</div>}
          {started && problems.length > 0 && <div className="etfx-note warn">{problems.join(' · ')}</div>}
          {err && <div className="etfx-note err">{err}</div>}

          <div className="etfx-frow">
            <label className="etfx-field">
              <span>Ticker</span>
              <input className="etfx-input" value={ticker} placeholder="z. B. PIZZA" onChange={(e) => setTicker(e.target.value.toUpperCase())} />
            </label>
            <label className="etfx-field">
              <span>Name</span>
              <input className="etfx-input" value={name} placeholder="z. B. Schul-Indexfonds" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="etfx-field">
              <span>Anteile / Unit</span>
              <input className="etfx-input num" type="number" min="1" step="1" value={spu} onChange={(e) => setSpu(e.target.value)} />
            </label>
            <label className="etfx-field">
              <span>Initiale Units</span>
              <input className="etfx-input num" type="number" min="1" step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
            </label>
          </div>

          <div className="etfx-subhead">Korb</div>
          {rows.map((row, i) => (
            <div className="etfx-brow" key={i}>
              <select
                className="etfx-select" value={row.stock_id}
                onChange={(e) => setBasket((b) => b.map((x, j) => (j === i ? { ...x, stock_id: e.target.value } : x)))}
              >
                <option value="">Aktie …</option>
                {stocks.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}</option>)}
              </select>
              <input
                className="etfx-input num" type="number" min="1" step="1" placeholder="Stück/Unit" value={row.qty}
                onChange={(e) => setBasket((b) => b.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
              />
              <button
                type="button" className="etfx-btn sm ghost danger" aria-label="Zeile entfernen" disabled={basket.length <= 1}
                onClick={() => setBasket((b) => b.filter((_, j) => j !== i))}
              >×</button>
            </div>
          ))}
          <button type="button" className="etfx-btn sm ghost" onClick={() => setBasket((b) => [...b, { stock_id: '', qty: '' }])}>+ Zeile</button>
          <div className="etfx-submit">
            <ConfirmBtn
              className="primary block" disabled={busy || problems.length > 0}
              label="ETF erstellen" armedLabel="Anlegen? Erneut klicken" onConfirm={submit}
            />
          </div>
        </>
      )}
    </section>
  );
}
