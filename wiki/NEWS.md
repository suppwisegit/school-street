# News

News in School Street kommen aus zwei Quellen: **Ereignisse** (Börsengang, Dividende,
BaFin, Übernahme, ETF, Systemmeldungen) entstehen dort, wo sie passieren, und der
**automatische Generator** (`server/newsgen.js`) meldet, was die Marktdaten zeigen.
Es gibt keinen Zufallsticker und keine erfundenen Geschichten: Ohne Ausreißer
bleibt es still.

Jede News ist eine Zeile in der Tabelle `news`: `kind`, `title`, `body`,
`security_id` (oder NULL für den ganzen Markt), `impact` (ganze Zahl −3 … +3,
Spalte seit dieser Überarbeitung; alte Zeilen haben 0) und `created_at`. Neues
erscheint per WebSocket (`type: 'news'`) und unter `GET /api/news`.

---

## 1. Wo News herkommen

| Art `kind` | Quelle | Kategorie im Client | Beispiel |
|---|---|---|---|
| `ipo` | Börsengang (Admin gibt frei, Bot-Firma), Nachplatzierung | Börse | „IPO: Kicker Sport AG (KICK) startet zum Kurs …“ |
| `dividend` | Dividende (Admin), Sonderdividende | Firma | „Dividende: … schüttet 0,50 je Aktie“ |
| `bafin` | Konto-Einfrieren durch den Admin, BaFin-Hinweis aus den Demo-Daten | Firma | „BaFin ermittelt gegen <Name>“ |
| `takeover` | Umbenennung oder feindliche Übernahme durch einen Mehrheitsinhaber | Firma | |
| `etf` | ETF-Start, Creation und Redemption | Börse | |
| `system` | Bot-Modus an/aus, Einkommen, Ghost-Cleanup, Notkredit, Neuer Trader | Börse | „Testspiel-Modus aktiviert“ |
| `news` | Generator (Kurs-Ausreißer, Marktstimmung), Admin (Art „Nachricht“) | Firma (mit Wert) oder Wirtschaft (ohne) | „EIS: legt heute 6 % zu“ |
| `rumor` | Generator (Investment AG hört …) | Gerücht | „Investment AG hört: Geheimtipp EIS?“ |

Die Kategorie ist keine Spalte, der Client leitet sie aus `kind` und
`security_id` ab (`client/src/news/category.js`). Jede Zeile trägt eine kleine
Grafik (`newsArt`), deterministisch aus Kategorie, News-Id und Ticker — dieselbe
News sieht auf jedem Gerät gleich aus.

---

## 2. Automatische News: Auslöser

Der Generator läuft in **Sim-Zeit**; `jobs.js` ruft ihn einmal je Wanduhr-Sekunde
mit dem Marktbild auf. Im Fast-Modus sind Sperrzeiten damit entsprechend kürzer.

| Auslöser | Bedingung | Wirkung `impact` | Sperrzeit |
|---|---|---|---|
| Kurs-Ausreißer einer Aktie | Änderung gegen den Kurs von vor 24 Sim-Stunden über 5 %, 10 % oder 20 % (je Schwelle, Aktie und Richtung einmal) | 0 (beschreibt nur) | frei erst wieder unter der Hälfte der Schwelle (Hysterese) |
| Marktstimmung „Index“ | Index ±3 % gegen den Bezug (nach Aktienzahl gewichtet), mindestens 5 Aktien | ±1 gleichgerichtet, marktweit | je Richtung höchstens eine je 30 Sim-Minuten; Hysterese |
| Marktstimmung „Breite“ | Index mindestens ±2 % und mindestens 80 % der Aktien in derselben Richtung | ±1 gleichgerichtet, marktweit | wie oben |
| Gerücht der Investment AG | Ein Wert hat sich in 30 Sim-Minuten um mindestens 5 % bewegt (Vergleichswert höchstens 35 Minuten alt) | ±1 in Richtung der Bewegung | im ganzen Markt höchstens eines je 45 Sim-Minuten; solange ein Kandidat dasteht, je Sim-Sekunde 1 % Chance |
| Ereignis-News | IPO, Dividende, BaFin, Übernahme, ETF, System | nach Art (siehe 3) | — |

Regeln dazu:

- **Dichte-Deckel:** höchstens 4 Kurs-Ausreißer-News je 10 Sim-Minuten über alle
  Aktien. Stehen mehr an, werden die kleinsten Bewegungen nicht gemeldet (gelten
  aber als erledigt). Die Stimmung und das Gerücht sind nicht mitgezählt.
- **Keine Rückkopplung:** Ausreißer-News haben bewusst `impact = 0`. Eine
  beschreibende Meldung („stürzt ab“) soll den Sturz nicht beschleunigen. Nur das
  Gerücht und die Stimmung wirken, und beide sind gesperrt.
- **Bezug:** Reicht die Kurs-Historie (24 Sim-Stunden je Aktie) nicht zurück
  (jüngerer Wert), gilt der älteste bekannte Kurs und der Text sagt „vom
  Messbeginn“ statt „vor 24 Stunden“.
- **Handelspause:** Während `trading_paused` wird nichts gemeldet, die Kurs-Historie
  läuft weiter.
- **Bezug „vor 24 Stunden“ heißt vor 24 Sim-Stunden.** Der Generator führt die
  Kurs-Historie selbst (eine Probe je Sim-Minute; `price_history` trägt
  Wanduhr-Zeiten). Nach einem Neustart wird sie einmal aus `price_history`
  aufgefüllt, sonst beginnt sie am Messbeginn und der Text sagt „vom Messbeginn“.
- **Dichte im Betrieb:** Fast-Modus 2 automatische News in 3 Sim-Stunden,
  Normalmodus 4 in 2 Sim-Stunden. Ohne Ausreißer bleibt es still.
- ETFs bleiben außen vor.

### Texte

Die Texte beschreiben nur, **was** ist — Gründe kennt der Server nicht. Pro Pool
stehen vier Varianten; nie zweimal hintereinander dieselbe. Beispiele (Zahl und
Wert kommen aus den Daten):

- 5 %: „EIS: legt heute 6 % zu“ — „<Name> steht 6 % über dem Kurs von vor
  24 Stunden.“
- 20 %: „EIS: läuft davon“ — „<Name> steht 24 % über dem Kurs von vor 24 Stunden.“
- Stimmung: „Fast alle Kurse steigen“ — „9 von 10 Aktien liegen im Plus. Der Index
  steht 4 % höher als vor 24 Stunden.“
- Gerücht: „Investment AG hört: Geheimtipp EIS?“ — „Die Investment AG hört, einige
  empfehlen <Name> weiter. Der Kurs ist in einer halben Stunde um 6 % gestiegen.
  Bewiesen ist nichts.“

---

## 3. Wirkung auf die Bots

Bewertet wird in `botbrain.newsImpact` (siehe [BOTS.md](./BOTS.md), Abschnitt
„News“). Kurz:

- `impact` × 0,1 verschiebt den privaten Wert, geklemmt auf ±0,3. `impact = 0` heißt
  **wirkungslos** — die News rückt die Aktie nur ins Blickfeld.
- Ereignis-Arten: Dividende +0,12, BaFin −0,25, Übernahme −0,30, IPO +0,02 (bewusst
  schwach: kein Kaufsignal mehr).
- Halbwertszeit der Wirkung 20 Spielminuten (Dividende 30, BaFin und Übernahme 45).
- Aktien-News wirken gestaffelt: In den ersten 3 Spielminuten folgt jeder Bot nur
  mit 20–100 %, damit nicht alle im selben Tick dieselbe Seite treffen.
- News ohne Wertpapier mit `impact ≠ 0` (Stimmung) geht in alle Aktien ein.

**Eigene News:** Das Formular im Admin-Bereich „News“ hat zwei weitere Felder:
**Art** (Nachricht, Gerücht, BaFin-Hinweis, Dividende) und **Kurswirkung** (ohne,
leicht bis stark positiv oder negativ = `impact` −3 … +3). „Ohne Wirkung“ macht die
Bots nur auf die Aktie aufmerksam; mit Kurswirkung kaufen oder verkaufen sie sie
eher. BaFin-Hinweis und Dividende wirken zusätzlich über ihre Art (−0,25 bzw.
+0,12). Dieselben Felder nimmt `POST /api/admin/news` entgegen.

---

## 4. Einstellungen

| Schlüssel | Default | Wirkung |
|---|---|---|
| `news_interval_sec` | 60 | 0 = Generator aus; jeder andere Wert = an. Früher war es ein Takt-Intervall, heute nur noch der Schalter. |
| `news_move_steps` | nicht gesetzt (5, 10, 20) | Schwellen der Ausreißer-News in Prozent, Zahl oder Liste, z. B. „5,10,20“. Steht nicht in den Defaults und nicht in der Freigabeliste von `PUT /api/admin/settings` — nur in der Tabelle `settings`. |

Alles andere (Stimmungsschwellen, Sperrzeiten, Dichte-Deckel) sind Konstanten in
`server/newsgen.js`.

---

## 5. Client

- **News-Seite** (`/news`): Liste mit Grafik, Kategorie-Chip, Quelle und Alter.
  Antippen öffnet das Detail mit Text, Kurs und „Zu <TICKER>“.
- **Gelesen:** Eine News gilt als gelesen, sobald sie geöffnet wurde; die Marke
  steht je Konto im `localStorage` des Geräts, nicht auf dem Server. „Alle gelesen“
  räumt auf. Ein Konto ohne gespeicherten Stand startet mit 0 ungelesenen News.
- **Zähler:** Am Tab „News“ steht die Zahl der ungelesenen News, ab 10 als „9+“.
  Kein Ton, kein Toast.
- **Kurzform:** Drei Schlagzeilen auf dem Markt (über der Werteliste), drei auf der
  Aktienseite (nur die dieses Werts), drei Textzeilen auf dem Beamer `/board`.
- **Börsengang:** Der Markt hat einen Abschnitt „Neu an der Börse“ für Werte, deren
  Börsengang weniger als `ipo_highlight_sec` (3 Stunden Wanduhr) zurückliegt, und
  markiert sie in der Liste. Das Board zeigt einen Hinweis auf neue Werte.
  Nachplatzierungen zählen nicht als Börsengang.

API: `GET /api/news` mit `?kind=` (Komma-Liste aus `news, rumor, dividend, bafin,
ipo, system, takeover, etf`; unbekannte Art → 400), `?security_id=<id>` (kombinierbar)
und `?limit=` (höchstens 100, Standard 40).

---

## 6. Was bewusst nicht kommt

- Keine zufälligen Nachrichten oder Gerüchte im Minutentakt.
- Keine erfundenen Ursachen („wegen Streik“ …).
- Keine News, die den Kurs in ihre eigene Richtung schiebt: Ausreißer-News sind
  wirkungslos, Stimmung und Gerücht sind gesperrt.
- Keine Zeichnungsphase für Börsengänge — der Börsengang wird über den
  Markt-Abschnitt, den Marker und den Admin-Dialog prominent, nicht über ein
  Bestellformular vor dem ersten Handel.
