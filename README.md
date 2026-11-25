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

## Für die Investment-AG: vier Bereiche, ohne Schulung

| Bereich | Was du hier machst |
|---|---|
| **Spiel** | Börse pausieren und weiterlaufen lassen. Bots an- und ausschalten und einstellen, wie viel sie handeln — sie halten den Markt lebendig, wenn gerade niemand kauft. Einkommen (Betrag, Abstand, „Jetzt auszahlen"), Startkapital, Gebühr. |
| **News** | Nachrichten schreiben, optional zu einem Wert. |
| **Werte** | Dividende zahlen. Börsengänge freigeben (Zulassungspreis, Streubesitz) oder ablehnen. |
| **Nutzer** | Passwort zurücksetzen, Guthaben aufladen, Konto einfrieren oder löschen. |

Jede Einstellung hat in der Ansicht einen Satz Erklärung. Geld wird in Credits eingegeben.

**Für den Unterricht bewährt**

- Bots anschalten, sonst bewegt sich zwischen zwei Kursen nichts.
- Einkommen auf „1 Tag" oder „Aus" stellen — der Standard ist zum Testen kurz.
- Pause am Stundenende: Niemand handelt weiter, die Kurse bleiben stehen.
- `/board` auf den Beamer: Die Klasse sieht Kurse und Rangliste live.

---

## Wie die Börse funktioniert

- **Kurse entstehen nur durch Trades.** Der Market-Maker (die Staatskasse) legt Kauf- und Verkaufsangebote um den letzten Kurs; jede Order der Schüler bewegt den Kurs über diese Staffel.
- **Der Preis des Gegenübers gilt**, bei gleichem Preis die früher aufgegebene Order zuerst (Price-Time-Priority, wie an der Börse).
- **Markt** kauft sofort zum besten verfügbaren Preis. **Limit** kauft nur zu deinem Preis oder besser.
- **Gebühr** pro ausgeführter Order (Standard 20 Credits), Geld und Aktien werden bei der Order hinterlegt — nichts rutscht ins Minus.
- **Preis-Band:** Limits dürfen höchstens 15 % vom Kurs entfernt liegen (Schutz vor Manipulation).
- **Börsengang:** Ein Schüler stellt im Profil einen Antrag, die Investment-AG gibt frei. Gründer dürfen ihre eigenen Aktien anfangs nicht verkaufen (Lock-up).
- **Übernahme:** Hält jemand mehr als die Hälfte einer Firma, gibt es eine News.
- **Schul-ETF:** Ein Korb aus mehreren Aktien, den die Staatskasse automatisch nah am Wert hält.
- **Inaktive Konten** werden nach drei Wochen gelöscht, das Vermögen fällt an die Staatskasse.

---

## Tests und Lasttest

```bash
npm test                                       # Server: Orders, Pause, Storno, Gewinn, WebSocket, Push
npm run smoke                                 # ganze API von vorn bis hinten (eigene DB, Port 3100)
node server/loadtest.js --clients 300 --seconds 20 --bots 100 --label neu
```

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
  bots.js         Bot-Händler
  jobs.js         Einkommen, Aufräumen, Kursverlauf
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

Das Panel zeigt fünf Einstellungen. Der Rest steht als Standard in `server/db.js` (`DEFAULT_SETTINGS`): Gebühr, Preis-Band, alles zum Market-Maker, Ghost-Frist und Lock-up. Wer sie ändern will, trägt den Wert einmalig in die Tabelle `settings` ein — sie bleiben bei Updates erhalten.

---

## Was bewusst wegfiel

Die frühere Version hatte neun Admin-Tabs, ein Pro-Terminal, einen Trading Desk, ein ETF- und Treasury-Terminal, Kapitalerhöhung, Sonderdividenden, Umbenennen, Trophäen und 31 Einstellungen. Das ist entfernt: Alles, was man verwalten oder erklären muss, macht die Börse schwerer zu bedienen. Der Motor (Markt-Maker, ETF-Automatik, Übernahme-Erkennung) läuft unsichtbar weiter.

Alles Entfernte steht unverändert im Commit `4909373`. Einige zugehörige Server-Endpunkte (ETF-Terminal, Treasury) sind noch da, von keiner Ansicht mehr erreichbar und können als Nächstes weg:

```bash
git show 4909373:client/src/pages/Desk.jsx            # ansehen
git checkout 4909373 -- client/src/pages/Desk.jsx     # zurückholen
```

Mehr zur Arbeitsweise von Bots und Matching: `wiki/BOTS.md`, `wiki/MATCHING-ENGINE.md`.
