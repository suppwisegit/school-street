// Tests für T8 (PLAN v2, V1): Alter eines Werts aus der jüngsten IPO-News, Fenster
// ipo_highlight_sec, Ablauf. Erwartungen aus DESIGN 11.2/11.5 — nicht aus dem Client-Code.
// Reine Funktionen aus dem Client (ESM) — kein Server, keine DB, kein Port.
process.env.TZ = 'UTC'; // `clock` formatiert in der lokalen Zone: feste Zone, fester Erwartungswert
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'client', 'src', 'ipo.js')).href);

const H = 3600000;
const NOW = Date.UTC(2026, 10, 27, 14, 0, 0);
const ipoNews = (id, securityId, at, title = 'IPO: Mensa (MENSA) startet zum Kurs 20,00') => (
  { id, kind: 'ipo', security_id: securityId, title, created_at: at }
);

test('T8: junger Börsengang ist neu, mit Alter, Restzeit und Fortschritt', async () => {
  const { ipoHighlights } = await load();
  const list = ipoHighlights([ipoNews(9, 4, NOW - 30 * 60000)], NOW, 3 * H / 1000);
  assert.equal(list.length, 1);
  const h = list[0];
  assert.equal(h.securityId, 4);
  assert.equal(h.ageSec, 1800);
  assert.equal(h.leftSec, 9000);
  assert.ok(Math.abs(h.progress - 1 / 6) < 1e-9, 'ein Sechstel des Fensters verstrichen');
  assert.equal(h.soon, false);
});

test('T8: am Fensterende fällt der Wert weg, kurz davor gilt er als bald abgelaufen', async () => {
  const { ipoHighlights } = await load();
  const win = 3 * H / 1000;
  assert.equal(ipoHighlights([ipoNews(9, 4, NOW - 3 * H + 1000)], NOW, win)[0].soon, true, 'noch 1 s: bald');
  assert.equal(ipoHighlights([ipoNews(9, 4, NOW - 3 * H + 301000)], NOW, win)[0].soon, false, 'noch 301 s: nicht bald');
  assert.deepEqual(ipoHighlights([ipoNews(9, 4, NOW - 3 * H)], NOW, win), [], 'Fenster vorbei: kein neuer Wert');
});

test('T8: Nachplatzierung ist keine IPO-News im Sinne von „neu“', async () => {
  const { ipoHighlights, isListingNews } = await load();
  const n = ipoNews(9, 4, NOW - 60000, 'Nachplatzierung: Mensa (MENSA) platziert 500 neue Aktien');
  assert.equal(isListingNews(n), false);
  assert.deepEqual(ipoHighlights([n], NOW, 10800), []);
});

test('T8: jüngster Börsengang je Wert zählt, Reihenfolge jüngster zuerst', async () => {
  const { ipoHighlights } = await load();
  const list = ipoHighlights([
    ipoNews(5, 8, NOW - 10 * 60000),  // Wert 8: 10 min alt
    ipoNews(6, 4, NOW - 50 * 60000),  // Wert 4: 50 min alt (ältere News zuerst in der Liste)
    ipoNews(4, 4, NOW - 20 * 60000),  // Wert 4: neuere News → 20 min
  ], NOW, 3600);
  assert.deepEqual(list.map((h) => h.securityId), [8, 4]);
  assert.equal(list[1].ageSec, 1200);
});

test('T8: kürzeres Fenster schließt älteren Börsengang aus; Fenster 0 schaltet ab', async () => {
  const { ipoHighlights } = await load();
  const news = [ipoNews(1, 4, NOW - 2 * H), ipoNews(2, 8, NOW - 10 * 60000)];
  assert.deepEqual(ipoHighlights(news, NOW, 3600).map((h) => h.securityId), [8]);
  assert.deepEqual(ipoHighlights(news, NOW, 0), []);
  assert.deepEqual(ipoHighlights(news, NOW, NaN), []);
});

test('T8: kaputte Einträge und leere Liste werfen nicht', async () => {
  const { ipoHighlights, ipoById } = await load();
  assert.deepEqual(ipoHighlights(null, NOW, 10800), []);
  assert.deepEqual(ipoHighlights([null, { kind: 'ipo' }, ipoNews(1, null, NOW), ipoNews(2, 5, 'x'), ipoNews(3, 5, -1)], NOW, 10800), []);
  assert.equal(ipoById(null).size, 0);
  assert.equal(ipoById(ipoHighlights([ipoNews(9, 4, NOW - 1000)], NOW, 10800)).has(4), true);
});

test('T8: Ablauf als Uhrzeit mit Wortwechsel, nie als Countdown (DESIGN 11.5)', async () => {
  const { clock, duration, untilText } = await load();
  const at = Date.UTC(2026, 10, 27, 14, 5);
  assert.equal(clock(at), '14:05');
  assert.equal(clock(Date.UTC(2026, 10, 27, 23, 59)), '23:59');
  assert.equal(duration(12), '1 Min.');
  assert.equal(duration(12 * 60), '12 Min.');
  assert.equal(duration(2 * 3600 + 5 * 60), '2 Std. 5 Min.');
  assert.equal(duration(3 * 3600), '3 Std.');
  assert.equal(duration(-5), '1 Min.');
  assert.deepEqual(untilText({ at, ageSec: 7200, leftSec: 3600, soon: false }), { text: 'Neu bis 17:05', warn: false });
  assert.deepEqual(untilText({ at, ageSec: 10740, leftSec: 60, soon: true }), { text: 'Läuft gleich ab (17:05)', warn: true });
});

test('T8: die Ablauf-Uhrzeit wandert nicht, während der Börsengang altert', async () => {
  const { ipoHighlights, untilText } = await load();
  const at = Date.UTC(2026, 10, 27, 8, 52, 36);
  const seen = new Set();
  for (const age of [10, 180, 600, 3600, 7200, 10740]) {
    const text = untilText(ipoHighlights([{ kind: 'ipo', security_id: 4, title: 'IPO: X', created_at: at }], at + age * 1000, 10800)[0]).text;
    // nur die Uhrzeit: der Wortlaut wechselt kurz vor Ende („Läuft gleich ab“)
    seen.add(text.match(/\d{2}:\d{2}/)[0]);
  }
  assert.deepEqual([...seen], ['11:52']);
});

test('T8: Startnotierung aus dem Seed (kind system) und ETF-News erzeugen keinen Marker', async () => {
  const { ipoHighlights, isListingNews } = await load();
  const seedNews = { kind: 'system', security_id: 4, title: 'Startnotierung: Mensa AG (MENSA) notiert zum Kurs 20.00', created_at: NOW - 1000 };
  const etfNews = { kind: 'etf', security_id: 5, title: 'IPO: Schul-ETF (SCHUL) startet zum Kurs 100.00', created_at: NOW - 1000 };
  assert.equal(isListingNews(seedNews), false);
  assert.equal(isListingNews(etfNews), false);
  assert.deepEqual(ipoHighlights([seedNews, etfNews], NOW, 10800), []);
  const real = { kind: 'ipo', security_id: 6, title: 'IPO: Kantine (KANT) startet zum Kurs 12.50', created_at: NOW - 1000 };
  assert.deepEqual(ipoHighlights([seedNews, etfNews, real], NOW, 10800).map((h) => h.securityId), [6]);
});

test('T8: der Seed schreibt keine IPO-News für Startwerte', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'seed.js'), 'utf8');
  const calls = [...src.matchAll(/addNews\('([a-z]+)'[^\n]*/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'Seed schreibt News');
  assert.ok(!calls.includes('ipo'), `Seed darf kein kind 'ipo' schreiben, hat aber: ${calls.join(', ')}`);
});

// ---- Server: GET /api/news?kind=… (routes.js). Eigenes Router-Objekt auf Loopback, eigene DB ----
const KINDS = ['news', 'rumor', 'dividend', 'bafin', 'ipo', 'system', 'takeover', 'etf'];
test('T8: GET /api/news filtert nach kind, ohne Parameter unverändert, ohne Login erreichbar', async (t) => {
  process.env.DB_NAME = `ipo-${process.pid}.db`;
  process.env.SEED = '';
  const dbmod = require('../db');
  const { addNews } = dbmod;
  const app = require('express')();
  app.use('/api', require('../routes'));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const BASE = `http://127.0.0.1:${srv.address().port}/api/news`;
  const get = async (qs) => {
    const r = await fetch(BASE + qs);
    return { status: r.status, kinds: ((await r.json()).news || []).map((n) => n.kind) };
  };
  try {
    // Wie im Spiel: Börsengang, dann Flut mit 240 jüngeren News
    const ipo = addNews('ipo', 'IPO: Kantine (KANT) startet zum Kurs 12.50', '', 6);
    for (let i = 0; i < 5; i++) addNews('system', `System ${i}`, '');
    for (let i = 0; i < 240; i++) addNews(i % 2 ? 'rumor' : 'news', `Flut ${i}`, '', 1, 0);
    const plain = await get('');
    assert.equal(plain.status, 200);
    assert.equal(plain.kinds.length, 40, 'ohne Parameter: 40 jüngste wie bisher');
    assert.ok(!plain.kinds.includes('ipo'), 'der Börsengang ist im ungefilterten Feed schon untergegangen');
    const f = await get('?kind=ipo');
    assert.equal(f.status, 200);
    assert.deepEqual(f.kinds, ['ipo'], 'gefiltert kommt der Börsengang trotz 240 jüngerer News');
    const many = await get('?kind=system, ipo&limit=100');
    assert.deepEqual(many.kinds.slice().sort(), [...f.kinds, 'system', 'system', 'system', 'system', 'system'].sort());
    assert.ok(many.kinds.includes('ipo'));
    assert.deepEqual((await get('?kind=')).kinds.length, 40, 'leer = kein Filter');
    assert.deepEqual((await get('?kind=IPO')).kinds, ['ipo'], 'Großschreibung egal');
    assert.deepEqual((await get('?kind=ipo,ipo')).kinds, ['ipo'], 'doppelt egal');
    const bad = await get("?kind=ipo'; DROP TABLE news;--");
    assert.equal(bad.status, 400, 'unbekannte Art wird abgelehnt');
    assert.equal((await get('?kind=nope')).status, 400);
    const after = await get('?kind=ipo');
    assert.deepEqual(after.kinds, ['ipo'], 'Tabelle unversehrt, Zeile noch da');
    assert.ok(ipo.id > 0);
    for (const k of KINDS) assert.ok(k === 'ipo' || (await get(`?kind=${k}`)).status === 200, `Schema-Art ${k} ist erlaubt`);
  } finally {
    srv.close();
    dbmod.db.close();
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'data'))) {
      if (f.startsWith(`ipo-${process.pid}.db`)) fs.unlinkSync(path.join(__dirname, '..', 'data', f));
    }
  }
});
