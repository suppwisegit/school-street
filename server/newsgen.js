// NEWSGEN — automatische News aus MARKTDATEN, nicht aus dem Zufall (E018).
//
// Die Investment AG (Staatskasse/Aufsicht) beobachtet den Markt und meldet nur, was die Daten
// hergeben. Es gibt keinen Takt „alle n Sekunden eine Nachricht"; ohne Ausreißer bleibt es still.
// Alles läuft über SIM-Zeit: jobs.js ruft jede Wanduhr-Sekunde setMarket(Marktbild) und once(simNow).
//  1. Kurs-Ausreißer je Aktie: Änderung gegen den Kurs von vor 24 SIM-Stunden über ±5 %, ±10 %,
//     ±20 %. Je Schwelle, Aktie und Richtung eine News; frei erst unter der Hälfte (Hysterese). Keine ETFs.
//  2. Marktstimmung: Index ±3 % oder Breite ≥ 80 %, je Richtung, Hysterese, je Richtung höchstens
//     eine je 30 Sim-Minuten.
//  3. Gerücht: selten, über einen Wert, der sich in 30 Sim-Minuten ≥ 5 % bewegt hat, im ganzen
//     Markt höchstens eines je 45 Sim-Minuten.
// Die Kurs-Historie führt newsgen selbst, eine Probe je Sim-Minute, 24 Sim-Stunden je Aktie; denn
// price_history trägt Wanduhr-Zeiten (im Fast-Modus ≈ 100 Sim-Stunden je Wanduhr-Tag). Nach einem
// Neustart wird der Ring einmal aus price_history aufgefüllt (Wanduhr über die gemessene Spieluhr in
// Sim-Zeit umgerechnet). Reicht die Historie trotzdem nicht 24 Sim-Stunden zurück (jüngerer Wert),
// gilt der älteste bekannte Kurs als Bezug und der Text sagt „am Messbeginn“ statt „vor 24 Stunden“.
//  4. Dichte-Deckel: höchstens 4 Ausreißer-News je 10 Sim-Minuten über alle Aktien.
// Ereignis-News (IPO, Dividende, BaFin, Übernahme …) entstehen dort, wo sie passieren — hier nicht.
// Die Texte beschreiben nur, WAS ist; Gründe kennt der Server nicht. Zufall nur für die Textvariante.
// Wirkung auf die Bots: siehe unten (keine Rückkopplung).
//
// Aufbau: `createNewsGenerator` ist rein (Markt, Zufall und Ausgaben injiziert, keine DB). Der
// Modul-Export bindet dieselbe Logik an db.js und den Bus; das Marktbild kommt von jobs.js (setMarket)
// oder, wenn dort keins steht, direkt aus engine.tickerAll().
'use strict';

// Schwellen in Prozent. Einstellbar über das Setting `news_move_steps` (Zahl oder Liste, z. B.
// "5,10,20"), ohne Migration; fehlt es, gelten diese Werte.
const MOVE_STEPS = [5, 10, 20];
// Wirkung auf die Bots (impact, ganze Zahl −3…3) — keine Rückkopplung: Keine Nachricht schiebt den
// Kurs in die Richtung, die sie selbst ausgelöst hat. Gemessen im Rückkopplungs-Lauf (newsevents.test.js,
// Bots + Generator im Kreis, mit/ohne Wirkung): Ausreißer-News mit ±1 im Gleichlauf brachten im Mittel
// mehr 20-%-Auslöser und größere Ausschläge. Deshalb:
//   Ausreißer (alle Stufen): 0 — beschreibt nur, was ist.
//   Gerücht: ±1 in Richtung des Texts (und der Bewegung), höchstens eines je 45 Sim-Minuten.
//   Stimmung: ±1 gleichgerichtet, marktweit, frühestens alle 30 Sim-Minuten je Richtung.
const MOVE_IMPACT = () => 0;
const MOOD_IMPACT = (dir) => (dir === 'pos' ? 1 : -1);
const RUMOR_IMPACT = (dir) => (dir === 'pos' ? 1 : -1);
const MOOD_PCT = 3;          // Index-Änderung, ab der die Stimmung „sehr“ ist
const BREADTH_SHARE = 0.8;   // Anteil Aktien in einer Richtung
const MOOD_MIN_STOCKS = 5;   // Markt-Stimmung zählt erst ab so vielen Aktien (sonst ist eine Aktie „der Markt“)
const MOOD_MIN_PCT = 2;      // Breiten-Auslöser: der Index muss mindestens so weit gehen
const MOOD_COOLDOWN_MIN = 30;
const RUMOR_MOVE_PCT = 5;
const RUMOR_WINDOW_MIN = 30;
const RUMOR_SLACK_MIN = 5;   // … der Vergleichswert muss höchstens so viel älter sein (nach Pause kein Gerücht)
const RUMOR_COOLDOWN_MIN = 45;
const RUMOR_P_PER_SEC = 0.01;  // Wahrscheinlichkeit je Sim-Sekunde, sobald ein Kandidat dasteht und die Sperre frei ist
const DAY_MS = 24 * 60 * 60 * 1000; // ein Spieltag in Sim-Zeit
const EPS = 1e-6;            // Toleranz an den Schwellen gegen Rundungsfehler
// Dichte-Deckel: Driften alle Werte in dieselbe Richtung, sollen nicht dauernd Meldungen kommen.
// Höchstens so viele Ausreißer-News in 10 Sim-Minuten über alle Aktien; stehen mehr an, werden die
// kleinsten Bewegungen nicht gemeldet (gelten trotzdem als erledigt).
const MOVE_PER_WINDOW = 4;
const MOVE_WINDOW_MIN = 10;

const MIN = 60 * 1000;

// ---- Textvorlagen -------------------------------------------------------------
// Kurze Schülersprache, keine Gründe, keine Füller. Jede Zahl sagt, worauf sie sich bezieht:
// `vglA` = „von vor 24 Stunden“ / „vom Messbeginn“, `vglB` = „als vor 24 Stunden“ / „als am Messbeginn“,
// `p` = gerundete Prozentzahl ohne Vorzeichen, `s` = Aktie. Die Stärke der Worte passt zur Stufe:
// 5 % „legt zu“ / „gibt nach“, 10 % „deutlich“, 20 % „läuft davon“ / „stürzt ab“.
const VGL = { voll: { vglA: 'von vor 24 Stunden', vglB: 'als vor 24 Stunden' }, kurz: { vglA: 'vom Messbeginn', vglB: 'als am Messbeginn' } };

const MOVE_TPL = {
  'pos:0': [
    (s, p) => [`${s.ticker}: legt heute ${p} % zu`, `${s.name} steht ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: ${p} % im Plus`, `${s.name} notiert heute ${p} % höher ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs zieht leicht an`, `Der Kurs von ${s.name} liegt heute ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: gibt heute ${p} % her`, `Heute kostet eine Aktie von ${s.name} ${p} % mehr ${s.vglB}.`],
  ],
  'pos:1': [
    (s, p) => [`${s.ticker}: legt kräftig zu`, `${s.name} steht ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: ${p} % im Plus`, `${s.name} notiert heute ${p} % höher ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs zieht stark an`, `Der Kurs von ${s.name} liegt heute ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: deutlich im Plus`, `Heute kostet eine Aktie von ${s.name} ${p} % mehr ${s.vglB}.`],
  ],
  'pos:2': [
    (s, p) => [`${s.ticker}: läuft davon`, `${s.name} steht ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: riesig im Plus`, `${s.name} notiert heute ${p} % höher ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs schießt nach oben`, `Der Kurs von ${s.name} liegt heute ${p} % über dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: heute ${p} % höher`, `Heute kostet eine Aktie von ${s.name} ${p} % mehr ${s.vglB}.`],
  ],
  'neg:0': [
    (s, p) => [`${s.ticker}: gibt heute ${p} % nach`, `${s.name} steht ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: ${p} % im Minus`, `${s.name} notiert heute ${p} % tiefer ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs rutscht leicht ab`, `Der Kurs von ${s.name} liegt heute ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: leicht im Minus`, `Heute kostet eine Aktie von ${s.name} ${p} % weniger ${s.vglB}.`],
  ],
  'neg:1': [
    (s, p) => [`${s.ticker}: fällt deutlich`, `${s.name} steht ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: ${p} % im Minus`, `${s.name} notiert heute ${p} % tiefer ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs gibt stark nach`, `Der Kurs von ${s.name} liegt heute ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: kräftig im Minus`, `Heute kostet eine Aktie von ${s.name} ${p} % weniger ${s.vglB}.`],
  ],
  'neg:2': [
    (s, p) => [`${s.ticker}: stürzt ab`, `${s.name} steht ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: riesig im Minus`, `${s.name} notiert heute ${p} % tiefer ${s.vglB}.`],
    (s, p) => [`${s.ticker}: Kurs bricht ein`, `Der Kurs von ${s.name} liegt heute ${p} % unter dem Kurs ${s.vglA}.`],
    (s, p) => [`${s.ticker}: heute ${p} % tiefer`, `Heute kostet eine Aktie von ${s.name} ${p} % weniger ${s.vglB}.`],
  ],
};

// Stimmung, je Richtung zwei Textarten nach Auslöser: `index` (der Index geht weit) und `breite` (fast
// alle Aktien gehen). Der Text redet nur über das, was die Daten zeigen. `d` = { pct, breite, vglA, vglB }.
const MOOD_TPL = {
  pos: {
    index: [
      (d) => ['Der Markt ist heute klar im Plus', `Der Index liegt ${d.pct} % über dem Stand ${d.vglA}.`],
      (d) => ['Ein starker Börsentag', `Der Index steht heute ${d.pct} % höher ${d.vglB}.`],
      (d) => ['Der ganze Markt liegt vorn', `Der Index notiert ${d.pct} % über dem Stand ${d.vglA}.`],
      (d) => ['Der Index steht deutlich höher', `Heute liegt der Markt ${d.pct} % über dem Stand ${d.vglA}.`],
    ],
    breite: [
      (d) => ['Fast alle Kurse steigen', `${d.breite}. Der Index steht ${d.pct} % höher ${d.vglB}.`],
      (d) => ['Der ganze Markt ist heute im Plus', `${d.breite}. Der Index liegt ${d.pct} % über dem Stand ${d.vglA}.`],
      (d) => ['Bei fast allen Aktien geht es hoch', `${d.breite}. Der Index notiert ${d.pct} % höher ${d.vglB}.`],
      (d) => ['Kaum eine Aktie fällt heute', `${d.breite}. Der Index steht ${d.pct} % über dem Stand ${d.vglA}.`],
    ],
  },
  neg: {
    index: [
      (d) => ['Der Markt ist heute klar im Minus', `Der Index liegt ${d.pct} % unter dem Stand ${d.vglA}.`],
      (d) => ['Ein schwacher Börsentag', `Der Index steht heute ${d.pct} % tiefer ${d.vglB}.`],
      (d) => ['Der ganze Markt liegt hinten', `Der Index notiert ${d.pct} % unter dem Stand ${d.vglA}.`],
      (d) => ['Der Index steht deutlich tiefer', `Heute liegt der Markt ${d.pct} % unter dem Stand ${d.vglA}.`],
    ],
    breite: [
      (d) => ['Fast alle Kurse fallen', `${d.breite}. Der Index steht ${d.pct} % tiefer ${d.vglB}.`],
      (d) => ['Der ganze Markt ist heute im Minus', `${d.breite}. Der Index liegt ${d.pct} % unter dem Stand ${d.vglA}.`],
      (d) => ['Bei fast allen Aktien geht es runter', `${d.breite}. Der Index notiert ${d.pct} % tiefer ${d.vglB}.`],
      (d) => ['Kaum eine Aktie steigt heute', `${d.breite}. Der Index steht ${d.pct} % unter dem Stand ${d.vglA}.`],
    ],
  },
};

// Gerüchte: als Frage, ohne Behauptung über Gründe; die Richtung des Texts folgt der Bewegung der
// letzten halben Stunde (`p` = Bewegung in 30 Sim-Minuten) — und so wirkt das Gerücht auch auf die Bots.
const RUMOR_TPL = {
  pos: [
    (s, p) => [`Investment AG hört: Geheimtipp ${s.ticker}?`, `Die Investment AG hört, einige empfehlen ${s.name} weiter. Der Kurs ist in einer halben Stunde um ${p} % gestiegen. Bewiesen ist nichts.`],
    (s, p) => [`Investment AG hört: ${s.ticker} läuft weiter?`, `Die Investment AG hört, einige rechnen bei ${s.name} mit mehr. Der Kurs ist in einer halben Stunde um ${p} % gestiegen. Stimmen muss das nicht.`],
    (s, p) => [`Investment AG hört: viele wollen ${s.ticker}?`, `Die Investment AG hört, in der Pause wird über ${s.name} geredet. Der Kurs ist in einer halben Stunde um ${p} % gestiegen. Ein Beweis fehlt.`],
    (s, p) => [`Investment AG hört: mehr Plus bei ${s.ticker}?`, `Die Investment AG hört, einige halten ${s.name} für günstig. Der Kurs ist in einer halben Stunde um ${p} % gestiegen. Sicher ist das nicht.`],
  ],
  neg: [
    (s, p) => [`Investment AG hört: ${s.ticker} gibt weiter nach?`, `Die Investment AG hört, einige raten zum Verkauf von ${s.name}. Der Kurs ist in einer halben Stunde um ${p} % gefallen. Bewiesen ist nichts.`],
    (s, p) => [`Investment AG hört: viele verkaufen ${s.ticker}?`, `Die Investment AG hört, einige wollen ihre Aktien von ${s.name} loswerden. Der Kurs ist in einer halben Stunde um ${p} % gefallen. Stimmen muss das nicht.`],
    (s, p) => [`Investment AG hört: ${s.ticker} fällt weiter?`, `Die Investment AG hört, in der Pause wird über ${s.name} geredet. Der Kurs ist in einer halben Stunde um ${p} % gefallen. Ein Beweis fehlt.`],
    (s, p) => [`Investment AG hört: mehr Minus bei ${s.ticker}?`, `Die Investment AG hört, einige halten ${s.name} für zu teuer. Der Kurs ist in einer halben Stunde um ${p} % gefallen. Sicher ist das nicht.`],
  ],
};

const tpl = ([title, body]) => ({ title, body });
// Alle Vorlagen mit Beispielwerten je Pool: { pool: [{ title, body }] }.
function renderTemplates() {
  const out = {};
  const s = { ...VGL.voll, ticker: 'MENSA', name: 'Mensa AG' };
  for (const dir of ['pos', 'neg']) {
    for (const i of [0, 1, 2]) out[`move:${dir}:${MOVE_STEPS[i]}`] = MOVE_TPL[`${dir}:${i}`].map((f) => tpl(f(s, MOVE_STEPS[i])));
    out[`mood:index:${dir}`] = MOOD_TPL[dir].index.map((f) => tpl(f({ ...VGL.voll, pct: MOOD_PCT, breite: `9 von 10 Aktien liegen im ${dir === 'pos' ? 'Plus' : 'Minus'}` })));
    out[`mood:breite:${dir}`] = MOOD_TPL[dir].breite.map((f) => tpl(f({ ...VGL.kurz, pct: MOOD_MIN_PCT, breite: `9 von 10 Aktien liegen im ${dir === 'pos' ? 'Plus' : 'Minus'}` })));
    out[`rumor:${dir}`] = RUMOR_TPL[dir].map((f) => tpl(f(s, RUMOR_MOVE_PCT)));
  }
  return out;
}
const templateCounts = () => Object.fromEntries(Object.entries(renderTemplates()).map(([k, v]) => [k, v.length]));

// ---- Hilfen -------------------------------------------------------------------
// Setting `news_move_steps` (Zahl, Liste oder „5,10,20“) → aufsteigende Prozentwerte über 0.
function readSteps(raw) {
  let list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\s]+/) : [raw];
  list = list.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1000);
  if (list.length === 0) return MOVE_STEPS;
  return [...new Set(list)].sort((a, b) => a - b);
}
// Eine Änderung „steht auf“ der Schwelle, auch wenn 9,5 / 10 intern 4,999999… % ergibt.
const onStep = (abs, step) => abs >= step - EPS;
const pct = (x) => Math.round(Math.abs(x) * 100 + EPS);
const unit = (rnd) => Math.min(Math.max(rnd(), 0), 0.999999);

// Textvariante: zufällig, aber nicht dieselbe wie zuletzt im Pool.
function pick(pool, rnd, st, key) {
  const n = pool.length;
  let i = Math.floor(unit(rnd) * n);
  if (n > 1 && i === st.lastTpl[key]) i = (i + 1) % n;
  st.lastTpl[key] = i;
  return i;
}
const moveTpl = (dir, i) => MOVE_TPL[`${dir}:${Math.min(i, 2)}`]; // mehr als drei Stufen: Textart der höchsten

// ---- Generator ----------------------------------------------------------------
// deps: { market: () => Zeilen [{ id, ticker, name, type, last, shares? }] | null | undefined,
//        history?: (id) => [{ t, p }] ältere Kurse in Sim-Zeit (null = noch nicht bereit),
//        settings: () => ({ trading_paused?, news_interval_sec?, news_move_steps? }),
//        addNews(kind, title, body, securityId, impact) => Zeile, emit(msg) }
function createNewsGenerator(deps) {
  // Fester Zustand: Sammlungen wachsen höchstens mit der Zahl der Aktien × 24 Sim-Stunden.
  const st = {
    lastSim: null, count: 0,
    day: new Map(),         // id → [{ t, p }] Kursproben, eine je Sim-Minute, älteste zuerst, höchstens 24 Sim-h
    armed: new Map(),       // id → { pos: [je Schwelle], neg: [je Schwelle] }
    moodLatch: { pos: false, neg: false }, lastMoodAt: { pos: null, neg: null },
    lastRumorAt: null, lastSimPrev: null,
    moveTimes: [],        // Sim-Zeiten der letzten Ausreißer-News (höchstens MOVE_PER_WINDOW)
    warmed: new Set(),    // Aktien, deren Ring schon aus der Kurs-Historie aufgefüllt wurde
    lastTpl: {},
  };

  // Nur Aktien mit brauchbarem Kurs; ETFs bleiben außen vor.
  function rows() {
    const all = deps.market();
    if (!Array.isArray(all)) return [];
    return all.filter((r) => r && r.type === 'stock' && Number.isInteger(r.id) && r.last > 0);
  }

  // Kursprobe je Sim-Minute sichern; Bezug = die älteste Probe, die mindestens 24 Sim-Stunden alt ist
  // (oder die erste überhaupt). Liefert { r, chg } mit chg = Änderung gegen den Bezug.
  function sample(list, simNowMs) {
    const out = [];
    for (const r of list) {
      let ring = st.day.get(r.id);
      if (!ring) { ring = []; st.day.set(r.id, ring); }
      // Nach einem Neustart beginnt die Historie beim ersten Takt. deps.history(id) liefert — in Sim-Zeit —
      // ältere Kurse aus der Kurs-Historie; sie werden einmal vorangestellt.
      if (ring.length === 1 && !st.warmed.has(r.id) && typeof deps.history === 'function') {
        const alt = deps.history(r.id);
        if (Array.isArray(alt)) {
          st.warmed.add(r.id);
          for (let k = alt.length - 1; k >= 0; k--) if (alt[k].p > 0 && alt[k].t < ring[0].t) ring.unshift({ t: alt[k].t, p: alt[k].p });
        }
      }
      if (ring.length === 0 || simNowMs - ring[ring.length - 1].t >= MIN - EPS) {
        ring.push({ t: simNowMs, p: r.last });
        // Vorne kürzen, aber die Probe an der 24-h-Grenze bleibt als Bezug stehen.
        while (ring.length > 2 && ring[1].t <= simNowMs - DAY_MS) ring.shift();
      }
      const ref = ring[0];
      out.push({ r, ring, ref, full: simNowMs - ref.t >= DAY_MS - EPS, chg: r.last / ref.p - 1 });
    }
    return out;
  }

  function write(n) {
    const row = deps.addNews(n.kind, n.title, n.body, n.secId, n.impact);
    // Die Zeile steht; ein Fehler beim Push darf sie nicht verbergen. addNews wirft weiter.
    try { deps.emit({ type: 'news', news: row }); }
    catch (e) { console.error(`[newsgen] Push fehlgeschlagen id=${row.id}: ${e.message}`); }
    st.count++;
    return { ...row, trigger: n.trigger };
  }

  // 1) Kurs-Ausreißer. Plan je Aktie: { n: News, commit() } oder nur { commit() } (Hysterese).
  function planMoves(sampled, steps, simNowMs) {
    const plans = [], cand = [];
    for (const { r, chg, full } of sampled) {
      let a = st.armed.get(r.id);
      if (!a || a.pos.length !== steps.length) a = { pos: steps.map(() => true), neg: steps.map(() => true) };
      const dir = chg >= 0 ? 'pos' : 'neg';
      const abs = Math.abs(chg) * 100;
      // Hysterese: eine gemeldete Schwelle wird erst wieder frei, wenn die Änderung unter ihre Hälfte fällt.
      const next = { pos: a.pos.map((free, i) => free || !onStep(abs, steps[i] / 2)), neg: a.neg.map((free, i) => free || !onStep(abs, steps[i] / 2)) };
      let hit = -1;
      for (let i = 0; i < steps.length; i++) if (onStep(abs, steps[i]) && next[dir][i]) hit = i;
      if (hit < 0) { plans.push({ commit: () => st.armed.set(r.id, next) }); continue; }
      // Höchste Stufe zuerst; Stufen darunter gelten als gemeldet, damit ein Sprung nicht drei Meldungen gibt.
      next[dir] = next[dir].map((free, i) => i > hit);
      cand.push({ r, chg, dir, hit, abs, full, next, step: steps[hit] });
    }
    // Dichte-Deckel: die größten Bewegungen zuerst, höchstens so viele, wie das 10-Minuten-Fenster frei hat.
    cand.sort((x, y) => y.abs - x.abs);
    st.moveTimes = st.moveTimes.filter((t) => simNowMs - t < MOVE_WINDOW_MIN * MIN);
    const frei = Math.max(0, MOVE_PER_WINDOW - st.moveTimes.length);
    cand.forEach((c, i) => {
      if (i >= frei) { plans.push({ commit: () => st.armed.set(c.r.id, c.next) }); return; } // nicht gemeldet, gilt als erledigt
      const pool = moveTpl(c.dir, c.hit);
      const [title, body] = pool[pick(pool, rnd, st, `move:${c.dir}:${c.hit}`)]({ ticker: c.r.ticker, name: c.r.name, ...(c.full ? VGL.voll : VGL.kurz) }, pct(c.chg));
      plans.push({ commit: () => { st.armed.set(c.r.id, c.next); st.moveTimes.push(simNowMs); },
        n: { kind: 'news', title, body, secId: c.r.id, impact: MOVE_IMPACT(), trigger: `move:${c.dir}:${c.step}` } });
    });
    return plans;
  }

  // 2) Marktstimmung aus Index (nach Aktienzahl gewichtet) und Breite; je Richtung geriegelt.
  function planMood(sampled, simNowMs) {
    const n = sampled.length;
    if (n < MOOD_MIN_STOCKS) return null;
    let num = 0, den = 0, up = 0, down = 0, full = 0;
    for (const { chg, r, full: f } of sampled) {
      const w = Number.isFinite(r.shares) && r.shares > 0 ? r.shares : 1;
      num += chg * w; den += w; if (f) full++;
      if (chg > 0.005) up++;
      else if (chg < -0.005) down++;
    }
    const idx = num / den, absIdx = Math.abs(idx) * 100;
    const upShare = up / n, downShare = down / n;
    // Auslöser merken: Der Text darf nur über das reden, was die Daten auch zeigen.
    let dir = null, art = null;
    if (absIdx >= MOOD_PCT) { dir = idx > 0 ? 'pos' : 'neg'; art = 'index'; }
    else if (absIdx >= MOOD_MIN_PCT && upShare >= BREADTH_SHARE) { dir = 'pos'; art = 'breite'; }
    else if (absIdx >= MOOD_MIN_PCT && downShare >= BREADTH_SHARE) { dir = 'neg'; art = 'breite'; }
    const extreme = (d) => (d === 'pos' ? idx : -idx) * 100 >= MOOD_PCT / 2
      || (d === 'pos' ? upShare : downShare) >= BREADTH_SHARE - 0.15;
    for (const d of ['pos', 'neg']) if (st.moodLatch[d] && !extreme(d)) st.moodLatch[d] = false;
    // Eine offene Riegel der Gegenrichtung blockiert nicht: nach „klar im Plus“ wird ein Crash gemeldet.
    if (dir === null || st.moodLatch[dir]) return null;
    if (st.lastMoodAt[dir] !== null && simNowMs - st.lastMoodAt[dir] < MOOD_COOLDOWN_MIN * MIN) return null;
    const pool = MOOD_TPL[dir][art];
    const data = { pct: pct(idx), ...(full === n ? VGL.voll : VGL.kurz),
      breite: `${dir === 'pos' ? up : down} von ${n} Aktien liegen im ${dir === 'pos' ? 'Plus' : 'Minus'}` };
    const [title, body] = pool[pick(pool, rnd, st, `mood:${art}:${dir}`)](data);
    return { commit: () => { st.moodLatch[dir] = true; st.lastMoodAt[dir] = simNowMs; },
      n: { kind: 'news', title, body, secId: null, impact: MOOD_IMPACT(dir), trigger: `mood:${art}:${dir}` } };
  }

  // 3) Gerücht: Kandidaten haben sich seit der Probe vor 30 Sim-Minuten ≥ 5 % bewegt; Text und Wirkung folgen der Richtung.
  function planRumor(sampled, simNowMs) {
    if (sampled.length === 0) return null;
    if (st.lastRumorAt !== null && simNowMs - st.lastRumorAt < RUMOR_COOLDOWN_MIN * MIN) return null;
    const cands = [];
    for (const { r, ring } of sampled) {
      // Von hinten die letzte Probe suchen, die mindestens 30 Sim-Minuten alt ist.
      for (let i = ring.length - 1; i >= 0; i--) {
        if (simNowMs - ring[i].t >= RUMOR_WINDOW_MIN * MIN - EPS) {
          const m = r.last / ring[i].p - 1;
          if (simNowMs - ring[i].t <= (RUMOR_WINDOW_MIN + RUMOR_SLACK_MIN) * MIN && Math.abs(m) * 100 >= RUMOR_MOVE_PCT - EPS) cands.push({ r, m });
          break;
        }
      }
    }
    // Wahrscheinlichkeit über die verstrichene Sim-Zeit (im Fast-Modus liegen zwischen zwei Takten 100 s).
    const dtSec = Math.min(Math.max((simNowMs - st.lastSimPrev) / 1000, 0), 60);
    if (cands.length === 0 || rnd() >= 1 - Math.pow(1 - RUMOR_P_PER_SEC, dtSec)) return null;
    const { r, m } = cands[Math.floor(unit(rnd) * cands.length)];
    const dir = m > 0 ? 'pos' : 'neg';
    const pool = RUMOR_TPL[dir];
    const [title, body] = pool[pick(pool, rnd, st, `rumor:${dir}`)]({ ticker: r.ticker, name: r.name }, pct(m));
    const impact = RUMOR_IMPACT(dir);
    return { commit: () => { st.lastRumorAt = simNowMs; }, n: { kind: 'rumor', title, body, secId: r.id, impact, trigger: `rumor:${dir}` } };
  }

  let rnd = Math.random;

  // Ruft jobs.js mit der Sim-Zeit auf. Liefert die in diesem Takt geschriebenen Zeilen (mit `trigger`).
  // Der Zustand (Hysterese, Sperren) wird erst nach dem erfolgreichen Schreiben übernommen: Wirft
  // addNews mitten im Takt, kommt der Rest im nächsten Takt — nichts ist verloren.
  function once(simNowMs, r = Math.random) {
    if (!Number.isFinite(simNowMs)) { st.lastSim = null; return []; }
    rnd = r;
    const cfg = (typeof deps.settings === 'function' && deps.settings()) || {};
    // Uhr steht neu (Sprung zurück): Historie und Sperren passen nicht mehr, die Hysterese bleibt.
    if (st.lastSim !== null && simNowMs < st.lastSim) {
      st.day.clear(); st.warmed.clear(); st.lastRumorAt = null; st.lastMoodAt = { pos: null, neg: null };
    }
    st.lastSimPrev = st.lastSim === null ? simNowMs : st.lastSim;
    st.lastSim = simNowMs;
    const list = rows();
    const sampled = sample(list, simNowMs);
    // news_interval_sec = 0 schaltet ab; während der Handelspause wird nichts gemeldet. Die Kurs-
    // Historie läuft in beiden Fällen weiter (Kurse stehen dann still), damit der Bezug nicht verloren geht.
    if (Number(cfg.news_interval_sec) === 0 || Number(cfg.trading_paused) === 1) { st.lastSim = simNowMs; return []; }
    const plans = planMoves(sampled, readSteps(cfg.news_move_steps), simNowMs);
    const mood = planMood(sampled, simNowMs);
    const rumor = planRumor(sampled, simNowMs);
    // Sammlungen auf die aktuellen Aktien begrenzen.
    const ids = new Set(list.map((x) => x.id));
    for (const id of st.day.keys()) if (!ids.has(id)) { st.day.delete(id); st.warmed.delete(id); }
    for (const id of st.armed.keys()) if (!ids.has(id)) st.armed.delete(id);

    const out = [];
    for (const p of [...plans, mood, rumor]) {
      if (!p || !p.commit) continue;
      if (p.n) out.push(write(p.n));
      p.commit();
    }
    return out;
  }

  function state() {
    return { count: st.count, lastSim: st.lastSim, mood: Object.keys(st.moodLatch).filter((d) => st.moodLatch[d]),
      lastMoodAt: st.lastMoodAt, lastRumorAt: st.lastRumorAt, tracked: st.armed.size };
  }
  return { once, state };
}

// ---- Bindung an db.js, engine und den Bus (lazy, damit die reine Logik ohne DB ladbar bleibt) ----
// Marktbild: jobs.js ruft vor jedem Takt setMarket(marketSnapshot()) — Zeilen aus engine.tickerAll()
// ({ id, ticker, type, last, ref, chgPct }). newsgen braucht davon id/type/last; Namen und Aktienzahlen
// kommen aus der Tabelle (einmal gelesen, neu gelesen bei unbekannter id oder nach einer Minute).
// Steht kein frisches Marktbild (z. B. Tests ohne jobs.js), liest newsgen selbst tickerAll().
const SNAPSHOT_MAX_AGE_MS = 60000;
const SEC_CACHE_MS = 60000;
const MAX_TICK_GAP_MS = 5000;
let bound = null;
let snapshot = null;
// Spieluhr: aus zwei aufeinanderfolgenden Takten folgt der Maßstab (Sim-ms je Wanduhr-ms), damit die
// Wanduhr-Zeiten der Kurs-Historie in Sim-Zeit umgerechnet werden können. ANNAHME: Der heute gemessene
// Maßstab galt auch für die gespeicherten Kurse — nach einem Wechsel von Normal auf Fast stimmt das für
// die erste Viertelstunde nicht genau, der Bezug bleibt aber ein echter früherer Kurs.
const uhr = { sim: null, wall: null, scale: null };
function setMarket(snap) { snapshot = snap && Array.isArray(snap.securities) ? snap : null; }

function generator() {
  if (!bound) {
    const { db, getSettings, addNews } = require('./db');
    const bus = require('./bus');
    const engine = require('./engine');
    const query = db.prepare("SELECT id, ticker, name, type, total_shares AS shares FROM securities WHERE type = 'stock' AND status = 'active' ORDER BY id");
    let cache = new Map(), cacheAt = 0;
    const stocks = () => cache;
    const refresh = (ids) => {
      if (Date.now() - cacheAt < SEC_CACHE_MS && ids.every((id) => cache.has(id))) return;
      cache = new Map(query.all().map((s) => [s.id, s])); cacheAt = Date.now();
    };
    bound = createNewsGenerator({
      market: () => {
        const snap = snapshot && Date.now() - snapshot.now <= SNAPSHOT_MAX_AGE_MS ? snapshot : null;
        const tick = snap ? snap.securities.filter((t) => t.type === 'stock') : engine.tickerAll().filter((t) => t.type === 'stock');
        refresh(tick.map((t) => t.id));
        return tick.map((t) => ({ ...stocks().get(t.id), last: t.last }));
      },
      settings: () => getSettings(),
      history: (id) => kursHistorie(id, db),
      addNews,
      emit: (m) => bus.emit(m),
    });
  }
  return bound;
}

// Ältere Kurse eines Wertes als Sim-Zeit-Proben, eine je Sim-Minute, höchstens 24 Sim-Stunden zurück.
// null = Maßstab noch nicht bekannt (im nächsten Takt erneut).
function kursHistorie(id, db) {
  if (uhr.scale === null || uhr.sim === null) return null;
  const liste = db.prepare('SELECT ts, price FROM price_history WHERE security_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
    .all(id, Math.floor(uhr.wall - DAY_MS / uhr.scale * 1.05), uhr.wall);
  if (liste.length > 20000) return [];
  const jeMinute = new Map();
  for (const r of liste) jeMinute.set(Math.floor((uhr.sim - (uhr.wall - r.ts) * uhr.scale) / MIN), r.price);
  return [...jeMinute].map(([m, p]) => ({ t: m * MIN, p }));
}

function once(simNowMs, rnd) {
  const wall = Date.now();
  if (uhr.sim !== null && wall > uhr.wall && wall - uhr.wall <= MAX_TICK_GAP_MS && simNowMs >= uhr.sim) {
    const sc = (simNowMs - uhr.sim) / (wall - uhr.wall);
    if (Number.isFinite(sc) && sc > 0 && sc <= 1000) uhr.scale = sc;
  }
  uhr.sim = simNowMs; uhr.wall = wall;
  return generator().once(simNowMs, rnd);
}
function state() { return generator().state(); }
function reset() { bound = null; snapshot = null; uhr.sim = null; uhr.wall = null; uhr.scale = null; }

module.exports = { createNewsGenerator, once, state, reset, setMarket, templateCounts, renderTemplates };
