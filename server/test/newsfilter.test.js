// Tests für T7c: GET /api/news?security_id=… (routes.js). Die Aktienseite braucht die News
// eines Werts zuverlässig, auch wenn sie in der Gesamtliste untergegangen sind.
// Eigenes Router-Objekt auf Loopback (Port ab 3285), eigene DB — Muster wie der HTTP-Test in ipo.test.js.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');

const listenFrom = async (srv, first) => {
  for (let port = first; port < first + 10; port++) {
    srv.listen(port, '127.0.0.1');
    const outcome = await Promise.race([
      once(srv, 'listening').then(() => 'open'),
      once(srv, 'error').then((e) => (e.code === 'EADDRINUSE' ? 'busy' : Promise.reject(e))),
    ]);
    if (outcome === 'open') return port;
  }
  srv.listen(0, '127.0.0.1'); // alle belegt: freier Port
  await once(srv, 'listening');
  return srv.address().port;
};

test('T7c: GET /api/news filtert nach security_id, kombinierbar mit kind, ohne Login erreichbar', async () => {
  process.env.DB_NAME = `newsfilter-${process.pid}.db`;
  process.env.SEED = '';
  const dbmod = require('../db');
  const { addNews } = dbmod;
  const app = require('express')();
  app.use('/api', require('../routes'));
  const srv = require('node:http').createServer(app); // noch nicht lauschend: listenFrom() bindet den Port
  const port = await listenFrom(srv, 3285);
  assert.ok(port === 0 || port >= 3285, `Port ${port} liegt im Task-Bereich`);
  const BASE = `http://127.0.0.1:${port}/api/news`;
  const get = async (qs) => {
    const r = await fetch(BASE + qs);
    const body = await r.json();
    return { status: r.status, news: body.news || [], error: body.error };
  };
  const EIS = 4;
  const MENSA = 7;
  try {
    // Wie im Spiel: drei EIS-News, dann 150 jüngere News zu einem anderen Wert
    const own = [
      addNews('bafin', 'BaFin prüft EIS', '', EIS, -2),
      addNews('news', 'EIS testet neue Sorte', '', EIS, 2),
      addNews('dividend', 'EIS schüttet aus', '', EIS, 1),
    ];
    for (let i = 0; i < 150; i++) addNews(i % 2 ? 'rumor' : 'news', `Flut ${i}`, '', MENSA, 0);

    const plain = await get('?limit=100');
    assert.equal(plain.status, 200);
    assert.equal(plain.news.length, 100);
    assert.ok(!plain.news.some((n) => n.security_id === EIS), 'ungefiltert sind die EIS-News untergegangen');

    const eis = await get(`?security_id=${EIS}&limit=3`);
    assert.equal(eis.status, 200);
    assert.deepEqual(eis.news.map((n) => n.id), own.map((n) => n.id).reverse(), 'die drei EIS-News, jüngste zuerst');
    assert.ok(eis.news.every((n) => n.security_id === EIS), 'nur News dieses Werts');

    assert.equal((await get(`?security_id=${EIS}`)).news.length, 3, 'Standardlimit schneidet nichts weg, was da ist');
    assert.equal((await get(`?security_id=${EIS}&limit=2`)).news.length, 2, 'limit gilt auch gefiltert');

    const both = await get(`?security_id=${EIS}&kind=dividend,bafin`);
    assert.deepEqual(both.news.map((n) => n.kind).sort(), ['bafin', 'dividend'], 'kind und security_id gemeinsam');
    assert.deepEqual((await get(`?security_id=${EIS}&kind=ipo`)).news, [], 'Kombination ohne Treffer ist leer, kein Fehler');

    assert.equal((await get('?security_id=')).news.length, 40, 'leer = kein Filter');
    const spaced = await get(`?security_id=%20${EIS}%20`);
    assert.equal(spaced.status, 200);
    assert.equal(spaced.news.length, 3, 'Leerzeichen um die Zahl sind egal');

    for (const bad of ['abc', '1.5', '-1', '4 OR 1=1', 'null', '4abc']) {
      const r = await get(`?security_id=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400, `security_id=${bad} wird abgelehnt`);
      assert.ok(typeof r.error === 'string' && r.error.length > 0, 'mit Meldung');
    }
    assert.equal((await get(`?security_id=${EIS}`)).news.length, 3, 'Tabelle unversehrt, Zeilen noch da');
    assert.equal((await get('?kind=nope')).status, 400, 'kind-Prüfung weiter in Kraft');
    assert.equal((await get(`?security_id=abc&kind=nope`)).status, 400, 'beide falsch: 400');
  } finally {
    srv.close();
    dbmod.db.close();
    const dir = path.join(__dirname, '..', 'data');
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`newsfilter-${process.pid}.db`)) fs.unlinkSync(path.join(dir, f));
    }
  }
});
