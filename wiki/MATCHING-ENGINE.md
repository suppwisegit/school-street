# Matching Engine & Market-Maker

Herz der Simulation: `server/engine.js`. Ein Prozess, synchron, SQLite (WAL)
— dadurch gibt es **keine Race Conditions** im Orderbuch. Alle Geldbeträge
sind Integer-Cents; Preise laufen bei Aktien und ETFs auf Ticks von 0,1 Credit
(10 Cent). Dazu führt jedes Buch einen **fairen Kurs F** in Milli-Cent; der
öffentliche Kurs ist F auf den Tick gerundet (Abschnitt 3).

---

## 1. Orderbuch (Price-Time-Priority)

Pro Wertpapier ein In-Memory-Buch (`books`-Map): `bids` absteigend, `asks`
aufsteigend; bei gleichem Preis gewinnt die **frühere Order** (FIFO) —
XETRA-Prinzip. Beim Serverstart wird das Buch aus `orders` (status='open')
rekonstruiert. Für die UI wird aggregiert (`bookSnapshot`).

Jedes Buch trägt zwei Kurse: `fair` (F in Milli-Cent, bei Aktien in
`securities.fair_price` persistiert) und `last` (der öffentliche Kurs K,
abgeleitet aus `fair`). Ein Fill-Preis steht im Trade, nicht im Kurs.

## 2. Lebensweg einer Order (`placeOrder`)

```
Validierung → Escrow → Matching → Flow-Update → MM-Recenter → Übernahme-Check → Broadcast
```

1. **Validierung:** Stückzahl, Typ, Preis-Tick (10 Cent); **Preis-Band** gegen
   Manipulation: Limits von Spielern und Bots müssen innerhalb des Bands um F
   liegen (Default ±15 %, mindestens 2 Ticks je Seite, Grenzen in 3.4;
   Staatskasse und Admin ausgenommen). **Ordergrößen-Grenze:** eine Markt-Order
   von Spielern und Bots an einer Aktie darf höchstens `Q_max` Stück umfassen
   (3.4). Markt-Orders werden vorab auf Tiefe und Cash geprüft („ehrlich
   abgelehnt“ statt Teilausführung ins Leere); dabei zählt nur Tiefe innerhalb
   des Bands. Founder-Lock-up blockt Gründer-Verkäufe.
2. **Escrow (treuhänderisch):**
   - Limit-Kauf: voller Betrag `preis × menge` wird vom Konto abgezogen;
     bei günstigerem Fill fließt die Differenz zurück.
   - Limit-Verkauf: Aktien wandern ins interne Escrow (Depot schrumpft).
   - Markt-Orders: keine Hinterlegung, Abrechnung pro Fill.
3. **Matching (`matchOrder`):** Der **Taker** frisst sich durch die
   Gegenseite — **zum Preis des Makers** (Maker-Preis gilt), nur innerhalb des
   Bands und an Aktien mit höchstens `Q_max` Stück (3.4). Dabei:
   - **Self-Trade-Prevention:** eigene Orders werden strikt übersprungen
     (auch Treasury darf eigene MM-Quotes nicht kaufen — deshalb hebt die
     AP-Automatik vor einer Creation die Quotes der Korbaktien auf).
   - **Budget-Guard** für Markt-Käufe: bar je Fill `cash − Gebühr`; ist das
     Geld midway alle, stoppt die Order.
   - Markt-Rest verfällt (Markt-Orders liegen nie im Buch).
4. **Abrechnung (`executeFill`):** Käufer zahlt/erhält Escrow-Refund,
   Verkäufer erhält Erlös; `avg_cost` (Käufer) und `realized_pl`
   (Verkäufer) werden fortgeschrieben; jeder Fill wird in `trades`
   persistiert; **Gebühr** wird bei beiden Seiten verbrannt
   (Geldvernichtung, auf den vorhandenen Cash geclampt — nie negativ). Der
   Fill-Preis setzt den Kurs nicht.
5. **Flow-Update** (in derselben Transaktion, direkt nach dem Matching): Pro
   Order mit Fills entsteht genau ein Kurspunkt in `price_history` (K,
   ausgeführte Menge) statt je Fill. An einer Aktie verschiebt außerdem jede
   Ausführung mit genau einer MM-Quote als Seite den fairen Kurs, nach der
   Seite des Teilnehmers (Formel in 3.2). Danach werden Orders, die durch
   den neuen Kurs außerhalb des Bands liegen, storniert (3.4).
6. Danach: MM legt die Staffel neu („Recenter“), >50 %-Übernahme-Check
   erzeugt News, WebSocket broadcastet `book`/`trade`/`ticker`/`dirty`.

Scheitert die Order nach einer Kursänderung, ist die Transaktion
zurückgerollt; `restoreBook` stellt dann auch den Arbeitsspeicher aus der
Tabelle wieder her (Wertpapierzeile, F, Orderbuch, ETF-Bücher). Es bleibt
kein Phantom-Kurs bis zum Neustart.

Storno (`cancelOrder`) gibt den Escrow exakt zurück — ohne Gebühr, die nur
auf **ausgeführte** Orders fällig wird. Dasselbe gilt für das automatische
Storno einer Order, die das Band verlassen hat (3.4). Stornieren ist
idempotent: Ist eine Order bereits storniert (auch durch das Band-Storno),
liefert ein zweites Stornieren Erfolg ohne Buchung; nur bei vollständig
ausgeführten Orders kommt eine Fehlermeldung.

---

## 3. Market Maker V3 — Orderflow-Preisfindung

Der MM ist die Staatskasse (Treasury, `role='bank'`) und bleibt passiv und
meinungslos: Er macht keinen Trend. Er führt je Aktie einen **fairen Kurs F**,
den ausschließlich der netto gerichtete Orderflow der Teilnehmer gegen seine
Quotes bewegt. Um F quotiert er eine Staffel, deren Grenzpreise genau dieser
Kurswirkung folgen.
Die Rechenregeln liegen als reine Funktionen in `server/mmath.js` (kein
DB-Zugriff, kein eigener Zufall — `Math.random` wird beim Aufruf übergeben);
`engine.js` liefert Zustand und Bestand.

Je Wertpapier abschaltbar: Spalte `securities.mm_enabled` (Default 1).

### 3.1 Zustand

- `F` je Aktie, ganzzahlig in Milli-Cent (1 Credit = 100 000). Spalte
  `securities.fair_price`, im RAM `book.fair`.
- `D` Streubesitz = `total_shares − Gründerbestand`, mindestens 1
  (`depthOf`). Abgeleitet aus `holdings`, nie gespeichert.
- `λ = ln(1 + p) / D` mit `p = mm_impact_pct / 100` — die Kurswirkung eines
  Stücks. Mit dem Default `p = 50` gilt: Wird netto der ganze Streubesitz
  gekauft (q = D), steigt F um 50 %.

### 3.2 Kursupdate — der einzige Weg, auf dem sich F ändert

```
q = ausgeführte Stückzahl (Kauf +, Verkauf −)
F ← round(F · e^(λ·q))
```

Als Orderflow zählt jede Ausführung, an der **genau eine Seite eine MM-Quote
der Staatskasse** ist und die andere ein Teilnehmer (`role='user'`, Spieler
oder Bot). Der Zähler geht nach der Seite des Teilnehmers:

1. Der Teilnehmer nimmt eine MM-Quote: seine Kaufmenge +, seine
   Verkaufsmenge −.
2. Der Market Maker beliefert ein liegendes Gebot oder Angebot eines
   Teilnehmers (seine Quote kreuzt es beim Neuplatzieren): sein Gebot wird
   gefüllt → +, sein Angebot → −.

**Geschäfte zwischen zwei Teilnehmern lassen F unverändert** — die Stücke
wechseln nur den Besitzer, die Nachfrage im Netz ist null. Treasury und
Admin als Gegenüber des Market Makers tragen nichts bei. ETFs haben kein
Flow-Impact (Abschnitt 4). Gründe: Zählte jedes Taker-Volumen, könnten zwei
Konten abwechselnd als Käufer gegeneinander handeln und F ohne Netto-Nachfrage
heben. Zählte nur Fall 1, könnte ein großes liegendes Gebot am Band-Rand den
ganzen Bestand der Staatskasse ohne Kurswirkung übernehmen. Das Kreuzen
endet von selbst: Steigt F, liegen die MM-Angebote irgendwann über dem Gebot.

Nach jedem Update steht F in `securities.fair_price`; danach rechnet
`syncEtfPrices()` die ETF-Kurse neu.

**Garantien**

1. F hängt nicht vom Limitpreis ab.
2. Pfadunabhängig: `F_T = F_0 · e^(λ·Σq)` — nur die Summe der Flow-Mengen
   zählt.
3. Monoton, in log symmetrisch: Nachfrage der Teilnehmer gegen den MM hebt F,
   Angebot senkt es; +q und −q heben sich auf.
4. Ohne Teilnehmer-Orders gegen den MM ist F konstant — Recenter, Refresh
   und Neustart lassen es unverändert.
5. Skalenfrei: dieselbe Stückzahl bewirkt denselben prozentualen Effekt,
   unabhängig vom Kursniveau.

### 3.3 Öffentlicher Kurs

`K = F auf Tick gerundet` (`publicPrice`), mindestens 1 Tick. `book.last`
trägt K (Feldname bleibt). Ticker, Charts (`price_history`), Depotwert,
Marktkapitalisierung und Bots lesen K. Fill-Preise stehen weiter in `trades`
und im WebSocket-Event `trade`.

`price_history` bekommt einen Punkt je Order mit Fills (K, ausgeführte
Menge) und alle 30 s einen Punkt mit dem aktuellen K (Preis-Sampler in
`jobs.js`).

### 3.4 Band und Ordergrößen-Grenze

**Band** (B = `limit_band_pct`, Default 15 %, mindestens 2 Ticks je Seite),
mit `fc` = F in Cent und `t` = Tick (10 Cent):

```
span = max(round(fc · B / 100), 2·t)
min  = max(t, floorTick(fc − span))
max  = ceilTick(fc + span)
```

`floorTick`/`ceilTick` runden auf Vielfache des Ticks ab bzw. auf —
float-sicher mit 1e-9-Toleranz, damit ein Wert, der rechnerisch genau auf
einem Tick liegt, dort bleibt (20 · 0,98 = 19,60 wird nicht 19,50).

- Limit-Orders von Spielern und Bots müssen innerhalb `[min, max]` liegen.
  Sonst: „Preis zu weit vom Kurs entfernt (Kurs X ±Y %). Erlaubt: min – max“
  mit X = K und Y = B.
- Ausgefüllt wird ausschließlich innerhalb desselben Bands — für jeden
  Taker, in Matching (`matchOrder`), Vorschau (`walkBook`) und
  Tiefenprüfung (`sideDepth`). `walkBook` bricht auf der Kaufseite ab, sobald
  ein Ask über `max` liegt, und überspringt Asks unter `min`; die
  Verkaufsseite ist spiegelbildlich. Vorschau und Ausführung rechnen gleich.
- MM-Quotes liegen per Konstruktion im Band: Die Staffel wird am Bandrand
  abgeschnitten, nicht hineingezwungen.
- **Automatisches Band-Storno:** Verlässt eine liegende Order, die keine
  MM-Quote ist (also ein Auftrag von Spielern oder Bots), das Band, weil sich
  F bewegt hat, wird sie storniert — Escrow zurück, `dirty`-Event je
  Benutzer. Ausgeführt nach jedem Flow-Update in derselben Transaktion und
  einmalig bei der Migration (3.7). Sonst blieben unausführbare Orders
  sichtbar und sperrten Escrow.

**Ordergrößen-Grenze.** Das Band begrenzt die Preise, zu denen gehandelt
wird, nicht die Stückzahl. Damit wirklich keine einzelne Order F um mehr als B
bewegt, führt eine Order von Spielern und Bots an einer Aktie höchstens

```
Q_max = floor(ln(1 + B) / λ)            (aus F · e^(λ·q) ≤ F · (1 + B))
```

Stück aus — dieselben Orders, die F bewegen. Bei 15 % Band und
`mm_impact_pct` 50 sind das 34 % des Streubesitzes: D = 2000 → 689 Stück,
D = 400 → 137 Stück.

- Markt-Order mit mehr als `Q_max` Stück: abgelehnt, bevor Liquidität und
  Cash geprüft werden — „Zu groß für eine Order: höchstens {Q_max} Stück,
  damit der Kurs pro Order höchstens {B} % springt. Teile die Order.“
- Limit-Order mit mehr als `Q_max` Stück: wird angenommen; sofort ausgeführt
  werden höchstens `Q_max` Stück, der Rest bleibt als offene Order im Buch.
- ETFs, Treasury-Orders und MM-Quotes: keine Grenze (kein Flow-Impact).
- `matchOrder`, `walkBook` (`opts.maxQty`) und `previewOrder` verwenden
  dieselbe Grenze; die Vorschau liefert sie als `cap` (bei ETFs `null`).

Folgerung: Keine einzelne Order bewegt F um mehr als B. Dafür gilt eine
zweite harte Regel für Fall 2 in 3.2: Der Market Maker beliefert eine
liegende Order eines Teilnehmers nur so weit, dass F den Preis dieser Order
nicht überschreitet (Gebot) bzw. unterschreitet (Angebot). Eine kreuzende
Staffelstufe wird auf die Stückzahl begrenzt, die bis zu diesem Preis führt —
Raum = `floor(ln(p / F) / λ)` mit p = Preis der Order für ein Gebot,
`floor(ln(F / p) / λ)` für ein Angebot. Passt keine mehr, wird die Stufe
nicht platziert. Da liegende Orders immer innerhalb des Bands liegen, gilt
die Grenze ohne Ausnahme. Gemessener Höchstwert bei Streubesitz 400 über
200 Ziehungen: 14,9 % (vor der Regel 24,55 %).

### 3.5 Staffel

`mmLadder(book)` ruft `mmath.ladder` mit `levels = mm_levels`,
`size = mm_size`, `sizeStep = mm_size_step`, `bandPct = limit_band_pct`,
`sizeJitter = mm_size_jitter` und `rnd = Math.random`. Mit F in Cent,
`h = (mm_spread_bp / 2) · 1e−4` (halber Spread), `j = mm_jitter_bp · 1e−4`
und `X` = Summe der Größen aller vorherigen Stufen gilt für die Stufe
`i = 0 … levels−1` (`rnd()` liefert gleichverteilt Werte in `[0,1)`):

```
s     = max(1, round((mm_size + i·mm_size_step) · (1 + (2·rnd()−1) · mm_size_jitter)))
mitte = X + s/2                          Mitte der eigenen Menge der Stufe
dist  = max(h, h + λ·mitte + (2·rnd()−1) · j)
ask   = ceilTick(F · (1 + dist))          bid = floorTick(F · (1 − dist))
```

- **Bewertung an der Stufenmitte.** Jede Stufe wird an der Mitte ihrer
  eigenen Menge bewertet: Verkauf `F · (1 + h + λ · (X_i + s_i/2))`, Kauf
  `F · (1 − h − λ · (X_i + s_i/2))`. Wer eine Stufe kauft, bezahlt damit genau
  die halbe Kursbewegung, die diese Menge auslöst. Der Rückverkauf derselben
  Menge kostet deshalb immer den doppelten Spread — es gibt keinen
  risikofreien Hin- und Rückhandel auf Kosten der Staatskasse.
- **Nie innerhalb des halben Spreads.** `max(h, …)` hält den Abstand
  mindestens beim halben Spread; der Jitter kann ihn nicht unterschreiten.
- **Streng monoton:** jede Stufe mindestens einen Tick von der vorigen
  (`max(ask, letzter ask + t)` bzw. `min(bid, letzter bid − t)`).
- **Im Band:** eine Seite wird nicht mehr beschickt, sobald ihre nächste
  Stufe außerhalb läge.
- **Kreuzungsschutz:** läge der beste Ask auf oder unter dem besten Bid,
  werden alle Asks um denselben Abstand angehoben (ganze Ticks, die Ordnung
  bleibt), sodass der beste einen Tick über dem Bid liegt; Stufen, die dann
  über `max` liegen, fallen weg.
- Ergebnis: `bids` absteigend, `asks` aufsteigend, alle Preise Vielfache des
  Ticks und innerhalb des Bands, `size ≥ 1`.

Beispiel mit den Defaults (F = 20,00 Cr, Streubesitz 2000, `mm_impact_pct` 50
→ λ = 0,0002027, `mm_spread_bp` 100 → h = 0,5 %, ohne Jitter): Stufen
10 / 35 / 60 / 85 / 110 / 135, zusammen 435 Stück je Seite.

| Größe | Mitte | Brief roh | Brief | Geld roh | Geld |
|---|---|---|---|---|---|
| 10 | 5 | 20,120 | 20,20 | 19,880 | 19,80 |
| 35 | 27,5 | 20,212 | 20,30 | 19,788 | 19,70 |
| 60 | 75 | 20,404 | 20,50 | 19,596 | 19,50 |
| 85 | 147,5 | 20,698 | 20,70 | 19,302 | 19,30 |
| 110 | 245 | 21,093 | 21,10 | 18,907 | 18,90 |
| 135 | 367,5 | 21,590 | 21,60 | 18,410 | 18,40 |

Kauft jemand alle 435 Stück, zahlt er im Mittel 21,01 Cr; F steht danach
bei 21,84 Cr (K = 21,80). Der Rückverkauf derselben Stückzahl über die neue
Staffel bringt im Mittel 20,74 Cr — ein Verlust von 1,3 % vor Gebühren.

**Tick-Raster und tatsächlicher Spread.** Die Spread-Einstellung ist nicht
der tatsächliche Spread: Das Gebot wird ab-, der Brief aufgerundet, und bei
Aktien kommt an jeder Stufe die Kurswirkung der halben Stufenmenge
`λ · s_i/2` hinzu. Der Spread an der Spitze liegt deshalb über der
Einstellung; bei billigen Werten fällt die Rundung stärker ins Gewicht, im
Einzelnen springt der Wert mit dem Raster. Ohne Jitter, bei Streubesitz 2000
mit `mm_spread_bp` 100 und `mm_size` 10: Aktie zu 20 Credits 2,0 %, zu
30 Credits 1,3 %, zu 50 Credits 1,6 %. Beim ETF-Quote ohne den λ-Zusatz:
1,0 %, 1,3 %, 1,2 %.

Beim Platzieren begrenzt `recenterBody` die Stufen auf das Cash-Budget
(Kaufseite) und den ganzen Bestand der Staatskasse (Verkaufsseite, ohne
Reserve; fehlt Bestand, legt die Nachplatzierung nach).

### 3.6 Liquidität

- **Nach jedem Trade mit Fills** quotiert der MM das Buch sofort neu. Kreuzt
  die neue Staffel dabei liegende Orders und verschiebt dadurch F, wird sie
  höchstens zweimal erneut gelegt.
- **Self-Healing** in `mmRefreshAll` (Takt 3 s): Ein Buch ohne MM-Quotes wird
  neu gelegt, sobald sein Takt fällig ist. Hebt die ETF-Automatik oder ein
  Fehler Quotes auf, wird der Takt sofort fällig — die Lücke heilt in
  spätestens 3 s. Sonst gilt der Turnus `mm_refresh_sec` (gestaffelt ±30 %);
  eine Seite, die sich nicht quotieren lässt (kein Bestand, kein Cash), wird
  nur im Turnus erneut versucht.
- **Nachplatzierung** (nur Aktien), wenn der Bestand der Staatskasse (Depot +
  Ask-Escrow) ≤ `mm_replenish_min`:
  - Regulär: `max(100, round(D · mm_replenish_pct / 100))` neue Aktien — mit
    den Defaults die Hälfte des Streubesitzes —, mit News, danach 30 Min
    Sperre (im Fast-Mode /100), ohne Kursbedingung.
  - Läuft die Sperre: ohne Wartezeit genau `mm_replenish_min` Stück
    nachlegen, ohne News.
- **Streubesitz-Regeln** (`mm_min_depth` > 0, Stand 27.11.2026; sie gelten
  zusätzlich zur Nachplatzierung oben und ohne Cooldown):
  - Der Streubesitz D sinkt nie unter `mm_min_depth` (Default 2000).
  - Das Band muss `mm_min_ask_shares` Stück fassen (Default 1000): `mmath.ladder`
    hängt Anschluss-Stufen an, bis die Angebotsseite so viele Stück hält oder
    das Band endet. Passt es beim aktuellen D nicht, kommt in einem Schritt so
    viel Streubesitz dazu, dass es passt (ohne News). Im Seed starten die
    Aktien mit D = 2822 statt 2000.
  - Nachplatzierungsschwelle (gilt statt `mm_replenish_min` im Kasten oben):
    Bestand der Staatskasse unter
    `max(mm_replenish_min, 25 % von D, mm_min_ask_shares + 100)`.
  - **Deckel:** Durch Nachplatzieren wächst D höchstens auf das 3-fache des
    Start-Streubesitzes (`MM_FLOAT_MAX_FACTOR`, fest im Code). Am Deckel wird
    nicht mehr nachgelegt; die Struktur-Regeln gelten weiter.
  - Die Nachplatzierung bei laufender Sperre füllt bis zur Schwelle auf, nicht
    um `mm_replenish_min` Stück.
  - Messwerte (frischer Seed, 10 000 Cr, eine Market-Order): Angebotsseite je
    Aktie 1 064–1 189 Stück (vorher 385–519), Ask-Summe 4 502 (vorher 1 855),
    Ordergrenze 972 (vorher 689). Eine Order bewegt den fairen Kurs bei
    50 / 200 / 500 Stück um 0,72 % / 2,92 % / 7,45 %.
    Quelle: `.agent-team/berichte/nachher/kaufbarkeit.txt`.
- **Verkaufsseite ohne Reserve:** Aktien und ETFs werden mit dem ganzen
  Bestand angeboten; es bleibt kein Puffer im Depot.
- **Bid-Cash-Budget je Wert:**
  `floor(Treasury-Cash · mm_cash_budget_pct / Zahl der Bücher mit mm_enabled)`.
- **Zentralbank-Notkredit** (fest im Code, keine Einstellung): Fällt der
  Treasury-Cash unter `mm_recap_min_pct` (5 %) des Startkapitals
  (`treasury_capital`), füllt die Zentralbank auf 25 % des Startkapitals auf,
  frühestens alle 10 Minuten.

### 3.7 Laden und Migrieren (`loadEngine`)

- `fair_price` nicht NULL → übernehmen (F überlebt Neustarts exakt).
- Aktie mit NULL (alte DB): Median der Preise der letzten 25 Trades, sonst
  `ipo_price`; × 1000; zurückschreiben.
- ETF: F über `syncEtfPrices()`, nachdem alle Aktien geladen sind.
- Wurde mindestens eine Zeile initialisiert, werden einmalig storniert, mit
  voller Escrow-Rückbuchung (Kauf: `price × Restmenge` an `cash`; Verkauf:
  Restmenge mit `avg_cost` der Order zurück ins Depot): jede offene Order
  außerhalb des Bands, auch alte Aufträge der Staatskasse, sofern keine
  MM-Quotes; und zusätzlich alle manuellen Orders der Staatskasse, auch
  innerhalb des Bands (frühere AP-Leitern — die Automatik arbeitet heute mit
  Market-Orders).
- `listSecurity` schreibt `fair_price = (initial_last || ipo_price) · 1000`.
- Einstellungen über einen Versions-Marker: Fehlt die Zeile `mm_version` in
  `settings`, gilt die Datenbank als vor V3 — egal welchen Alters. Dann
  laufen beim Laden in einer Transaktion ab: die 14 entfallenen Schlüssel
  (3.8) löschen; alte Standardwerte ersetzen (`mm_spread_bp` 350 oder 300 →
  100, `mm_jitter_bp` 60 → 20, `mm_size` 15 oder 40 → 10; eigene Werte
  bleiben); Marker setzen. Auf einer frischen Datenbank setzt sie nur den
  Marker. Kehrt man zum alten Code zurück und wieder auf V3, bleiben die 14
  Schlüssel, die der alte Code neu anlegt, stehen — kein Code liest sie.

### 3.8 Einstellungen

Standard in `DEFAULT_SETTINGS` (`server/db.js`). Einmalig in die Tabelle
`settings` eingetragen, bleiben eigene Werte erhalten; änderbar auch über
`PUT /api/admin/settings`. Ein Basispunkt (bp) ist 0,01 %.

| Schlüssel | Einheit | Default | Wirkung |
|---|---|---|---|
| `mm_version` | intern | 3 | Stand des Market-Maker-Modells; fehlt die Zeile, migriert der Server die Einstellungen beim Laden (3.7). Nicht ändern. |
| `mm_impact_pct` | % | 50 | Kursanstieg, wenn netto der ganze Streubesitz D gekauft wird: `λ = ln(1 + mm_impact_pct/100) / D`. Bestimmt Kurswirkung, Staffelabstände und `Q_max`. |
| `mm_spread_bp` | Basispunkte | 100 | Gesamter Abstand zwischen Geld und Brief an Stufe 0; je Seite `mm_spread_bp / 2` vom fairen Kurs. Gilt auch für ETF-Quotes. Der tatsächliche Spread liegt darüber (Tick-Raster, 3.5). |
| `mm_jitter_bp` | Basispunkte | 20 | Zufalls-Jitter ± auf den Abstand jeder Stufe; unterschreitet den halben Spread nie. |
| `mm_levels` | Stufen je Seite | 6 | Zahl der Stufen der Staffel. |
| `mm_size` | Stück | 10 | Stückzahl von Stufe 0. Klein, damit der Touch trotz Bewertung an der Stufenmitte beim Spread bleibt (Austritt um `λ · mm_size / 2`, mit 10 Stück 0,1 % bei Streubesitz 2000). Mit `mm_size_step` 25: Stufen 10/35/60/85/110/135, rund 435 Stück je Seite. |
| `mm_size_step` | Stück | 25 | Zuwachs je Stufe: Stufe `i` hat `mm_size + i · mm_size_step`. |
| `mm_size_jitter` | Anteil | 0.35 | Zufalls-Jitter ± auf die Größe jeder Stufe (0.35 = ±35 %). |
| `mm_refresh_sec` | Sekunden | 15 | Turnus, in dem ein beidseitig quotiertes Buch neu gelegt wird (gestaffelt ±30 %). |
| `mm_fee_exempt` | 0/1 | 1 | 1 = MM-Quotes zahlen keine Gebühr. |
| `mm_cash_budget_pct` | Anteil | 0.9 | Anteil der Treasury-Cash für das Bid-Escrow, fair auf die Bücher mit `mm_enabled` verteilt. |
| `mm_replenish_min` | Stück | 120 | Schwelle, ab der nachgelegt wird: Bestand der Staatskasse (Depot + offene Verkaufsorders) nicht über diesem Wert → neue Aktien. Zugleich die Menge der Nachlegung ohne Wartezeit, wenn die 30-Minuten-Sperre der regulären Nachplatzierung läuft (dann ohne News). Kein Puffer im Depot. |
| `mm_replenish_pct` | % | 50 | Reguläre Nachplatzierung: `max(100, round(D · mm_replenish_pct / 100))` neue Aktien — mit dem Default die Hälfte des Streubesitzes. |
| `mm_min_ask_shares` | Stück | 1000 | Mindestangebot der Angebotsseite (Anschluss-Stufen bis zur Bandkante). Bestimmt auch den Start-Streubesitz und die Nachplatzierungsschwelle (3.6). 0 = aus. |
| `mm_min_depth` | Stück | 2000 | Streubesitz sinkt nie darunter; auch der unterste Wert, von dem an der Start-Streubesitz gesucht wird. 0 = alte Regeln ohne Start-Streubesitz und ohne Deckel. |
| `mm_recap_min_pct` | Anteil | 0.05 | Zentralbank-Notkredit: Treasury-Cash unter diesem Anteil von `treasury_capital` → Auffüllung auf 25 %, frühestens alle 10 Minuten. |
| `limit_band_pct` | % | 15 | Band um F für Limits, Ausführung und Staffel; bestimmt `Q_max`. (Kein MM-Schlüssel, aber Grenze der Staffel.) |
| `etf_auto` | 0/1 | 1 | 1 = AP-Automatik nach der Arbeitsbestand-Regel (Abschnitt 4), Job alle 5 s. |
| `etf_ap_inventory_pct` | % | 25 | Arbeitsbestand der Staatskasse am ETF in % des Umlaufs: `W = max(W0, round(etf_ap_inventory_pct / 100 · Umlauf))`, mindestens 1 Unit. |
| `etf_auto_max_units` | Creation Units | 25 | Höchstmenge je Aktion (Creation oder Redemption). |
| `etf_auto_interval_sec` | Sekunden | 10 | Mindestabstand zwischen zwei Aktionen je ETF. |

**Entfallene Einstellungen:** `limit_band_cents`, `mm_step_bp`, `mm_noise_bp`,
`mm_inv_target_pct`, `mm_inv_skew_bp`, `mm_guard_pct`, `mm_guard_widen`,
`mm_vol_ref`, `mm_vol_mult_max`, `mm_replenish_qty`,
`mm_replenish_price_mult`, `mm_recap_to_pct`, `etf_auto_threshold_pct`,
`etf_auto_units`.

**Entfallene Mechaniken:** Referenz-Rauschen, Inventar-Skew,
Volatilitäts-Skalierung, Momentum-Bremse, ETF-Referenzmischung,
NAV-Peg-Leiter, Premium-Schwelle als Trigger, Market-Kauf von ETF-Anteilen
durch die Automatik, 100-Cr-Band-Boden, Kursbedingung der Nachplatzierung.

---

## 4. ETF: vollautomatisches Management am NAV

Die Staatskasse ist **Authorized Participant**. Einen ETF hält sie ohne
Zutun am Wert seines Korbs: Der Market Maker quotiert ihn direkt am NAV, und
die AP-Automatik (`etf.autoArbitrage()`, Job alle 5 s, nur mit `etf_auto=1`)
führt den Bestand. Schöpfen und Einlösen von Hand bleibt möglich über
`/api/admin/etf/:id/create-units` und `/redeem-units` (Vorschau:
`/api/admin/etf/:id/preview`).

**Kurs = NAV.** `NAV = round(Σ qty_i · F_i / shares_per_unit)` in
Milli-Cent — der Korb bewertet zu den fairen Kursen der Aktien. Nicht
persistiert; beim Laden und bei jeder Änderung einer Korbaktie neu berechnet
(`engine.syncEtfPrices()`). Orderflow im ETF kann kein Aufgeld erzeugen: Für
ETFs gibt es kein Flow-Impact. K weicht höchstens einen Tick (0,1 Credit) vom
NAV ab.

**Quotes.** Flach, eine Stufe je Seite (`mmath.flatQuotes`), mit NAV in Cent
und `h = (mm_spread_bp / 2) · 1e−4` (halber Spread):

```
ask = ceilTick(NAV · (1 + h))          bid = floorTick(NAV · (1 − h))
```

Kreuzen sie sich, liegt der Ask einen Tick über dem Bid. Verkauf mit dem
ganzen freien Bestand (keine Reserve), Kauf mit dem Cash-Budget. Neu gelegt,
sobald K um mindestens 1 Tick von der letzten Quotierung abweicht (Prüfung in
`mmRefreshAll`, Takt 3 s).

**Arbeitsbestand-Regel.** Die Staatskasse hält als AP einen Arbeitsbestand
und handelt ihn in beide Richtungen automatisch. Eine Unit ist eine Creation
Unit (`shares_per_unit` Anteile), Umlauf ist `total_shares` des ETF,
`clamp(x, a, b)` begrenzt x auf `[a, b]`.

- `W0` = `securities.ap_inventory_target`: Anfangsbestand bei Schöpfung
  (`initial_units · shares_per_unit`), setzt `createEtf`. Ist der Wert NULL
  oder ≤ 0 (alte DB), setzt die Automatik ihn einmalig auf
  `max(1 Unit, etf_ap_inventory_pct % des Umlaufs)` und speichert ihn —
  immer bevor `W` gerechnet wird.
- `W = max(W0, round(etf_ap_inventory_pct / 100 · Umlauf))`, mindestens
  1 Unit — der Arbeitsbestand.
- `T` = Depotbestand der Staatskasse am ETF + ihre offenen MM-Verkaufsorders
  (Ask-Escrow).

**Creation**, wenn `T < 0.5 · W`:
`n = clamp(ceil((W − T) / shares_per_unit), 1, etf_auto_max_units)` Units.

1. Je Korbaktie rechnen: Bedarf `qty · n`; Potenzial = Depotbestand der
   Staatskasse plus Summe ihrer eigenen offenen MM-Verkaufsorders;
   Fremdangebot = Summe der im Band liegenden offenen Verkaufsorders anderer
   Konten.
2. Reicht für eine Aktie Potenzial plus Fremdangebot nicht: Abbruch ohne
   Aktion — es wird nichts gekauft, keine Quote angefasst, es gibt kein News
   und keinen actions-Eintrag, der Mindestabstand wird nicht gesetzt. Neuer
   Versuch beim nächsten Takt. So bleibt kein angefangener Teilkorb liegen.
3. Sonst je Aktie die Differenz Bedarf minus Potenzial am Markt von Spielern
   kaufen (Market-Order der Staatskasse, Best-Effort), Potenzial neu lesen;
   reicht es irgendwo nicht: ebenfalls Abbruch ohne Aktion, Kurse und
   MM-Quotes der Korbaktien bleiben unberührt.
4. `createUnits`, das die MM-Quotes der Korbaktien aufhebt. Danach wird in
   jedem Fall jede Korbaktie sofort neu quotiert, auch nach einem Fehler:
   Eine wiederholt scheiternde Creation darf sie nicht ohne MM-Quotes
   lassen.

**Redemption**, wenn `T > 1.25 · W` und `T − W ≥ 1 Unit`:
`n = min(floor((T − W) / shares_per_unit), etf_auto_max_units)` Units (ergibt
mindestens 1). Ist der Überschuss kleiner als eine Unit, passiert nichts.
Ablauf: MM-Quotes des ETF aufheben → `redeemUnits` (quotiert den ETF neu) →
Korbaktien sofort neu quotieren, damit die zurückgekommenen Aktien angeboten
werden.

Sonst keine Aktion. Mindestabstand `etf_auto_interval_sec` je ETF für beide
Richtungen. News je Aktion, höchstens 1 pro Minute je ETF.

Was die Regel bewirkt:

- Beim Start eines ETF greift keine Aktion, weil die Staatskasse dort genau
  `W0` hält.
- Eingelöst wird nur, was über `W` hinausgeht: Der Umlauf bleibt immer
  mindestens `W0`. Bei kleinen ETFs mit weniger als 4 Units Arbeitsbestand
  wird so nie unter den Arbeitsbestand hinaus eingelöst.
- Es gibt kein Hin- und Her zwischen Schöpfen und Einlösen.
- Schöpfen oder Einlösen von Hand über die AP-Endpunkte holt die Automatik
  spätestens nach `etf_auto_interval_sec` in den Bereich des Arbeitsbestands
  zurück.
- Die Automatik kauft keine ETF-Anteile am Markt und richtet sich nicht
  nach Aufgeld oder Abschlag.

---

## 5. Marktdaten & Invarianten

- **Ticker/Stats** alles ehrlich aus Trades/Buch berechnet: Kurs `last` = K;
  VWAP, 24 h Hoch/Tief und Volumen aus den Fill-Preisen in `trades`;
  Marktkapitalisierung = K × `total_shares`; Spread (bp) aus bestem Bid/Ask;
  Volatilität aus `price_history`; Tiefe aus dem Buch.
- **Order-Preview** (`/api/securities/:id/preview`) nutzt denselben Book-Walk
  wie die Ausführung, mit demselben Band und derselben
  Ordergrößen-Grenze — Was-du-siehst-ist-was-du-bezahlst.
- **Invarianten der Engine:**
  - Kein Konto geht je negativ (Gebühr geclampt).
  - Self-Trade-Prevention ist strikt.
  - Geld bleibt erhalten bis auf verbrannte Gebühren, Einkommen,
    Dividenden und Zentralbank-Operationen.
  - Der MM erzeugt keine Kurstrends — F ändert sich nur durch den netto
    gerichteten Orderflow der Teilnehmer (Spieler und Bots) gegen den
    Market Maker; Kauf und Verkauf derselben Stückzahl führen zum selben F
    zurück. Geschäfte zwischen zwei Teilnehmern lassen F unverändert.
  - Keine einzelne Order bewegt F um mehr als das Band
    (±`limit_band_pct`). Liegende Orders beliefert der MM nur bis zu ihrem
    Preis (3.4).
