// Tests für den gemeinsamen News-Vorrat des Clients (client/src/newsStore.js): eine Abfrage je
// URL für alle Nutzer, WebSocket-Update nur in passende Vorräte, Fehler und erneutes Laden.
// Reines Modul: fetch wird ersetzt, React rendert nicht (Abo-API statt Hook).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const news = (id, extra = {}) => ({ id, kind: 'news', security_id: 1, title: `News ${id}`, created_at: 1_000_000 + id, ...extra });
let store, calls, answer, fail, seq = 0;
const settle = () => new Promise((r) => setImmediate(r));
const feed = (params) => {
  const seen = [];
  const off = store.subscribeNews(params, () => seen.push(store.readNews(params).items));
  return { off, seen, state: () => store.readNews(params) };
};

// fetch ersetzt: `answer` ist die Liste des Servers, gefiltert wie GET /api/news.
const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'client', 'src', 'newsStore.js')).href + `?t=${++seq}`); // je Test ein frischer Vorrat

test.before(async () => {
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (fail) throw new TypeError('Netzwerk');
    const u = new URL(url, 'http://x');
    let list = answer;
    if (u.searchParams.get('security_id') != null) list = list.filter((n) => n.security_id === Number(u.searchParams.get('security_id')));
    if (u.searchParams.get('kind')) list = list.filter((n) => u.searchParams.get('kind').split(',').includes(n.kind));
    return { ok: true, status: 200, json: async () => ({ news: list.slice(0, Number(u.searchParams.get('limit')) || 40) }) };
  };
});
test.beforeEach(async () => { calls = []; fail = false; answer = [news(3), news(2), news(1)]; store = await load(); });

test('zwei Nutzer derselben Abfrage laden einmal und sehen dieselbe Liste', async () => {
  const q = { limit: 100 };
  const a = feed(q), b = feed(q);
  assert.equal(a.state().items, null, 'solange lädt, gibt es keine Liste');
  await settle(); await settle();
  assert.equal(calls.length, 1, 'eine Abfrage für beide');
  assert.deepEqual(a.state().items.map((n) => n.id), [3, 2, 1]);
  assert.equal(b.seen.at(-1), a.seen.at(-1), 'beide bekommen dieselbe Liste');
  assert.equal(a.state().failed, false);
  a.off(); b.off();
  // Ohne Abo bleibt der Vorrat; ein neues Abo innerhalb der Frist lädt nicht noch einmal
  const c = feed(q);
  await settle();
  assert.equal(calls.length, 1, 'frischer Vorrat wird wiederverwendet');
  c.off();
});

test('andere Abfragen sind eigene Vorräte; ein Push landet nur in passenden, vorne, ohne Doppel', async () => {
  const all = feed({ limit: 12 }), eis = feed({ security_id: 4, limit: 3 }), ipos = feed({ kind: 'ipo', limit: 20 });
  await settle(); await settle();
  assert.equal(calls.length, 3);
  store.newsPush({ type: 'news', news: news(9) });
  store.newsPush({ type: 'news', news: news(10, { security_id: 4, kind: 'ipo' }) });
  store.newsPush({ type: 'trade', security_id: 1 });
  store.newsPush({ type: 'news', news: news(9) });
  assert.deepEqual(all.state().items.map((n) => n.id), [10, 9, 3, 2, 1], 'alle News, jüngste zuerst, keine Doppel');
  assert.deepEqual(eis.state().items.map((n) => n.id), [10], 'nur die News des Werts');
  assert.deepEqual(ipos.state().items.map((n) => n.id), [10], 'nur die IPO-News');
  assert.equal(all.seen.length, 3, 'gemeldet: das Laden und die zwei neuen News — der Doppel-Push nicht');
  all.off(); eis.off(); ipos.off();
});

test('ein Push während des Ladens steht vor der Antwort; die Liste bleibt bei `limit`', async () => {
  answer = Array.from({ length: 40 }, (_, i) => news(i + 1)).reverse();
  const a = feed({ limit: 5 });
  store.newsPush({ type: 'news', news: news(99) });
  store.newsPush({ type: 'news', news: news(99, { id: 99 }) });
  store.newsPush({ type: 'news', news: news(40) }); // steht schon in der Antwort
  await settle(); await settle();
  assert.deepEqual(a.state().items.map((n) => n.id), [99, 40, 39, 38, 37], 'Push vor der Antwort, höchstens 5 Zeilen');
  a.off();
});

test('Fehler wird gemeldet, kein Stand vorgetäuscht; erneut laden holt die Liste', async () => {
  fail = true;
  const q = { limit: 100 };
  const a = feed(q);
  await settle(); await settle();
  assert.equal(a.state().items, null);
  assert.equal(a.state().failed, true);
  assert.equal(a.seen.length, 1, 'der Fehler meldet sich einmal');
  fail = false;
  await a.state().load();
  assert.equal(a.state().failed, false);
  assert.deepEqual(a.state().items.map((n) => n.id), [3, 2, 1]);
  a.off();
  // Ein neuer Nutzer nach einem Fehler lädt selbst (die Seite zeigt sonst einen alten Fehler)
  const b = feed(q);
  fail = true;
  await b.state().load();
  assert.equal(b.state().failed, true);
  assert.deepEqual(b.state().items.map((n) => n.id), [3, 2, 1], 'der letzte Stand bleibt stehen');
  b.off();
  fail = false;
  const c = feed(q);
  await settle(); await settle();
  assert.equal(c.state().failed, false, 'neues Abo nach Fehler lädt neu');
  c.off();
});

test('läuft die Abfrage schon, wartet ein zweiter Aufruf darauf; alter Stand wird neu geladen', async () => {
  const q = { limit: 100 };
  const a = feed(q);
  await settle(); await settle();
  answer = [news(7)];
  const p1 = a.state().load(), p2 = a.state().load();
  assert.equal(p1, p2, 'zwei Aufrufe, eine Abfrage');
  await p1;
  assert.equal(calls.length, 2);
  assert.deepEqual(a.state().items.map((n) => n.id), [7]);
  a.off();
  a.state().at = 0; // älter als die Frist
  const b = feed(q);
  assert.deepEqual(b.state().items.map((n) => n.id), [7], 'der letzte Stand bleibt bis zur Antwort stehen');
  await settle(); await settle();
  assert.equal(calls.length, 3, 'alter Stand wird beim Abo neu geladen');
  b.off();
});
