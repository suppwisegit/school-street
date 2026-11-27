// QA zu T8 (IPO prominenter): Logik client/src/ipo.js. Fälle aus dem DoD/DESIGN 11
// abgeleitet (Fenster exakt, Dauer, künftige Zeitstempel, kein IPO-News, Nachplatzierung).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'client', 'src', 'ipo.js')).href);
const NOW = Date.UTC(2026, 10, 27, 14, 0, 0);
const WIN = 10800; // Default ipo_highlight_sec (3 Sim-Stunden)
const ipo = (id, securityId, at, title) => ({ id, kind: 'ipo', security_id: securityId, title, created_at: at });

test('QA8: Fenster-Grenzen exakt — 1 ms vor Ablauf dabei, bei Ablauf und danach weg', async () => {
  const { ipoHighlights } = await load();
  assert.equal(ipoHighlights([ipo(1, 4, NOW - (WIN * 1000 - 1))], NOW, WIN).length, 1, 'noch 1 ms im Fenster');
  assert.deepEqual(ipoHighlights([ipo(1, 4, NOW - WIN * 1000)], NOW, WIN), [], 'genau am Ablauf: weg');
  assert.deepEqual(ipoHighlights([ipo(1, 4, NOW - WIN * 1000 - 1)], NOW, WIN), [], '1 ms nach Ablauf: weg');
  const fresh = ipoHighlights([ipo(1, 4, NOW)], NOW, WIN)[0];
  assert.equal(fresh.leftSec, WIN, 'frisch gelistet: volle Restzeit');
  assert.equal(fresh.progress, 0);
});

test('QA8: Dauer — Alter und Restzeit rechnen in Sekunden, Summe ist das Fenster', async () => {
  const { ipoHighlights } = await load();
  for (const age of [1, 59, 60, 599, 3600, WIN - 1]) {
    const h = ipoHighlights([ipo(1, 4, NOW - age * 1000)], NOW, WIN)[0];
    assert.equal(h.ageSec, age, `Alter ${age}`);
    assert.equal(h.leftSec, WIN - age, `Restzeit bei Alter ${age}`);
  }
});

test('QA8: künftiger Zeitstempel wirft nicht, kein negatives Alter, keine Restzeit über das Fenster', async () => {
  const { ipoHighlights } = await load();
  const h = ipoHighlights([ipo(1, 4, NOW + 3600000)], NOW, WIN)[0];
  assert.ok(h, 'eintrag vorhanden');
  assert.equal(h.ageSec, 0);
  assert.equal(h.leftSec, WIN);
  assert.equal(h.progress, 0);
  assert.equal(h.soon, false);
});

test('QA8: ohne IPO-News ist nichts neu — andere Arten und News ohne Wertpapier zählen nicht', async () => {
  const { ipoHighlights } = await load();
  const others = ['news', 'rumor', 'dividend', 'bafin', 'system', 'takeover', 'etf'].map((kind, i) => (
    { id: i, kind, security_id: 4, title: `IPO: Mensa (MENSA) startet`, created_at: NOW - 60000 }
  ));
  assert.deepEqual(ipoHighlights(others, NOW, WIN), []);
  const noSec = { id: 9, kind: 'ipo', security_id: null, title: 'IPO: Mensa startet', created_at: NOW - 60000 };
  assert.deepEqual(ipoHighlights([noSec], NOW, WIN), []);
  assert.deepEqual(ipoHighlights([], NOW, WIN), []);
});

test('QA8: Nachplatzierung macht eine Aktie nicht neu — auch nicht mit frischem Zeitstempel', async () => {
  const { ipoHighlights, isListingNews } = await load();
  const n = { id: 9, kind: 'ipo', security_id: 4, created_at: NOW - 60000, title: 'Nachplatzierung: Mensa Gourmet SE (MENSA) platziert 500 neue Aktien' };
  assert.equal(isListingNews(n), false);
  assert.deepEqual(ipoHighlights([n], NOW, WIN), []);
  // Nachplatzierung nach einem alten Börsengang: der Wert bleibt alt
  const old = ipo(1, 4, NOW - 5 * 3600000);
  assert.deepEqual(ipoHighlights([n, old], NOW, WIN), [], 'junge Nachplatzierung darf den Wert nicht verjüngen');
  // Groß-/Kleinschreibung und führendes Leerzeichen im Titel
  assert.equal(isListingNews({ ...n, title: '  nachplatzierung: X' }), false);
});

test('QA8: duration — gerundete Mindestangabe, keine 0, keine negative Dauer', async () => {
  const { duration } = await load();
  assert.equal(duration(0), '1 Min.');
  assert.equal(duration(3599), '59 Min.');
  assert.equal(duration(10800), '3 Std.');
});

test('QA8: Ablauf-Uhrzeit ist der Listing-Zeitpunkt + Fenster, unabhängig vom Alter', async () => {
  // DESIGN 11.5: Uhrzeit, kein Countdown. Der Ablauf wandert nicht, während der Wert altert.
  const { ipoHighlights, untilText } = await load();
  for (const age of [10, 600, 3600, 7200]) {
    const h = ipoHighlights([ipo(1, 4, NOW - age * 1000)], NOW, WIN)[0];
    const want = new Date(NOW - age * 1000 + WIN * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    assert.equal(untilText(h).text, `Neu bis ${want}`, `Alter ${age} s`);
  }
});
