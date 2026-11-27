// ============================================================================
// MMATH — Market Maker V3: reine Mathematik der Orderflow-Preisfindung.
// ----------------------------------------------------------------------------
// Der faire Kurs F je Wertpapier bewegt sich ausschließlich durch den netto
// gerichteten Orderflow der Teilnehmer: F ← F · e^(λ·q). Öffentlicher Kurs und
// Preis-Band leiten sich nur aus F ab; die MM-Staffel folgt derselben
// Kurswirkung wie der Flow.
//
// Rein: kein DB, keine Abhängigkeiten, kein eigener Zufall. Zufall kommt als
// Funktion rnd() herein (Zahl in [0,1)); ladder() ruft sie in fester
// Reihenfolge auf — je Stufe erst Größe, dann Abstand.
//
// Einheiten: fair = fairer Kurs F, ganzzahlig in Milli-Cent (1 Credit = 100 000)
//            tick = kleinste Preisgrenze in Cent; alle übrigen Preise in Cent
//
// Aufbau (von innen nach außen):
//   0) Argumente        checkNumber / checkTick / draw: endliche Zahlen, tick > 0, rnd in [0, 1)
//   1) Tick-Rundung    floorTick / ceilTick
//   2) Kursupdate      depthOf, impactLambda, maxOrderSize, applyFlow
//   3) Kurs & Band     publicPrice, band, inBand
//   4) Quotes          ladder (Aktien), flatQuotes (ETF)
// ============================================================================
const MILLI = 1000; // Milli-Cent je Cent

// ---------------------------------------------------------------------------
// 0) ARGUMENTPRÜFUNG
// ---------------------------------------------------------------------------
// Nicht endliche Zahlen (NaN, ±Infinity) und tick ≤ 0 werden nicht still
// verrechnet (applyFlow = NaN, leere Staffel), sondern gemeldet.
function checkNumber(name, value) {
  if (!Number.isFinite(value)) throw new RangeError(`mmath: ${name} muss eine endliche Zahl sein (erhalten ${value})`);
  return value;
}
function checkTick(name, tick) {
  if (!Number.isFinite(tick) || tick <= 0) throw new RangeError(`mmath: ${name} muss > 0 sein (erhalten ${tick})`);
  return tick;
}
// Ein Zufallswert aus rnd(): Zahl in [0, 1), sonst kein stiller Unsinn (leere Staffel).
function draw(rnd) {
  const r = rnd();
  if (!(typeof r === 'number' && r >= 0 && r < 1)) throw new RangeError(`mmath: rnd muss eine Zahl in [0, 1) liefern (erhalten ${r})`);
  return r;
}

// ---------------------------------------------------------------------------
// 1) TICK-RUNDUNG
// ---------------------------------------------------------------------------
// Auf Vielfache von tick — Geld (bid) nach unten, Brief (ask) nach oben:
// der MM kauft nie teurer und verkauft nie billiger als berechnet.
// ± 1e-9 (in Ticks): ein Wert, der rechnerisch genau auf einem Tick liegt,
// rutscht nicht durch Float-Rauschen auf den nächsten (20 · 0,98 = 19,60).
function floorTick(p, tick) { return Math.floor(p / tick + 1e-9) * tick; }
function ceilTick(p, tick) { return Math.ceil(p / tick - 1e-9) * tick; }

// ---------------------------------------------------------------------------
// 2) KURSUPDATE — der einzige Weg, auf dem sich F ändert.
// ---------------------------------------------------------------------------
// Streubesitz D = Gesamtaktien − Gründerbestand, mindestens 1. Nur er ist
// handelbar, nur er bestimmt, wie stark ein Stück den Kurs bewegt.
function depthOf(totalShares, founderHolding) {
  checkNumber('totalShares', totalShares); checkNumber('founderHolding', founderHolding);
  return Math.max(1, totalShares - Math.max(0, founderHolding));
}

// Kurswirkung je Stück: λ = ln(1 + p) / D mit p = mm_impact_pct/100.
// Wird netto der ganze Streubesitz gekauft (q = D), steigt F um genau p %.
function impactLambda(depth, impactPct) {
  checkNumber('depth', depth); checkNumber('impactPct', impactPct);
  return Math.log(1 + impactPct / 100) / Math.max(1, depth);
}

// Größte Stückzahl, die eine Order ausführen darf, ohne F um mehr als
// B = bandPct % zu bewegen: F·e^(λ·q) ≤ F·(1 + B) ⇔ q ≤ ln(1 + B) / λ.
// λ ≤ 0: keine Stückgrenze (negative Impact-Werte klemmt die Engine vor der Übergabe auf 0).
function maxOrderSize(depth, impactPct, bandPct) {
  checkNumber('bandPct', bandPct);
  const lambda = impactLambda(depth, impactPct);
  if (!(lambda > 0)) return Number.MAX_SAFE_INTEGER; // keine Stückgrenze
  const b = Math.max(0, bandPct); // bandPct <= 0: keine Bewegung erlaubt -> log(1 + pct/100) bleibt definiert
  const raw = Math.log(1 + b / 100) / lambda;
  return Math.max(1, Math.floor(raw + 1e-9)); // 1e-9 fängt 399,99999999999994 ab, verschiebt sonst nichts
}

// F ← round(F · e^(λ·q)); q = ausgeführte Stückzahl, Kauf +, Verkauf −.
// Nur Σq zählt (pfadunabhängig), nie der Limitpreis. F bleibt ≥ 1.
function applyFlow(fair, lambda, signedQty) {
  checkNumber('fair', fair); checkNumber('lambda', lambda); checkNumber('signedQty', signedQty);
  return Math.max(1, Math.round(fair * Math.exp(lambda * signedQty)));
}

// ---------------------------------------------------------------------------
// 3) ÖFFENTLICHER KURS & PREIS-BAND
// ---------------------------------------------------------------------------
// Öffentlicher Kurs K = F auf Tick gerundet (book.last), mindestens 1 Tick.
function publicPrice(fair, tick) {
  checkNumber('fair', fair); checkTick('tick', tick);
  return Math.max(tick, Math.round(fair / MILLI / tick) * tick);
}

// Band um F: F ± B, mindestens 2 Ticks je Seite, Grenzen nach außen auf Tick.
// Limits müssen darin liegen, gefüllt wird nur darin — keine Order bewegt den
// Kurs um mehr als B. ref = K (für die Fehlermeldung).
function band(fair, tick, bandPct) {
  checkNumber('fair', fair); checkTick('tick', tick); checkNumber('bandPct', bandPct);
  const fc = fair / MILLI; // F in Cent
  const span = Math.max(Math.round(fc * bandPct / 100), 2 * tick);
  return {
    ref: publicPrice(fair, tick),
    min: Math.max(tick, floorTick(fc - span, tick)),
    max: ceilTick(fc + span, tick)
  };
}

// Grenzen einschließlich.
function inBand(b, price) { return price >= b.min && price <= b.max; }

// ---------------------------------------------------------------------------
// 4) QUOTES
// ---------------------------------------------------------------------------
// Aktien-Staffel um F: { bids, asks } aus { price, size }; bids absteigend,
// asks aufsteigend. Jede Stufe liegt an der Mitte ihrer eigenen Menge: Wer sie
// komplett kauft, handelt im Mittel zum fairen Kurs der Stufe (F·(1 + λ·X) vor
// ihr, F·(1 + λ·(X + s)) nach ihr) — ein Hin- und Rückverkauf über die Staffel
// wirft keinen risikofreien Gewinn ab.
// Alle Preise im Band; eine Seite, die es verlässt, wird nicht mehr beschickt.
// minTotal > 0 (V4): hinter den eingestellten Stufen folgen Anschluss-Stufen, bis
// die Angebotsseite minTotal Stück hält oder das Band endet. Eine Anschluss-Stufe,
// die nicht mehr ganz ins Band passt, wird auf den Restraum bis zur Bandkante
// verkleinert (Teil-Quote statt Lücke) — so hält die Angebotsseite nahe am
// geometrischen Maximum, statt am Größen-Jitter zu hängen. Ohne minTotal (0)
// bleibt alles wie zuvor; die ersten Stufen sind in keinem Fall betroffen.
const LADDER_MAX_LEVELS = 50;  // Anschluss-Stufen enden spätestens hier, wie engine.js MM_LEVELS_MAX: bei Stufen von 1 Stück sonst hunderte Orders je Seite
const LADDER_MAX_LEVELS_TOTAL = (levels) => Math.max(levels, 3 * levels, LADDER_MAX_LEVELS); // harte Obergrenze insgesamt
const LADDER_EXTRA_MIN = 5;   // kleinste Anschluss-Stufe; darunter ist der Restraum verbraucht
function ladder({ fair, tick, lambda, halfSpreadBp, levels, size, sizeStep, bandPct, jitterBp, sizeJitter, minTotal = 0, rnd }) {
  for (const [name, wert] of Object.entries({ fair, lambda, halfSpreadBp, levels, size, sizeStep, bandPct, jitterBp, sizeJitter, minTotal })) checkNumber(name, wert);
  checkTick('tick', tick);
  if (typeof rnd !== 'function') throw new TypeError(`mmath: rnd muss eine Funktion sein (erhalten ${typeof rnd})`);
  levels = Math.floor(levels); // nur ganze Stufen
  const b = band(fair, tick, bandPct);
  const f = fair / MILLI;       // F in Cent
  const h = halfSpreadBp / 1e4; // halber Spread
  const j = jitterBp / 1e4;     // Abstands-Jitter ±
  // Größter Abstand von F, den beide Seiten gerade noch im Band liegen: Brief ≤ b.max, Geld ≥ b.min
  const maxDist = Math.min(b.max / f - 1, 1 - b.min / f);
  const bids = [], asks = [];
  let X = 0;                          // bereits liegende Menge (Summe der Stufen)
  let askSum = 0;                     // Stück auf der Angebotsseite im Band
  let askOpen = true, bidOpen = true; // Seite liegt noch im Band
  // Anschluss-Stufen: nur bis max(50, 3 · levels) und nur, wenn das Ziel in ihrem Rahmen
  // überhaupt erreichbar ist — sonst bliebe bei winzigen Stufen nur ein Riesenbuch ohne Gewinn.
  // Erreichbarkeit: hält selbst die nominelle Leiste (ohne Jitter, ohne Band) bis zur Stufengrenze
  // nicht minTotal, bleibt es bei der eingestellten Leiste.
  const maxLevels = Math.max(LADDER_MAX_LEVELS, 3 * levels);
  let nominal = 0;
  for (let i = 0; minTotal > 0 && i < maxLevels; i++) nominal += Math.max(1, Math.round(size + i * sizeStep));
  const extend = minTotal > 0 && nominal >= minTotal;
  for (let i = 0; i < LADDER_MAX_LEVELS_TOTAL(levels) && (i < levels || (i < maxLevels && extend && askOpen && askSum < minTotal)); i++) {
    // Stufengröße: size + i·sizeStep, um ±sizeJitter gestreut, mindestens 1
    let s = Math.max(1, Math.round((size + i * sizeStep) * (1 + (2 * draw(rnd) - 1) * sizeJitter)));
    const jit = (2 * draw(rnd) - 1) * j; // Abstands-Jitter ±j dieser Stufe
    // Anschluss-Stufe: auf den Raum verkleinern, der bei diesem Jitter bis zur Bandkante bleibt
    if (extend && i >= levels) {
      const fit = lambda > 0 ? Math.floor(2 * ((maxDist - h - jit) / lambda - X) + 1e-9) : s; // X + s/2 muss unter die Bandkante passen
      if (fit < Math.min(s, LADDER_EXTRA_MIN)) break; // Restraum zu klein: die Bandkante ist erreicht
      s = Math.min(s, fit);
    }
    // Abstand von F: halber Spread + Kurswirkung bis zur Mitte dieser Stufe
    // (λ · (X + s/2)) + Jitter ±j; nie innerhalb des halben Spreads
    const mitte = X + s / 2; // Mitte der eigenen Menge der Stufe
    const dist = Math.max(h, h + lambda * mitte + jit);
    let ask = ceilTick(f * (1 + dist), tick);
    let bid = floorTick(f * (1 - dist), tick);
    // streng monoton: jede Stufe mindestens einen Tick von der vorigen
    if (asks.length) ask = Math.max(ask, asks[asks.length - 1].price + tick);
    if (bids.length) bid = Math.min(bid, bids[bids.length - 1].price - tick);
    // nicht ins Band geklemmt: liegt eine Seite außerhalb, endet sie (b.min ≥ tick)
    if (askOpen && inBand(b, ask)) { asks.push({ price: ask, size: s }); askSum += s; } else askOpen = false;
    if (bidOpen && inBand(b, bid)) bids.push({ price: bid, size: s }); else bidOpen = false;
    if (!askOpen && !bidOpen) break; // beide Seiten außerhalb des Bands: sie kommen nie zurück
    X += s;
  }
  // Kreuzungsschutz: Brief nie auf oder unter dem Geld. Alle Asks um denselben
  // Abstand anheben (ganze Ticks, die Ordnung bleibt), dann streicht das Band
  // die Stufen oberhalb von b.max.
  if (bids.length && asks.length && asks[0].price <= bids[0].price) {
    const delta = bids[0].price + tick - asks[0].price;
    for (const q of asks) q.price += delta;
    while (asks.length && asks[asks.length - 1].price > b.max) asks.pop();
  }
  return { bids, asks };
}

// ETF-Quotes: je Seite eine Stufe, ± h um den NAV. Geld mindestens 1 Tick,
// Brief nie auf oder unter dem Geld.
function flatQuotes({ fair, tick, halfSpreadBp }) {
  checkNumber('fair', fair); checkTick('tick', tick); checkNumber('halfSpreadBp', halfSpreadBp);
  const f = fair / MILLI;       // F (= NAV) in Cent
  const h = halfSpreadBp / 1e4; // halber Spread
  const bid = Math.max(tick, floorTick(f * (1 - h), tick));
  const ask = Math.max(ceilTick(f * (1 + h), tick), bid + tick);
  return { bid, ask };
}

module.exports = { MILLI, depthOf, impactLambda, maxOrderSize, applyFlow, publicPrice, band, inBand, ladder, flatQuotes };
