// charts.jsx — Sparkline und Linienchart auf Canvas 2D (ohne Bibliothek).
// Das Kerzenchart liegt in candle.jsx. Preise sind INTEGER-CENTS; Farben kommen
// aus den Design-Tokens.
import React, { useEffect, useMemo, useRef } from 'react';

let palette = null;
function pal() {
  if (palette) return palette;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fb) => (css.getPropertyValue(name) || '').trim() || fb;
  palette = { up: v('--ss-up', '#3ee08a'), down: v('--ss-down', '#ff6b7a'), text: v('--ss-text-3', '#8f999e'), font: v('--ss-font-body', 'system-ui') };
  return palette;
}
function rgba(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(128,128,128,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Zeichnet bei Größenänderung neu; `deps` sagt, wann sich die Daten ändern.
function useCanvasDraw(draw, deps) {
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
      try { draw(ctx, w, h); } catch { /* Canvas noch ohne Größe */ }
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// ---------------- Sparkline (Markt- und Depotliste) ----------------
// tone: 'up' | 'down' — feste Färbung (z. B. nach Gewinn); ohne Angabe nach Verlauf.
export function Sparkline({ values, w = 76, h = 30, fill = true, tone }) {
  const data = useMemo(() => (values || []).filter((v) => isFinite(v)), [values]);
  const ref = useCanvasDraw((ctx) => {
    if (data.length < 2) return;
    let min = Infinity, max = -Infinity;
    for (const v of data) { min = Math.min(min, v); max = Math.max(max, v); }
    if (min === max) { min -= 1; max += 1; }
    const up = tone ? tone === 'up' : data[data.length - 1] >= data[0];
    const p = pal();
    const col = up ? p.up : p.down;
    const x = (i) => (w * i) / (data.length - 1);
    const y = (v) => 3 + (h - 6) * (1 - (v - min) / (max - min));
    if (fill) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = rgba(col, 0.16);
      ctx.fill();
    }
    ctx.beginPath();
    data.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x(data.length - 1), y(data[data.length - 1]), 2.2, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }, [data, w, h, fill, tone]);
  return <canvas ref={ref} style={{ width: w, height: h, display: 'block' }} />;
}

// ---------------- Linienchart (z. B. Index auf dem Beamer) ----------------
// points: [{ t, v }] — mit Achsenbeschriftung (Handel: Lehre aus Trading 212).
export function LineChart({ points, showLabels = true }) {
  const data = useMemo(() => (points || []).filter((p) => p && isFinite(p.v)), [points]);
  const ref = useCanvasDraw((ctx, w, h) => {
    const p = pal();
    if (data.length < 2) {
      ctx.fillStyle = p.text;
      ctx.font = `600 14px ${p.font}`;
      ctx.textAlign = 'center';
      ctx.fillText('Wird aufgebaut …', w / 2, h / 2);
      return;
    }
    const padR = showLabels ? 84 : 10, padT = 8, padB = 8, padL = 4;
    const plotW = Math.max(1, w - padL - padR), plotH = Math.max(1, h - padT - padB);
    let min = Infinity, max = -Infinity;
    for (const d of data) { min = Math.min(min, d.v); max = Math.max(max, d.v); }
    if (min === max) { min -= 1; max += 1; }
    const up = data[data.length - 1].v >= data[0].v;
    const col = up ? p.up : p.down;
    const x = (i) => padL + (plotW * i) / (data.length - 1);
    const y = (v) => padT + plotH * (1 - (v - min) / (max - min));

    // Fläche unter der Linie, flach und leise
    ctx.beginPath();
    ctx.moveTo(x(0), padT + plotH);
    for (let i = 0; i < data.length; i++) ctx.lineTo(x(i), y(data[i].v));
    ctx.lineTo(x(data.length - 1), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = rgba(col, 0.12);
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) { if (i === 0) ctx.moveTo(x(i), y(data[i].v)); else ctx.lineTo(x(i), y(data[i].v)); }
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x(data.length - 1), y(data[data.length - 1].v), 3, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    if (showLabels) {
      const fmt = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 0 });
      ctx.textAlign = 'left';
      ctx.font = `600 12px ${p.font}`;
      ctx.fillStyle = p.text;
      ctx.fillText(fmt(max), padL + plotW + 8, padT + 12);
      ctx.fillText(fmt(min), padL + plotW + 8, padT + plotH);
      ctx.fillStyle = col;
      ctx.font = `700 13px ${p.font}`;
      ctx.fillText(fmt(data[data.length - 1].v), padL + plotW + 8, Math.min(padT + plotH, Math.max(padT + 12, y(data[data.length - 1].v) + 4)));
    }
  }, [data, showLabels]);
  return <canvas ref={ref} />;
}
