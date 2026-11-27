// ============================================================================
// BOTBRAIN — Entscheidungslogik der Bot-Trader. Rein: keine DB, keine Engine,
// kein Zufall außer über das injizierte `rnd`. bots.js bringt hier nur Marktdaten
// und Kontostände herein und führt die entschiedene Order aus.
//
// Modell (je Bot eine dauerhafte Persona, siehe personaFor):
//   * Jeder Bot hat einen ZIELANTEIL Aktien am Vermögen. Liegt der Wert seiner
//     Position unter dem Ziel, kauft er, darüber verkauft er, dazwischen hält er.
//     Kauf und Verkauf hängen an derselben relativen Schwelle — kein „Kaufen
//     scheitert am Cash, Verkaufen läuft immer".
//   * Das Ziel je Aktie schwankt mit Signalen: privates Wert-Rauschen des Bots
//     (verfällt langsam), News (newsImpact), Momentum und Lage im Kursband.
//     Dadurch kaufen und verkaufen verschiedene Bots gleichzeitig.
//   * Disposition: Gewinner werden eher verkauft, Verlierer eher gehalten.
//   * House Money: wer reicher ist als zu Beginn, handelt größere Orders.
//   * Overconfidence: Handelsrate je Bot (Faktor 0,3 – 3).
// ============================================================================
'use strict';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- Persona-Typen: Grundzug je Typ, Zielanteil und Mitlaufen ------------
const PERSONA_TYPES = [
  // Ø Zielanteil 0,50. Bei 0,45 (Nachfrage ≈ Streubesitz bei Emissionskursen) rutschte der Index
  // nach dem Start um 3–6 % ab: Verkäufe laufen immer, Käufe scheitern an der Cash-Reserve.
  // Bei 0,51 mit Startposition null war die Nachfrage größer als das Angebot (Index stieg monoton).
  { key: 'vorsichtig', target: 0.27, herd: 0.0 },
  { key: 'sparer', target: 0.37, herd: 0.0 },
  { key: 'ausgeglichen', target: 0.49, herd: 0.05 },
  { key: 'aktienfan', target: 0.61, herd: 0.1 },
  { key: 'zocker', target: 0.75, herd: 0.2 },
  { key: 'mitlaeufer', target: 0.49, herd: 1.0 }
];

// Stabile Hash → Zufallstrom: dieselbe Persona überläuft Server-Neustarts,
// weil sie nur vom Benutzernamen abhängt.
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Normalverteilt (Box-Muller) aus gleichverteilter Quelle — 0 bei 0 oder 1
function gauss(rnd) {
  const u = Math.max(1e-12, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

// Je Bot feste Werte. Alle Felder sind dimensionslos, Zeiten in Spielminuten.
function personaFor(username) {
  const r = stream(hash32(String(username)));
  const roll = r();
  let acc = 0, type = PERSONA_TYPES[0];
  for (const t of PERSONA_TYPES) { acc += 1 / PERSONA_TYPES.length; if (roll < acc) { type = t; break; } }
  const targetShare = clamp(type.target + (r() - 0.5) * 0.2, 0.1, 0.9);
  const herd = r() < type.herd;
  return {
    type: type.key,
    targetShare,                                   // Soll-Anteil Aktien am Vermögen
    reserveFrac: clamp(Math.min((1 - targetShare) * 0.6 + 0.08, 1 - targetShare), 0.05, 0.5), // davon bleibt Cash immer (Default); lässt das Ziel erreichbar
    reserveSeed: r(),                                // 0 … 1: Anteil an bot_cash_reserve_min … _max
    disposition: 0.3 + r() * 0.6,                  // 1 = verkauft Gewinner deutlich eher als Verlierer
    houseMoney: 0.5 + r() * 1.1,                   // Ordergröße wächst mit dem Gewinn seit Start
    overconfidence: clamp(Math.exp(gauss(r) * 0.8), 0.3, 3), // Handelsrate relativ zum Durchschnitt
    attention: 0.15 + r() * 0.35,                  // Anteil der Versuche, die auf News-Aktien gehen
    herd,                                          // folgt dem Markt (nur ein kleiner Teil)
    contrarian: !herd && r() < 0.2,                // handelt dem Trend entgegen
    noiseSigma: 0.12 + r() * 0.18,                 // Streuung des privaten Wert-Ankers
    horizonMin: 4 + r() * 16,                      // so lange gilt ein privater Wert (4–20 min): frischere Kauf-/Verkaufsimpulse
    limitAffinity: 0.1 + r() * 0.2,                // Anteil Limit- statt Market-Orders
    takeProfit: 0.02 + r() * 0.12,                // Gewinnmitnahme ab 2–14 % Kursgewinn (je Bot verschieden)
    newsReact: 0.2 + r() * 0.8                    // Folge einer FRISCHEN Aktien-News: anfangs 20–100 % der Wirkung
  };
}

// ---- News ----------------------------------------------------------------------
// Stimmungswörter (klein geschrieben); Vorkommen je +1 bzw. −1.
const GOOD_WORDS = ['rekord', 'gewinn', 'gewinne', 'erfolg', 'boom', 'wächst', 'wachstum', 'vertrag',
  'sieg', 'expansion', 'ausbau', 'festival', 'hitze', 'sonderdividende', 'gefragt', 'gewinnt', 'expandiert',
  'durchbruch', 'beliebt', 'auftrag', 'plus'];
const BAD_WORDS = ['verlust', 'warnung', 'ermittelt', 'ermittlungen', 'bafin', 'skandal', 'rückruf',
  'einbruch', 'krise', 'desaster', 'pleite', 'insolvenz', 'verbot', 'rückgang', 'minus', 'schwach',
  'streik', 'unfall', 'brand', 'ausfall', 'kündig'];
const KIND_BASE = {
  dividend: { value: 0.12, attention: 0.9, halfLifeMin: 30 },
  bafin: { value: -0.25, attention: 1, halfLifeMin: 45 },
  takeover: { value: -0.3, attention: 1, halfLifeMin: 45 },
  ipo: { value: 0.02, attention: 0.3, halfLifeMin: 20 }, // bewusst schwach: Börsengang und Nachplatzierung sind kein Kaufsignal
  news: { value: 0, attention: 0.7, halfLifeMin: 20 }
};

// newsImpact(news) — Wirkung EINER Nachricht auf die Bots (rein, ohne Zufall).
//   news: Zeile der Tabelle `news` — { kind, title, body, impact?, security_id? }.
//   Rückgabe { value, attention, halfLifeMin }:
//     value        Verschiebung des privaten Werts als Bruchteil des Kurses (−0,4 … +0,4).
//                  +0,10 = die Bots halten die Aktie künftig rund 10 % mehr wert:
//                  sie kaufen sie eher und verkaufen sie seltener. Positiv wie negativ
//                  beschränkt — News verschieben das Ziel, sie erzwingen keine Seite.
//     attention    0 … 1 — wie stark die Nachricht die Aktie ins Blickfeld rückt
//                  (Bots mit News-Aufmerksamkeit wählen sie bevorzugt).
//     halfLifeMin  Halbwertszeit der Wirkung in Spielminuten.
//   Wertung: Steht in der Zeile eine Wirkung `impact` (Spalte news.impact, ganze Zahl
//   −3 … +3, siehe newsgen.js), gilt impact × 0,1 — und impact 0 heißt WIRKUNGSLOS: Eine
//   beschreibende Meldung („im Plus“, „klar im Minus“) wird nicht über Stichwörter doch
//   noch in eine Richtung gelesen; sie rückt die Aktie nur ins Blickfeld (attention).
//   Stichwörter und die Art zählen nur bei echten Ereignissen (Dividende, BaFin,
//   Übernahme — ihre Bedeutung steckt in der Art) und bei älteren Zeilen ohne impact.
//   Nachrichten ohne Wertpapier (security_id null) sind marktweite Stimmung: sie
//   gehen über marketMood() in ALLE Aktien ein, nicht in eine einzelne.
// Der News-Generator braucht nichts über die Bots zu wissen: jede Zeile wird hier
// bewertet.
// Ereignis-Arten: die Bedeutung steckt in der Art; dort ist impact meist nicht gesetzt.
const EVENT_KINDS = ['dividend', 'bafin', 'takeover'];
function newsImpact(news) {
  const base = KIND_BASE[news && news.kind] || { value: 0, attention: 0.5, halfLifeMin: 20 };
  const text = `${(news && news.title) || ''} ${(news && news.body) || ''}`.toLowerCase();
  let value;
  if (Number.isFinite(news && news.impact) && news.impact !== 0) value = clamp(news.impact * 0.1, -0.3, 0.3);
  else if (news && Number.isFinite(news.impact) && !EVENT_KINDS.includes(news.kind)) value = 0; // beschreibende Meldung: keine Richtung
  else {
    let words = 0;
    for (const w of GOOD_WORDS) if (text.includes(w)) words += 1;
    for (const w of BAD_WORDS) if (text.includes(w)) words -= 1;
    value = base.value + 0.03 * words;
  }
  return { value: clamp(value, -0.4, 0.4), attention: base.attention, halfLifeMin: base.halfLifeMin };
}

// Marktweite Stimmung aus Nachrichten OHNE Wertpapier (Wirtschaft, Börse insgesamt),
// zeitlich abgeklungen. Rückgabe −0,3 … +0,3 — geht in jede Aktie eines Bots ein;
// wie stark, bestimmt die Persona (valueSignal: Mitläufer stärker, Konträre entgegengesetzt).
// Nur Nachrichten MIT ausdrücklicher Wirkung (impact ≠ 0, siehe newsgen.js): ältere
// Zeilen ohne Wert — etwa ein BaFin-Hinweis an die Spieler — meinen keinen Markt.
function marketMood(news, ageMsOf) {
  let mood = 0;
  for (const n of news || []) {
    if (n.security_id != null || !Number.isFinite(n.impact) || n.impact === 0) continue;
    const imp = newsImpact(n);
    mood += imp.value * Math.pow(2, -Math.max(0, ageMsOf(n)) / (imp.halfLifeMin * 60000));
  }
  return clamp(mood, -0.3, 0.3);
}

// Wirkung mehrerer Nachrichten auf EIN Wertpapier, zeitlich abgeklungen.
//   news: Zeilen mit created_at (Wanduhr-ms), ageMsOf(news) → Alter in Spiel-ms.
// Rückgabe { value (-0,4 … 0,4), attention (0 … 1) } — Summe, gedämpft.
function newsSignal(news, ageMsOf) {
  let value = 0, attention = 0;
  for (const n of news || []) {
    const imp = newsImpact(n);
    const age = Math.max(0, ageMsOf(n));
    const decay = Math.pow(2, -age / (imp.halfLifeMin * 60000));
    value += imp.value * decay;
    attention = Math.max(attention, imp.attention * decay);
  }
  return { value: clamp(value, -0.4, 0.4), attention };
}

// ---- Signale --------------------------------------------------------------------
// Privater Wert-Anker: je Bot und Aktie ein Wert mit Rauschen, der `persona.horizonMin`
// gilt und dann neu gezogen wird. `store` (Map, gehört dem Bot) hält den Zustand.
// Rückgabe in Bruchteilen des Kurses, etwa −0,6 … +0,6.
function privateSignal(store, key, persona, simT, rnd) {
  let s = store.get(key);
  if (!s || s.until <= simT) {
    s = { value: clamp(gauss(rnd) * persona.noiseSigma, -0.6, 0.6), until: simT + persona.horizonMin * 60000 };
    store.set(key, s);
  }
  return s.value;
}

// Momentum: Kurs gegen Mittel der letzten `prices` ({t, p}, ältester zuerst).
// Rückgabe −0,3 … 0,3. Kurz, leer oder ohne Bewegung → 0.
function momentum(prices) {
  if (!prices || prices.length < 4) return 0;
  const last = prices[prices.length - 1].p;
  const mean = prices.reduce((a, x) => a + x.p, 0) / prices.length;
  if (!mean || !last) return 0;
  return clamp((last / mean - 1) * 3, -0.3, 0.3);
}

// Lage im Kursband (0 = am Tief, 1 am Hoch) → Kaufreiz am Tief, Gewinnmitnahme am Hoch.
function anchorBias(prices) {
  if (!prices || prices.length < 4) return 0;
  let lo = Infinity, hi = 0;
  for (const x of prices) { lo = Math.min(lo, x.p); hi = Math.max(hi, x.p); }
  if (!(hi > lo)) return 0;
  const pos = (prices[prices.length - 1].p - lo) / (hi - lo);
  return clamp((0.5 - pos) * 0.2, -0.1, 0.1);
}

// Orderbuch-Lage: −1 (kaum Angebot) … +1 (kaum Nachfrage). Ohne Tiefe auf beiden
// Seiten 0.
function bookImbalance({ bidDepth = 0, askDepth = 0 }) {
  const all = bidDepth + askDepth;
  return all > 0 ? clamp((bidDepth - askDepth) / all, -1, 1) : 0;
}

// Gesamtsignal eines Bots für eine Aktie: −0,8 … +0,8. Große Anteile liegen beim
// privaten Rauschen — nur der kleine Herd-Anteil folgt dem Markt deutlich.
// mood = marktweite Stimmung (marketMood), je Persona gedämpft oder gedreht.
// book = Lage im Orderbuch −1 … +1 (kaum Angebot, viel Nachfrage → −1): Dünne
// Angebotseite heißt für Schüler „nichts zu holen, teuer" — wer welche hat, verkauft
// eher hinein. Ohne diesen Term lief jede Knappheit (leere Staatskasse) in reine Käufe.
function valueSignal(persona, { priv, news, momentum: mom, anchor, mood = 0, book = 0 }) {
  // Mitläufer folgen dem Trend gedämpft (höchstens ±0,3): volle Trendfolge ließ sie
  // einseitig vollkaufen, solange der Kurs stieg.
  // Mitläufer folgen dem Trend nur gedämpft (0,6): Mit voller Trendfolge beherrschten sie das
  // Marktgeschehen (Netto-Trendfolge über alle Personas +0,24) — Kurse liefen in eine Richtung,
  // der Kaufanteil lag bei Aufwärtsläufen bei 65–73 %, alle Bots kauften nach einer News im selben Tick.
  const herdTerm = persona.herd ? mom * 0.6 : persona.contrarian ? -mom * 0.9 : mom * 0.35;
  const moodTerm = persona.herd ? mood * 1.6 : persona.contrarian ? -mood * 0.6 : mood;
  return clamp(priv + news * 0.8 + herdTerm + anchor + moodTerm + book * 0.25, -0.8, 0.8);
}

// Effektiver Zielwert einer Position in Credits, nach Signal und Disposition.
//   wealth       Vermögen des Bots (Cash + Depotwert)
//   slotShare    Anteil des Vermögens, der auf diese Aktie entfällt (targetShare / n)
//   held         Stück im Depot, price letzter Kurs, avgCost Einstand (Cent, 0 wenn unbekannt)
// Die Gewinnmitnahme-Schwelle ist je Bot verschieden (persona.takeProfit, Default 3 %):
// Eine gemeinsame Schwelle ließ bei jedem Anstieg ALLE Bots gleichzeitig verkaufen.
const DEFAULT_TAKE_PROFIT = 0.03;
function targetValue(persona, { wealth, slotShare, signal, held, price, avgCost }) {
  let want = wealth * slotShare * (1 + signal);
  if (held > 0 && avgCost > 0 && price > 0) {
    const gain = price / avgCost - 1;
    if (gain > (Number.isFinite(persona.takeProfit) ? persona.takeProfit : DEFAULT_TAKE_PROFIT)) {
      want *= 1 - persona.disposition * 0.5;                     // Gewinner: Ziel sinkt → eher verkaufen
    } else if (gain < -0.03) want *= 1 + persona.disposition * 0.6; // Verlierer: Ziel steigt → eher halten
  }
  return Math.max(0, want);
}

// Ob und was gehandelt wird — die eigentliche, symmetrische Entscheidung.
// Eingabe (alles bereits in Cent bzw. Stück):
//   persona, wealth, want (Zielwert), heldValue (Wert der Position), cash, fee,
//   refWealth (Vermögen zu Beginn, für House Money), rnd
// Rückgabe { side: 'buy'|'sell'|'hold', size, reason }; size = Anteil 0,2 … 1 der
// Abweichung (in Stück), den die Order deckt — House Money macht ihn größer.
//   Hold-Bereich: Position innerhalb ±HOLD_TOL um den Zielwert.
//   Kauf und Verkauf nutzen dieselbe Regel: Menge = Anteil der Abweichung vom Ziel,
//   mindestens 1 Stück. Ob der Kauf bezahlbar ist, entscheidet der Aufrufer an
//   derselben Menge, die der Verkauf hätte — nicht an einer anderen Schwelle.
const HOLD_TOL = 0.15;
function planTrade(persona, { wealth, want, heldValue, cash, reserve, refWealth, rnd }) {
  if (!(wealth > 0) || !(want >= 0)) return { side: 'hold', size: 0, reason: 'kein Vermögen' };
  const rel = (heldValue - want) / Math.max(1, want);
  if (want > 0 && Math.abs(rel) <= HOLD_TOL) return { side: 'hold', size: 0, reason: 'im Zielbereich' };
  if (want === 0 && heldValue <= 0) return { side: 'hold', size: 0, reason: 'im Zielbereich' };
  const side = heldValue < want ? 'buy' : 'sell';
  const gap = side === 'buy' ? want - heldValue : heldValue - want;
  // House Money: relatives Vermögen seit Start skaliert die Order (0,5 … 2,5-fach)
  const house = clamp(wealth / Math.max(1, refWealth || wealth), 0.5, 2.5);
  const drive = clamp(0.3 + 0.7 * Math.min(1, gap / Math.max(1, want)), 0.3, 1); // weit weg vom Ziel → größer
  // Erster Einstieg in eine Position komplett (sonst entsteht eine Kette aus vielen
  // kleinen Nachkäufen, die alle dieselbe Seite treffen); danach Anteil der Abweichung.
  const size = side === 'buy' && heldValue <= 0 ? 1 : clamp(persona.houseMoney * house * drive * (0.6 + rnd() * 0.8), 0.2, 1);
  return { side, size, reason: side === 'buy' ? 'unter Ziel' : 'über Ziel' };
}

// Stückzahl aus dem Wert-Antrieb und den Grenzen. Kauf und Verkauf symmetrisch:
// beide werden nur durch dieselben Marktgrenzen (Gegenseite, Orderdeckel) und
// durch die eigene Reserve begrenzt.
//   gapValue  Abstand zum Ziel in Cent, price Kurs in Cent
//   size      Anteil der Abweichung (planTrade)
//   minChunk  Stück: kleinste Order, damit das Auffüllen nicht in vielen Mini-Käufen
//             endet, die alle dieselbe Seite treffen (Default: 20 % der Abweichung)
//   maxByMoney  Stück, die die Reserve erlaubt (Verkauf: Stück im Depot)
//   limit       { available, cap } — Gegenseite im Buch, Ordergrößen-Grenze (null = keine)
function sizeOrder({ gapValue, price, size, minChunk, maxByMoney, limit }) {
  if (!(price > 0) || !(maxByMoney >= 1)) return 0;
  const gap = gapValue / price;
  const chunk = Math.max(1, Math.ceil(minChunk == null ? gap * 0.2 : minChunk));
  let amount = clamp(Math.max(Math.round(gap * size), chunk), 1, Math.min(Math.max(1, Math.floor(maxByMoney)), Math.max(1, Math.floor(gap))));
  if (limit) {
    if (Number.isFinite(limit.available)) amount = Math.min(amount, Math.floor(limit.available));
    if (limit.cap != null && Number.isFinite(limit.cap)) amount = Math.min(amount, Math.floor(limit.cap));
  }
  return amount >= 1 ? amount : 0;
}

// Größte Stückzahl einer Order, die der faire Kurs um höchstens maxStep hebt:
// F·e^(λ·q) ≤ F·(1 + maxStep) ⇔ q ≤ ln(1 + maxStep) / λ, λ = ln(1 + impactPct/100) / D.
// Rückgabe null = keine Grenze (kein Streubesitz oder impactPct ≤ 0).
//   depth       Streubesitz D (engine.impactDepth)
//   impactPct   Setting mm_impact_pct (Kursanstieg in %, wenn der ganze Streubesitz gekauft wird)
function maxStepShares(depth, impactPct, maxStep = 0.03) {
  if (!(depth > 0) || !(impactPct > 0) || !(maxStep > 0)) return null;
  const q = Math.floor(Math.log(1 + maxStep) / (Math.log(1 + impactPct / 100) / depth));
  return q >= 1 ? q : null;
}

// ---- Uhren ----------------------------------------------------------------------
// Poisson-Uhr: Abstand bis zur nächsten Entscheidung. lambdaPerMs = Rate je Spiel-ms.
function poissonInterval(lambdaPerMs, rnd) {
  if (!(lambdaPerMs > 0)) return Infinity;
  return -Math.log(Math.max(1e-12, 1 - rnd())) / lambdaPerMs;
}

// Ziel-Rate der ganzen Population in Orders je Spielminute.
const BASE_RATE_PER_MIN = 420; // bei bot_activity = 100
function populationRatePerMin(activity, baseRate = BASE_RATE_PER_MIN) {
  return Math.max(0, (Number(activity) || 0) / 100) * baseRate;
}

// Rate je Bot: die Population hält insgesamt ihre Zielrate, handlungsunfähige
// Bots zählen nicht, Overconfidence verteilt sie. Rückgabe je Spielminute.
function botRatePerMin(persona, activity, ableOcSum, baseRate) {
  if (!(ableOcSum > 0)) return 0;
  return populationRatePerMin(activity, baseRate) * persona.overconfidence / ableOcSum;
}

module.exports = {
  PERSONA_TYPES, personaFor, newsImpact, EVENT_KINDS, newsSignal, marketMood, bookImbalance, privateSignal, momentum, anchorBias, valueSignal,
  targetValue, planTrade, sizeOrder, maxStepShares, DEFAULT_TAKE_PROFIT, poissonInterval, populationRatePerMin, botRatePerMin, HOLD_TOL,
  BASE_RATE_PER_MIN
};
