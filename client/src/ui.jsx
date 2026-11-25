// Design-System „Anzeigetafel“: Tokens und Bausteine laut .agent-team/DESIGN.md (§3, §5).
// Regeln: kein Import aus charts.jsx/candle.jsx; Router nur in Row (Link) und TabBar (NavLink).
import React, {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useMatch } from 'react-router-dom';
import { IconCheck, IconChevronRight, IconCircleX, IconInfoCircle, IconX } from '@tabler/icons-react';
import { fmtC } from './api.js';

// ---------- Helfer ----------
const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Zahl oder null (null/undefined/leer/NaN → null). Geld bleibt Integer-Cents.
const numOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const cls = (...parts) => parts.filter(Boolean).join(' ');

// Icon-Komponente (Funktion oder forwardRef-/memo-Objekt, wie die Tabler-Icons)
// oder fertiges Element → Element. Ein rohes Komponenten-Objekt darf nie als Kind
// landen (React-Fehler 31).
const iconOf = (icon, props) => {
  if (!icon) return null;
  if (React.isValidElement(icon)) return icon;
  return typeof icon === 'function' || typeof icon === 'object' ? React.createElement(icon, props) : null;
};

// Fehlerobjekt → Satz
const textOf = (c) => (c instanceof Error ? c.message : c);

// ---------- Zahlen ----------
export function Money({ c, signed = false, colored = false, suffix = '', className = '' }) {
  const v = numOf(c) || 0;
  const tone = colored ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';
  return (
    <span className={cls('num', tone, className)}>
      {signed && v > 0 ? '+' : ''}{fmtC(v)}{suffix}
    </span>
  );
}

const PCT_FMT = {};
const pctFmt = (d) => PCT_FMT[d] || (PCT_FMT[d] = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: d, maximumFractionDigits: d,
}));

export function Pct({ v, digits = 2, signed = false, colored = false, className = '' }) {
  const d = Math.min(20, Math.max(0, Math.floor(numOf(digits) ?? 2)));
  const raw = numOf(v) ?? 0;
  const n = Number(raw.toFixed(d));
  const tone = colored ? (n > 0 ? 'pos' : n < 0 ? 'neg' : '') : '';
  return (
    <span className={cls('num', tone, className)}>
      {signed && n > 0 ? '+' : ''}{pctFmt(d).format(n)}%
    </span>
  );
}

export function Num({ v, className = '' }) {
  return <span className={cls('num', className)}>{(numOf(v) ?? 0).toLocaleString('de-DE')}</span>;
}

// Rollt einen Geldbetrag in `duration` ms zum Zielwert. Nur von Zahl zu Zahl:
// beim ersten Wert und nach „kein Kurs“ steht die Zahl sofort da.
function useCountUp(target, duration) {
  const [val, setVal] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    const to = target;
    if (to === from) return undefined;
    if (to === null || from === null || !duration || reducedMotion()) {
      cur.current = to;
      setVal(to);
      return undefined;
    }
    let raf = 0;
    let t0;
    const step = (t) => {
      if (t0 === undefined) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      cur.current = from + (to - from) * (1 - Math.pow(1 - p, 3));
      setVal(cur.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// Liefert 600 ms lang 'up'/'down' nach einer Änderung (mit laufender Nummer zum Neustart).
function useFlash(value) {
  const [fx, setFx] = useState({ dir: '', n: 0 });
  const seq = useRef(0); // zählt die Blitze; die laufende Nummer startet die Animation neu.
  const prev = useRef(value); // der Wert vor der letzten Änderung
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (value === before || value === null || before === null || reducedMotion()) return undefined;
    const n = ++seq.current;
    setFx({ dir: value > before ? 'up' : 'down', n });
    const t = setTimeout(() => setFx((f) => (f.n === n ? { dir: '', n } : f)), 600);
    return () => clearTimeout(t);
  }, [value]);
  return fx;
}

// Live-Preis: rollt 300 ms und blitzt in up/down auf. `countMs: 0` schaltet das Rollen ab.
export function LivePrice({ value, format = fmtC, className = '', countMs = 300 }) {
  const v = numOf(value);
  const shown = useCountUp(v, countMs);
  const { dir } = useFlash(v);
  if (shown === null) return <span className={cls('num', 'muted', className)}>–</span>;
  return <span className={cls('num', dir && `lp-${dir}`, className)}>{format(shown)}</span>;
}

// Legt beim Änderung von `value` 600 ms lang up-/down-wash über den Inhalt (die Zeile).
export function Flash({ value, children, className = '' }) {
  const { dir, n } = useFlash(numOf(value));
  return (
    <div className={cls('flash', className)}>
      {children}
      {dir ? <span key={n} className={`flash-fx ${dir}`} aria-hidden="true" /> : null}
    </div>
  );
}

// ---------- Etikett, Avatar, Kürzel ----------
export function Chip({ tone = 'neutral', children, className = '' }) {
  return <span className={cls('chip', tone, className)}>{children}</span>;
}

const initials = (s) => String(s || '').trim().split(/\s+/).slice(0, 2)
  .map((w) => Array.from(w)[0] || '').join('').toUpperCase();

// Avatare sind Initialen (keine Bilder, keine Farbe ohne Vorzeichen).
export function Avatar({ seed, label, size = 36, className = '' }) {
  const s = numOf(size) || 36;
  const name = label || seed || '';
  return (
    <span
      className={cls('avatar', className)}
      role="img"
      aria-label={name || undefined}
      style={{ width: s, height: s, fontSize: Math.round(s * 0.38) }}
    >
      {initials(name) || '?'}
    </span>
  );
}

// Kürzel fett, Name in text-2; `sub` ist ein Zusatz in der Kürzelzeile.
export function Symbol({ ticker, name, sub, className = '' }) {
  return (
    <span className={cls('sym', className)}>
      <span className="sym-top">
        <b className="sym-tk">{ticker}</b>
        {sub ? <span className="sym-sub">{sub}</span> : null}
      </span>
      {name ? <span className="sym-nm">{name}</span> : null}
    </span>
  );
}

// ---------- Zeile und Abschnitt ----------
// `to` → Link, `onClick` → Button, sonst div. Ohne `title`/`sub` belegt `leading`
// den Textbereich (wächst), sonst ist `leading` eine feste Spalte davor.
export function Row({ leading, title, sub, trailing, to, onClick, className = '', disabled = false, ...rest }) {
  const hasText = title !== undefined && title !== null && title !== false;
  const hasSub = sub !== undefined && sub !== null && sub !== false;
  const body = (
    <>
      {leading ? <div className={hasText ? 'row-lead' : 'row-text'}>{leading}</div> : null}
      {hasText || hasSub ? (
        <div className="row-text">
          {hasText ? <div className="row-title">{textOf(title)}</div> : null}
          {hasSub ? <div className="row-sub">{textOf(sub)}</div> : null}
        </div>
      ) : null}
      {trailing ? <div className="row-trail">{trailing}</div> : null}
    </>
  );
  const base = cls('row', disabled && 'disabled', className);
  if (to) {
    return (
      <Link
        to={to}
        className={cls(base, 'row-link')}
        aria-disabled={disabled || undefined}
        onClick={disabled ? (e) => e.preventDefault() : rest.onClick}
      >
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls(base, 'row-btn')} onClick={onClick} disabled={disabled} {...rest}>
        {body}
      </button>
    );
  }
  return <div className={base} {...rest}>{body}</div>;
}

export function Section({ title, action, children, className = '' }) {
  return (
    <section className={cls('sec', className)}>
      {title || action ? (
        <div className="sec-head">
          {title ? <h2 className="sec-title">{title}</h2> : null}
          {action ? <div className="sec-act">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ---------- Bedienelemente ----------
// variant: buy | sell | primary | ghost | danger · size: sm (44) | md (48) | lg (56)
export function Button({
  variant = 'primary', size = 'md', full = false, loading = false, type = 'button', disabled = false,
  className = '', children, ...rest
}) {
  return (
    <button
      type={type}
      className={cls('btn', variant, size, full && 'full', loading && 'loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// Umschalter mit Pfeiltasten; options: [{value, label, disabled?}]
export function Segmented({ value, onChange, options = [], className = '', 'aria-label': ariaLabel }) {
  const onKey = (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    if (i < 0) return;
    const n = options.length;
    const next = options[(i + d + n) % n];
    onChange?.(next.value);
    const btns = e.currentTarget.querySelectorAll('.seg-btn');
    if (btns[(i + d + n) % n]) btns[(i + d + n) % n].focus();
  };
  return (
    <div className={cls('seg', className)} role="group" aria-label={ariaLabel} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={cls('seg-btn', o.value === value && 'on')}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// − / Zahl / + mit direkter Eingabe. `label` benennt die Gruppe und das Feld.
export function Stepper({
  value, onChange, min = 0, max, step = 1, label, suffix, id, className = '', disabled = false,
}) {
  const autoId = useId();
  const cur = numOf(value) ?? 0;
  const st = numOf(step) > 0 ? numOf(step) : 1;
  const lo = numOf(min) ?? 0;
  const hi = numOf(max) ?? Infinity;
  const clamp = (n) => Math.min(hi, Math.max(lo, n));
  const [raw, setRaw] = useState(null); // null = nichts wird getippt
  const typed = () => parseInt(String(raw).replace(/\D/g, ''), 10) || 0;
  const commit = () => {
    if (raw === null) return;
    const n = clamp(typed());
    setRaw(null);
    if (n !== cur) onChange?.(n);
  };
  const bump = (dir) => {
    const n = clamp(Math.round((raw === null ? cur : typed()) / st) * st + dir * st);
    setRaw(null);
    if (n !== cur) onChange?.(n);
  };
  const now = raw === null ? cur : typed();
  return (
    <div className={cls('stepper', className)} role="group" aria-label={label || 'Wert'}>
      <button type="button" className="step-btn" onClick={() => bump(-1)} disabled={disabled || now <= lo} aria-label="Verringern">
        −
      </button>
      <input
        id={id || autoId}
        className="step-input num"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={raw === null ? String(cur) : raw}
        disabled={disabled}
        aria-label={label || 'Wert'}
        onChange={(e) => setRaw(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') setRaw(null);
        }}
      />
      {suffix ? <span className="step-suffix">{suffix}</span> : null}
      <button type="button" className="step-btn" onClick={() => bump(1)} disabled={disabled || now >= hi} aria-label="Erhöhen">
        +
      </button>
    </div>
  );
}

// Beschriftung + Hilfe + Fehlertext. Ohne `htmlFor` wird das einzige Kind automatisch
// verknüpft (id, aria-describedby, aria-invalid).
export function Field({ label, help, error, htmlFor, children, className = '' }) {
  const autoId = useId();
  const helpId = useId();
  const errId = useId();
  let content = children;
  let id = htmlFor || undefined;
  if (!id && React.isValidElement(children) && children.type !== React.Fragment) {
    id = children.props.id || autoId;
    const extra = { id };
    const described = [help && !error ? helpId : '', error ? errId : ''].filter(Boolean).join(' ');
    if (described) extra['aria-describedby'] = described;
    if (error) extra['aria-invalid'] = 'true';
    content = React.cloneElement(children, extra);
  }
  return (
    <div className={cls('field', error && 'has-error', className)}>
      {label ? <label className="field-label" htmlFor={id}>{label}</label> : null}
      {content}
      {error ? <div className="field-error" id={errId}>{textOf(error)}</div>
        : help ? <div className="field-help" id={helpId}>{help}</div> : null}
    </div>
  );
}

export const Input = forwardRef(function Input({ className = '', error = false, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cls('ctl', error && 'err', className)}
      aria-invalid={error ? 'true' : undefined}
      {...rest}
    />
  );
});

export const Select = forwardRef(function Select({ className = '', children, ...rest }, ref) {
  return (
    <span className="selectwrap">
      <select ref={ref} className={cls('ctl', className)} {...rest}>{children}</select>
      <IconChevronRight size={18} aria-hidden="true" />
    </span>
  );
});

export const Textarea = forwardRef(function Textarea({ className = '', error = false, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cls('ctl', 'ctl-area', error && 'err', className)}
      aria-invalid={error ? 'true' : undefined}
      {...rest}
    />
  );
});

// ---------- Sheet / Confirm ----------
// Nur das oberste offene Sheet reagiert auf Esc und Tab.
const sheetStack = [];
let sheetSeq = 0;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Unten (mobil) bzw. zentriert (ab 720 px). Esc und Klick auf den Rand schließen,
// der Fokus bleibt im Sheet und kehrt danach zum Auslöser zurück.
export function Sheet({ open, onClose, title, children, footer, className = '' }) {
  const panel = useRef(null);
  const sid = useRef(0);
  const titleId = useId();

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sheetSeq += 1;
    sid.current = sheetSeq;
    sheetStack.push(sheetSeq);
    if (panel.current) panel.current.focus({ preventScroll: true });
    return () => {
      const i = sheetStack.indexOf(sid.current);
      if (i >= 0) sheetStack.splice(i, 1);
      document.body.style.overflow = prevOverflow;
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e) => {
    if (sheetStack[sheetStack.length - 1] !== sid.current) return;
    const node = panel.current;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab' || !node) return;
    const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
    if (!items.length) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === node)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="sheet-back"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className={cls('sheet', className)}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          {title ? <h2 className="sheet-title" id={titleId}>{title}</h2> : <span />}
          <button type="button" className="sheet-x" onClick={onClose} aria-label="Schließen">
            <IconX size={20} stroke={2} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// Bestätigungsdialog auf Basis von Sheet (ersetzt window.confirm).
// `onConfirm` darf ein Promise zurückgeben: Lädt-Zustand, bei Erfolg `onClose()`,
// bei Fehler bleibt der Dialog offen und der Satz landet als Toast.
export function Confirm({
  open, title, children, confirmLabel = 'Bestätigen', danger = false, onConfirm, onClose,
}) {
  const push = useToast();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);
  const run = async () => {
    let failed = false;
    try {
      const r = onConfirm?.();
      if (r && typeof r.then === 'function') {
        setBusy(true);
        await r;
      }
    } catch (err) {
      failed = true;
      push(textOf(err) || 'Das ging nicht.', 'err');
    } finally {
      setBusy(false);
    }
    if (!failed) onClose?.();
  };
  return (
    <Sheet
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Abbrechen</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={run} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
    </Sheet>
  );
}

// ---------- Navigation ----------
function TabItem({ item, forced }) {
  const match = useMatch({ path: item.to, end: item.to === '/' });
  const controlled = forced !== undefined && forced !== null;
  const on = controlled ? forced === item.to : Boolean(match);
  const content = (
    <>
      {iconOf(item.icon, { size: 22, stroke: 1.8 })}
      <span>{item.label}</span>
    </>
  );
  const klass = cls('tab', on && 'on');
  // Gesteuert: Link übernimmt aria-current unverändert (NavLink setzt es nur bei
  // eigener Router-Übereinstimmung). Sonst NavLink mit Funktions-className, damit
  // kein zusätzliches „active“ angehängt wird.
  if (controlled) {
    return (
      <Link to={item.to} className={klass} aria-current={on ? 'page' : undefined}>{content}</Link>
    );
  }
  return <NavLink to={item.to} end={item.to === '/'} className={() => klass}>{content}</NavLink>;
}

// 4 Tabs: mobil unten, PC oben. `active` (ein `to`) hebt den aktiven Tab vor,
// wenn die Route kein Tab ist (z. B. `/security/:id` → Markt).
export function TabBar({ items = [], active }) {
  return (
    <nav className="tabbar" aria-label="Hauptnavigation">
      {items.map((item) => <TabItem key={item.to} item={item} forced={active} />)}
    </nav>
  );
}

// ---------- Zustände ----------
export function Skel({ h = 16, w, radius, style, className = '' }) {
  return (
    <div
      className={cls('skel', className)}
      style={{ height: h, width: w, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

export function SkelRows({ n = 5, h, className = '' }) {
  const count = Math.max(0, Math.floor(numOf(n) ?? 5));
  return (
    <div className={cls('skelrows', className)} role="status" aria-busy="true" aria-label="Lädt">
      {Array.from({ length: count }, (_, i) => <Skel key={i} h={h} />)}
    </div>
  );
}

export function Loading({ label = 'Lädt …' }) {
  return <div className="loading" role="status">{textOf(label)}</div>;
}

export function Empty({ icon, title, children, className = '' }) {
  return (
    <div className={cls('empty', className)}>
      {icon ? <div className="empty-ico">{iconOf(icon, { size: 28, stroke: 1.6 })}</div> : null}
      {title ? <div className="empty-title">{textOf(title)}</div> : null}
      {children}
    </div>
  );
}

export function ErrorBox({ children, onRetry }) {
  if (!children && !onRetry) return null;
  return (
    <div className="msg" role="alert">
      {children ? textOf(children) : null}
      {onRetry ? <Button variant="ghost" size="sm" onClick={onRetry}>Erneut versuchen</Button> : null}
    </div>
  );
}

export function OkBox({ children }) {
  if (!children) return null;
  return <div className="msg ok">{textOf(children)}</div>;
}

// ---------- Fehlergrenze ----------
// Fängt Render-Fehler im Baum und zeigt statt einer weißen Seite ErrorBox mit
// „Erneut versuchen“; der Versuch setzt den Baum per Schlüssel zurück.
// Wechselt `resetKey` (z. B. die Route), setzt die Grenze von selbst zurück.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, n: 0, resetKey: props.resetKey };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey === state.resetKey) return null;
    const next = { resetKey: props.resetKey };
    if (state.error) {
      next.error = null;
      next.n = state.n + 1;
    }
    return next;
  }

  retry() {
    this.setState((s) => ({ error: null, n: s.n + 1 }));
  }

  render() {
    const { error, n } = this.state;
    if (!error) return <React.Fragment key={n}>{this.props.children}</React.Fragment>;
    return (
      <ErrorBox onRetry={this.retry}>
        <span>Hier ist etwas schiefgegangen.</span>
        {error && error.message ? <span className="small muted">{error.message}</span> : null}
      </ErrorBox>
    );
  }
}

// ---------- Konfetti ----------
// `origin` = {x, y} in Pixeln des Viewports (z. B. Mitte der Schaltfläche).
// Ohne Angabe: Handel aus der Bildmitte, Rang von oben.
let confettiRunning = 0;
const readToken = (name) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
};

export function confetti(origin, kind = 'trade') {
  if (typeof document === 'undefined' || reducedMotion() || confettiRunning >= 3) return;
  const colors = ['--ss-up', '--ss-down', '--ss-gold', '--ss-white'].map(readToken).filter(Boolean);
  if (!colors.length) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = numOf(origin && origin.x);
  let y = numOf(origin && origin.y);
  if (x !== null && y !== null && x <= 1 && y <= 1) { x *= vw; y *= vh; } // Bruchteile statt Pixel
  if (x === null) x = vw / 2;
  if (y === null) y = kind === 'rank' ? 0 : vh * 0.4;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:950';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.appendChild(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const rain = kind === 'rank';
  const parts = Array.from({ length: rain ? 120 : 80 }, () => {
    const base = {
      w: 5 + Math.random() * 4,
      h: 8 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.25,
      c: colors[(Math.random() * colors.length) | 0],
    };
    if (rain) {
      return { ...base, x: Math.random() * vw, y: -20 - Math.random() * vh * 0.3, vx: (Math.random() - 0.5) * 2, vy: 2.5 + Math.random() * 3.5 };
    }
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const sp = 6 + Math.random() * 10;
    return { ...base, x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp };
  });

  confettiRunning += 1;
  const t0 = performance.now();
  let last = t0;
  const step = (t) => {
    const el = t - t0;
    const dt = Math.min(3, (t - last) / 16.67);
    last = t;
    ctx.clearRect(0, 0, vw, vh);
    ctx.globalAlpha = el > 800 ? Math.max(0, 1 - (el - 800) / 400) : 1;
    for (const p of parts) {
      p.vy += (rain ? 0.04 : 0.32) * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.fillStyle = p.c;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    if (el < 1200) requestAnimationFrame(step);
    else {
      canvas.remove();
      confettiRunning -= 1;
    }
  };
  requestAnimationFrame(step);
}

// ---------- Toasts ----------
const ToastCtx = createContext(null);

// push(text, kind) mit kind: 'ok' | 'err' | 'info'
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  const timers = useRef(new Map());
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const push = useCallback((text, kind = 'ok') => {
    seq.current += 1;
    const id = seq.current;
    setToasts((t) => [...t.slice(-4), { id, text: String(textOf(text) ?? ''), kind }]);
    timers.current.set(id, setTimeout(() => dismiss(id), 4200));
  }, [dismiss]);
  useEffect(() => {
    const m = timers.current;
    return () => {
      m.forEach((t) => clearTimeout(t));
      m.clear();
    };
  }, []);
  const icons = { ok: <IconCheck size={18} stroke={2} />, err: <IconCircleX size={18} />, info: <IconInfoCircle size={18} /> };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {typeof document === 'undefined' ? null : createPortal(
        <div className="toastwrap" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={cls('toast', t.kind)} onClick={() => dismiss(t.id)}>
              {icons[t.kind] || icons.info}
              <span>{t.text}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx) || (() => {});
}
