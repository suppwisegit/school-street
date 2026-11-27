# School-Street — Börsensimulation für die Schule

Ein Server-PC im Schul-WLAN, alle Schüler verbinden sich per Browser. Ein Node-Prozess, eine SQLite-Datei, kein Internet nötig.

| Adresse | Zweck |
|---|---|
| `http://<server-ip>:3000/` | **Spieler-App**: Markt, Depot, News, Rang |
| `http://<server-ip>:3000/admin` | **Börse verwalten**: Spiel, News, Werte, Nutzer |
| `http://<server-ip>:3000/board` | **Beamer**: Kurse und Rangliste fürs Klassenzimmer |

---

## Schnellstart

```bash
npm install        # nur beim ersten Mal
npm run build      # App bauen (landet in server/public/)
./start.sh         # Server starten, loggt nach server/data/schoolstreet.log
```

Im WLAN erreichbar unter `http://<server-ip>:3000` (IP mit `ip a` herausfinden).
Stoppen: `pkill -f 'node server/index.js'` · Log: `tail -f server/data/schoolstreet.log` · Anderer Port: `PORT=8080 ./start.sh`.

**Erster Start:** Die Börse ist leer, das Admin-Konto legt der Server selbst an und druckt das Passwort in die Konsole. Eigenes Passwort bei leerer Börse: `ADMIN_PASSWORD=xyz npm start`. Danach registrieren sich die Schüler selbst (Name und Passwort).

**Demo-Daten zum Ausprobieren** (4 Aktien, 1 ETF, Demo-Trader):

```bash
npm run seed       # ACHTUNG: löscht die bestehende Börse komplett
```

Zugänge danach: `admin` / `ag123`, Demo-Trader `Anna` … `Hannah` / `demo123`.

---

## Für Schüler: in zwei Minuten startklar

1. Namen und Passwort eintippen, „Konto anlegen".
2. **Markt** antippen, einen Wert wählen, „Kaufen". Bevor es zählt, steht da, was es kostet.
3. **Depot** zeigt den Wert und den Gewinn live. **Rang** zeigt den Platz in der Klasse.

---

## Was ist neu (27.11.2026)

- **Bots handeln wie Händler, nicht wie Wurfmaterial.** Jeder Bot hat eine feste Persönlichkeit mit Zielanteil und Cash-Reserve; liegt sein Depot unter dem Ziel, kauft er, darüber verkauft er. Neue Bots starten mit einer Startposition aus dem Streubesitz, der Markt ist von der ersten Minute an zweiseitig. Deckel verhindern, dass alle Bots im selben Tick dieselbe Seite treffen.
- **Gebühren kommen zurück.** Die Handelsgebühren fließen mit dem nächsten Einkommen an alle Konten zurück (Standard 100 %).
- **Fast-Modus ist eine Spieluhr.** Handelsrate, News-Wirkung und Sperrzeiten laufen hundertmal schneller; das Kapital läuft nicht schneller leer. Das Einkommen bleibt standardmäßig an der Wanduhr, damit die Geldmenge nicht davonläuft.
- **Streubesitz größer:** In jeder Aktie liegen rund 1 000 Stück im Orderbuch (vorher 385–519). „500 wanted, nur 200 verfügbar“ gehört der Vergangenheit an.
- **News sind ereignisgetrieben:** Automatische Meldungen entstehen nur aus Marktdaten (Ausreißer, Marktstimmung, seltenes Gerücht der Investment AG). Die News-Seite zeigt Grafiken, ungelesene News und einen Zähler am Tab.
- **Börsengänge prominenter:** Abschnitt „Neu an der Börse“ im Markt, Marker in der Werteliste, Hinweis auf dem Beamer; im Admin ist der Antragstext vollständig lesbar.
- **Admin: ETF anlegen** im Bereich „Werte“, mit Vorschau und Prüfung, ob die Staatskasse den Korb besitzt.

Details: `wiki/BOTS.md`, `wiki/NEWS.md`, `wiki/MATCHING-ENGINE.md`.

---

## Für die Investment-AG: vier Bereiche, ohne Schulung

| Bereich | Was du hier machst |
|---|---|
| **Spiel** | Börse pausieren und weiterlaufen lassen. Bots an- und ausschalten und einstellen, wie viel sie handeln — sie halten den Markt lebendig, wenn gerade niemand kauft. Schnellmodus (hundertmal so schnell, ein Schultag in wenigen Minuten). Einkommen (Betrag, Abstand, „Jetzt auszahlen"), Startkapital, Gebühr. |
| **News** | Nachrichten schreiben, optional zu einem Wert. |
| **Werte** | ETF anlegen. Dividende zahlen. Börsengänge freigeben (Zulassungspreis, Streubesitz) oder ablehnen. |
| **Nutzer** | Passwort zurücksetzen, Guthaben aufladen, Konto einfrieren oder löschen. |

Jede Einstellung hat in der Ansicht einen Satz Erklärung. Geld wird in Credits eingegeben.

**Bots starten:** Admin → **Spiel** → „Bots einschalten". Beim ersten Mal legt die Börse 100 erfundene Mitspieler und bis zu vier Bot-Firmen an. „Wie viel die Bots handeln" (0–100, Standard 40) dreht die Zahl der Orders.

**Fast-Modus:** **Spiel** → „Schnellmodus" → An. Läuft im laufenden Spiel; Handelsrate und News laufen mit. Das Einkommen kommt standardmäßig weiter nach Wanduhrzeit (z. B. einmal je Stunde), damit im Schnellmodus kein Geldüberhang entsteht.

**ETF anlegen:** **Werte** → „Neuer ETF": Name, Kürzel, Beschreibung, Aktien je Anteil, Anteile bei Start, Zusammensetzung. Die Vorschau zeigt den Korb; fehlt der Staatskasse eine Aktie, steht da, wie viele Stück, und „Anlegen" bleibt gesperrt. Es wird nichts automatisch gekauft — die Staatskasse muss den Korb besitzen.

**News selbst posten:** **News** → Titel, Text, optional Wert → „Veröffentlichen". Sie erscheint sofort bei allen. Das Formular hat auch **Art** (Nachricht, Gerücht, BaFin-Hinweis, Dividende) und **Kurswirkung** (ohne bis stark positiv/negativ): „Ohne Wirkung" macht die Bots nur auf den Wert aufmerksam, mit Kurswirkung kaufen oder verkaufen sie ihn eher.

**Für den Unterricht bewährt**

- Bots anschalten, sonst bewegt sich zwischen zwei Kursen nichts.
- Einkommen auf „1 Tag" oder „Aus" stellen — der Standard ist zum Testen kurz.
- Pause am Stundenende: Niemand handelt weiter, die Kurse bleiben stehen.
- `/board` auf den Beamer: Die Klasse sieht Kurse und Rangliste live.

---

## Wie die Börse funktioniert

- **Kurse entstehen aus Orderflow.** Der Market-Maker (die Staatskasse) legt Kauf- und Verkaufsangebote um einen fairen Kurs. Den bewegt nur, was Schüler und Bots netto bei ihm kaufen oder verkaufen: Kaufen hebt ihn, Verkaufen senkt ihn, je mehr Stück, desto stärker. Der Limitpreis spielt keine Rolle, und Geschäfte zwischen zwei Schülern lassen den Kurs unverändert.
- **Der Preis des Gegenübers gilt**, bei gleichem Preis die früher aufgegebene Order zuerst (Price-Time-Priority, wie an der Börse).
- **Markt** kauft sofort zum besten verfügbaren Preis. **Limit** kauft nur zu deinem Preis oder besser.
- **Gebühr** pro ausgeführter Order (Standard 20 Credits), Geld und Aktien werden bei der Order hinterlegt — nichts rutscht ins Minus.
- **Preis-Band:** Limits dürfen höchstens 15 % vom Kurs entfernt liegen, und gehandelt wird nur innerhalb dieses Bereichs (Schutz vor Manipulation).
- **Ordergröße:** Eine Order an einer Aktie bewegt den Kurs höchstens um 15 %, liegende Orders beliefert der Market Maker nur bis zu ihrem Preis. Größere Markt-Orders werden abgelehnt („Teile die Order“), bei größeren Limit-Orders bleibt der Rest im Orderbuch.
- **Börsengang:** Ein Schüler stellt im Profil einen Antrag, die Investment-AG gibt frei. Gründer dürfen ihre eigenen Aktien anfangs nicht verkaufen (Lock-up).
- **Übernahme:** Hält jemand mehr als die Hälfte einer Firma, gibt es eine News.
- **Schul-ETF:** Ein Korb aus mehreren Aktien. Sein Kurs ist immer der Wert des Korbs (NAV): Die Staatskasse bietet ihn direkt am Wert an und schafft oder löst Anteile, sobald ihr eigener Bestand zu niedrig oder zu hoch ist — vollautomatisch.
- **Bots:** Normale Konten mit eigener Persönlichkeit, Zielanteil und Startposition. Sie halten Cash in Reserve und handeln über die ganze Spieldauer; Details in `wiki/BOTS.md`.
- **Einkommen und Gebühren:** Die Gebühren fließen mit dem Einkommen an alle aktiven Konten zurück.
- **Inaktive Konten** werden nach drei Wochen gelöscht, das Vermögen fällt an die Staatskasse.

---

## Tests und Lasttest

```bash
npm test                                       # Server: Orders, Pause, Storno, Gewinn, WebSocket, Push, Market-Maker-Modell (reine Mathematik, Kurs aus Orderflow, Band, Stückgrenze), ETF-Automatik, Einstellungs-Migration
npm run smoke                                 # ganze API von vorn bis hinten (eigene DB, Port 3100)
node server/loadtest.js --clients 300 --seconds 20 --bots 100 --label neu
node server/test/mm-sim.js --label neu --seconds 600 --activity 40 --tick 3 --reasons
```

`mm-sim.js` misst das Kursverhalten im Bot-Modus auf einer eigenen Wegwerf-Datenbank: Volatilität, größten Kursschritt, Abweichung der ETFs vom NAV und (mit `--reasons`) die Ablehnungen der Bots nach Art. Die Tabelle erscheint auf dem Bildschirm; mit `--server <Verzeichnis>` läuft es auch gegen einen alten Stand.

Der Lasttest startet einen eigenen Server auf Port 3199 mit einer temporären Datenbank und schreibt seinen Bericht nach `.agent-team/berichte/`. Die echte Börse wird nie berührt.

---

## Entwickeln

```bash
PORT=3100 DB_NAME=dev.db npm run dev
```

Ohne `DB_NAME` würde der Entwicklungsserver die echte Börse öffnen — deshalb immer beides setzen. Der Vite-Proxy zeigt auf Port 3000; wer einen anderen Port nutzt, ändert ihn in `client/vite.config.js`.

```
server/
  index.js        HTTP, statische App, WebSocket
  push.js         eine Nachricht einmal serialisieren, an alle senden
  engine.js       Orderbuch, Matching, Market-Maker
  mmath.js        Rechenregeln des Market-Makers: fairer Kurs, Band, Staffel
  bots.js         Bot-Händler (Startposition, Uhr, Ausführung)
  botbrain.js     Entscheidungslogik der Bots (ohne Datenbank)
  newsgen.js      automatische News aus Marktdaten
  jobs.js         Einkommen und Gebühren-Recycling, News, Aufräumen, Kursverlauf
  etf.js          ETF-Wert und Automatik
  routes.js       REST-API unter /api
  db.js           SQLite, Schema, Einstellungen
  auth.js         Konten und Sitzungen
  loadtest.js     Lasttest
client/src/
  hooks.jsx       Live-Kurse außerhalb von React; jede Zeile rendert allein
  ui.jsx          Bausteine (Zeile, Schaltfläche, Sheet, …)
  styles.css      Farben, Schrift, Abstände
  pages/          eine Datei je Ansicht
```

Alles Geld ist in Cent gespeichert (Integer). Alle Farben und Abstände kommen aus den Variablen am Anfang von `styles.css`.

### Einstellungen hinter dem Panel

Das Panel zeigt die Einstellungen zu Bots, Einkommen, Startkapital und Gebühr. Der Rest steht als Standard in `server/db.js` (`DEFAULT_SETTINGS`): alles zum Market Maker (Streubesitz, Mindestangebot, Nachplatzierung), Preis-Band, Ghost-Frist, Lock-up, Gebühren-Recycling, Bot-Reserve. Wer sie ändern will, trägt den Wert einmalig in die Tabelle `settings` ein oder schickt ihn an `PUT /api/admin/settings` — sie bleiben bei Updates erhalten. Die volle Liste steht in `wiki/BOTS.md` und `wiki/MATCHING-ENGINE.md`. Beim ersten Start mit Market Maker V3 löscht der Server die nicht mehr gebrauchten Market-Maker-Schlüssel und setzt `mm_spread_bp`, `mm_jitter_bp` und `mm_size` auf die neuen Standardwerte, sofern dort noch die alten stehen.

---

## Was bewusst wegfiel

Die frühere Version hatte neun Admin-Tabs, ein Pro-Terminal, einen Trading Desk, ein ETF- und Treasury-Terminal, Kapitalerhöhung, Sonderdividenden, Umbenennen, Trophäen und 31 Einstellungen. Das ist entfernt: Alles, was man verwalten oder erklären muss, macht die Börse schwerer zu bedienen. Der Motor (Markt-Maker, ETF-Automatik, Übernahme-Erkennung) läuft unsichtbar weiter.

Alles Entfernte steht unverändert im Commit `4909373`. Einige zugehörige Server-Endpunkte (ETF-Terminal, Treasury) sind noch da, von keiner Ansicht mehr erreichbar und können als Nächstes weg:

```bash
git show 4909373:client/src/pages/Desk.jsx            # ansehen
git checkout 4909373 -- client/src/pages/Desk.jsx     # zurückholen
```

Mehr zur Arbeitsweise von Bots, News und Matching: `wiki/BOTS.md`, `wiki/NEWS.md`, `wiki/MATCHING-ENGINE.md`.
