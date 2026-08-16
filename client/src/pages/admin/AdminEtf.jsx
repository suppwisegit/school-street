// Admin: ETF-Zentrale (Herzstück) – NAV-Arbitrage via Creation/Redemption + AP-Terminal.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { credsToCent, fmtC, snapToTick, tickOf } from '../../api.js';
import { Card, Chip, ConfirmModal, Empty, ErrorBox, Field, Loading, Money, Pct, Tabs, useToast } from '../../ui.jsx';

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

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!etfData) return <Loading />;

  const etf = etfData.etfs?.find((x) => String(x.id) === String(etfId)) || null;

  return (
    <div className="col" style={{ gap: 14 }}>
      <Card title="ETF wählen">
        <div className="inputpair">
          <select className="select" value={etfId} onChange={(e) => setEtfId(e.target.value)}>
            {(etfData.etfs || []).length === 0 && <option value="">Noch kein ETF vorhanden</option>}
            {(etfData.etfs || []).map((e) => <option key={e.id} value={e.id}>{e.ticker} · {e.name}</option>)}
          </select>
          <a className="btn ghost" href="/board" target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>Board ansehen</a>
        </div>
      </Card>

      {etf && <EtfPanels etf={etf} A={A} toast={toast} reload={load} />}
      <TreasuryPositions positions={etfData.treasury_positions || []} />
      <ApTerminal A={A} toast={toast} allSecs={allSecs} />
      <CreateFund A={A} toast={toast} stocks={etfData.stocks || []} reload={load} />
    </div>
  );
}

// ---------------- Kurs vs NAV + Creation/Redemption ----------------
function EtfPanels({ etf, A, toast, reload }) {
  const [units, setUnits] = useState('1');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'create' | 'redeem'
  const [perr, setPerr] = useState('');

  const last = etf.ticker_data?.last ?? etf.last ?? 0;
  const nav = etf.nav_per_share || 0;
  const pct = etf.premium_pct || 0;
  const width = Math.min(Math.abs(pct), 10) / 10 * 50;

  const runPreview = async () => {
    const u = Math.max(1, Math.floor(Number(units) || 1));
    setBusy(true); setPerr('');
    try {
      const r = await A(`/api/admin/etf/${etf.id}/preview`, { params: { units: u } });
      setPreview(r);
    } catch (e) { setPerr(e.message); setPreview(null); }
    finally { setBusy(false); }
  };

  const execute = async () => {
    const kind = confirm;
    const u = Math.max(1, Math.floor(Number(units) || 1));
    setConfirm(null);
    setBusy(true);
    try {
      const r = await A(`/api/admin/etf/${etf.id}/${kind === 'create' ? 'create-units' : 'redeem-units'}`, { method: 'POST', body: { units: u } });
      toast(kind === 'create' ? `Creation: ${r.shares_created} ETF-Anteile geschaffen` : `Redemption: ${r.shares_redeemed} ETF-Anteile vernichtet`, 'ok');
      setPreview(null);
      reload();
    } catch (e) { toast('' + e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Card title={`${etf.ticker} – Kurs vs. NAV`}>
        <div className="statgrid">
          <div className="stat">
            <div className="lbl">ETF-Kurs</div>
            <div className="val num">{fmtC(last)}</div>
          </div>
          <div className="stat">
            <div className="lbl">NAV je Anteil</div>
            <div className="val num">{fmtC(nav)}</div>
          </div>
        </div>
        <div className="center row" style={{ justifyContent: 'center', gap: 8, marginTop: 8 }}>
          <span className="muted small">Prämium/Discount</span>
          <Pct v={pct} />
        </div>
        <div className="prembar">
          <div className="mid" />
          <div className="fill" style={{ left: pct >= 0 ? '50%' : `${50 - width}%`, width: `${width}%`, background: pct >= 0 ? 'var(--green)' : 'var(--red)' }} />
        </div>
        <div className="small muted center">{etf.shares_per_unit} ETF-Anteile pro Creation Unit · {(etf.total_shares || 0).toLocaleString('de-DE')} Anteile im Umlauf</div>

        <div className="divider" />
        <h3 style={{ margin: 0 }}>Korb-Zusammensetzung</h3>
        <table className="tbl">
          <thead><tr><th>Aktie</th><th className="r">Stück/Unit</th><th className="r">Kurs</th><th className="r">Wert/Unit</th></tr></thead>
          <tbody>
            {(etf.items || []).map((it) => (
              <tr key={it.stock_id}>
                <td><b>{it.ticker}</b> <span className="muted small">{it.name}</span></td>
                <td className="r num">{it.qty}</td>
                <td className="r num">{fmtC(it.price)}</td>
                <td className="r num">{fmtC(it.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row between small muted" style={{ marginTop: 6 }}>
          <span>Korb-Gesamtwert (pro Creation Unit)</span><Money c={etf.basket_value} />
        </div>
      </Card>

      <Card title="Arbitrage-Werkzeug (Authorized Participant)">
        <div className="hintbox">
          <b>So funktioniert Arbitrage:</b><br />
          Creation = Korb-Aktien kaufen → ETF-Anteile schaffen → teuer verkaufen → drückt den Kurs auf NAV (bei Prämium).<br />
          Redemption = ETF-Anteile billig zurückkaufen → vernichten → Korb-Aktien verkaufen → hebt den Kurs zum NAV (bei Discount).
        </div>
        <div className="inputpair" style={{ marginTop: 10 }}>
          <Field label="Anzahl Creation Units" help={`= ${((Number(units) || 0) * etf.shares_per_unit).toLocaleString('de-DE')} ETF-Anteile`}>
            <input className="input num" type="number" min="1" step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
          </Field>
          <button className="btn primary" style={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }} disabled={busy} onClick={runPreview}>Vorschau</button>
        </div>
        <ErrorBox>{perr}</ErrorBox>

        {preview && (
          <div className="previewgrid" style={{ marginTop: 6 }}>
            <div className="previewpanel" style={{ borderColor: 'rgba(34,197,94,0.45)' }}>
              <h4>Creation <span className="muted small">(bei Prämium: Kurs &gt; NAV)</span></h4>
              <div className="kv"><span className="muted">Korb-Kaufkosten</span><b className="num">{fmtC(preview.creation.buy_basket_cost)}</b></div>
              <div className="kv"><span className="muted">ETF-Verkaufserlös</span><b className="num">{fmtC(preview.creation.etf_sell_proceeds)}</b></div>
              <div className="kv"><span className="muted">geschätzter Profit</span><Money c={preview.creation.est_profit} colored signed /></div>
              {preview.creation.etf_sell_shortfall > 0 && <div className="warnbox" style={{ marginTop: 8 }}>Orderbuch zu dünn: {preview.creation.etf_sell_shortfall} ETF-Anteile bleiben unverkauft liegen.</div>}
              {preview.creation.basket_shortfalls?.length > 0 && (
                <div className="warnbox" style={{ marginTop: 8 }}>
                  Treasury muss erst Korb-Aktien nachkaufen:{' '}
                  {preview.creation.basket_shortfalls.map((s) => `${s.ticker} (${s.have}/${s.need})`).join(', ')} – über das AP-Terminal unten.
                </div>
              )}
              <button className="btn buy block" style={{ marginTop: 10 }} onClick={() => setConfirm('create')}>Creation durchführen</button>
            </div>
            <div className="previewpanel" style={{ borderColor: 'rgba(239,68,68,0.45)' }}>
              <h4>Redemption <span className="muted small">(bei Discount: Kurs &lt; NAV)</span></h4>
              <div className="kv"><span className="muted">ETF-Rückkaufkosten</span><b className="num">{fmtC(preview.redemption.etf_buy_cost)}</b></div>
              <div className="kv"><span className="muted">Korb-Verkaufserlös</span><b className="num">{fmtC(preview.redemption.basket_sell_proceeds)}</b></div>
              <div className="kv"><span className="muted">geschätzter Profit</span><Money c={preview.redemption.est_profit} colored signed /></div>
              {preview.redemption.etf_buy_shortfall > 0 && <div className="warnbox" style={{ marginTop: 8 }}>Nicht genug ETF-Verkäufe im Buch: {preview.redemption.etf_buy_shortfall} Anteile fehlen.</div>}
              {preview.redemption.basket_sell_shortfalls?.length > 0 && (
                <div className="warnbox" style={{ marginTop: 8 }}>Korb-Aktien lassen sich nur teils verkaufen: {preview.redemption.basket_sell_shortfalls.map((s) => s.ticker).join(', ')}.</div>
              )}
              <button className="btn sell block" style={{ marginTop: 10 }} onClick={() => setConfirm('redeem')}>Redemption durchführen</button>
            </div>
          </div>
        )}

        {confirm && (
          <ConfirmModal
            title={confirm === 'create' ? 'Creation bestätigen' : 'Redemption bestätigen'}
            confirmLabel={confirm === 'create' ? 'Creation durchführen' : 'Redemption durchführen'}
            onClose={() => setConfirm(null)}
            onConfirm={execute}
          >
            {confirm === 'create'
              ? <>Es werden <b className="num">{Math.max(1, Math.floor(Number(units) || 1))}</b> Creation Units (= <b className="num">{Math.max(1, Math.floor(Number(units) || 1)) * etf.shares_per_unit}</b> ETF-Anteile) aus Treasury-Korb-Aktien geschaffen. Die neuen Anteile landen im Treasury-Depot.</>
              : <>Es werden <b className="num">{Math.max(1, Math.floor(Number(units) || 1))}</b> Creation Units (= <b className="num">{Math.max(1, Math.floor(Number(units) || 1)) * etf.shares_per_unit}</b> ETF-Anteile) vernichtet. Die Korb-Aktien landen im Treasury-Depot.</>}
          </ConfirmModal>
        )}
      </Card>
    </>
  );
}

// ---------------- Treasury-Positionen ----------------
function TreasuryPositions({ positions }) {
  return (
    <Card title="Treasury-Depot (Korb-Aktien für Creations)">
      {positions.length === 0 ? (
        <Empty>Noch keine Positionen – über das AP-Terminal Korb-Aktien kaufen, sonst ist keine Creation möglich.</Empty>
      ) : (
        <div className="badges">
          {positions.map((p, i) => <Chip key={i} blue>{p.ticker}: {p.amount.toLocaleString('de-DE')} Stück</Chip>)}
        </div>
      )}
    </Card>
  );
}

// ---------------- AP-Handelsterminal ----------------
function ApTerminal({ A, toast, allSecs }) {
  const [orders, setOrders] = useState([]);
  const [secId, setSecId] = useState('');
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await A('/api/admin/treasury/orders'); setOrders(r.orders || []); } catch {}
  }, [A]);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

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
      const r = await A('/api/admin/treasury/order', { method: 'POST', body });
      const trades = r.trades || [];
      toast(trades.length ? `Treasury: ${trades.reduce((a, t) => a + t.amount, 0)} Stück gehandelt` : 'Treasury-Order im Buch', 'ok');
      setAmount('');
      load();
    } catch (e) {
      setErr(e.message);
      toast('' + e.message, 'err');
    } finally { setBusy(false); }
  };

  const cancel = async (o) => {
    try {
      await A(`/api/admin/treasury/cancel/${o.id}`, { method: 'POST' });
      toast('Treasury-Order storniert', 'ok');
      load();
    } catch (e) { toast('' + e.message, 'err'); }
  };

  return (
    <Card title="AP-Handelsterminal (Staatskasse handelt als Marktteilnehmer)">
      <Field label="Wertpapier">
        <select className="select" value={secId} onChange={(e) => setSecId(e.target.value)}>
          <option value="">– wählen –</option>
          {allSecs.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}{s.type === 'etf' ? ' (ETF)' : ''}</option>)}
        </select>
      </Field>
      <div className="inputpair" style={{ marginTop: 4 }}>
        <Tabs value={side} onChange={(v) => setSide(v)} className={side === 'buy' ? 'tabs-buy' : 'tabs-sell'}
          tabs={[{ value: 'buy', label: 'KAUFEN', cls: 'buytab' }, { value: 'sell', label: 'VERKAUFEN', cls: 'selltab' }]} />
        <Tabs value={type} onChange={setType} tabs={[{ value: 'limit', label: 'Limit' }, { value: 'market', label: 'Market' }]} />
      </div>
      <div style={{ height: 10 }} />
      <div className="inputpair">
        <Field label="Stückzahl">
          <input className="input num" type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {type === 'limit' && (
          <Field label={`Limit (Credits)${sec ? ` · Tick ${(tickOf(sec.type) / 100).toFixed(2)}` : ''}`}>
            <input className="input num" type="number" min="0" step="0.1" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        )}
      </div>
      <ErrorBox>{err}</ErrorBox>
      <button className={`btn block xl ${side === 'buy' ? 'buy' : 'sell'}`} disabled={busy} onClick={submit}>
        {busy ? '…' : `${side === 'buy' ? 'Für Treasury kaufen' : 'Für Treasury verkaufen'}`}
      </button>

      <div className="divider" />
      <h3 style={{ margin: 0 }}>Offene Treasury-Orders ({orders.length})</h3>
      {orders.length === 0 ? <Empty>Keine offenen Orders.</Empty> : orders.map((o) => (
        <div className="row between" key={o.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(31,39,64,0.5)' }}>
          <span className="small">
            <b>{o.ticker}</b> <span className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side === 'buy' ? 'Kauf' : 'Verkauf'}</span>{' '}
            <span className="muted num">{o.filled}/{o.amount} {o.type === 'limit' ? '@ ' + fmtC(o.price) : 'Market'}</span>
          </span>
          <button className="btn sm danger" onClick={() => cancel(o)}>Storno</button>
        </div>
      ))}
    </Card>
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

  const totalNeeded = useMemo(() => basket.reduce((a, b) => a + (Number(b.qty) || 0) * (Number(units) || 0), 0), [basket, units]);

  const submit = async () => {
    setErr('');
    const tick = ticker.trim().toUpperCase();
    if (!/^[A-Z]{3,6}$/.test(tick)) return setErr('Ticker: 3–6 Buchstaben');
    if (!(Number(spu) >= 1)) return setErr('Multiplikator (ETF-Anteile pro Unit) ≥ 1');
    if (!(Number(units) >= 1)) return setErr('Initiale Units ≥ 1');
    const b = basket.filter((x) => x.stock_id && Number(x.qty) > 0).map((x) => ({ stock_id: Number(x.stock_id), qty: Number(x.qty) }));
    if (!b.length) return setErr('Korb ist leer – mind. eine Aktie mit Stückzahl');
    if (!window.confirm(`ETF ${tick} anlegen?\nDer Treasury muss die Korb-Aktien für ${units} Creation Units bereits im Depot haben (AP-Terminal!).`)) return;
    setBusy(true);
    try {
      await A('/api/admin/etf/create-fund', { method: 'POST', body: { ticker: tick, name: name.trim() || tick, shares_per_unit: Number(spu), initial_units: Number(units), basket: b } });
      toast(`ETF ${tick} gestartet`, 'ok');
      setTicker(''); setName(''); setBasket([{ stock_id: '', qty: '' }]);
      setOpen(false);
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <details className="fold" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>Neuen ETF anlegen</summary>
      <div className="hintbox" style={{ marginBottom: 12 }}>
        Die Staatskasse braucht die Korb-Aktien für die initialen Creation Units <b>vor</b> dem Anlegen im Depot
        (über das AP-Handelsterminal kaufen). Andernfalls schlägt die Erstellung fehl.
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div className="inputpair">
        <Field label="Ticker (3–6 Großbuchstaben)">
          <input className="input" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="z.B. PIZZA" />
        </Field>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. Schul-Indexfonds" />
        </Field>
      </div>
      <div className="inputpair">
        <Field label="ETF-Anteile pro Unit (Multiplikator)" help="Klein = feine Steuerung des ETF-Kurses">
          <input className="input num" type="number" min="1" step="1" value={spu} onChange={(e) => setSpu(e.target.value)} />
        </Field>
        <Field label="Initiale Creation Units" help={`Benötigt insgesamt ${totalNeeded.toLocaleString('de-DE')} Korb-Aktien im Treasury-Depot`}>
          <input className="input num" type="number" min="1" step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
        </Field>
      </div>
      <h3 style={{ margin: '8px 0' }}>Korb</h3>
      {basket.map((row, i) => (
        <div className="basketrow" key={i}>
          <select className="select" value={row.stock_id} onChange={(e) => setBasket((b) => b.map((x, j) => (j === i ? { ...x, stock_id: e.target.value } : x)))}>
            <option value="">– Aktie wählen –</option>
            {stocks.map((s) => <option key={s.id} value={s.id}>{s.ticker} · {s.name}</option>)}
          </select>
          <input className="input num" type="number" min="1" step="1" placeholder="Stück/Unit" value={row.qty}
            onChange={(e) => setBasket((b) => b.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
          <button className="btn sm danger" disabled={basket.length <= 1} onClick={() => setBasket((b) => b.filter((_, j) => j !== i))}><IconX size={14} stroke={2} /></button>
        </div>
      ))}
      <button className="btn sm ghost" onClick={() => setBasket((b) => [...b, { stock_id: '', qty: '' }])}>+ Zeile</button>
      <div style={{ height: 12 }} />
      <button className="btn primary block" disabled={busy} onClick={submit}>{busy ? '…' : 'ETF erstellen'}</button>
    </details>
  );
}
