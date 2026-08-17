# Matching Engine & Market-Maker

Herz der Simulation: `server/engine.js`. Ein Prozess, synchron, SQLite (WAL)
— dadurch gibt es **keine Race Conditions** im Orderbuch. Alle Geldbeträge
sind Integer-Cents; Preise von Aktien laufen auf 1-Credit-Ticks (100 Cent),
ETFs auf 0,1 Credit (10 Cent).

---

## 1. Orderbuch (Price-Time-Priority)

Pro Wertpapier ein In-Memory-Buch (`books`-Map): `bids` absteigend, `asks`
aufsteigend; bei gleichem Preis gewinnt die **frühere Order** (FIFO) —
XETRA-Prinzip. Beim Serverstart wird das Buch aus `orders` (status='open')
rekonstruiert. Für die UI wird aggregiert (`bookSnapshot`).

## 2. Lebensweg einer Order (`placeOrder`)

```
Validierung → Escrow → Matching → MM-Recenter → Übernahme-Check → Broadcast
```

1. **Validierung:** Stückzahl, Typ, Preis-Tick; **Preis-Band** gegen
   Manipulation: Limits müssen innerhalb `last ± max(limit_band_cents,
   last × limit_band_pct/100)` liegen (MM/Treasury/Admin ausgenommen).
   Markt-Käufe werden vorab auf Tiefe und Cash geprüft („ehrlich abgelehnt“
   statt Teilausführung ins Leere). Founder-Lock-up blockt Gründer-Verkäufe.
2. **Escrow (treuhänderisch):**
   - Limit-Kauf: voller Betrag `preis × menge` wird vom Konto abgezogen;
     bei günstigerem Fill fließt die Differenz zurück.
   - Limit-Verkauf: Aktien wandern ins interne Escrow (Depot schrumpft).
   - Markt-Orders: keine Hinterlegung, Abrechnung pro Fill.
3. **Matching (`matchOrder`):** Der **Taker** frisst sich durch die
   Gegenseite — **zum Preis des Makers** (Maker-Preis gilt). Dabei:
   - **Self-Trade-Prevention:** eigene Orders werden strikt übersprungen
     (auch Treasury darf eigene MM-Quotes nicht kaufen — Basis der
     ETF-Arbitrage-Logik).
   - **Budget-Guard** für Markt-Käufe: bar je Fill `cash − Gebühr`; ist das
     Geld midway alle, stoppt die Order.
   - Markt-Rest verfällt (Markt-Orders liegen nie im Buch).
4. **Abrechnung (`executeFill`):** Käufer zahlt/erhält Escrow-Refund,
   Verkäufer erhält Erlös; `avg_cost` (Käufer) und `realized_pl`
   (Verkäufer) werden fortgeschrieben; Trade + Kurspunkt (`price_history`)
   werden persistiert; **Gebühr** wird bei beiden Seiten verbrannt
   (Geldvernichtung, auf den vorhandenen Cash geclampt — nie negativ).
5. Danach: MM re-zentriert, >50 %-Übernahme-Check erzeugt News, WebSocket
   broadcastet `book`/`trade`/`ticker`/`dirty`.

Storno (`cancelOrder`) gibt den Escrow exakt zurück — ohne Gebühr, die nur
auf **ausgeführte** Orders fällig wird.

---

## 3. Market-Maker V2 — der adaptive Liquidity Provider

Der MM ist die Staatskasse (Treasury, `role='bank'`) und ist per Vorgabe
**passiv und meinungslos**: Er macht keinen Trend, er bietet nur Liquidität
um den zuletzt *gehandelten* Kurs. Wie ein echter Liquidity Provider:

| Mechanik | Verhalten | Settings (Default) |
|---|---|---|
| **Ragged Ladder** | 6 Stufen je Seite; Abstände & Größen mit Zufalls-Jitter — das Buch sieht aus wie viele Teilnehmer, nicht wie eine Maschine | `mm_levels` (6), `mm_jitter_bp` (60), `mm_size_jitter` (0.35) |
| **Referenz-Noise** | Quotes zentrieren auf einem kleinen Random Walk statt exakt auf dem Last | `mm_noise_bp` (18) |
| **Volatilitäts-Skalierung** | Spread wächst **kontinuierlich** mit gemessener Volatilität σ (letzte Kursänderungen, Sampler-Pausen gefiltert), Größen schrumpfen: ruhig = eng & groß, wild = breit & klein | `mm_vol_ref` (0.01), `mm_vol_mult_max` (2.8; min 0.7) |
| **Inventory-Skew** | Viel Treasury-Bestand drückt die Quotes (abbauen), wenig Bestand hebt sie (sparsam verkaufen, günstig zurückkaufen) — hält Cash- und Aktienbestand im Kreislauf | `mm_inv_skew_bp` (200), `mm_inv_target_pct` (0.2) |
| **Momentum-Bremse** | Extrem-Circuit-Breaker: ±6 % in 10 Min → Quotes zusätzlich ×1,7 breiter | `mm_guard_pct` (6), `mm_guard_widen` (1.7) |
| **Faires Cash-Budget** | Bid-Escrow wird **pro Wertpapier** fair zugeteilt (früher frass das erste Buch alles → einseitige Bücher); Teil-Quotes statt Lücken | `mm_cash_budget_pct` (0.9) |
| **Bestandsreserve** | Über der Nachplatzierungs-Schwelle bleibt Puffer im Depot, damit nach Sweep-Orders sofort neu quotiert werden kann; darunter wird bis auf 5 Stück alles angeboten | `mm_replenish_min` (120) |
| **Nachplatzierung** | Float aufgebraucht (Depot **+ Ask-Escrow** unter Schwelle) **und** Kurs > 1,15 × IPO → +1.000 neue Aktien mit News (Nachfrage wird beliefert, Pumps gedämpft; schwache Kurse werden nicht verwässert; Cooldown 30 Min, im Fast-Mode komprimiert) | `mm_replenish_qty` (1000), `mm_replenish_price_mult` (1.15) |
| **Zentralbank-Notkredit** | Droht der Treasury-Cash auszugehen, stützt die Zentralbank auf 25 % des Startkapitals (max. 1×/10 Min) — der MM bleibt immer beidseitig handlungsfähig | `mm_recap_min_pct` (0.05) |
| **Gestaffelter Refresh** | Jedes Buch refresht versetzt (`mm_refresh_sec` ± 30 %) — nie alle gleichzeitig; nach jedem Spieler-Trade wird zusätzlich nachgezogen | `mm_refresh_sec` (15) |
| **ETF-NAV-Quoting** | Bei ETFs (Auto-Modus an) blendet der MM die Referenz Richtung NAV (bis 60 %, mit der Abweichung skalierend) — deshalb kleben ETFs am NAV | `etf_auto`, `etf_auto_threshold_pct` (10) |

## 4. ETF & Auto-Arbitrage (AP-Automatik)

Die Staatskasse ist **Authorized Participant**. Mit `etf_auto=1` läuft alle
5 s `etf.autoArbitrage()` mit zwei Instrumenten:

1. **AP-NAV-Pegging** (schnell, ab halber Schwelle): Quote-Leiter um den
   NAV — bei Discount Kauforders bei NAV ×0,985/0,96/0,93, bei Premium
   Verkauforders bei NAV ×1,015/1,04/1,07. Spieler, die dagegen handeln,
   konvergieren den Kurs sofort (kreuzende Peg-Orders nehmen cheap
   Spieler-Quotes gleich mit).
2. **Creation/Redemption** (Hintergrund, ab voller Schwelle): passt den
   Treasury-Bestand an. Units skalieren dynamisch mit der Abweichung
   (Basis `etf_auto_units` bis `etf_auto_max_units`), aber max. 30 % des
   Umlaufs pro Aktion und nie unter einen harten Float-Boden — und wenn die
   Ask-Seite ganz stirbt, schafft der AP 2 Units Nachschub („Markt-
   Erneuerung“). News max. 1×/Minute je ETF.

Gemessen: Voll-Dump des ETF → zurück im Band (−2 %) nach ~50 s.

## 5. Marktdaten & Invarianten

- **Ticker/Stats** alles ehrlich aus Trades/Buch berechnet: VWAP, Spread
  (bp), 24 h Hoch/Tief, Volumen, Volatilität, Marktkapitalisierung, Tiefe.
- **Order-Preview** (`/api/securities/:id/preview`) nutzt denselben
  Book-Walk wie die Ausführung — Was-du-siehst-ist-was-du-bezahlst.
- **Invarianten der Engine:**
  - Kein Konto geht je negativ (Gebühr geclampt).
  - Self-Trade-Prevention ist strikt.
  - Geld bleibt erhalten bis auf verbrannte Gebühren, Einkommen,
    Dividenden und Zentralbank-Operationen.
  - Der MM erzeugt keine Kurstrends — Kursbewegungen entstehen
    ausschließlich durch Trades der Teilnehmer.
