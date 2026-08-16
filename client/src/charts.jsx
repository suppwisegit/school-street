// Charts: CandleChart auf Basis von TradingView Lightweight-Charts (MIT),
// Sparkline + LineChart (Canvas) für Mini-/Board-Anzeigen.
// Alle Preise sind INTEGER-CENTS.
import React, { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';
import { fmtC } from './api.js';

const GREEN = '#00d68f';
const RED = '#ff6459';
const GRID = 'rgba(125, 138, 166, 0.10)';
const LABEL = '#7d8aa6';

// ---------------- Candle-Chart (Lightweight-Charts) ----------------
export function CandleChart({ candles }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volRef = useRef(null);

  // Chart einmalig erzeugen
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: LABEL,
        fontFamily: "'Archivo Variable', 'Instrument Sans', sans-serif",
        fontSize: 11,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: 'rgba(30, 42, 65, 0.9)' },
      timeScale: { borderColor: 'rgba(30, 42, 65, 0.9)', timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: {
        vertLine: { color: 'rgba(124, 92, 255, 0.55)', width: 1, style: 3, labelBackgroundColor: '#2e4064' },
        horzLine: { color: 'rgba(124, 92, 255, 0.55)', width: 1, style: 3, labelBackgroundColor: '#2e4064' },
      },
      localization: {
        locale: 'de-DE',
        priceFormatter: (p) => p.toFixed(2),
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const price = chart.addCandlestickSeries({
      upColor: GREEN,
      downColor: RED,
      borderVisible: false,
      wickUpColor: GREEN,
      wickDownColor: RED,
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

  // Daten-Updates
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
    price.setData(data.map((c) => ({
      time: Math.floor(c.t / 1000),
      open: c.o / 100,
      high: c.h / 100,
      low: c.l / 100,
      close: c.c / 100,
    })));
    vol.setData(data.map((c) => ({
      time: Math.floor(c.t / 1000),
      value: c.v || 0,
      color: c.c >= c.o ? 'rgba(0, 214, 143, 0.28)' : 'rgba(255, 100, 89, 0.28)',
    })));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
      {!(candles && candles.length) && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: LABEL, fontSize: 13, fontWeight: 600 }}>
          Noch keine Kursdaten – warten auf die ersten Trades
        </div>
      )}
    </div>
  );
}

// Zeichnet bei Größenänderung neu; stellt devicePixelRatio-Schärfung bereit.
function useCanvasDraw(draw) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 150;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      try { draw(ctx, w, h); } catch {}
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    return () => ro.disconnect();
  });
  return ref;
}

function niceTime(ts, span) {
  const d = new Date(ts);
  if (span > 2 * 86400000) return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// ---------------- Linien-Chart (z.B. Board-Index) ----------------
export function LineChart({ points, showLabels = true }) {
  const data = (points || []).filter((p) => p && isFinite(p.v));
  const ref = useCanvasDraw((ctx, w, h) => {
    if (data.length < 2) {
      ctx.fillStyle = LABEL;
      ctx.font = '600 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Index-Historie wird aufgebaut …', w / 2, h / 2);
      return;
    }
    const padR = showLabels ? 74 : 10, padT = 6, padB = 6, padL = 4;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    let min = Infinity, max = -Infinity;
    for (const p of data) { min = Math.min(min, p.v); max = Math.max(max, p.v); }
    if (min === max) { min -= 1; max += 1; }
    const up = data[data.length - 1].v >= data[0].v;
    const col = up ? GREEN : RED;
    const x = (i) => padL + (plotW * i) / (data.length - 1);
    const y = (v) => padT + plotH * (1 - (v - min) / (max - min));

    // Fläche
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, up ? 'rgba(0,214,143,0.26)' : 'rgba(255,100,89,0.26)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.moveTo(x(0), padT + plotH);
    for (let i = 0; i < data.length; i++) ctx.lineTo(x(i), y(data[i].v));
    ctx.lineTo(x(data.length - 1), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Linie
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) { if (i === 0) ctx.moveTo(x(i), y(data[i].v)); else ctx.lineTo(x(i), y(data[i].v)); }
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Endpunkt
    ctx.beginPath();
    ctx.arc(x(data.length - 1), y(data[data.length - 1].v), 4, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    if (showLabels) {
      ctx.font = '700 12px sans-serif';
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(max)), padL + plotW + 8, padT + 12);
      ctx.fillText(String(Math.round(min)), padL + plotW + 8, padT + plotH);
      ctx.fillStyle = col;
      ctx.font = '800 13px sans-serif';
      ctx.fillText(String(Math.round(data[data.length - 1].v)), padL + plotW + 8, y(data[data.length - 1].v) + 4);
    }
  });
  return <canvas ref={ref} />;
}

// ---------------- Sparkline (Positions-/Marktliste) ----------------
export function Sparkline({ values, w = 76, h = 30, fill = true }) {
  const data = (values || []).filter((v) => isFinite(v));
  const ref = useCanvasDraw((ctx) => {
    if (data.length < 2) return;
    let min = Infinity, max = -Infinity;
    for (const v of data) { min = Math.min(min, v); max = Math.max(max, v); }
    if (min === max) { min -= 1; max += 1; }
    const up = data[data.length - 1] >= data[0];
    const col = up ? GREEN : RED;
    const x = (i) => (w * i) / (data.length - 1);
    const y = (v) => 3 + (h - 6) * (1 - (v - min) / (max - min));

    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, up ? 'rgba(0,214,143,0.25)' : 'rgba(255,100,89,0.25)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(0, h);
      data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    data.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Endpunkt
    ctx.beginPath();
    ctx.arc(x(data.length - 1), y(data[data.length - 1]), 2.2, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  });
  return <canvas ref={ref} style={{ width: w, height: h, display: 'block' }} />;
}
