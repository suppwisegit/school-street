# Die virtuellen Trader (Bot-Modus)

Der Bot-Modus ist das **Testspiel-Feature**: 100 virtuelle Schüler halten den Markt
lebendig, wenn nur wenige echte Spieler da sind. Entscheidungslogik in
`server/botbrain.js` (reine Funktionen, ohne DB), Markt, Uhr und Ausführung in
`server/bots.js`. Gesteuert wird er im Admin-Bereich **Spiel** (Knopf „Bots an/aus“,
„Wie viel die Bots handeln“, „Schnellmodus“), die Schnittstelle ist
`/api/admin/bots`.

Stand 27.11.2026. Dieser Text ersetzt die frühere Beschreibung (Kauf- oder
Verkaufslaune, Cash-Pacing) — die gilt nicht mehr.

---

## 1. In zwei Minuten

| | |
|---|---|
| Anzahl | Setting `bot_count` (Default 100) |
| Namen | Vornamen-Pool + Nummer: „Alex (Bot 5)“ |
| Konto | Normale Trader-Konten (`role='user'`, Flag `is_bot=1`), `start_capital` wie Schüler |
| Startposition | **Neu:** frische Bots übernehmen beim Start Aktien aus dem Streubesitz der Staatskasse und zahlen dafür zum aktuellen Kurs (ohne Order, ohne Kurswirkung) |
| Bot-Firmen | Bis zu 4 Bots gründen eine Firma (KICK, TAXI, BIO, TAB, BAND, MERCH, SCOOT, LERN, AULA, PRINT; IPO 18–55 Cr, 1 000 gesperrte Gründeraktien) |
| Persistenz | `bot_running` überlebt den Server-Neustart; Bots sind vom Ghost-Cleanup ausgenommen |
| Schutz | Escrow, Gebühr, Preis-Band und Self-Trade-Prevention gelten für Bots wie für Schüler |

Der Modus überlebt Neustarts; die Startposition gibt es nur einmal (Bots ohne
jeden Handel und ohne freie Aktien). Wer den Modus nach einem Neustart wieder
einschaltet, findet die Depots vor. **Bots einer alten Börse (vor dem 27.11.)
bekommen keine Startposition** und durchlaufen die alte Kaufphase der ersten
rund 15 Minuten — für ein neues Spiel neu seeden oder die Bots neu anlegen lassen.

---

## 2. Wie ein Bot entscheidet

### Persona (je Bot fest, aus dem Namen-Hash, überlebt Neustarts)

| Typ | Zielanteil Aktien | Mitläufer-Anteil |
|---|---|---|
| vorsichtig | 0,27 | – |
| sparer | 0,37 | – |
| ausgeglichen | 0,49 | 5 % |
| aktienfan | 0,61 | 10 % |
| zocker | 0,75 | 20 % |
| mitlaeufer | 0,49 | 100 % |

Der Zielanteil schwankt je Bot um ±0,1 (im Mittel 0,50; bis 27.11. 0,45). Dazu kommen je Bot: Cash-Reserve
(Anteil zwischen `bot_cash_reserve_min` und `bot_cash_reserve_max`),
Disposition (0,3–0,9), House-Money-Faktor (0,5–1,6), Overconfidence
(Handelsrate 0,3–3,0), News-Aufmerksamkeit (15–50 %), Konträr-Typ (20 % der
Nicht-Mitläufer), Wert-Rauschen und Haltedauer eines privaten Werts (4–20
Spielminuten), Limit-Affinität (10–30 %), Gewinnmitnahme-Schwelle (2–14 %),
News-Reaktion (20–100 %).

### Zielposition und Order

1. **Korb:** Jeder Bot beobachtet 2–4 Aktien fest; sind bei der Startposition
   welche übergeben worden, sind es genau diese. ETFs wählt er zu 12 %.
2. **Signal** (Summe −0,8 … +0,8): privater Wert-Anker, News, Momentum (letzte
   30 Spielminuten), Lage im Kursband (letzte 6 Spielstunden), marktweite
   Stimmung, Orderbuch-Lage. Nur Mitläufer folgen dem Trend deutlich.
3. **Zielwert je Aktie** = Vermögen × Zielanteil / Korblänge × (1 + 1,5 × Signal),
   geklemmt auf 25 % … 175 % des Anteils. Signal verschiebt das Ziel, es erzwingt
   keine Seite.
4. **Disposition:** Liegt der Kurs über der Gewinnmitnahme-Schwelle, sinkt das Ziel
   (Gewinner werden eher verkauft). Liegt er über 3 % unter dem Einstand, steigt es
   (Verlierer werden eher gehalten).
5. **Hold-Bereich ±15 %** um den Zielwert: dazwischen wird nichts getan.
6. **Ordergröße** = Anteil der Abweichung vom Ziel (20–100 %), größer durch House
   Money (Vermögen seit Start, Faktor 0,5–2,5). Der erste Einstieg in eine Position
   ist komplett, danach wird in Teilen nachgekauft oder abgebaut.
7. **Cash-Reserve:** Gekauft wird nur aus dem Betrag über der Reserve; liegt das
   Depot unter dem Ziel, darf der Bot die Reserve bis zur Hälfte anzapfen. Das ist
   die Asymmetrie, die bleibt: Verkäufe über dem Ziel laufen frei, Käufe unter dem
   Ziel scheitern an der Reserve (siehe Abschnitt 6).
8. **Neues Vermögen** (Einkommen, geschenkte Credits) wird nur zu 5 % in die
   Aktienziel-Grundlage aufgenommen, höchstens bis +50 % über dem Startvermögen.
   So wird nicht jede Einkommenszahlung zu einem Kauf.

### Uhr: Poisson, nur handlungsfähige Bots

- Jeder Bot hat eine eigene Poisson-Uhr in **Spielzeit**. Die Population zielt auf
  `bot_activity/100 × 420` Entscheidungen je Spielminute (Default 40 → 168);
  handlungsunfähige Bots (kein Cash für ein Stück, keine handelbare Aktie) zählen
  nicht mit. Jeder Bot handelt erstmals gleichverteilt in den ersten 2
  Spielminuten (bis 27.11.: 10 Minuten — da handelte im Normalmodus in der ersten
  Minute fast niemand). Die Signale wirken in den ersten 8 Spielminuten nur
  teilweise (15 % → 100 %).
- Je Tick höchstens 600 Entscheidungen und 200 Orders. Rest bleibt fällig.
- Der frühere TypeError aus `pickSecurity` (Zufall im `find`-Prädikat) ist weg.
- Limit-Orders: Bot-Limits verfallen nach 10 Spielminuten.

### Deckel gegen Herden

| Deckel | Wert | Wirkung |
|---|---|---|
| Order-Deckel je Bot-Order | eine Bot-Order bewegt den fairen Kurs um höchstens 3 % | aus Streubesitz und `mm_impact_pct` gerechnet (`maxStepShares`) |
| Herding-Deckel je Tick und Aktie (liegende Bot-Limit-Orders zählen mit) | alle Bot-Orders dieses Ticks an einer Aktie bewegen den Kurs **netto** um höchstens rund 1 % | die Order wird auf den Rest des Deckels **gekürzt** (`herdCapTrim`); ist kein Rest frei, wartet der Bot bis zu einer Sekunde Spielzeit (`herdCap`) |
| News-Staffelung | eine frische Aktien-News (jünger als 3 Spielminuten) wirkt je Bot nur mit 20–100 % | sonst liefen nach einer Nachricht alle Bots im selben Tick in dieselbe Richtung |

### News

`botbrain.newsImpact(news)` bewertet jede Zeile der Tabelle `news`:

- Steht eine Wirkung `impact` (ganze Zahl −3 … +3), verschiebt sie den Wert um
  `impact × 0,1` (geklärt auf ±0,3). `impact = 0` heißt **wirkungslos**: Die News
  rückt die Aktie nur ins Blickfeld.
- Ereignis-Arten ohne `impact` (Dividende +0,12, BaFin −0,25, Übernahme −0,30)
  wirken über ihre Art; IPO-News bewusst schwach (+0,02).
- Die Wirkung klingt ab: Halbwertszeit 20 Spielminuten (Dividende 30, BaFin und
  Übernahme 45), berücksichtigt werden News der letzten 45 Spielminuten. Messwerte im
  Betrieb: Fast-Modus 2 automatische News in 3 Sim-Stunden, Normalmodus 4 in
  2 Sim-Stunden.
- News ohne Wertpapier und mit `impact ≠ 0` sind marktweite Stimmung und gehen in
  alle Aktien ein; Mitläufer stärker, Konträre entgegengesetzt.

Einzelheiten und die automatischen News: [NEWS.md](./NEWS.md).

---

## 3. Fast-Modus und Spieluhr

`bot_fast` lässt die **Spieluhr** der Bots mit Faktor 100 laufen. Mit ihr skalieren:
Entscheidungsrate, Alter von News, Verfall von Limit-Orders, die Sperrzeiten des
News-Generators und der Nachplatzierungs-Cooldown (30 min / 100). Das **Einkommen
folgt standardmäßig der Wanduhr** (`income_sim_scale = 0`, für Schüler und Bots
dieselbe Uhr); mit `income_sim_scale = 1` läuft es mit der Spieluhr und die
Geldmenge wächst im Fast-Modus hundertmal schneller. Fast ist damit nur schneller — das
Kapital läuft nicht schneller leer, und eine Spielstunde dauert 36 Sekunden
Wanduhr. Der Schnellmodus lässt sich im laufenden Betrieb ein- und ausschalten.

Nicht skaliert: `ipo_highlight_sec` („Neu an der Börse“) und die Ghost-Frist.

---

## 4. Einkommen und Gebühren-Recycling

- **Einkommen** `income_cent` an alle aktiven Konten (Spieler und Bots) alle
  `income_sec` Wanduhr-Sekunden (Standard, `income_sim_scale = 0`); mit
  `income_sim_scale = 1` im Fast-Modus alle `income_sec / 100` Wanduhr-Sekunden; Bots erhalten stattdessen `bot_income_cent`, falls
  in der Tabelle `settings` gesetzt. Eingefrorene Konten erhalten nichts.
- **Gebühren-Pool:** Jede tatsächlich abgebuchte Gebühr (nach der Klemme auf das
  vorhandene Cash) landet in `fee_pool_cent` — derselbe Transaktion wie die Order.
- **Auszahlung:** Mit dem Einkommen zahlt `jobs.payIncome()`
  `fee_recycle_pct` % des Pool gleichmäßig an alle aktiven Konten aus und leert ihn.
  Eine Zahlung ist eine Transaktion; ein Neustart zahlt nichts doppelt.
- Die System-News „Wocheneinkommen ausgezahlt“ erscheint nur, wenn die Zahlungen
  mindestens eine Minute Wanduhr auseinanderliegen (im Fast-Modus mit
  `income_sim_scale = 1` oder sehr kurzem `income_sec` also nicht).
- Bots zahlen `bot_fee_cent`, falls gesetzt, sonst `fee_cent` wie Spieler.

Mit den Defaults (Gebühr 20 Cr, Recyclingsatz 100 %) ist die Gebühr damit kein
Geldvernichter mehr: Sie wird mit der nächsten Einkommenszahlung verteilt zurück
— inklusive der Gebühren der Schüler.

---

## 5. Einstellungen

Standard in `DEFAULT_SETTINGS` (`server/db.js`). Im Admin-Panel „Spiel“ stehen
Bots, Schnellmodus, Einkommen (Betrag und Abstand, „Jetzt auszahlen“), Startkapital
und Gebühr; alles andere änderbar über `PUT /api/admin/settings` oder einmalig in
der Tabelle `settings`.

| Schlüssel | Default | Wirkung |
|---|---|---|
| `bot_count` | 100 | Zahl der virtuellen Trader |
| `bot_activity` | 40 (0–100) | Zielrate: Entscheidungen je Spielminute = Wert/100 × 420 |
| `bot_tick_sec` | 3 | Takt des Bot-Loops in Sekunden Wanduhr |
| `bot_fast` | 0 | 1 = Spieluhr ×100 (Schnellmodus) |
| `bot_running` | 0 | intern: Modus läuft (überlebt Neustart) |
| `bot_cash_reserve_min` / `_max` | 0,2 / 0,4 | Cash-Anteil am Vermögen, den ein Bot nie in Aktien steckt (je Bot zwischen min und max) |
| `bot_fee_cent` | 0 | Eigene Gebühr je Bot-Order in Cent; 0 = wie `fee_cent` |
| `fee_recycle_pct` | 100 | % des Gebühren-Pools, der mit dem Einkommen zurückgezahlt wird |
| `income_sim_scale` | 0 | 1 = Einkommen folgt der Spieluhr (im Fast-Modus ×100 mehr Geld je Echtzeitstunde); 0 = Wanduhr (empfohlen) |
| `income_sec` | 300 | Abstand der Einkommenszahlungen in Spiel-Sekunden; 0 = aus |
| `income_cent` | 100000 | Einkommen je Zahlung (1 000 Cr) |
| `fee_cent` | 2000 | Gebühr je ausgeführter Order (Spieler; 20 Cr) |
| `start_capital` | 1000000 | Startkapital je Konto; zugleich Obergrenze für die Startposition eines Bots |
| `news_interval_sec` | 60 | 0 = automatische News aus; jeder andere Wert = an (kein Takt mehr, siehe NEWS.md) |
| `mm_impact_pct` | 50 | Kurswirkung je Stück; bestimmt Order- und Herding-Deckel der Bots |
| `mm_min_ask_shares` | 1000 | Mindestangebot der MM-Leiste je Aktie |
| `mm_min_depth` | 2000 | Streubesitz fällt nie darunter |
| `mm_replenish_min` | 120 | Mindestbestand der Staatskasse (Nachplatzierung) |
| `mm_replenish_pct` | 50 | Umfang einer regulären Nachplatzierung in % des Streubesitzes |

Nicht im Panel und nicht in der Freigabeliste, nur in der Tabelle `settings`:
`bot_trades_per_min` (Basisrate der Population, Default 420 je Spielminute bei
Aktivität 100) und `bot_income_cent` (eigenes Bot-Einkommen in Cent).

Endpunkte: `GET /api/admin/bots` (Status: läuft, Aktivität, Orders, Trades,
Überspringungen je Grund, handlungsfähige Bots, Spielminuten, Fehler),
`POST /api/admin/bots/start` / `stop`, `PUT /api/admin/bots/settings`
(`bot_activity`, `bot_tick_sec`, `bot_fast`), `POST /api/admin/income/now`.

---

## 6. Vorher/Nachher der Marktdynamik

### Was vorher war (DIAGNOSE, 26.11.)

Käufe waren durch Cash gedeckelt, Verkäufe nur durch den Bestand; 25 % des Cash
je Order plus 20 Cr Gebühr auf 1–10 Aktien. Im Turbo-Lauf des Nutzers (Kopie der
echten Börse, 100 Bots, Aktivität 100, Einkommen 3 600 s): Index 1,123 → 1,234 in
1,5–6,5 Minuten, dann bis 1,009 zurück; 18 966 Trades je 5 min am Höhepunkt, 0 am
Ende; am Ende hatten 100 von 100 Bots weniger als 240 Cr und **kein** Bot eine
Aktie. Im Normalmodus (120 Spielminuten) stand der Index bei 1,018 → 1,077, alle
Kurse klebten am oberen Rand des Bands.

### Kaufbarkeit (frischer Schüler, 10 000 Cr, eine Market-Order direkt nach dem Seed)

| Kennzahl | Vorher | Nachher |
|---|---|---|
| Kaufkraft, kleinste je Aktie | 69,7 % (EIS) | 99,7 % |
| mit einer Order kaufbar (MENSA / HAUSA / EVENT / EIS) | 190 / 270 / 465 / 434 Stück | 193 / 274 / 472 / 617 Stück |
| begrenzt durch | bei EIS das Angebot | bei allen vier das Geld |
| Ask-Summe über alle Aktien | 1 855 Stück | 4 502 Stück |
| kleinste Angebotsseite je Aktie | 385 Stück | 1 064 Stück |
| Streubesitz je Aktie | 2 000 | 2 822 |
| Ordergrenze | 689 Stück | 972 Stück |

Quellen: `.agent-team/berichte/vorher/kaufbarkeit.txt`,
`.agent-team/berichte/nachher/kaufbarkeit.txt` (dasselbe Skript).

### Bot-Dynamik (gleiche Szenarien wie die Diagnose)

Drei Szenarien, fester Seed 3, **ohne automatische News**, Einkommen an der
Wanduhr. Vorher aus `berichte/DIAGNOSE.md` bzw. `diag-sim-*.txt`; Nachher = Endstand
nach Rücknahme der Zielband-Regel (`berichte/NACHHER-MESSUNG.md`, Abschnitte 2, 8
und 9). Trades je 5 min, Kaufanteil und Index-Ende sind der Endstand; die Zeilen
„erstes Fenster“ und „größter Schritt“ stammen vom Stand der Runde davor.

| Kennzahl | Normal 60 min | Fast 120 min | Turbo 90 min (Live-Einstellungen) |
|---|---|---|---|
| Trades je 5 min, erstes Drittel — vorher → nachher | 170 → 375 | 2 041 → 313 | 4 674 → 455 |
| Trades je 5 min, letztes Drittel — vorher → nachher | 164 → 215 (57 %) | 1 090 → 148 (47 %) | 1 256 → 246 (54 %) |
| Fenster ohne Trades | 0 von 12 | 0 von 24 | 0 von 18 |
| Kaufanteil im Mittel — vorher → nachher | 63 % → 47,2 % | 54 % → 47,7 % | 51 % → 47,4 % |
| Kaufanteil im ersten Fenster — vorher → nachher | 92 % → 42 % | 81 % → 38 % | 76 % → 45 % |
| Fenster außerhalb 25–75 % Kaufanteil — vorher → nachher | 2 → 0 von 12 | 1 → 0 von 24 | 1 → 0 von 18 |
| Index Start → Ende, nachher (vorher Ende) | 1,010 → 0,981 (1,125) | 1,009 → 0,952 (1,492) | 1,009 → 0,949 (1,280) |
| Größter Kursschritt zwischen zwei Abtastungen (3 s) | 0,20 % | 0,34 % | 0,25 % |
| Bots unter 200 Cr am Ende — vorher → nachher | 0 → 0 | 0 → 0 | 97 → 0 |
| Bots ohne Cash und ohne Aktien am Ende — vorher → nachher | 0 → 0 | 0 → 0 | 96 → 0 |
| Staatskasse | nie leer | nie leer (vorher vier Aktien bei 0 Stück) | nie leer |

### Erreicht

- Der Markt handelt in allen drei Szenarien bis zur letzten Minute: kein Fenster
  ohne Trades, keine Kauf-, Verkaufs- oder Stagnationsphase mehr.
- Kein Bot ist leer: 0 unter 200 Cr, 0 ohne Cash und ohne Aktien, 100 von 100 mit
  Aktien; die Staatskasse läuft nie leer.
- Kein Herding: größter Kursschritt zwischen zwei Abtastungen 0,20–0,34 %; Index
  ±1–3 % je Stunde.
- Bots handeln ab der ersten Minute (Normalmodus: Trades in jedem 10-Sekunden-Fenster
  ab Sekunde 15).
- e2e „Bots 40 s, kein Schritt über 3 %“: 3 von 3 Läufen grün.

### Nicht erreicht

- **Leichte Verkaufsneigung:** Kaufanteil im Mittel rund 47 % (Ziel 49–51 %). Der
  Index fällt nach dem Start um 2–6 % und läuft dann flach (Normal −3 %, Fast
  −5 % bis −6 % über 60–90 Sim-Minuten). Der Test auf dieses Ziel steht als `todo`
  in `bots.test.js`.
- **Ursache, gemessen:** Unter dem Ziel wollen die Bots kaufen und können es nicht
  — die Cash-Reserve blockiert (`broke`: 2 791 je Fast-Lauf, 77 im Normal-Lauf).
  Über dem Ziel verkaufen sie frei (Fast-Live 90 min: 810 Käufe gegen 1 432
  Verkäufe). Nach einem Kursrückgang wollen alle nachkaufen und können nicht.
- **Zielband-Versuch zurückgenommen:** Netto verkaufen nur oberhalb Ziel + Band,
  kaufen nur unterhalb Ziel − Band. Ergebnis schlechter (Kaufanteil 43 %, Index
  −3,4 % / −7,7 %, Trades im letzten Drittel −40 %). Die Regel ist ausgebaut;
  geblieben sind nur die Zähler je Grund (`status().why_this_run`).
- **Kleinstes 5-min-Fenster ≥ 50 % des ersten Viertels:** 38–45 %. Die ersten
  10–15 Minuten sind ein Einschwingen nach der Startposition, danach stabil.
- **Ruhiger Index:** ±1–3 % je Stunde, 0,2–0,3 % je 5 min; einzelne Aktien −7 %
  bis +4 %. Mehr Bewegung brächte höhere Aktivität — nicht gemessen.
- **Mit News am endgültigen Generator nur ein Lauf** (Fast, 60 Sim-Minuten): 0
  Kurs-Auslöser (Grenze 4 je 10 Sim-Minuten), Kaufanteil 45,3 %, Index 1,010 →
  0,949. Ein Normal-Lauf mit News am endgültigen Generator fehlt.
- Der Bestandstest „Fast … 75 Spielminuten aktiv“ (letztes Drittel ≥ 50 % des
  ersten) fiel in einem von vier Läufen auf 46 % — an der Grenze.

Was ein nächster Ansatz bräuchte (nicht umgesetzt): Nachschub an Cash
(`income_sim_scale = 1`) oder eine Reserve, die das Erreichen des Zielanteils nie
blockiert.

---

## 7. Bekannte Grenzen

- **Streubesitz-Deckel:** Der Streubesitz wächst durch Nachplatzieren höchstens auf
  das 3-fache des Start-Streubesitzes (Faktor fest im Code,
  `MM_FLOAT_MAX_FACTOR`). Am Deckel wird nicht mehr nachgelegt; am Deckel bleibt
  das Angebot, was die Staatskasse noch hat. Ohne den Deckel wuchs er im
  Fast-Modus in 3 Minuten von 2 822 auf 27 461 Stück je Aktie.
- Läuft der Cooldown der Nachplatzierung, füllt die Auffüllung bis zur Schwelle
  auf; bei anhaltendem Kauf wächst der Streubesitz dabei zusätzlich.
- Die Nachplatzierung vergrößert den Streubesitz und senkt die Kurswirkung je
  Stück — der Markt wird mit der Zeit zäher.
- Order- und Herding-Deckel (3 %, 1 %) sind fest im Code, nicht einstellbar.
- Die Startposition gibt es nur für frische Bots; nach einem Neustart mitten im
  Spiel bekommt niemand Aktien zusätzlich.
- `bots.status().errors` zählt Ausnahmen in der Entscheidung (im Log als
  `[Bots] Entscheidungs-Fehler`); die Überspringungen (`skips`) sind normales
  Verhalten, keine Fehler.

---

## 8. Kalibrieren: zu ruhig oder zu wild

Zuerst `GET /api/admin/bots` ansehen: `able_bots` (handlungsfähige Bots),
`sim_minutes`, `skips_this_run`, `errors`.

| Symptom | Drehen an | Wirkung |
|---|---|---|
| Kaum Trades, Kurse stehen | `bot_activity` herauf (z. B. 40 → 70) | mehr Entscheidungen je Spielminute |
| Kaufwellen, einseitiger Markt | `bot_activity` herab; `bot_cash_reserve_min`/`_max` herauf | weniger Orders, mehr Cash bleibt liegen |
| Große Kurssprünge | `mm_impact_pct` herab | jedes Stück bewegt den Kurs weniger (auch für Schüler) |
| Geldmenge und Rangliste laufen im Fast-Modus davon | `income_sim_scale = 0` (Standard) | Einkommen an der Wanduhr, kein Geldüberhang |
| Index sinkt nach dem Start, Verkäufe überwiegen | `income_sim_scale = 1`; oder `bot_cash_reserve_min`/`_max` herab | Nachkäufe scheitern seltener an der Reserve (nicht gemessen) |
| Zu viele automatische News | `news_move_steps` herauf (z. B. „7,15,25“) oder `news_interval_sec = 0` | Ausreißer-News später bzw. gar nicht |
| Engpass am Angebot | `mm_min_ask_shares` herauf | mehr Stück im Buch; zugleich zähere Kurse |

Zwei Schritte ändern, ein paar Minuten laufen lassen, wieder messen — die Wirkungen
überlagern sich.

---

## 9. Dateien

| Datei | Inhalt |
|---|---|
| `server/botbrain.js` | Persona, Signal, Zielwert, Orderplan, Poisson-Uhr (rein, testbar ohne Server) |
| `server/bots.js` | Startposition, Bot-Firmen, Runner (Uhr, Einkommen, Deckel), Admin-Steuerung |
| `server/jobs.js` | Einkommen + Gebühren-Recycling, Spieluhr, News-Takt |
| `server/newsgen.js` | Automatische News aus Marktdaten |
| `server/test/bots.test.js` | Entscheidungslogik und Langzeitläufe |
