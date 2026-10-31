# SPEC: harte Compaction-Grenze (rolling-compaction, `compaction-guard`)

Status: DRAFT 1, 2026-10-31. Der Mensch hat den Weg B in dieser Sitzung ausdrücklich
gewählt („Können wir B machen?“), nachdem A (nur Konfiguration), B (Konfiguration nach
Wunsch unangetastet, Grenze im Plugin) und C zur Auswahl standen. Der Bau beginnt auf
dieser Grundlage; jede Abweichung von einem der Sätze unten ist eine Frage an ihn.
Besitzer der Entscheidungen: Tilman.

Dieses Dokument beschreibt **einen** Bereich: wann und wie eine Sitzung verdichtet wird,
wenn der Kontext voll wird. Es beschreibt nicht den Chat, nicht die Anzeige der
Compactions und nicht die Anker-Logik von `context_compact` (die steht in der
Werkzeugbeschreibung und in `docs/SPEC-compact-chat.md`).

## 1. Die Entscheidung des Menschen (seine Worte)

- 2026-10-31, nach zwei Ablehnungen durch den Anbieter: *„Nein, Swift ist egal,
  Deepseek hat eben abgelehnt. Und zwar bei, weiss ich nicht, 86 % Kontext, dann hat
  es halt eine lange Nachricht geschrieben und dann kam API-Error, so, und das geht
  gar nicht, weisst du? Das geht gar nicht."*
- 2026-10-31, Vorform: *„Wir können das von mir aus auch so machen, dass einfach bei
  90 % der Agent injected bekommt, dass es ein absoluter Befehl ist, drop all compact
  now, otherwise complete catastrophic failure."*
- 2026-10-30, die Regel, die **nicht** verletzt werden darf: eine Verdichtung darf nur
  am Ende des eigenen Zuges stattfinden, nie als Antwort auf eine Nachricht des
  Menschen. Damals wurde die Automatik abgeschaltet (`auto: false`), weil der Kern in
  `agent/pre-step` verdichtete und der Zug für den Menschen ohne Antwort endete.
- 2026-10-30, Arbeitsfenster: die neuesten 3 oder 4 Züge bleiben unverdichtet
  (`keepTurns: 3`).

Daraus die beschlossene Bauform (Weg B): **`auto: false` bleibt stehen.** Nicht der
Kern verdichtet, sondern dieses Plugin: es kennt das echte Budget, es verdichtet am
Zug-Ende, und es verdichtet vor einer Anfrage nur dann, wenn die Anfrage sonst
abgelehnt würde.

## 2. Gemessene Grundlage (2026-10-31, Mac, Profil `web`)

1. Jede Anfrage dieser Route trägt `provider: deepseek-official`,
   `model: deepseek-flash`, `maxTokens: 256000` — gelesen aus dem `request/header`
   der laufenden Sitzung. Der Anbieter meldet dazu `contextWindow: 1000000` aus dem
   `request/context`-Ereignis derselben Sitzung.
2. Vorgaben von `@deepseek-ai/dsh-compaction-basic` (0.2.0-rc.2, `lib/index.js`):
   `thresholdRatio` 0.8, `retainRatio` 0.16, `headroomTokens` 65536; die für die
   Antwort reservierten Token sind **die `maxTokens` des Anfragekopfs**
   (`reservedCompletionTokens`, Zeile 757). Die Druckschwelle ist
   `floor(min(Fenster × thresholdRatio, Fenster − Reserve − Headroom))` (Zeile 132).
3. Mit (1) und (2): Puffer 1.000.000 − 256.000 = 744.000; Druckschwelle
   `min(800.000, 678.464) = 678.464` = **67,8 %** des Fensters. Die 90 % aus dem Kopf
   des Menschen waren auf dieser Route nie erreichbar, und die 86 %, die er in der
   Anzeige sah, sind schon 116 % des Budgets, weil die Anzeige `Prompt ÷ Fenster`
   rechnet und die Antwort-Reserve nicht kennt.
4. `auto: false` steht in **allen vier** Presets des Profils
   (`~/.dsh/profiles/web/cordis.patch.yml`, Zeilen 807, 1385, 1573, 1763). Damit ist
   nicht nur die Druck-Verdichtung aus, sondern auch die Rettung nach
   `CONTEXT_WINDOW_EXCEEDED` — beide hängen an `_registerAutomaticCompaction()`.
5. Belege für den Ausfall selbst (andere Route, gleiches Muster): Session
   `6d42496f-ee0e-488d-8159-6ba666404353`, Zug 2: `prompt (27511 tokens) +
   max tokens (256000) exceeds the context (262144)`; Session `3ddfcb24-…`, Zug 13:
   `30032 + 256000 > 262144`; Session `263d0e1c-…`, Zug 934: `328717 + 65536 >
   393216`. Die Anbieter-Fehlermeldung nennt das echte Fenster und schlägt vor, die
   Ausgabe zu verkleinern — genau das tut diese Spec (siehe R2).

## 3. Anforderungen

R1. **Harte Grenze.** Erreicht die Prompt-Belegung `boundaryRatio` (Vorgabe 0,9) des
    nutzbaren Fensters, wird verdichtet — ohne Rücksicht auf Phase, Aufgabenliste
    oder laufenden Zug. Das ist die Grenze, die nicht verhandelbar ist.

R2. **Keine Ablehnung wegen Kapazität.** Vor jeder Anfrage wird die Antwort-Reserve
    (`maxTokens`) so geklemmt, dass `Prompt + Reserve ≤ Fenster − safetyTokens`
    bleibt. Die Reserve wird nie erhöht und nie unter `minMaxTokens` gesenkt; ist
    der Rest kleiner als `minMaxTokens`, wird stattdessen verdichtet.
    Die Klemme wird auf `clampStep` abgerundet, damit der Anfragekopf nicht bei
    jedem Schritt neu geschrieben wird (Cache).

R3. **Verdichtet wird am Zug-Ende.** Ist der Agent untätig (`agent/status` = `idle`)
    und die Belegung liegt über der Grenze, verdichtet das Plugin sofort — da wartet
    kein Mensch. Vor einem Schritt (`agent/pre-step`) wird **nur** verdichtet, wenn
    die Anfrage sonst abgelehnt würde (R2-Sonderfall). Das hält die Anordnung vom
    30.10. ein.

R4. **Arbeitsfenster bleibt.** Verdichtet wird turn-basiert über die ältesten
    abgeschlossenen Züge in **einem** Checkpoint; die neuesten `keepTurns` Züge
    bleiben unberührt. Der Schnitt und die frei gewordenen Token werden geloggt.

R5. **Eine Wiederholung nach Ablehnung.** Meldet der Anbieter
    `CONTEXT_WINDOW_EXCEEDED`, verdichtet das Plugin einmal und lässt die Anfrage
    wiederholen; danach keine weitere Wiederholung in diesem Zug.

R6. **Der Befehl an das Modell.** Zwischen `nudgeRatio` (Vorgabe 0,75) und
    `boundaryRatio` erhält das Modell eine Anweisung, die die gemessenen Zahlen
    nennt und als Befehl formuliert ist („call context_compact now“), mit dem
    nächstbesten `turns=N` und dessen gemessener Ersparnis. Sie ist die letzte
    weiche Lage; die harte Grenze hängt nicht von ihr ab.

R7. **Nachvollziehbar.** Jede Entscheidung schreibt eine Zeile in das Host-Log: die
    Zahlen (Prompt, Reserve, Fenster, Prozent), die Entscheidung und bei einer
    Verdichtung der Bereich und die gemessenen frei gewordenen Token. Eine
    Behauptung ohne Zahl ist kein Beleg.

R8. **Kein Kern wird verändert.** Alles läuft über die öffentlichen Dienste
    `compaction`, `tokenMeter`, `llm`, `sessionProjections`, `agents` und die
    Ereignisse `agent/request`, `agent/pre-step`, `agent/request-error`,
    `agent/status`. Keine Datei aus der DSH-Installation wird angefasst.

## 4. Grenzen und Fehlerfälle

- Fenstergröße unbekannt → der Guard tut nichts und sagt es einmal. Er rät nicht.
- Es gibt weniger abgeschlossene Züge als `keepTurns` → für die Notfall-Grenze
  greift die aggressive Rettung des Kerns (`compactIfNeeded`, Trigger
  `context-overflow`). Begründung: eine Sitzung, die nicht schrumpfen kann, muss
  trotzdem gerettet werden; dann geht Arbeitsfenster vor Zug-Tod.
- Verdichtung schlägt fehl → Fehler wird geloggt, die Anfrage läuft weiter (der
  Guard blockiert nie eine Anfrage, die ohne ihn auch gescheitert wäre).
- Läuft bereits eine Verdichtung derselben Sitzung, wird keine zweite gestartet.

## 5. Abnahme (jeweils gemessen, nicht behauptet)

A1. Offline: die Budget-Entscheidung rechnet die drei gemessenen Fälle richtig
    (1.000.000/256.000 → klemmen, 90 % → verdichten, 262.144/256.000 → verdichten).
    Beleg: `node --test test/budget.test.mjs`.
A2. Live: bei einer Sitzung über der Grenze erscheint im Host-Log die Zeile mit
    Prompt, Reserve, Fenster und Prozent, und die Verdichtung mit Bereich und
    `freedTokens`.
A3. Live: der Anfragekopf einer Sitzung zwischen 68 % und 90 % Füllung trägt eine
    Reserve kleiner als 256.000 (`request/header` in `sessions/…`), und die Anfrage
    geht durch.
A4. Live: eine erzwungene Prüfung mit `boundaryRatio: 0.05` verdichtet sofort, ohne
    dass der Mensch eine Antwort verliert — danach zurückstellen.
A5. `git diff` zeigt keine Änderung außerhalb dieses Plugins.

## 6. Änderungsverlauf

- 2026-10-31 Draft 1: aus der Wahl „B“ und den gemessenen Zahlen geschrieben; Umsetzung
  im selben Zug begonnen (`src/budget.ts`, `src/compaction-guard.ts`).
## 6. Änderungsverlauf

- 2026-10-31 Draft 1: aus der Wahl „B“ und den gemessenen Zahlen geschrieben; Umsetzung
  im selben Zug begonnen (`src/budget.ts`, `src/compaction-guard.ts`).
- 2026-10-31 gebaut als `0.2.1-trunk.26` (Commit 8b9261b auf
  `feature/compaction-grenze`, gemergt mit `--no-ff` als 88c1849, Tag
  `v0.2.1-trunk.26`, Release mit Tarball). 189 Tests grün, davon 17 neu
  (`test/budget.test.mjs` 9, `test/compaction-guard.test.mjs` 8). Im Profil `web`
  installiert; die Sichtprüfung (A2–A4) braucht einen Neustart von `dsh web` und
  steht noch aus.

## 7. Offene Entscheidung des Menschen (nicht gebaut, bewusst)

Die Antwort-Reserve entscheidet, WO im Fenster die Grenze liegt, ohne eine Zeile
Code:

| Reserve (`maxTokens` der Route) | Prompt-Budget im 1M-Fenster | Grenze bei 90 % davon | das sind, in der Fensteranzeige |
|---|---|---|---|
| 256000 (heute) | 739.904 | 665.913 | 66,6 % |
| 65536 | 930.368 | 837.331 | 83,7 % |
| 32768 | 963.136 | 866.822 | 86,7 % |

Mit der heutigen Reserve greift die Grenze also schon bei rund zwei Dritteln der
Anzeige — sicher, aber früher als der Mensch sie erwartet. Die Frage an ihn:
darf eine einzelne Antwort höchstens 32768 oder 65536 Token lang werden? Wenn ja,
wird die Reserve gesenkt und die Grenze wandert auf 84–87 % der Anzeige. Bis zu
seiner Antwort bleibt die Reserve bei 256000; die Grenze ist dann konservativ.
