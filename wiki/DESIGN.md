# DESIGN.md — School-Street „Anzeigetafel"

Gilt für alle drei Fassungen (Spieler-App, Admin-Panel, Beamer `/board`) und für jeden, der eine Ansicht baut.
Wer eine Ansicht baut, nimmt **nur** Tokens, Bausteine und Wörter aus dieser Datei. Was hier fehlt, wird gemeldet, nicht selbst erfunden.

Stand 24.11.2026 · Pakete am installierten Code geprüft: `@fontsource-variable/archivo` 5.3.0, `@fontsource/instrument-sans` 5.3.0, `@tabler/icons-react` 3.46.0, `lightweight-charts` 4.2.3.

---

## 1. Richtung

**Eine Anzeigetafel, kein Dashboard:** School-Street sieht aus wie die Tafel einer Börse — dunkler Grund, Zeilen unter feinen Linien, Zahlen in einer breiten, kräftigen Schrift. Grün und Rot stehen nur dort, wo Geld gewonnen oder verloren wird.
**Eine Sache pro Bildschirm:** Jede Ansicht hat höchstens eine große Zahl, oben links, ohne Kasten. Alles andere ist dichte Liste, die kurz aufblitzt, wenn sich ein Kurs ändert.
**Signatur ist das Ticker-Band:** Unter der Kopfzeile steht ein Band aus Kürzel, Kurs und Veränderung aller Werte. Es ist das eine Erkennungsmerkmal — kein zweites Deko-Element kommt dazu.

**Dopamin kommt aus Daten:** Aufblitzen bei Kursänderung, rollende Zahlen, Konfetti nur nach einem ausgeführten Handel und beim Rangaufstieg.

### Referenzen

| Produkt | Übernehmen | Nicht übernehmen |
|---|---|---|
| Robinhood | Depotwert als erste Zahl; Kaufen/Verkaufen als farbige Aktion | (keine Bildprüfung gemacht) |
| Trading 212 | Liste statt Kartenraster; Y-Achse beschriften — die Lehre aus dem zurückgenommenen Redesign (Dez. 2025) | runde Karten, Inhalte hinter der Suche versteckt |
| Kalshi / Polymarket | eine Zahl groß, eine Aktion je Eintrag, Bestätigung in Daumennähe | XP, Streaks, Stufen, Badges |

Quelle zu Trading 212 (gelesen): https://www.tradingview.com/news/financemagnates:43ac728c4094b:0-trading-212-reverses-interface-redesign-after-users-warn-they-ll-switch-brokers-it-s-like-you-re-intentionally-trying-to-anger-us

### Bewusste Entscheidungen (kein Zufalls-Default — mit Begründung)

Der Anti-Slop-Katalog (Abschnitt 8) führt „fast-schwarz + ein Grün-Akzent", „eine große Zahl als Hero" und „Count-up" als typische KI-Defaults. Hier sind sie **gewählt**, weil sie aus der Sache kommen:

- Dunkler Grund und Grün/Rot: Kurs- und Gewinnfarben sind die Fachsprache jeder Börse; die Farben tragen immer ein Vorzeichen.
- Eine große Zahl: In der Depot-Ansicht ist der Depotwert die Antwort auf die Frage, mit der jede Broker-App öffnet.
- Count-up: nur für Geldbeträge, 300 ms, abschaltbar. Keine Statistik-Zahlen rollen.

---

## 2. Grundmuster

1. **Liste ist das Grundmuster.** Werte, Positionen, News, Rangliste, Einstellungen: Zeilen (`Row`) unter einer Haarlinie. Keine Kachel-, Sticky-Note- oder Kartenraster.
2. **Abschnitte bekommen eine Überschrift, keinen Rahmen.** Überschrift in Satzschreibweise (nicht in Versalien), darunter Haarlinie. Nur Sheet, Dialog und Login sind eigene Flächen.
3. **Farbe nur mit Vorzeichen.** Grün/Rot markieren Geldbeträge, Prozente, Kaufen, Verkaufen. Gold nur für Platz 1 und Rangaufstieg, Warnfarbe nur für „pausiert" und Fehler.
4. **Kürzel statt Icon-Kachel.** Ein Wert wird an seinem Börsenkürzel erkannt (`Symbol`), nicht an einem farbigen Icon.
5. **Keine Bilder.** Kein Internet im Schul-LAN: keine Stockfotos, News unbebildert, Avatare als Initialen.
6. **Rand bis Rand.** Zeilen laufen über die volle Breite; Inhalt beginnt am Seitenrand (`--ss-gutter`).

### Fassungen und Breakpoints

| Fassung | Breite | Aufbau |
|---|---|---|
| Mobil (Standard) | < 720 px | eine Spalte, Rand 16 px, Tab-Leiste **unten** (4 Tabs), Sheet von unten |
| PC | ≥ 720 px | Rand 24 px, Inhaltsbreite höchstens 1120 px, Leiste **oben**, Sheet wird zentrierter Dialog (440 px) |
| PC breit | ≥ 1024 px | Markt/Handeln zweispaltig: Liste links (380 px), Wert rechts |
| Beamer `/board` | ≥ 1280 px, 16:9 | keine Bedienelemente, zwei Spalten (Kurse links, Rangliste rechts), Schrift über `clamp()` |

`data-view="board"` bzw. `data-view="admin"` am `<html>`-Element schaltet die Tokens der Fassung. Alle Maße in `rem` oder px, `html { font-size: 100 % }`.

---

## 3. Tokens (copy-fertig)

```css
:root {
  /* Flächen */
  --ss-bg: #0d0f10;
  --ss-surface: #15181a;
  --ss-surface-2: #1e2225;
  --ss-line: #394146;
  --ss-line-strong: #6b7378;

  /* Text */
  --ss-text: #f2f4f4;
  --ss-text-2: #b9c1c4;
  --ss-text-3: #8f999e;

  /* Bedeutung */
  --ss-up: #3ee08a;
  --ss-down: #ff6b7a;
  --ss-gold: #ffc94d;
  --ss-warn: #ffb224;
  --ss-ink: #0d0f10;
  --ss-white: #ffffff;

  /* Getönte Flächen */
  --ss-up-wash: rgba(62, 224, 138, 0.16);
  --ss-down-wash: rgba(255, 107, 122, 0.16);
  --ss-gold-wash: rgba(255, 201, 77, 0.16);
  --ss-warn-wash: rgba(255, 178, 36, 0.16);
  --ss-scrim: rgba(0, 0, 0, 0.64);

  /* Typografie */
  --ss-font-num: 'Archivo Variable', 'Archivo', system-ui, sans-serif;
  --ss-font-body: 'Instrument Sans', system-ui, sans-serif;
  --ss-fs-xs: 0.75rem;
  --ss-fs-sm: 0.875rem;
  --ss-fs-base: 1rem;
  --ss-fs-md: 1.125rem;
  --ss-fs-lg: 1.5rem;
  --ss-fs-xl: 2rem;
  --ss-fs-hero: 2.75rem;

  /* Form */
  --ss-gutter: 16px;
  --ss-max-w: 1120px;
  --ss-bp-pc: 720px;
  --ss-bp-wide: 1024px;
  --ss-row-h: 56px;
  --ss-radius: 12px;
  --ss-radius-ctl: 10px;
  --ss-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  --ss-tabbar-h: 60px;

  /* Bewegung */
  --ss-dur-fast: 120ms;
  --ss-dur: 220ms;
  --ss-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (min-width: 720px) {
  :root { --ss-gutter: 24px; }
}
[data-view="board"] {
  --ss-fs-sm: clamp(1.125rem, 1.4vw, 1.5rem);
  --ss-fs-base: clamp(1.25rem, 1.6vw, 1.75rem);
  --ss-fs-lg: clamp(1.75rem, 2.4vw, 2.75rem);
  --ss-fs-xl: clamp(2.25rem, 3.4vw, 4rem);
  --ss-fs-hero: clamp(2.75rem, 4.6vw, 5.5rem);
  --ss-gutter: clamp(16px, 2vw, 40px);
  --ss-row-h: 72px;
}
```

Kontrast auf `--ss-bg` (berechnet): text 17,4 · text-2 10,5 · text-3 6,6 · up 11,2 · down 7,0 · gold 12,6 · line-strong 4,0. `--ss-line` (1,9) ist nur zierende Trennlinie, nie Rand eines Bedienelements.

---

## 4. Typografie, Abstände, Radien

| Schritt | rem (px) | Schrift | Gebrauch |
|---|---|---|---|
| xs | 0,75 (12) | Body 600 | einzige Kleinstufe: Zeitstempel, Einheiten |
| sm | 0,875 (14) | Body 400/600 | Zeilen-Untertitel, Hilfe |
| base | 1 (16) | Body 400/600 | Fließtext, Eingaben, Zeilentitel |
| md | 1,125 (18) | Body 600 | Abschnittsüberschrift |
| lg | 1,5 (24) | Zahlen 700 | zweitgrößte Zahl |
| xl | 2 (32) | Zahlen 700 | Kurs im Handel |
| hero | 2,75 (44) | Zahlen 800, `font-stretch: 110 %` | die eine große Zahl je Ansicht |

Zeilenhöhe: Zahlen 1,05, Fließtext 1,45. Alle Zahlen `font-variant-numeric: tabular-nums` (Klasse `.num`). Gewichte nur 400, 600, 700, 800.
Abstände auf einem 4-px-Raster: 4, 8, 12, 16, 24, 32, 48. Radien: 12 px nur für Sheet/Dialog, 10 px für Bedienelemente, 999 px für Chips. Schatten nur `--ss-shadow` und nur unter offenem Sheet/Dialog. Kein Blur, kein Verlauf.

Icons nur aus `@tabler/icons-react`, sparsam. **Vorhanden** (geprüft): IconArrowUp, IconArrowDown, IconChartLine, IconWallet, IconNews, IconTrophy, IconCoins, IconUsers, IconX, IconCheck, IconAlertTriangle, IconCircleX, IconInfoCircle, IconWifiOff, IconClock, IconSearch, IconChevronLeft, IconChevronRight, IconPlayerPause, IconPlayerStop, IconPlayerPlay, IconRefresh, IconCrown, IconDeviceTv, IconChartCandle. **Nicht vorhanden** (nicht benutzen): IconPlay, IconChartCandlestick, IconTv, IconCircleAlert.

---

## 5. Bausteine (`client/src/ui.jsx`)

Alle Exporte sind Pflicht; nichts davon heißt anders. Zustände für alle Bedienelemente: Standard, Hover (`--ss-surface`), Fokus (`outline: 2px solid var(--ss-white); outline-offset: 2px`), Lädt (`loading`), Deaktiviert (Opacity 0,5, kein Hover), Fehler (`error`-Text in `--ss-down`).

| Export | Props | Zweck |
|---|---|---|
| `Money` | `c` (Cent), `signed`, `colored`, `suffix`, `className` | Geldbetrag de-DE, `.num` |
| `Pct` | `v` (Prozentzahl), `digits=2`, `signed`, `colored`, `className` | Prozent de-DE **mit Komma**, Vorzeichen |
| `Num` | `v` | Stückzahl de-DE |
| `LivePrice` | `value`, `format`, `className` | Geld mit Count-up (300 ms) und Aufblitzen |
| `Flash` | `value`, `children`, `className` | legt `--ss-up-wash`/`--ss-down-wash` 600 ms über die Zeile bei Änderung |
| `Chip` | `tone`: `up`/`down`/`gold`/`warn`/`neutral` | kleines Etikett (ETF, Platz 1, pausiert) |
| `Avatar` | `seed`, `label`, `size=36` | Initialen auf `--ss-surface-2` |
| `Symbol` | `ticker`, `name`, `sub` | Kürzel fett + Name in text-2 |
| `Row` | `leading`, `title`, `sub`, `trailing`, `to`, `onClick`, `className`, `disabled` | Zeile, 56 px, Haarlinie; `to` → Link, `onClick` → Button |
| `Section` | `title`, `action`, `children` | Überschrift + Haarlinie + Zeilen |
| `Button` | `variant`: `buy`/`sell`/`primary`/`ghost`/`danger`, `size`: `sm`/`md`/`lg`, `full`, `loading`, `type`, `disabled`, `className` | `primary` = weiß mit dunkler Schrift; `buy`/`sell` = Grün/Rot mit dunkler Schrift; Höhe ≥ 44 px, `lg` 56 px |
| `Segmented` | `value`, `onChange`, `options: [{value,label}]` | Umschalter (Kaufen/Verkaufen, Markt/Limit) |
| `Stepper` | `value`, `onChange`, `min=0`, `max`, `step=1`, `label`, `suffix` | − / Zahl / +, direkte Eingabe möglich |
| `Field` | `label`, `help`, `error`, `htmlFor`, `children` | Beschriftung, Hilfe, Fehlertext; `label` ist mit `htmlFor` verknüpft |
| `Input`, `Select`, `Textarea` | Standard-Props | einheitliche Felder, Höhe 48 px |
| `Sheet` | `open`, `onClose`, `title`, `children`, `footer` | unten (mobil) / zentriert (PC); Esc und Klick auf den Rand schließen; Fokus bleibt im Sheet |
| `Confirm` | `open`, `title`, `children`, `confirmLabel`, `danger`, `onConfirm`, `onClose` | Bestätigungsdialog auf Basis von Sheet — ersetzt `window.confirm` |
| `TabBar` | `items: [{to,label,icon}]`, `active` | 4 Tabs: unten mobil, oben PC |
| `Skel`, `SkelRows` | `h`, `w`, `radius` / `n`, `h` | Skeleton |
| `Loading`, `Empty`, `ErrorBox`, `OkBox` | `label` / `icon`, `title`, `children` / `children`, `onRetry` / `children` | Lädt, Leer, Fehler, Erfolg — jede Ansicht braucht Lädt, Leer und Fehler |
| `ToastProvider`, `useToast` | `push(text, kind)` | `kind`: `ok`/`err`/`info` |
| `confetti` | `origin`, `kind`: `trade`/`rank` | Canvas, 1,2 s, Farben nur up/down/gold/white |

Charts kommen aus `client/src/hooks.jsx`: `CandleChart({candles})` (lazy, eigener Chunk), `Sparkline({values, w, h, fill, tone})` und `LineChart({points, showLabels})` (direkt).

CSS-Klassen für Seiten (nur diese): `.num .pos .neg .muted .small .page .sticky-actions .banner .table .search .tape .two-col`. Seiten-eigenes CSS darf **nur Variablen** benutzen, keine Hex-Werte, keine Schatten, Verläufe, Blur.

---

## 6. Bewegung

- Kursänderung: Fläche der Zeile blitzt 600 ms in up/down-wash auf; Preis rollt 300 ms.
- Konfetti: nach ausgeführtem Handel (vom Kaufen-/Verkaufen-Button) und bei Rangaufstieg (oben mittig). Sonst nirgends.
- Sheet: 220 ms von unten bzw. Dialog mit 220 ms Fade. Nichts sonst bewegt sich: kein Hover-Heben von Karten, kein Fade-up beim Scrollen, kein Bounce.
- Ticker-Band: läuft langsam (90 s je Umlauf), steht bei Hover.
- `prefers-reduced-motion: reduce`: alles sofort, kein Count-up, kein Konfetti, Ticker-Band steht (mehrzeilig umgebrochen).

---

## 7. Tonalität (Deutsch, Du-Form)

Kurz, selbstbewusst, ohne Jugendsprech und ohne Fachjargon. Ein Satz, keine Absätze.

| Statt | Sagen |
|---|---|
| „Order erfolgreich platziert" | „Gekauft. 12 ACME für 480,00." |
| „Transaktion fehlgeschlagen" | „Das ging nicht. Du hast zu wenig Geld." |
| „Orderbuch, Tiefe, Liquidität" | (weglassen) |
| „Limit-Order" | „Limit — nur zu deinem Preis oder besser." |
| „Investment-AG-Konsole" | „Börse verwalten" |

Zahlen immer de-DE: `1.234,56`. Währung so, wie sie `fmtC` aus `api.js` ausgibt.

---

## 8. So nicht — Anti-Slop-Checkliste

Quellen: Katalog `avoid-ai-design` (81 Tells; gelesen: https://github.com/funboy322/avoid-ai-design), https://www.paralect.com/blog/signs-of-ai-slop-in-design, https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website, https://medium.com/design-bootcamp/how-to-stop-your-frontend-looking-ai-generated-efbb9681a6a2, https://www.mindstudio.ai/blog/claude-design-avoid-ai-slop-design-system

1. Kein Violett, Lila, Indigo. Kein Farbverlauf, kein Text mit Verlauf.
2. Kein Glassmorphismus, kein `backdrop-filter`, kein Glow, keine Orbs oder Grids im Hintergrund.
3. Kein `shadow` + großer Radius auf allem; keine Icons in abgerundeten Quadraten.
4. Keine Kartenraster, keine „drei Icon-Karten". Listen statt Karten.
5. Keine Emoji als Icons. Nur Tabler-Icons, sparsam.
6. Nicht Inter, Roboto, Geist oder Space Grotesk als Erkennungsschrift. Zahlen in Archivo.
7. Kein zentrierter Hero mit Slogan. Keine „Elevate / Seamless"-Wörter, kein Pfeil an der Schaltfläche.
8. Nicht überall derselbe Fade-up, kein Bounce. Bewegung nur, wo sich Daten ändern. Reduced Motion respektiert.
9. Fokus immer sichtbar. Text-Kontrast ≥ 4,5:1, Bedienelemente ≥ 44 px.
10. Keine pulsierenden Punkte, keine dekorativen „01 / 02 / 03", keine falschen Fensterpunkte.
11. Keine Drift: nur Tokens und Bausteine aus dieser Datei, keine Hex-Werte im Seiten-CSS.
12. Keine Count-up-Statistiken, keine Trophäen-, Streak- oder Badge-Programme.

Selbsttest je Ansicht („Silhouette"): Würde das Layout für jede x-beliebige App passen? Wenn ja, fehlt die Anzeigetafel: Zeilen, Kürzel, Zahlen, Ticker-Band.

---

## 9. Ansichten

**Spieler-App** — Kopfzeile: Wortmarke „School Street", rechts Avatar (→ Profil). Darunter das Ticker-Band. Ist die Börse pausiert, ein warnfarbener Streifen „Börse pausiert — gerade keine Orders." Tab-Leiste: **Markt · Depot · News · Rang**.

| Ansicht | Route | Inhalt |
|---|---|---|
| Login | `/login` | eine Spalte: Wortmarke, Name, Passwort, „Rein"; Umschalter „Neu hier? Konto anlegen". Kein Verlauf, kein Glow |
| Markt | `/` | Suche, Filter Alle/Gewinner/Verlierer, Liste: `Symbol` · Sparkline · Kurs (`LivePrice`) · Veränderung (`Pct`) |
| Handel | `/security/:id` | Kurs groß + Veränderung, Kerzenchart (1T · 1W · 1M), Zeilen Hoch/Tief, Volumen, dein Bestand; unten fixiert „Kaufen"/„Verkaufen"; offene Orders mit Storno |
| Handels-Sheet | (über Handel) | Kaufen/Verkaufen, Markt/Limit, Menge mit ¼ ½ Alles, Vorschau (Du bekommst, Ø-Preis, Gebühr, Gesamt), Fehlerzeile, Bestätigen, danach Erfolgs-Anzeige mit Konfetti |
| Depot | `/depot` | Depotwert als große Zahl, darunter Gewinn/Verlust; Zeilen Cash, investiert; Positionen; offene Orders; Verlauf |
| News | `/news` | Zeilen: Zeit („vor 5 Min."), Titel, Text, Kürzel-Chip → Handel |
| Rang | `/rank` | „Platz 12" als große Zahl + eigener Wert; Top 50; eigene Zeile unten fixiert, wenn außerhalb |
| Profil | `/me` | Name, Rangtitel, Wert; „Meine Firma" (Firma oder Antrag oder „Firma an die Börse bringen"); „Ausloggen" |

**Rangtitel** nach Depotwert: Broke, NPC, Hustler, Wolf, Whale — Schwellen unverändert aus `RANKS` in der bisherigen `client/src/pages/Profile.jsx` (Zeilen 10–17; Whale ab 50.000 Cr).

**Admin** (`/admin`, Wortmarke „Börse verwalten", Leiste oben): **Spiel · News · Werte · Nutzer**. PC-first, aber bis 720 px benutzbar.

| Bereich | Inhalt |
|---|---|
| Spiel | Statuszeile Läuft/Pausiert mit Schaltfläche; Bots an/aus + „Wie viel die Bots handeln" (0–100); Einkommen (Betrag, Abstand als Auswahl: Aus, 5 Min, 1 h, 1 Tag, 1 Woche, „Jetzt auszahlen"); Startkapital; Gebühr. Jede Einstellung eine Zeile mit einem Hilfesatz |
| News | Formular Titel, Text, Wert (optional); darunter die letzten 30 |
| Werte | Liste aller Werte (Kürzel, Name, Kurs, Anteile im Umlauf, Halter); je Zeile „Dividende"; darüber IPO-Anträge mit „Freigeben" (IPO-Preis, Streubesitz) und „Ablehnen" |
| Nutzer | Suche, Liste ohne Bots (Name, Cash, Wert, Status); je Zeile Passwort, Guthaben, Einfrieren/Auftauen, Löschen |

**Beamer** (`/board`): Index als große Zahl, links Kurse (Kürzel, Kurs, Veränderung), rechts Top 10. Live über WebSocket; nur die Uhr wird minütlich aktualisiert.
