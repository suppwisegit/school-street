// Wiederverwendbare UI-Bausteine: Money, Pct, Card, Tabs, Toasts, Modal,
// plus Motion-Baukasten: Count-Up, Preis-Flash, Skeletons, Trophäen, Konfetti.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconCircleCheck, IconCircleX, IconInfoCircle } from '@tabler/icons-react';
import { fmtC } from './api.js';

const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Zahlen ----------
export function Money({ c, colored = false, signed = false, className = '', suffix = '' }) {
  const v = Number(c) || 0;
  const cls = colored ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';
  const sign = signed && v > 0 ? '+' : '';
  return <span className={`num ${cls} ${className}`}>{sign}{fmtC(v)}{suffix}</span>;
}

export function Pct({ v, className = '', digits = 2 }) {
  const n = Number(v) || 0;
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  const sign = n > 0 ? '+' : '';
  return <span className={`num ${cls} ${className}`}>{sign}{n.toFixed(digits)}%</span>;
}

export const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

// Zahl zählt weich zum Zielwert hoch/runter (rAF, ease-out, reduced-motion-fähig).
export function useCountUp(target, { duration = 800, enabled = true } = {}) {
  const to = Number(target) || 0;
  const [val, setVal] = useState(0);
  const cur = useRef(0);
  useEffect(() => {
    const from = cur.current;
    if (from === to) { setVal(to); return; }
    if (!enabled || prefersReduced() || duration <= 0) { cur.current = to; setVal(to); return; }
    let raf;
    let t0;
    const step = (t) => {
      if (t0 === undefined) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      cur.current = v;
      setVal(v);
      if (p < 1) raf = requestAnimationFrame(step);
      else { cur.current = to; setVal(to); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, duration, enabled]);
  return val;
}

// Liefert 'tick-up'/'tick-down'-Klasse, solange der Wert-Flash läuft.
export function usePriceFlash(value) {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (value === prev.current) return;
    const dir = value > prev.current ? 'up' : 'down';
    prev.current = value;
    setCls('');
    const raf = requestAnimationFrame(() => setCls('tick-' + dir));
    const t = setTimeout(() => setCls(''), 850);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [value]);
  return cls;
}

// Live-Preis: Count-Up + Farb-Flash bei jeder Änderung.
export function LivePrice({ value, className = '', format = fmtC, countMs = 450 }) {
  const flash = usePriceFlash(value);
  const v = useCountUp(value, { duration: countMs });
  return <span className={`num ${flash} ${className}`}>{format(v)}</span>;
}

// Hero-Betrag (z.B. Gesamtvermögen): zählt beim Laden von 0 hoch.
export function HeroMoney({ cents, className = '' }) {
  const v = useCountUp(cents, { duration: 900 });
  return <span className={`num ${className}`}>{fmtC(Math.round(v))}</span>;
}

// ---------- Layout ----------
export function Card({ title, right, children, className = '', ...rest }) {
  return (
    <div className={`card ${className}`} {...rest}>
      {(title || right) && (
        <div className="row between" style={{ marginBottom: title ? 10 : 0 }}>
          {title && <h3 style={{ marginBottom: 0 }}>{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={`tabs ${className}`}>
      {tabs.map((t) => (
        <button key={t.value} type="button" className={value === t.value ? 'on ' + (t.cls || '') : ''} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, tone = '' }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Spinner() {
  return <div className="spinner" />;
}

export function Loading({ label = 'Lade …' }) {
  return (
    <div className="loading-screen">
      <Spinner />
      <div>{label}</div>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ children }) {
  if (!children) return null;
  return <div className="errbox">{children}</div>;
}

export function OkBox({ children }) {
  if (!children) return null;
  return <div className="okbox">{children}</div>;
}

export function Field({ label, help, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  );
}

// ---------- Skeletons ----------
export function Skel({ h = 16, w, radius = 10, style, className = '' }) {
  return <div className={`skel ${className}`} style={{ height: h, width: w, borderRadius: radius, ...style }} />;
}

export function SkelRows({ n = 4, h = 62, gap = 10 }) {
  return (
    <div className="col" style={{ gap }}>
      {Array.from({ length: n }, (_, i) => <Skel key={i} h={h} radius={14} />)}
    </div>
  );
}

// ---------- Avatare / Monogramme ----------
export function tileColors(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    background: `hsl(${hue} 42% 19%)`,
    color: `hsl(${hue} 78% 76%)`,
    border: `1px solid hsl(${hue} 55% 32% / 0.7)`,
  };
}

export function AvatarTile({ seed, label, size = 40, radius = 12 }) {
  const c = tileColors(seed || '?');
  return (
    <div className="logotile" style={{ ...c, width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.33) }}>
      {(label || seed || '?').slice(0, 3)}
    </div>
  );
}

// ---------- Trophäen (Achievements mit Rarity) ----------
const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', shame: 'Peinlich' };

export function Trophy({ rarity = 'common', icon, title, desc, right }) {
  return (
    <div className={`trophy ${rarity}`}>
      <div className="gem">{icon}</div>
      <div className="grow">
        <div className="tt">{title}</div>
        {desc ? <div className="td">{desc}</div> : null}
        <span className="rr">{RARITY_LABEL[rarity] || rarity}</span>
      </div>
      {right}
    </div>
  );
}

// ---------- Konfetti ----------
const CONFETTI_COLORS = ['#7c5cff', '#00d68f', '#ffc24d', '#45cfe6', '#ecf1f8', '#a08bff'];
export function confetti(origin = { x: 0.5, y: 0.35 }) {
  if (typeof window === 'undefined' || prefersReduced()) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:1200';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const parts = Array.from({ length: 90 }, () => ({
    x: origin.x * innerWidth,
    y: origin.y * innerHeight,
    vx: (Math.random() - 0.5) * 11,
    vy: -Math.random() * 9 - 3,
    w: 4 + Math.random() * 5,
    h: 7 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
  }));
  const t0 = performance.now();
  const step = (t) => {
    const el = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.22; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - el / 1400);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (el < 1400) requestAnimationFrame(step);
    else canvas.remove();
  };
  requestAnimationFrame(step);
}

// ---------- Toasts ----------
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = useCallback((text, kind = 'ok') => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-4), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toastwrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="tico">
              {t.kind === 'ok' ? <IconCircleCheck stroke={1.9} /> : t.kind === 'err' ? <IconCircleX stroke={1.9} /> : <IconInfoCircle stroke={1.9} />}
            </span>
            <span className="grow">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  return useContext(ToastCtx) || (() => {});
}

// ---------- Modal / Confirm ----------
export function Modal({ title, children, onClose, actions }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {title && <h3>{title}</h3>}
        <div>{children}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, children, confirmLabel = 'Bestätigen', danger = false, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
          <button className={`btn ${danger ? 'sell' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
