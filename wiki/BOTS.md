# Die virtuellen Trader (Bot-Modus)

Der Bot-Modus ist das **Testspiel-Feature**: 100 virtuelle Schüler halten den Markt
lebendig, wenn nur wenige echte Spieler da sind. Implementiert in `server/bots.js`,
gesteuert über den Admin-Tab **„Bots“** (`/api/admin/bots`).

---

## 1. Anlegen & Start

| | |
|---|---|
| Anzahl | Setting `bot_count` (Default 100) |
| Namen | Vornamen-Pool + fortlaufende Nummer: „Alex (Bot 5)“, „Mia (Bot 23)“ … |
| Konto | Ganz normale Trader-Konten (`role='user'`, Flag `is_bot=1`) |
| Startkapital | Dasselbe wie für echte Schüler (`start_capital`) |
| Aktien | **Keine!** Bots starten bewusst ohne Depot — wie echte Schüler |
| Passwort | Zufall, niemand loggt sich ein |

**Bot-Gründer:** Beim Start gründen zufällige Bots Firmen (Ziel: 4 Stück, Pool:
KICK, TAXI, BIO, TAB, BAND, MERCH, SCOOT, LERN, AULA, PRINT — IPO 18–55 Cr,
1.000 Gründeraktien mit Lock-up, Streubesitz kauft die Staatskasse). Nur so
kommen Bots „natural“ an Aktien im Depot. Reicht die Treasury-Cash nicht für
den vollen Float, wird der Float verkleinert.

**Persistenz:** Der Modus überlebt Server-Neustarts automatisch (`bot_running`).
Bots sind vom Ghost-Account-Cleanup ausgenommen und erhalten wie alle Trader
das Wocheneinkommen.

---

## 2. Der Handels-Loop

Ein Ticker läuft alle `bot_tick_sec` Sekunden (Default 3):

```
erwartete Trades je Tick = bot_activity/100 × 2      (×100 im Fast-Mode, Deckel 200)
```

Stille Skips (pleite, leeres Depot, leeres Buch) werden **bis zu 3× nachgelegt**,
damit die Ziel-Frequenz tatsächlich ankommt. Fehler (Liquidität, Band, …) werden
still verworfen — der Bot „überlegt es sich anders“, wie ein echter Schüler.

**Fast-Mode** (`bot_fast`, Button „🚀 Fast-Mode“ im Admin-Tab): 100×
Handelsgeschwindigkeit für MM-/Chart-Pattern-Tests. Zeitbasierte Mechaniken
(Momentum-Fenster, Nachplatzierungs-Cooldown, Wert-Anker-Fenster) komprimieren
mit — der Markt verhält sich wie im Zeitraffer, nicht wie mit 100× mehr Geld.

---

## 3. Wie ein Bot „denkt“ (Pipeline eines Trades)

Alle Entscheidungen sind **stochastisch mit Anlässen** — nahezu random, aber
nicht sinnlos. Reihenfolge in `oneTrade()`:

1. **Zufälliger Bot** wird gewählt (nicht eingefroren).
2. **Arbitrage-Instinkt** (50 % Chance): Notiert eine Bid im eigenen Depot
   **deutlich über dem letzten Kurs** (> +3 %, z. B. AP-Peg-Quotes am NAV oder
   ein fetter Tipp-Fehler), verkauft der Bot sofort 5–15 Stück hinein — freies
   Geld zieht Verkäufer an.
3. **Wertpapier-Wahl:** Aktien bevorzugt, ETFs nur zu 12 %. Mit 35 % Chance
   wird eine „heiße“ Aktie aus den News der letzten 10 Minuten bevorzugt.
4. **Kauf- oder Verkaufslaune** — die Kernformel:

   ```
   buyProb = 0,5
           + News-Stimmung × 0,12        (−3 … +3)
           + Trend-Faktor × 0,18         (gedämpftes Momentum, ±0,6)
           + Wert-Anker                  (±0,15)
   buyProb wird auf 0,1 … 0,9 geklemmt, dann gewürfelt.
   ```

   - **News-Stimmung:** Schlagwörter in Titel/Text der letzten 10 Minuten
     („Rekord/Gewinn/Dividende“ positiv, „Verlust/BaFin/Warnung“ negativ;
     Dividenden-News +2, BaFin −2, IPO +1).
   - **Momentum:** Kursänderung über die letzten 25 Kurspunkte, **gedämpft**
     (×6, Clamp ±0,6) — volle Selbstverstärkung erzeugt nur Pump-&-Dump-Blasen.
   - **Wert-Anker (Mean Reversion):** Position des Kurses im Hoch/Tief-Band
     (24 h; im Fast-Mode komprimiert). Nahe Tief → +0,15 Kaufreiz
     („Schnäppchen“), nahe Hoch → −0,15 Gewinnmitnahme. Das erzeugt natürliche
     Oszillation statt Endlos-Drift.

5. **Persönlichkeit** (stabil pro Bot-Name, überlebt Neustarts):
   ~20 % sind **Kontrarianer** (fahren Trends entgegen), dazu ein
   Größen-Bias 0,5–1,5 für die Ordergröße.
6. **Verkaufs-Re-Pick:** Hat der Bot Verkaufslaune, aber keine Stücke der
   gewählten Aktie, verkauft er stattdessen **eine zufällige gehaltene
   Position**. Ohne diesen Fix könnte ein frischer Bot-Schwarm anfangs nur
   kaufen und den Markt einseitig in den Himmel pumpen.
7. **Größe:** `(1 + Zufall×10) × Größen-Bias`, dazu in 7 % der Fälle ein
   **Wal** (3–5× Größe) — die spülen durch mehrere MM-Level und erzeugen
   große Kerzen.
8. **Cash-Pacing:** Eine Order kostet höchstens **25 % des Cash** (Wale 35 %).
   Bots bleiben dadurch immer handlungsfähig — keine Pleite-Flatlines mehr.
9. **Order-Typ:** ~85 % **Market-Orders** (wie echte Schüler), sonst Limit-
   Orders direkt am Spread (Bid + 0–2 Ticks bzw. Ask − 1–2 Ticks).

Vergessene Bot-Limit-Orders werden nach 10 Minuten automatisch aufgeräumt.

---

## 4. Was Bots bewusst NICHT tun

- Keine Kursmeinung: Sie erzeugen nur Verkehr — Trends entstehen aus ihrem
  Zusammenspiel, nicht aus Absicht.
- Keine IPO-Anträge, keine Übernahmen, keine Sonderdividenden-Anträge.
- Kein Login, keine Sessions.
- **Lock-up gilt auch für sie:** Bot-Gründer verkaufen ihre Gründeraktien
  erst nach Ablauf (realistischer „Lockup-Ablauf-Dump“).
- Alle Schutzmechanismen greifen wie für Spieler: Escrow, Gebühr, Preis-Band,
  Self-Trade-Prevention.

---

## 5. Einstellungen & Endpunkte

| Setting | Default | Bedeutung |
|---|---|---|
| `bot_count` | 100 | Anzahl virtueller Trader |
| `bot_activity` | 40 | 0–100; ≈ Trades/Min = activity/100 × 2 × 60/Tick-Sek |
| `bot_tick_sec` | 3 | Takt des Handels-Loops |
| `bot_fast` | 0 (aus) | Fast-Mode: ×100 Trades (Deckel 200/Tick) |
| `bot_running` | intern | Überlebt Server-Neustarts |

| Endpunkt | Wirkung |
|---|---|
| `GET /api/admin/bots` | Status (läuft?, Trades, Fehler, Bot-Firmen) |
| `POST /api/admin/bots/start` / `stop` | Modus starten (legt Bots + Bot-IPOs an) / stoppen |
| `PUT /api/admin/bots/settings` | `bot_activity`, `bot_tick_sec`, `bot_fast` live ändern |

Bots erscheinen normal in Trades, Orderbuch, Tape und Leaderboard; im Admin-
Nutzerfilter sind sie per Chip als „Bot“ markiert.

---

## 6. Design-Lektionen (Warum genau so?)

Frühere Versionen erzeugten ein unnatürliches Muster **Pump → Crash →
Flatline über Stunden**. Die Ursachen und ihre Fixes:

| Problem | Fix |
|---|---|
| Momentum-Herde pumpt jeden Trend bis zum Kapital-Kollaps | Momentum-Gewicht 0,35 → 0,18, Clamp ±0,6 |
| Bots kaufen sich beim Hype komplett leer | Cash-Pacing (max. 25 % pro Order) |
| Frische Bots können nur kaufen (einseitiger Flow) | Verkaufs-Re-Pick aus eigenem Depot |
| Kein Gegengewicht zum Trend → Endlos-Drift | Wert-Anker (Hoch/Tief-Band) |
| Pleite-Bots nach Crash → tote Märkte | Cash-Pacing + Wocheneinkommen |
| Gebühr zog Konten ins Minus | `chargeFee` bucht max. vorhandenen Cash ab |

Ergebnis (Fast-Mode-Messung): 35–40 % Umkehrquote, Kurse pendeln im Band,
keine Flatline — bei ~24 Trades/s belastbar (API-Latenz ~3 ms).
