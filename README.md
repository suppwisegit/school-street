# 🏦 School-Street — Börsensimulation der Investment-AG

Kompletter Prototyp einer Schulbörsen-Simulation für das lokale WLAN.
Ein Server-PC hostet **einen** Node.js-Prozess (Matching Engine, Market-Maker,
Datenbank, Hintergrund-Jobs + fertiges Frontend); alle Schüler verbinden sich
per Browser.

| Adresse | Zweck |
|---|---|
| `http://<serverip>:3000/` | **Spieler-Interface** (Login/Registrierung, Handel, Depot, News) |
| `http://<serverip>:3000/admin` | **Investment-AG** (Aufsicht, IPOs, News, Dividenden, ETF-Arbitrage) |
| `http://<serverip>:3000/board` | **Board/TV-Ansicht** (Index, Tops/Flops, Leaderboard, News-Ticker) |

> `/admin` ist bewusst "irgendeine Adresse" — der Server liefert die App für
> jeden Pfad aus; die AG verteilt nur diesen Link an ihre Mitglieder.

---

## Schnellstart auf dem Server-PC

```bash
cd ANTIGRAVITYTEST
npm install          # nur beim ersten Mal
npm run seed         # Demo-Daten (4 Aktien + ETF, setzt DB zurück!)
npm run build        # React-Frontend bauen (liefert nach server/public/)
./start.sh           # startet den Server (im Hintergrund, loggt in server/data/schoolstreet.log)
```

Stoppen: `pkill -f 'node server/index.js'` — Log verfolgen: `tail -f server/data/schoolstreet.log`.
Alternativ im Vordergrund (Strg+C zum Stoppen): `npm start`. Anderer Port: `PORT=8080 ./start.sh`.

Im WLAN erreichbar unter `http://<serverip>:3000` (Server-IP via `ip a`).
Anderer Port: `PORT=8080 npm start`.

**Zugänge nach `npm run seed`:**

| Konto | Login | Passwort |
|---|---|---|
| Investment AG (Admin) | `admin` | `ag123` (oder `ADMIN_PASSWORD=...` beim Seed) |
| Demo-Trader | `Anna`, `Ben`, … `Hannah` | `demo123` |
| Gründer | `Max`, `Lena`, `Tim`, `Zoe` | `demo123` |

Ohne Seed läuft der Server mit leerer DB und legt automatisch einen Admin an
(Passwort wird **in der Server-Konsole gedruckt** — notieren und notfalls per
`ADMIN_PASSWORD=xyz npm start` bei leerer DB selbst setzen).

**Ohne Demo-Daten starten** (leere Börse): `npm start` — Registrierung ist frei.

## Entwicklung (Hot Reload)

```bash
npm run dev   # Server mit --watch + Vite-Dev-Server (Proxy auf :3000)
```

## Testen

```bash
npm run smoke   # End-to-End-API-Test (startet eigenen Server auf Port 3100 mit eigener DB)
```

---

## Wie die Börse funktioniert

### Matching Engine (nach XETRA-Prinzip)
- Kontinuierlicher Handel mit **Price-Time-Priority**; der Preis des ruhenden
  Orders (Maker) gilt. Selbstmatch wird verhindert.
- **Limit-Orders** matchen sofort soweit möglich, Rest liegt im Buch.
  Gebot / Brief **jederzeit einsehbar** (aggregiert pro Preisstufe).
- **Market-Orders** werden sofort ausgeführt, ein Rest verfällt.
- Geld & Aktien werden bei Orderaufgabe treuhänderisch **escrowed** —
  nichts kann ins Minus gehen, kein Geld aus dem Nichts (SQLite-Transaktionen,
  alles synchron in einem Prozess ⇒ keine Race Conditions).
- **Gebühr (Geldverbrennung):** 20 Credits pro ausgeführter Order (Inflationsschutz).

### Kurse bewegen sich NUR durch Spieler-Trades
Der Market-Maker (Staatskasse/Treasury) legt **passive Quoten** um den letzten
Handelspreis (Spread + kleine Stückzahl). Nach jedem Trade re-zentriert er.
Kursänderungen entstehen also ausschließlich durch Nachfrage/Angebot der
Spieler — **News steuern nur indirekt**: "EIS zahlt Sonderdividende" → Schüler
kaufen → Kurs steigt. Der Market-Maker erzeugt keine Trends.

### Unternehmen & IPO
1. Schüler stellt IPO-Antrag (Name, Ticker, Konzept) im Profil.
2. AG gibt im Admin-Panel frei: Zulassungspreis, Gründeraktien (Standard 1000),
   Streubesitz an die Staatskasse (Standard 400), Milestone-Schwelle.
3. **Lock-up:** Gründer dürfen 2 Wochen keine eigenen Aktien verkaufen
   (Test-modus: 2 Minuten, einstellbar).
4. **Kapitalerhöhung:** Kurs bleibt über der Schwelle → Gründer kann 20% neue
   Aktien beantragen, AG genehmigt.
5. **Feindliche Übernahme:** Fremder Aktionär > 50% → Sonderrechte
   (Firma umbenennen, Sonderdividende beantragen) + News-Alarm.

### Schul-ETF & Arbitrage (AG als Authorized Participant)
- Fixer Korb (z.B. 2× MENSA, 1× HAUSA, 3× EVENT) mit **Multiplikator**
  (Creation Unit = Korb → z.B. 10 ETF-Anteile → NAV je Anteil günstig & ganzzahlig).
- **NAV** wird in Echtzeit aus den Kursen berechnet und überall angezeigt.
- Die AG macht Arbitrage **manuell** im Admin-Tab "ETF": Vorschau zeigt
  Korb-Kaufkosten vs. ETF-Erlös (Creation) bzw. ETF-Rückkauf vs. Korb-Verkauf
  (Redemption) inkl. **geschätztem Profit** — Kurse werden durch die Aktionen
  selbst Richtung NAV gedrückt/gezogen (echte Marktwirkung!).
- **Dividenden-Routing:** Schüttet eine Korb-Aktie aus, erhalten ETF-Besitzer
  anteilig ihre Dividende automatisch.

### Wirtschaftskreislauf
- Startkapital 10.000 Credits, **Wocheneinkommen** 1.000 Credits (Intervall im
  Admin-Panel einstellbar — Standard 5 Minuten zum Testen, Plus "Jetzt ausschütten").
- **Ghost-Accounts:** Nach Inaktivität (Standard 3 Wochen) werden Konten
  gelöscht, Vermögen fällt an die Staatskasse und fließt als Streubesitz zurück.
- **BaFin:** AG kann Konten einfrieren (automatische "BaFin ermittelt"-News).

### Gamification
- Leaderboard nach Depotwert, Ränge: 🪙 Broke → 👤 NPC → 💼 Hustler → 🐺 Wolf → 🐋 Whale
- Badges: 🎓 Gründer, 👑 Übernahme-König (>50% fremder Firma), 🧊 Bagholder
- Board-Ansicht für Aula/Fernseher mit Index, Tops/Flops, News-Ticker.

---

## Architektur

```
server/                 Node.js (ein Prozess, alles synchron => keine Locks nötig)
  index.js              HTTP + WebSocket + statisches Frontend
  db.js                 SQLite (WAL), Schema, Settings — alles INTEGER-CENTS
  engine.js             XETRA-Orderbuch, Escrow, Market-Maker (passiv), Takeover-Check
  etf.js                NAV, Creation/Redemption, AP-Previews, Dividenden-Routing
  jobs.js               Einkommen, Ghost-Cleanup, MM-Refresh, Milestone-Stunden
  routes.js             REST-API (/api/...)
  seed.js               Demo-Daten (echte Trades über die Engine => echte Charts)
  smoke.js              End-to-End-Test
client/                 React (Vite) → baut nach server/public/
  /                     Spieler (Neo-Broker, Dark Mode, Mobile-First, Pro-Modus)
  /admin                AG-Panel (Übersicht, IPOs, Anträge, News, Dividende, ETF, Nutzer, Einstellungen)
  /board                TV-Ansicht (Autorefresh, kein Login)
```

**Live-Updates:** WebSocket pushed Ticker (5 s), Orderbücher/Trades (bei
Abonnement), News und "dirty"-Signale (Portfolio/Orders neu laden).

## Wichtige Einstellungen (Admin → Einstellungen)

| Key | Bedeutung | Default |
|---|---|---|
| `fee_cent` | Gebühr je ausgeführter Order (Cent) | 2000 |
| `income_cent` / `income_sec` | Einkommen / Intervall | 100000 / 300 |
| `lockup_sec` | Founder-Lock-up | 120 (Seed) / 14 Tage (Default) |
| `mm_spread_bp` / `mm_size` | MM-Spread / Stück je Quote | 350 / 10 |
| `cap_hours_needed` | Stunden über Schwelle für Kapitalerhöhung | 120 |
| `inactivity_sec` | Ghost-Account-Frist | 3 Wochen |
