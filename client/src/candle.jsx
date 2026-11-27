// candle.jsx — Kerzenchart auf Basis von TradingView Lightweight-Charts (MIT).
// Eigene Datei, damit die Bibliothek nur geladen wird, wenn ein Wert geöffnet
// wird. Preise sind INTEGER-CENTS; Farben kommen aus den Design-Tokens.
import React, { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

let palette = null;
function pal() {
  if (palette) return palette;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fb) => (css.getPropertyValue(name) || '').trim() || fb;
  palette = { up: v('--ss-up', '#3ee08a'), down: v('--ss-down', '#ff6b7a'), text: v('--ss-text-3', '#8f999e'), line: v('--ss-line', '#394146') };
  return palette;
}
function rgba(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(128,128,128,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const toBar = (c) => ({
  time: Math.floor(c.t / 1000),
  open: c.o / 100,
  high: c.h / 100,
  low: c.l / 100,
  close: c.c / 100,
});

export function CandleChart({ candles }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volRef = useRef(null);
  const firstTime = useRef(null);

  // Chart einmalig erzeugen
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const p = pal();
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: p.text,
        fontFamily: "'Archivo Variable', 'Instrument Sans', system-ui, sans-serif",
        fontSize: 12,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderColor: p.line, scaleMargins: { top: 0.2, bottom: 0.2 } },
      timeScale: { borderColor: p.line, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.35)', width: 1, style: 3, labelBackgroundColor: p.line },
        horzLine: { color: 'rgba(255,255,255,0.35)', width: 1, style: 3, labelBackgroundColor: p.line },
      },
      localization: { locale: 'de-DE', priceFormatter: (x) => x.toFixed(2) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const price = chart.addCandlestickSeries({
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const vol = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chartRef.current = chart;
    priceRef.current = price;
    volRef.current = vol;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  // Daten-Updates: Neu einpassen nur beim ersten Mal und beim Wechsel des Zeitraums —
  // sonst springt der Chart zurück, während jemand hineinzoomt.
  useEffect(() => {
    const price = priceRef.current;
    const vol = volRef.current;
    if (!price || !vol) return;
    const data = (candles || []).slice().sort((a, b) => a.t - b.t);
    if (!data.length) {
      price.setData([]);
      vol.setData([]);
      return;
    }
    price.setData(data.map(toBar));
    vol.setData(data.map((c) => ({ time: Math.floor(c.t / 1000), value: c.v || 0, color: rgba(c.c >= c.o ? pal().up : pal().down, 0.3) })));
    const rangeChanged = data[0].t !== firstTime.current;
    if (rangeChanged) chartRef.current?.timeScale().fitContent();
    firstTime.current = data[0].t;
  }, [candles]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
      {!(candles && candles.length) && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: pal().text, fontSize: 14, fontWeight: 600 }}>
          Noch keine Kurse — die ersten Trades kommen.
        </div>
      )}
    </div>
  );
}
