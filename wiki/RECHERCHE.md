# RECHERCHE — School-Street

Stand: 24.11.2026 · Rolle RECH · Projektroot `/home/paul/Schreibtisch/Börse/school-street`

Am installierten Paket geprüft: better-sqlite3 12.11.1, ws 8.21.3, express 4.22.2 (Root-`node_modules`), Node v24.14.0, React ^18.3.1, Vite ^5.4.11, lightweight-charts ^4.2.3. Tailwind steht nicht in `client/package.json`.

## 0. Zur Einordnung

- **Zeitbudget überschritten.** Vorgegeben waren höchstens 8 Minuten. Von Start 17:24:52 Uhr bis zum letzten Messwert 18:00:19 Uhr vergingen mehr als 35 Minuten, ohne das Schreiben dieser Datei. Nach dem ersten Messwert (14 Minuten) habe ich noch zwei Nachrüfungen angehängt, statt abzubrechen.
- **Lesart.** **Fakt** = steht so in der Quelle. **Empfehlung** = mein Schluss für dieses Projekt, nicht aus der Quelle. `ANNAHME` = in dieser Runde nicht geprüft.
- **Zitate.** [D1] wurde als Volltext gelesen. Die übrigen Seiten liefen über ein Abruf-Werkzeug mit zusammenfassendem Modell. Die Zitate sind wörtlich übernommen, aber nicht Zeichen für Zeichen nachgeprüft.
- **Suchanfragen** (14 gestellt, davon 2 deutsch; 12 aufgeführt, zwei weitere waren fast gleichlautend):„how to avoid the generic AI look in web design frontend checklist"; „Vercel geistdev AI slop design blog interface"; „KI-generiertes Frontend generisches Design vermeiden Checkliste AI Slop UI"; „Website wirkt KI-generiert vermeiden Typografie Farbe Layout Tipps Designer"; „better-sqlite3 performance many concurrent connections WAL busy_timeout event loop blocking"; „ws WebSocket broadcast performance serialize once same buffer to all clients Node.js"; „Robinhood confetti first trade celebration order preview before buy app design"; „Robinhood removes confetti animation order preview screens 2021"; „Robinhood help order preview review order before placing swipe trade button"; „Trading 212 app redesign trade button buy sell screen order preview UX"; „Bitpanda app redesign UI trade screen one screen buy button design case study"; „Webull app order preview review order confirm button trade screen design".
- **Deutschsprachige Quellen.** Die zwei deutschsprachigen Anfragen brachten keinen deutschsprachigen Artikel mit einer Checkliste zum AI-Look. Alle verwerteten Quellen sind englischsprachig.

## 1. Zehn Kern-Erkenntnisse

**K1 — Der AI-Look ist ein Bündel nicht getroffener Entscheidungen.**
- Fakt: ralabs definiert AI-Slop als „competent and interchangeable. Nothing is broken, and nothing was chosen." [D5] Alan West nennt drei Ursachen: Standardpalette, Layout-Grammatik aus Komponenten-Bibliotheken, „sichere" Typografie mit Inter überall. [D4]
- Empfehlung: DESIGN.md legt Schrift, Palette, Radius, Abstands- und Typo-Skala und Bewegung mit festen Werten fest. Parallele Implementer sollen nichts davon selbst wählen.

**K2 — Keine Violett-Verläufe, eine Akzentfarbe, Farbe trägt Bedeutung.**
- Fakt: „The purple-to-indigo hero gradient is the most recognizable AI fingerprint there is." [D1] „One accent colour, used only for primary actions." [D3] Vercel: Farbe nur, wenn sie für Zustand, Aktion oder Daten Bedeutung hat, stets mit einem zweiten Hinweis außer Farbe. [D7]
- Empfehlung: Farben nur als Tokens aus DESIGN.md. Grün und Rot nur für Gewinn und Verlust, immer auch mit Vorzeichen. Genau eine Akzentfarbe für die Handelsschaltfläche.

**K3 — Nicht alles ist eine Karte.**
- Fakt: „If every element is a card, no element is important." [D1] Paralect: „Group things with spacing and headings first." Glass cards nur für Overlays über Inhalt. [D2] Vercel: „Do not wrap every section, metric, or comparison in a card." [D7]
- Empfehlung: Depot, Ranking und Orders als Zeilen mit Linien. Karte nur für das Order-Sheet. Kein `backdrop-filter`.

**K4 — Ein Bildschirm, eine Hauptaktion.**
- Fakt: Das Hauptziel des Nutzers soll „the most visible thing on the page" sein. Slop-Anzeichen: „Every element given equal visual weight" und „Cards inside cards inside cards". [D3] Zwölf gleichgewichtige Kennzahl-Kacheln sind „not a dashboard, it's a list". [D5]
- Empfehlung: Spieler bekommen einen Handels-Screen mit einer dominanten Handelsschaltfläche. Alles andere einen Tap entfernt. Admin: Spiel an/aus und Bots an/aus ganz oben.

**K5 — Skalen statt Gefühlswerte.**
- Fakt: „Use 4, 8, 12, 16, 24 and 32 pixel spacing only", „Use three text sizes: 13, 15 and 20 pixels", Slop-Anzeichen „Spacing that is almost consistent, but not quite". [D3] „Radius chosen by feel", innen = außen minus Abstand. [D1] „Do not create arbitrary font sizes or numeric font weights." [D7]
- Empfehlung: CSS nur mit Tokens. Die Zahlen aus [D3] sind ein Beispiel; DESIGN.md setzt die eigene Skala.

**K6 — Zustände sind der zuverlässigste Slop-Indikator.**
- Fakt: „Generated interfaces almost always ship the happy path only." (Hover, active, focus, loading, empty, error) [D1] „Has anyone opened every state, or only the one in the demo?" [D5]
- Empfehlung: DoD je Ansicht: Screenshot für Standard, Leer, Lade und Fehler.

**K7 — Texte sind Design.**
- Fakt: „Learn more" und „Submit" benennen nicht das Ergebnis. [D1] „Submit/Continue buttons where the action has a name", vage Fehlermeldungen, Leerzustände mit „No items". [D5] „Write 3, not 'three'." [D2]
- Empfehlung: „Kaufen" und „Verkaufen" statt „Absenden". Fehler nennen Betrag und Ursache. Zahlen als Ziffern.

**K8 — Bewegung: Stillstand ist der Standard.**
- Fakt: „Default to stillness." Bewegung nur, um einen Zustandswechsel zu erklären oder eine Aktion zu bestätigen. [D7] „Only animate things that change.", Animationen „under 300ms", `reduce-motion` beachten. [D2] Als Slop gelten auch „Buttons that snap instead of easing". [D6]
- Empfehlung: Feier-Animation nur nach einer echt ausgeführten Order. Keine Scroll-Reveal-Effekte. `prefers-reduced-motion` global.

**K9 — Neo-Broker: erst Vorschau, dann Bestätigen.**
- Fakt: Trading 212: „Tap Review Buy order or Review Sell order, check the details and confirm the order." [N1] Robinhood: „Select Review, and then swipe up to submit". [N4] Webull: ohne zusätzliche Bestätigung handelt nur, wer „Show Order Confirmation" ausschaltet. [N5]
- Empfehlung: Order-Sheet in drei Schritten: Betrag, Vorschau (Stücke, Kurs, Gebühr, Gesamt), Bestätigen. Details in Abschnitt 4.

**K10 — Performance: Abfrage und Serialisierung je Client ist der Multiplikator.**
- Fakt: „Calling ws.send() in a loop will frame the message to broadcast n times where n is the number of connected clients." [P4] better-sqlite3 hat eine „synchronous API" (installierter README, Zeile 7). Blockierende Callbacks senken den Durchsatz. [P5]
- Empfehlung: Snapshot einmal je Tick berechnen, einmal serialisieren, denselben Buffer senden. Details in Abschnitt 3.

## 2. Anti-Slop-Checkliste

Jede Regel ist am fertigen Produkt prüfbar. Die Prüfspalte nennt das Verfahren.

| # | Regel | Prüfung | Warum | Quelle |
|---|---|---|---|---|
| 1 | Die Hauptschrift ist gewählt, nicht Standard: weder Inter, Roboto, Arial, Open Sans, Helvetica noch nur der System-Stack. | `getComputedStyle` am `body` | „Inter is not a bad font. It is the default font." [D1]; „The Inter Default" [D6] | [D1][D6] |
| 2 | Kein Deko-Verlauf, kein Glow, kein `backdrop-filter`. | grep im Client-CSS nach `gradient`, `text-shadow`, `backdrop-filter` | „most recognizable AI fingerprint" [D1]; „Glow, neon and grid lines on dark" [D2]; „glows … glass, or ornamental shadows" [D7] | [D1][D2][D7] |
| 3 | Genau eine Akzentfarbe, nur für die Hauptaktion. | Jede Ansicht hat genau eine gefüllte Primärschaltfläche | „One accent colour per site." [D1] | [D3][D1] |
| 4 | Keine Violett- oder Indigo-Standardpalette. Farben nur als Tokens. | grep nach Hex-Werten und Farbnamen außerhalb der Token-Datei | Standardfarben sind das, was Modelle am meisten gesehen haben. [D4] | [D4][D1][D6] |
| 5 | Kein Raster aus drei bis fünf gleichen Karten, keine Icon-Kacheln über Überschriften. | Screenshot, gleich große Geschwister-Elemente zählen | „Three equal cards in a row. This is the most generic AI layout that exists." [D1]; „Arbitrary icon tiles" [D7] | [D1][D4][D5][D7] |
| 6 | Rahmen, Schatten und Fläche nur für Auswahl, Interaktion, Warnung, Gruppierung. | Zahl der umrandeten Boxen je Ansicht | „a border is easier to add than a decision" [D5] | [D1][D2][D7][D5] |
| 7 | Ein Radius-Vokabular. Innen = außen minus Abstand. | grep `border-radius` außerhalb der Token-Datei | „pick ONE radius vocabulary for the whole site" [D4] | [D4][D1][D2] |
| 8 | Alle Abstände aus einer Skala. | grep nach px und rem außerhalb der Token-Datei | „Spacing that is almost consistent, but not quite" [D3] | [D3][D1] |
| 9 | Kurze Typo-Skala ohne Ad-hoc-Werte, Satzcase, kein Kursiv, keine Gewichte über bold. | grep `font-size`, `font-weight`, `font-style` | „Arbitrary sizes" [D1] | [D3][D1][D7] |
| 10 | Eine Hauptaktion je Ansicht, keine gleichgewichtigen Kacheln. | Screenshot: Was springt zuerst ins Auge? | „Every element given equal visual weight" [D3] | [D3][D5] |
| 11 | Hover, Active, Focus, Lade, Leer, Fehler und langer Inhalt sind gebaut und geöffnet. | Screenshot je Zustand | „Generated interfaces almost always ship the happy path only." [D1] | [D1][D3][D5] |
| 12 | Schaltflächen nennen die Aktion. Fehler sagen, was passiert ist. Keine Hype-Wörter, Platzhalternamen, erfundenen Zahlen. | Liste aller Button-Texte und Fehlertexte lesen | „Error copy should say what happened." [D1] | [D1][D5][D2] |
| 13 | Keine Emojis als Icons. Ein Icon-Set. | grep nach Emoji-Codepunkten in `client/src` | „look different on every device, don't match your icons or colors" [D2] | [D2][D5] |
| 14 | Keine All-Caps-Zeile über jeder Überschrift. Badge und Punkt nur, wenn sie das Verhalten ändern. | Liste aller Badges mit ihrer Bedeutung | „All-caps or tracked eyebrows" [D7] | [D2][D7] |
| 15 | Animation nur bei Zustandswechsel, unter 300 ms, `prefers-reduced-motion` überall. | grep nach Dauern und nach `prefers-reduced-motion` | „Default to stillness." [D7]; „Only animate things that change." [D2] | [D7][D2][D1] |
| 16 | Fließtext mindestens 4,5:1 Kontrast, große Texte und Fokusrahmen 3:1, Tippziele mindestens 24 × 24 px, Layout bei 320 px und 200 % Zoom heil. | Kontrastrechner, schmales Fenster | WCAG 2.2 AA [D5] | [D2][D5] |
| 17 | Kurs- und Depotzahlen in Tabellenziffern. Monospace nur für Zahlen in Tabellen und Code. | `font-variant-numeric: tabular-nums` auf Zahlen | „Use monospace for code, numbers in tables and things people copy." [D2] | [D2][D7] |
| 18 | Jeder Design-Fund nennt den beanstandeten Wert und den Ort. | Review je Bereich: Typografie, Farbe, Layout, Bewegung, Texte, Zustände | „Every finding needs evidence and a location." [D1] | [D1] |

Zwei Warnungen aus den Quellen: Eine Checkliste ohne Ausnahme führt laut [D1] zu Arbeit, die wiederum wie bei allen anderen aussieht. Vercel warnt vor der Überkorrektur in „a sterile anti-design template". [D7]

## 3. Performance-Muster

| Muster | Fakt (Quelle) | Empfehlung für School-Street |
|---|---|---|
| Snapshot einmal serialisieren, derselbe Buffer an alle | ws-Maintainer: „Calling ws.send() in a loop will frame the message to broadcast n times where n is the number of connected clients." Mit permessage-deflate gibt es „one compressor per socket". [P4] Server-Standard: „The extension is disabled by default on the server" und „adds a significant overhead in terms of performance and memory" (installierter ws-README, Zeile 104 f.; auch [P3]). | Pro Tick oder Ereignis genau einmal `JSON.stringify`, dann `Buffer.from(...)`, denselben Buffer an alle offenen Sockets. `perMessageDeflate` nicht einschalten. |
| Caching statt Abfrage je Client | Node: „each of your JavaScript callbacks should complete quickly". [P5] better-sqlite3: „Easy-to-use synchronous API" (installierter README, Zeile 7). | Öffentliche Snapshots (Kurse, Ranking, Board) einmal je Tick berechnen und im Speicher halten, mit Versionszähler, der bei jedem Schreiben steigt. Je Client weder Abfrage noch Serialisierung. |
| Additive Schema-Migration | `ALTER TABLE … ADD COLUMN` ändert nur den Schematext und läuft „as quickly on a table with 10 million rows as on a table with 1 row". Einschränkungen: kein PRIMARY KEY oder UNIQUE, kein CURRENT_TIMESTAMP als Default, NOT NULL nur mit Default. Mit CHECK werden alle Zeilen gelesen. [P6] | Beim Start je Tabelle die Spaltenliste lesen und nur fehlende Spalten ohne CHECK nachziehen. Zeitstempel in der Anwendung setzen. |
| WAL, ein Schreiber | better-sqlite3 empfiehlt `db.pragma('journal_mode = WAL')`. [P1] SQLite: „there can only be one writer at a time", alle Prozesse müssen auf demselben Rechner liegen, bei immer vorhandenem Leser wächst das WAL „without bound". [P2] | Ein Prozess schreibt. Bot- und Matching-Arbeit in kurzen Transaktionen. Keine dauerhaft offene Lese-Transaktion. |
| Event-Loop nicht blockieren | Ein 50-MB-JSON braucht im Node-Beispiel „0.7 seconds to stringify … 1.3 seconds to parse". Synchrone fs-, crypto- und zlib-Aufrufe blockieren. [P5] better-sqlite3: „Worker thread support (for large/slow queries)" (installierter README, Zeile 10). | Snapshots klein halten. Schwere oder selten nötige Arbeit in Teilschritten mit `setImmediate` oder in einen Worker-Thread auslagern. |
| Indizes | Ein Index ist nur nutzbar, wenn seine linke Spalte eingeschränkt ist, sonst „full table scan". `LIKE` mit führendem Platzhalter kann keinen Index nutzen. Ein Covering Index kann Abfragen „twice as fast" machen. `EXPLAIN QUERY PLAN` zeigt die gewählte Strategie. [P7] | Heiße Abfragen (Depot je Spieler, Orders je Wert, Preisverlauf, Ranking) mit `EXPLAIN QUERY PLAN` prüfen. Zusammengesetzte Indizes mit Gleichheits-Spalten vorne. |
| HTTP-Caching mit ETag | Ein ETag „is an identifier for a specific version of a resource". Passt `If-None-Match`, antwortet der Server mit „a 304 Not Modified status, without a body". Typisch ist „just a revision number". [P8] | Den Versionszähler als ETag senden und mit 304 antworten, bevor die Abfrage läuft. |
| Kompression | compression packt deflate, gzip und br ab `1kb`, Standardstufe 6. Mit Server-Sent Events ist `res.flush()` nötig. [P9] | JSON- und HTML-Antworten ab 1 kB packen und im Lasttest messen, weil zlib CPU kostet. [P5] |

Projekt-Stand (am 24.11.2026 geprüft):
- `server/db.js:11` setzt bereits `journal_mode = WAL`.
- In `server/**/*.js` (ohne `node_modules`, `data`, `public`) kein Treffer für `perMessageDeflate`, `compression`, `busy_timeout`, `synchronous`, `etag`.
- `compression` steht nicht in `server/package.json`.
- Express 4.22.2 setzt von sich aus einen schwachen ETag (`lib/application.js:82`) und antwortet bei `req.fresh` mit 304 (`lib/response.js:210`). Der ETag wird aus dem Body berechnet (`lib/response.js:204`), die Abfrage also vorher ausgeführt.

## 4. Neo-Broker-Referenzen

**M1 — Erst Vorschau, dann Bestätigen.**
- Fakt: Trading 212: „Tap Review Buy order or Review Sell order, check the details and confirm the order." Der Button „remains unavailable until all required prices are entered". [N1] Robinhood (Hilfeartikel zum Ersetzen einer Order): „Select Review, and then swipe up to submit". [N4] Webull: Wer „Show Order Confirmation" ausschaltet, dessen Orders werden „submitted without an additional confirmation step". [N5]
- Empfehlung: Order-Sheet in drei Schritten: Betrag, Vorschau (Stücke, Kurs, Gebühr, Gesamtbetrag), Bestätigen. Bestätigen erst freigeben, wenn alle Pflichtwerte gesetzt sind.

**M2 — Schnellwahl der Größe, Freitext bleibt.**
- Fakt: Trading 212 hat „Quick-size buttons for Buy and Sell orders", beim Verkauf „25%, 50%, 75% and 100%". [N1] Im Forum beklagen Nutzer den weggefallenen Schieberegler: „Losing the slider is a big blow." (8. Okt. 2026). [N2]
- Empfehlung: Betrag per Schnellwahl (25/50/75/100 % bzw. MAX) und frei eintippbar, nicht nur als Festwerte. [N2] ist Nutzermeinung, keine offizielle Quelle.

**M3 — Feiern nur an echte Meilensteine, gezügelt.**
- Fakt: Robinhood zeigte Konfetti zu „firsts" (erste Trades, erste Schritte mit Cash Management, erfolgreiche Empfehlungen) und kündigte am 31.3.2021 die Ablösung durch „new, dynamic visual experiences" an. Anlass war Kritik an der „Gamification". [N3]
- Empfehlung: kurze Feier-Animation nur nach einer echt ausgeführten Order, nicht bei jedem Tipp.

**M4 — Ein Muster für alles, Zustände explizit.**
- Fakt: Eine Bitpanda-Case-Study nennt „One pattern, many markets", „explicit empty/error/loading/latency/risk states" und „redesigned confirmations for credibility and cognitive safety". [N6] Die Seite weist ihre Zahlen selbst als nicht unabhängig geprüft aus.
- Empfehlung: Kaufen und Verkaufen nutzen dasselbe Sheet mit getauschter Richtung. Leer-, Lade- und Fehlerzustand gehören zum Muster. Der Beleg ist schwach, die Quelle bleibt auf Projektebene.

**M5 — Der Wert steht im Mittelpunkt, nicht die Stückzahl.**
- Fakt: Im Trading-212-Forum: „Why does share count take centre stage over the value of what you own?" und „some of the font is so tiny I can barely read it with my glasses on". [N2] Trading 212: der Bildschirm „starts with 0 rather than with pre-filled values". [N1]
- Empfehlung: Euro-Betrag groß, Stückzahl klein darunter. Startwert 0, damit nicht versehentlich geordert wird.

**Nicht belegt:**
- „Eine große Handelsschaltfläche": Keine aufgerufene Broker-Quelle beschreibt die Größe der Schaltfläche. Die Regel stammt aus den allgemeinen Hierarchie-Quellen [D3][D5].
- Bitpanda: nur Fallstudien auf Projektebene [N6][N7], kein Bildschirm-Beleg.
- Robinhood „Order-Vorschau": nur ein Satz aus einer Hilfe-Anleitung [N4]. Die Aussage, Robinhood habe 2021 eigene Vorschau-Bildschirme eingeführt, stand nur in Suchsnippets (Reuters, WSJ), nicht im aufgerufenen CNBC-Artikel.

**Entscheidungspunkt für den Orchestrator:** Der Auftrag verlangt ein „cooles Dopamin-Design" und nennt Konfetti als Beispiel. [N3] belegt, dass Robinhood genau dafür 2021 öffentlich kritisiert wurde und es entfernte. Bei einem Spiel ohne echtes Geld greift diese Kritik anders als bei echtem Geld. Das ist eine Entscheidung des Auftraggebers, nicht der Recherche.

## 5. Lücken und nicht aufrufbare Quellen

Fehlgeschlagene oder unvollständige Aufrufe:
- [uxdesign.cc „How to de-slopify your designs"](https://uxdesign.cc/how-to-de-slopify-your-designs-4c40c57c1dc9): 307 auf eine Medium-Anmeldewand.
- [ws-API-Doku `doc/ws.md`](https://github.com/websockets/ws/blob/master/doc/ws.md): HTTP 503.
- [better-sqlite3 `docs/api.md`](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md): HTTP 503.
- [`nodejs.org/en/learn/dont-block-the-event-loop`](https://nodejs.org/en/learn/dont-block-the-event-loop): 404. Die Nachfolge-URL [P5] ist geladen.
- [AP News zu Robinhood](https://apnews.com/article/business-3c83ae69e7dbc4ddc825e9af308e9c78): geladen, aber nur Navigation, kein Artikeltext. Nicht verwendet.
- ralabs [D5]: erster Versuch HTTP 520, zweiter Versuch geladen.

Deshalb nicht geprüfte Annahmen:
- ANNAHME: Einmal vorbereitete Statements und viele Schreibvorgänge in einer Transaktion sind schneller als einzelne Aufrufe — API-Doku nicht ladbar.
- ANNAHME: `busy_timeout` fängt `SQLITE_BUSY` bei Schreibkonflikten ab — nicht geprüft. [P2] belegt nur, dass `SQLITE_BUSY` auch im WAL-Modus auftreten kann.
- ANNAHME: `bufferedAmount` je Socket zeigt Stau bei langsamen Clients — API-Doku nicht ladbar.
- ANNAHME: Vite baut gehashte Dateinamen, Assets sind dadurch lange cachebar — keine Quelle geladen.

Nur als Suchsnippet gesehen, deshalb hier nicht als Fakt verwendet:
- Konfetti bei Robinhood seit Herbst 2016.
- Robinhood führte 2021 Order-Vorschau-Bildschirme ein (Reuters, WSJ, nicht aufgerufen).
- better-sqlite3 erreiche rund 2000 Abfragen pro Sekunde (npm-Seite, nicht aufgerufen).

Nicht aufgerufen (Zeit): Reddit-Threads, der Artikel „16 Patterns That Mark a Site as Vibe-Coded" (nur ein Google-Redirect-Link), lautundklar.de, webdesign-journal.de, der Medium-Artikel zu ws-Backpressure, der Evil-Martians-Benchmark, weitere Trading-212-Threads, der Finance-Magnates-Artikel zum zurückgerollten Redesign, der Webull-App-Store-Eintrag.

## 6. Quellen

Alle unten genannten URLs wurden am 24.11.2026 tatsächlich aufgerufen.

Design und Anti-Slop:
- [D1] jacob perks, Bootcamp, 2. Aug. 2026: „How to stop your frontend looking AI-generated" (30 Anzeichen, als Volltext gelesen).
- [D2] Paralect: „Signs of AI slop in design" (21 Anzeichen, kein Datum auf der Seite).
- [D3] Zander Whitehurst, Memorisely, 5. Nov. 2026: „How to stop AI slop from reaching your UI".
- [D4] Alan West, dev.to, 18. Mai (Jahr laut Abruf-Werkzeug 2026): „How to fix the 'AI-generated' look in your frontend". Die Lint-Regeln dort sind Tailwind-spezifisch.
- [D5] Dmytro Makarov, ralabs, 1. Okt. 2026: „AI Design Slop: How to Review an AI-Generated Interface".
- [D6] 925studios, 19. Mär. 2026: „AI Slop Web Design".
- [D7] Vercel: `design.md`, Design-Vertrag für Berichtseiten. „Design in monochrome" gilt für Vercel-Berichte, übertragbar ist nur das Prinzip „Farbe nur mit Bedeutung".
- [D8] Yash Thakker, explainx.ai, 1. Sep. 2026: Bericht über Vercels `design.md`. Laut Artikel 91 bekannte Fehler ohne und 39 mit der Datei, bei null fehlerfreien Seiten. Die Zahlen sind nicht selbst geprüft.
- [D9] Vercel Geist, Einführungsseite. Geladen, enthält keine konkreten Regeln.

Performance:
- [P1] better-sqlite3, `docs/performance.md`.
- [P2] SQLite, „Write-Ahead Logging".
- [P3] ws-README auf GitHub (Master). Die Aussage zum Server-Standard steht genauso im installierten ws 8.21.3.
- [P4] ws Issue 617, „Broadcast performance".
- [P5] Node.js, „Don't Block the Event Loop (or the Worker Pool)".
- [P6] SQLite, „ALTER TABLE", Abschnitt ADD COLUMN.
- [P7] SQLite, „Query Optimizer Overview".
- [P8] MDN, „ETag".
- [P9] Express, „compression" Middleware.
- Lokal: `node_modules/better-sqlite3/README.md` (12.11.1), `node_modules/express/lib/application.js` und `lib/response.js` (4.22.2), `node_modules/ws/README.md` (8.21.3).

Neo-Broker:
- [N1] Trading 212 Help Centre: „The Invest order screen has a new look".
- [N2] Trading-212-Community: „The new buy and sell UI on the app is a serious downgrade" (Nutzerstimmen, Okt. 2026).
- [N3] CNBC, 31. Mär. 2021: „Robinhood gets rid of confetti feature amid scrutiny over gamification".
- [N4] Robinhood Support: „Cancel or replace an order".
- [N5] Webull Help: „Order Instructions and Settings".
- [N6] Barna Norbert, Case Study Bitpanda (Portfolio-Text).
- [N7] Ali Rezaiyan, „Android Trading at Bitpanda" (Portfolio-Text, keine Bildschirm-Details).

[D1]: https://medium.com/design-bootcamp/how-to-stop-your-frontend-looking-ai-generated-efbb9681a6a2
[D2]: https://www.paralect.com/blog/signs-of-ai-slop-in-design
[D3]: https://www.memorisely.com/blog/how-to-stop-ai-slop-in-your-ui
[D4]: https://dev.to/alanwest/how-to-fix-the-ai-generated-look-in-your-frontend-1ahh
[D5]: https://ralabs.org/blog/ai-design-slop-how-to-review-ai-generated-interfaces
[D6]: https://www.925studios.co/blog/ai-slop-web-design-guide
[D7]: https://vercel.com/design.md
[D8]: https://explainx.ai/blog/vercel-design-md-spec-driven-ai-ui-rauchg-2026
[D9]: https://vercel.com/geist/introduction
[P1]: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
[P2]: https://www.sqlite.org/wal.html
[P3]: https://github.com/websockets/ws
[P4]: https://github.com/websockets/ws/issues/617
[P5]: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
[P6]: https://www.sqlite.org/lang_altertable.html
[P7]: https://www.sqlite.org/optoverview.html
[P8]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
[P9]: https://expressjs.com/en/resources/middleware/compression.html
[N1]: https://helpcentre.trading212.com/hc/en-us/articles/39211011634077-The-Invest-order-screen-has-a-new-look
[N2]: https://community.trading212.com/t/the-new-buy-and-sell-ui-on-the-app-is-a-serious-downgrade/93605
[N3]: https://www.cnbc.com/2021/03/31/robinhood-gets-rid-of-confetti-feature-amid-scrutiny-over-gamification.html
[N4]: https://robinhood.com/us/en/support/articles/cancel-a-pending-order
[N5]: https://www.webull.com/help/faq/291-Order-Instructions-and-Settings
[N6]: https://www.barnanorbert.com/work/bitpanda
[N7]: https://www.alirezaiyan.com/projects/bitpanda-trading-experiences
