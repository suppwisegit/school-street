// API-Helfer: fetch mit Token, Fehlerbehandlung, Query-Params.
// Konvention: Alle Geldbeträge/Preise kommen als INTEGER-CENTS (100 = 1.00 Credits).
const TOKEN_KEY = 'ss_token';
export const ADMIN_TOKEN_KEY = 'ss_admin_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  try { window.dispatchEvent(new Event('ss-token-changed')); } catch {}
};

// Credits (String/Eingabe) -> Cents (Integer)
export const credsToCent = (v) => Math.round(parseFloat(String(v ?? '').replace(',', '.')) * 100) || 0;
// Cents -> anzeigbarer Credits-String (de-DE: Tausenderpunkte, 2 Nachkommastellen)
const CUR_FMT = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtC = (c) => CUR_FMT.format((Number(c) || 0) / 100);
// Tick-Größe: Aktie 100 Cent, ETF 10 Cent
export const tickOf = (type) => (type === 'etf' ? 10 : 100);
export const snapToTick = (cents, type) => Math.max(tickOf(type), Math.round(cents / tickOf(type)) * tickOf(type));

export async function api(path, { method = 'GET', body, params, token } = {}) {
  let url = path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = {};
  const t = token !== undefined ? token : getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Netzwerkfehler – Server nicht erreichbar');
  }
  let data = null;
  try { data = await res.json(); } catch { /* leere Antwort */ }
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

export const timeStr = (ts) => (ts ? new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
export const dateTimeStr = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
