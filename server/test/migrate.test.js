// QA-Tests für Schema und Einstellungs-Migration nach V3 (server/db.js, T3) — dauerhaft.
// Erwartungen stammen aus PLAN.md V3, nicht aus dem Code des Implementers.
// Isolation wie in Abschnitt 0: eigene DB mit Prozess-ID (migrate-test-<pid>-<fall>.db); db.js wird in einem
// Kindprozess geladen, damit jedes Öffnen ein echtes Neuladen ist. Die echte Börse wird nie berührt.
// Voraussetzung: SQLite >= 3.35 — die Fälle bauen den alten Stand mit ALTER TABLE … DROP COLUMN nach.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER = path.join(__dirname, '..');
const PREFIX = `migrate-test-${process.pid}`;
const datei = (name) => path.join(SERVER, 'data', `${PREFIX}-${name}.db`);

// V3: Schlüssel nach der Migration = Baseline ohne die 14 entfernten, plus die 3 neuen und den Versions-Marker (34).
// Fehlt die Marker-Zeile, gilt die DB als vor V3.
const MARKER = 'mm_version';
const ENTFERNT = { limit_band_cents: 10000, mm_step_bp: 120, mm_noise_bp: 18, mm_inv_target_pct: 0.2, mm_inv_skew_bp: 200,
  mm_guard_pct: 6, mm_guard_widen: 1.7, mm_vol_ref: 0.01, mm_vol_mult_max: 2.8, mm_replenish_qty: 1000,
  mm_replenish_price_mult: 1.15, mm_recap_to_pct: 0.12, etf_auto_threshold_pct: 10, etf_auto_units: 2 }; // Werte der Baseline
const NEU = { mm_impact_pct: 50, mm_replenish_pct: 50, etf_ap_inventory_pct: 25 };
const ALT = { mm_spread_bp: [350, 300], mm_jitter_bp: [60], mm_size: [15, 40] }; // alte Defaults (erste Version, V2) → neuer Default
// Erweiterung V1 (27.11.): zehn neue Schlüssel mit ihren Defaults, dazu die Spalte news.impact.
const V1 = { news_interval_sec: 60, bot_cash_reserve_min: 0.2, bot_cash_reserve_max: 0.4, bot_fee_cent: 0, fee_recycle_pct: 100,
  income_sim_scale: 0, mm_min_ask_shares: 1000, mm_min_depth: 2000, ipo_highlight_sec: 10800 };
// fee_pool_cent: interner Zustand (Gebühren-Pool) im Default-Set, keine Admin-Einstellung.
const INTERN = { fee_pool_cent: 0 };
const V1_UND_INTERN = { ...V1, ...INTERN };
const V3 = { mm_version: 3, ...NEU, ...V1, ...INTERN, mm_spread_bp: 100, mm_jitter_bp: 20, mm_size: 10, limit_band_pct: 15 };
const SCHLUESSEL = ['bot_activity', 'bot_count', 'bot_fast', 'bot_running', 'bot_tick_sec', 'cap_hours_needed',
  'etf_ap_inventory_pct', 'etf_auto', 'etf_auto_interval_sec', 'etf_auto_max_units', 'fee_cent', 'idx_base_mcap',
  'inactivity_sec', 'income_cent', 'income_sec', 'limit_band_pct', 'lockup_sec', 'mm_cash_budget_pct', 'mm_fee_exempt',
  'mm_impact_pct', 'mm_jitter_bp', 'mm_levels', 'mm_recap_min_pct', 'mm_refresh_sec', 'mm_replenish_min',
  'mm_replenish_pct', 'mm_size', 'mm_size_jitter', 'mm_size_step', 'mm_spread_bp', 'mm_version', 'start_capital',
  'trading_paused', 'treasury_capital'];
const ANZAHL = 44; // 34 aus V3 + 9 aus V1 + fee_pool_cent
SCHLUESSEL.push(...Object.keys(V1_UND_INTERN));
SCHLUESSEL.sort((a, b) => a.localeCompare(b));

// Öffnet db.js im Kindprozess auf der eigenen Test-DB und meldet Tabelle, Cache, Spalten und Datenbestand.
const LESER = `
  const d = require(${JSON.stringify(path.join(SERVER, 'db.js'))});
  const tabelle = {};
  for (const r of d.db.prepare('SELECT key, value FROM settings').all()) tabelle[r.key] = JSON.parse(r.value);
  const spalten = d.db.prepare('PRAGMA table_info(securities)').all().map((c) => c.name).sort();
  const wertpapiere = d.db.prepare('SELECT COUNT(*) c FROM securities').get().c;
  const news = d.db.prepare('SELECT id, kind, title, security_id, impact FROM news ORDER BY id').all();
  const newsSpalte = d.db.prepare('PRAGMA table_info(news)').all().find((c) => c.name === 'impact');
  const spaltenFormat = newsSpalte ? [newsSpalte.type, newsSpalte.notnull, newsSpalte.dflt_value] : null;
  console.log(JSON.stringify({ defaults: d.DEFAULT_SETTINGS, cache: d.getSettings(), tabelle, spalten, wertpapiere, news, spaltenFormat }));
  d.db.close();
`;
const oeffnen = (name) => spawnSync(process.execPath, ['-e', LESER], { encoding: 'utf8', env: { ...process.env, DB_NAME: path.basename(datei(name)) } });
const zustand = (name) => {
  const r = oeffnen(name);
  assert.equal(r.status, 0, `db.js laden auf ${name}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

// Direkter Zugriff nur auf die eigene Test-DB: Zustand vor V3 herstellen und lesen.
const direkt = (name, fn) => {
  const db = new Database(datei(name));
  try { return fn(db); } finally { db.close(); }
};
const lesen = (name) => direkt(name, (db) => ({
  tabelle: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])),
  spalten: db.prepare('PRAGMA table_info(securities)').all().map((c) => c.name).sort(),
  wertpapiere: db.prepare('SELECT COUNT(*) c FROM securities').get().c,
}));
const setzen = (db, werte) => {
  const set = db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(werte)) set.run(k, JSON.stringify(v));
};
// Stand vor V1 auf einer DB mit Marker (so sieht eine echte DB nach V3 aus): die zehn Schlüssel fehlen,
// die Tabelle news hat keine Spalte impact, und es liegen schon News.
const ALT_NACHRICHTEN = [{ kind: 'news', title: 'Alte Meldung', security_id: null }, { kind: 'dividend', title: 'Dividende', security_id: 4 }];
function vorV1(name) {
  direkt(name, (db) => {
    const weg = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const k of Object.keys(V1_UND_INTERN)) weg.run(k);
    const ins = db.prepare('INSERT INTO news(kind, title, body, security_id, created_at) VALUES(?,?,?,?,?)');
    for (const n of ALT_NACHRICHTEN) ins.run(n.kind, n.title, 'Text', n.security_id, 1700000000000);
    db.exec('ALTER TABLE news DROP COLUMN impact');
  });
}
const newsSpalten = (name) => direkt(name, (db) => db.prepare('PRAGMA table_info(news)').all());
// Vor-V3-Zustand: ohne Marker und ohne die neuen Schlüssel, mit den genannten alten Schlüsseln (Werte der Baseline)
// und den übergebenen Einstellungen, ohne die beiden neuen Spalten.
function vorV3(name, werte, alteSchluessel = Object.keys(ENTFERNT)) {
  direkt(name, (db) => {
    const weg = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const k of [...Object.keys(ENTFERNT), ...Object.keys(NEU), ...Object.keys(V1_UND_INTERN), MARKER]) weg.run(k);
    db.exec('ALTER TABLE news DROP COLUMN impact');
    setzen(db, Object.fromEntries(alteSchluessel.map((k) => [k, ENTFERNT[k]])));
    setzen(db, werte);
    db.exec('ALTER TABLE securities DROP COLUMN fair_price; ALTER TABLE securities DROP COLUMN ap_inventory_target;');
  });
}
function seeden(name) {
  try {
    execFileSync(process.execPath, [path.join(SERVER, 'seed.js')],
      { env: { ...process.env, DB_NAME: path.basename(datei(name)), ADMIN_PASSWORD: 'ag123' }, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`Seed für ${name} fehlgeschlagen (Engine oder ETF in Arbeit?): ${String(e.stderr).slice(-400)}`);
  }
}
const kopieren = (von, nach) => {
  for (const endung of ['', '-wal', '-shm']) if (fs.existsSync(datei(von) + endung)) fs.copyFileSync(datei(von) + endung, datei(nach) + endung);
};
const sortiert = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

// Was V3 nach dem Laden verlangt: Marker und neue Schlüssel gesetzt, alte Defaults nur ersetzt, wenn sie noch auf
// einem alten Wert stehen, alles andere unverändert — in Tabelle und Cache.
function sollNachV3(vorher) {
  const soll = {};
  for (const k of SCHLUESSEL) {
    if (k in V3 && !(k in vorher.tabelle)) soll[k] = V3[k];
    else if (k in ALT && ALT[k].includes(vorher.tabelle[k])) soll[k] = V3[k];
    else soll[k] = vorher.tabelle[k];
  }
  return soll;
}
function pruefeV3(z, soll) {
  for (const map of [z.defaults, z.cache, z.tabelle]) assert.deepEqual(Object.keys(map).sort(), SCHLUESSEL);
  for (const [k, v] of Object.entries(V3)) assert.deepEqual(z.defaults[k], v, `Default von ${k}`);
  for (const k of Object.keys(ENTFERNT)) assert.ok(!(k in z.tabelle) && !(k in z.cache), `${k} ist entfernt, steht aber noch in Tabelle oder Cache`);
  for (const k of SCHLUESSEL) {
    assert.deepEqual(z.tabelle[k], soll[k], `${k} in der Tabelle`);
    assert.deepEqual(z.cache[k], soll[k], `${k} im Cache`);
  }
  assert.ok(z.spalten.includes('fair_price') && z.spalten.includes('ap_inventory_target'), `Spalten: ${z.spalten}`);
  assert.deepEqual(z.spaltenFormat, ['INTEGER', 1, '0'], 'news.impact');
  for (const k of Object.keys(V1_UND_INTERN)) {
    assert.deepEqual([z.tabelle[k], z.cache[k], z.defaults[k]], [V1_UND_INTERN[k], V1_UND_INTERN[k], V1_UND_INTERN[k]], `${k} (V1) in Tabelle, Cache und Default`);
  }
}

const zweimalGleich = (name, erst) => {
  const zweit = zustand(name);
  assert.deepEqual(sortiert(zweit.tabelle), sortiert(erst.tabelle));
  assert.deepEqual(zweit.cache, erst.cache);
  assert.deepEqual(zweit.spalten, erst.spalten);
};

after(() => {
  for (const f of fs.readdirSync(path.join(SERVER, 'data'))) if (f.startsWith(PREFIX)) fs.unlinkSync(path.join(SERVER, 'data', f));
});

describe('Schema und Einstellungs-Migration (V3)', () => {
  let vorlageBereit = false;
  // Frisch geseedete V3-DB als Vorlage; jeder Fall arbeitet auf einer eigenen Kopie.
  const geseedet = (name) => {
    if (!vorlageBereit) { seeden('vorlage'); vorlageBereit = true; }
    kopieren('vorlage', name);
  };
  const V2 = { mm_spread_bp: 300, mm_jitter_bp: 60, mm_size: 40, mm_levels: 7 }; // V2: alle 14 alten Schlüssel, mm_levels = 7 als eigener Wert
  const ERSTE_VERSION = { mm_spread_bp: 350, mm_size: 15, mm_levels: 7 }; // allererste Version: keine alten Schlüssel

  test('frische DB: 44 Schlüssel aus DEFAULT_SETTINGS in Tabelle und Cache, mm_version = 3, keine entfernten Schlüssel, beide Spalten angelegt; zweimal Öffnen unverändert', () => {
    const erst = zustand('frisch');
    assert.equal(SCHLUESSEL.length, ANZAHL);
    assert.equal(Object.keys(erst.defaults).length, ANZAHL);
    assert.deepEqual(newsSpalten('frisch').find((c) => c.name === 'impact')?.dflt_value, '0');
    pruefeV3(erst, erst.defaults);
    assert.deepEqual([erst.tabelle.mm_version, erst.cache.mm_version], [3, 3]);
    assert.equal(erst.wertpapiere, 0);
    zweimalGleich('frisch', erst);
  });

  test('Alt-DB mit V3-Marker und News ohne impact (Stand vor V1): Spalte wird nachgerüstet, alte News bleiben mit impact 0, zehn Schlüssel mit Default, eigene Werte bleiben; zweimal Öffnen unverändert', () => {
    const name = 'vor-v1';
    geseedet(name);
    vorV1(name);
    direkt(name, (db) => setzen(db, { mm_spread_bp: 250, bot_fast: 1 }));
    const vorher = lesen(name);
    assert.ok(!(Object.keys(V1)[0] in vorher.tabelle) && vorher.tabelle.mm_version === 3, 'Vorbedingung: Marker da, V1-Schlüssel fehlen');
    assert.ok(!newsSpalten(name).some((c) => c.name === 'impact'), 'Vorbedingung: Spalte impact fehlt');

    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    const spalte = newsSpalten(name).find((c) => c.name === 'impact');
    assert.deepEqual([spalte.type, spalte.notnull, spalte.dflt_value], ['INTEGER', 1, '0']);
    // Alle News der Vorlage (IPO-Meldungen aus dem Seed) und die beiden eingefügten: Titel und Zuordnung bleiben, impact 0.
    assert.deepEqual(erst.news.slice(-ALT_NACHRICHTEN.length).map(({ id, ...n }) => n), ALT_NACHRICHTEN.map((n) => ({ ...n, impact: 0 })), 'alte News bleiben, impact 0');
    assert.ok(erst.news.every((n) => n.impact === 0), 'auch die News aus dem Seed: impact 0');
    assert.deepEqual([erst.tabelle.mm_spread_bp, erst.tabelle.bot_fast], [250, 1], 'eigene Werte bleiben');
    zweimalGleich(name, erst);
  });

  test('Vor-V3-DB mit V2-Werten (300 / 60 / 40, alle 14 alten Schlüssel): entfernte Schlüssel weg (Tabelle und Cache), alte Defaults ersetzt, eigene Werte bleiben, Marker, neue Schlüssel und Spalten ergänzt; zweimal Öffnen unverändert', () => {
    const name = 'v2';
    geseedet(name);
    vorV3(name, V2);
    const vorher = lesen(name);
    assert.ok(Object.keys(ENTFERNT).every((k) => k in vorher.tabelle) && !(MARKER in vorher.tabelle), 'Vorbedingung: Stand vor V3');
    assert.ok(Object.keys(NEU).every((k) => !(k in vorher.tabelle)) && !vorher.spalten.includes('fair_price') && !vorher.spalten.includes('ap_inventory_target'), 'Vorbedingung: neues fehlt noch');

    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    assert.deepEqual([erst.tabelle.mm_spread_bp, erst.tabelle.mm_jitter_bp, erst.tabelle.mm_size, erst.tabelle.mm_levels, erst.tabelle.mm_version], [100, 20, 10, 7, 3]);
    assert.deepEqual(Object.values(NEU), ['mm_impact_pct', 'mm_replenish_pct', 'etf_ap_inventory_pct'].map((k) => erst.tabelle[k]), 'neue Schlüssel nachgereicht');
    assert.equal(erst.wertpapiere, vorher.wertpapiere, 'Daten bleiben erhalten');
    zweimalGleich(name, erst);
  });

  test('DB der allerersten Version (keine alten Schlüssel, Spread 350, mm_size 15, ohne Marker): wird am Marker erkannt und migriert', () => {
    const name = 'erste-version';
    geseedet(name);
    vorV3(name, ERSTE_VERSION, []);
    const vorher = lesen(name);
    assert.ok(Object.keys(ENTFERNT).every((k) => !(k in vorher.tabelle)) && !(MARKER in vorher.tabelle) && vorher.tabelle.mm_spread_bp === 350, 'Vorbedingung');
    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    assert.deepEqual([erst.tabelle.mm_spread_bp, erst.tabelle.mm_size, erst.tabelle.mm_version], [100, 10, 3]);
    zweimalGleich(name, erst);
  });

  test('DB von ab8d8f1 (limit_band_cents und mm_step_bp vorhanden, Spread 350, mm_size 15): migriert vollständig', () => {
    const name = 'ab8d8f1';
    geseedet(name);
    vorV3(name, ERSTE_VERSION, ['limit_band_cents', 'mm_step_bp']);
    const vorher = lesen(name);
    assert.deepEqual(Object.keys(vorher.tabelle).filter((k) => k in ENTFERNT).sort(), ['limit_band_cents', 'mm_step_bp'], 'Vorbedingung');
    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    assert.deepEqual([erst.tabelle.mm_spread_bp, erst.tabelle.mm_size, erst.tabelle.mm_version], [100, 10, 3]);
    zweimalGleich(name, erst);
  });

  test('eigene Werte bleiben: mm_spread_bp 250 und mm_size 77 werden nicht angefasst; der alte Jitter-Default daneben wird ersetzt', () => {
    const name = 'eigen';
    geseedet(name);
    vorV3(name, { ...V2, mm_spread_bp: 250, mm_size: 77 });
    const vorher = lesen(name);
    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    assert.deepEqual([erst.tabelle.mm_spread_bp, erst.tabelle.mm_size, erst.tabelle.mm_jitter_bp, erst.cache.mm_spread_bp, erst.cache.mm_size], [250, 77, 20, 250, 77]);
    assert.deepEqual([erst.defaults.mm_spread_bp, erst.defaults.mm_size], [100, 10], 'Defaults bleiben die aus V3');
    zweimalGleich(name, erst);
  });

  test('V3-DB mit Marker bleibt unverändert — auch bei Werten, die wie alte Defaults aussehen, und bei einem stehen gebliebenen alten Schlüssel', () => {
    const name = 'mit-marker';
    geseedet(name);
    direkt(name, (db) => setzen(db, { mm_spread_bp: 300, mm_size: 40, limit_band_cents: 10000 }));
    const vorher = lesen(name);
    assert.deepEqual(vorher.tabelle.mm_version, 3, 'Vorbedingung: Marker vorhanden');
    const erst = zustand(name);
    assert.deepEqual(sortiert(erst.tabelle), sortiert(vorher.tabelle), 'Tabelle wird nicht angefasst');
    for (const [k, v] of Object.entries(vorher.tabelle)) if (!(k in ENTFERNT)) assert.deepEqual(erst.cache[k], v, `Cache ${k}`);
    assert.deepEqual([erst.cache.mm_spread_bp, erst.cache.mm_size, erst.cache.mm_version], [300, 40, 3]);
    assert.deepEqual(erst.wertpapiere, vorher.wertpapiere);
    zweimalGleich(name, erst);
  });

  test('Fehlerfall: Abbruch mitten in der Migration lässt nichts Halbes zurück — Tabelle zurückgerollt, kein Marker gesetzt, zweites Laden migriert vollständig', () => {
    const name = 'abbruch';
    geseedet(name);
    vorV3(name, V2);
    const vorher = lesen(name);
    // Drei Trigger in der Test-DB brechen die Migration nach mindestens einem Schreibvorgang ab — unabhängig von
    // der Reihenfolge der Anweisungen: die beiden ersten brechen das Ersetzen oder Setzen des Markers ab, sobald
    // ein alter Schlüssel gelöscht ist; der dritte bricht die Löschung ab, falls die Defaults schon ersetzt sind.
    const liste = Object.keys(ENTFERNT).map((k) => `'${k}'`).join(', ');
    direkt(name, (db) => {
      db.exec(`CREATE TRIGGER qa_nach_loeschung BEFORE INSERT ON settings
        WHEN NEW.key IN ('mm_spread_bp', 'mm_jitter_bp', 'mm_size', '${MARKER}')
         AND (SELECT COUNT(*) FROM settings WHERE key IN (${liste})) < ${Object.keys(ENTFERNT).length}
        BEGIN SELECT RAISE(ABORT, 'qa-abbruch'); END;`);
      db.exec(`CREATE TRIGGER qa_nach_loeschung_update BEFORE UPDATE ON settings
        WHEN (SELECT COUNT(*) FROM settings WHERE key IN (${liste})) < ${Object.keys(ENTFERNT).length}
        BEGIN SELECT RAISE(ABORT, 'qa-abbruch'); END;`);
      db.exec(`CREATE TRIGGER qa_nach_ersetzung BEFORE DELETE ON settings
        WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'mm_size' AND value = '10')
        BEGIN SELECT RAISE(ABORT, 'qa-abbruch'); END;`);
    });
    const r = oeffnen(name);
    assert.notEqual(r.status, 0, 'Laden musste an qa-abbruch scheitern (Migrationsfehler darf nicht verschluckt werden)');
    assert.match(r.stderr, /qa-abbruch/, r.stderr.slice(-600));
    // Nichts Halbes: jeder vor dem Laden vorhandene Schlüssel hat noch seinen alten Wert — gelöscht wäre endgültig,
    // alte Defaults wären schon überschrieben. Der Marker fehlt, sonst hielte das nächste Laden die DB für aktuell.
    const nachAbbruch = lesen(name).tabelle;
    for (const [k, v] of Object.entries(vorher.tabelle)) assert.deepEqual(nachAbbruch[k], v, `${k} nach Abbruch`);
    assert.ok(!(MARKER in nachAbbruch), 'kein Marker nach Abbruch');

    direkt(name, (db) => db.exec('DROP TRIGGER qa_nach_loeschung; DROP TRIGGER qa_nach_loeschung_update; DROP TRIGGER qa_nach_ersetzung;'));
    const erst = zustand(name);
    pruefeV3(erst, sollNachV3(vorher));
    zweimalGleich(name, erst);
  });
});
