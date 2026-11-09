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

R6. **Der Befehl an das Modell.** An der Grenze (`boundaryRatio`, Vorgabe 0,9), und nur dort,
    erhält das Modell einen absoluten Befehl zu verdichten. Der Text ist **fest**: keine
    Prozentzahl, keine Ankerliste, keine Schnitt-Tabelle, byte-gleich bei jedem Schritt. Er
    sagt, was zu tun ist (`context_compact_plan` einmal, dann `context_compact` mit dem
    größten erlaubten `turns=N`, als letzte Handlung des Zugs), er sagt, dass er erledigt
    ist, sobald nach ihm eine Verdichtung stattgefunden hat, und er verbietet die zweite
    Verdichtung für ihn. Zwischen `nudgeRatio` und der Grenze sagt das Plugin nichts.
    (Geändert 2026-11-06, siehe Änderungsverlauf; die frühere Fassung nannte die gemessenen
    Zahlen und galt ab `nudgeRatio`.) Die harte Grenze hängt nicht von diesem Text ab.

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

## 8. Nachtrag 2026-11-06: doppelte Verdichtung durch einen veralteten Befehl

Gemessen in Sitzung `a856b862-d0ef-4b53-b12e-a674a3a00c2c` (VST-Dev, deepseek-flash, Fenster
384000, Antwort-Reserve 65536, Prompt-Budget 314368):

- Der Hinweistext trug die aktuelle Prozentzahl, die Ankerliste und die Schnitt-Tabelle. Er
  änderte sich bei jedem Schritt, und DSH speicherte jede Fassung als eigenen Block: **21
  Blöcke zu je rund 12.000 Zeichen** in einer Sitzung, 19 davon Mahnungen zwischen 75 % und
  90 %, 2 davon der absolute Befehl bei 91,4 % und 93,1 %.
- Die Mahnung stand von 13:04 bis 23:32 des 5.11., also über neun Stunden, und das Modell
  verdichtete in dieser Zeit in kleinen Happen von 30.000 bis 63.000 Token, obwohl der
  Mensch Blöcke von mindestens 70.000 angeordnet hat.
- Um 02:04 verdichtete das Modell (63.404 Token frei, Prompt von 256.143 auf 214.999, also
  auf 68 % des Budgets). Der Block von 01:57 lag in der laufenden Runde und wurde von der
  Verdichtung nicht ersetzt (geprüft: weder Nachricht 941 noch 947 steht unter den
  ersetzten Nachrichten). Er behauptete weiter „81,1 %". Das Modell glaubte ihm und
  verdichtete um 02:09 ein zweites Mal (50.763 Token), nach einem Fehlversuch mit
  `turns=1` gegen die Arbeitsfenster-Regel.

Entscheidung des Menschen, 2026-11-06, auf den Vorschlag „Mahnung weg, Befehl fest und ohne
Zahlen, Wächter verdichtet selbst, nur einmal je Überschreitung": *„gut so"*.

Gebaut in `0.2.1-trunk.28`: `boundaryCommandText()` ohne Parameter und ohne Ziffer
(`test/nudge-ruhe.test.mjs`); `volume-nudge` liefert nur noch bei `verdict.kind ===
'compact'` Text; `nudgeRatio` bleibt als Schlüssel bestehen, sendet aber nichts mehr.

## 9. Nachtrag 2026-11-09: die Zwangs-Verdichtung scheitert still und wiederholt sich

### 9.1 Anordnung des Menschen (seine Worte)

- 2026-11-09, ~21:40: *„Eben ist es leider Gottes passiert, dass eine Session mehrfach
  hintereinander Compaction halt verschoben hat. Immer weiter, bis sie bei 92% gelandet war
  […] Und das ist vom Ding her auch in Ordnung, aber es muss halt eine harte Grenze geben.
  Das heißt, bei 90% gibt es eine Zwangs-Compaction. Da kann, da wird dann quasi das
  originale Tool aufgerufen und es wird einfach hart compacted lossy. So, immer. Weil das
  muss sein, um die Session zu retten."*
- 2026-11-09, ~21:55, zur Sitzung `a856b862-d0ef-4b53-b12e-a674a3a00c2c`: *„Zugegebenermaßen,
  als ich sie unterbrochen hatte, war es halt 92% und sie hing da aber schon für Ewigkeiten.
  […] Aber ja, 90 ist zu viel. 85. Weil wenn dann da irgendwas, ne, sagen wir mal, das ist ein
  super komplexes Thema und die Compaction danach ist 80.000 lang. So, um quasi 400.000
  sinnvoll zu erhalten. Also, es geht eh nicht mehr als 64.000 auf einmal, aber nachher ist
  sie so lang und es gibt nicht mehr genug Kontext, um die Compaction zu schreiben so und dann
  ist die Session gebricht quasi. Man müsste dann Rollback machen so und das ist mal richtig
  painful hier in DSH. Es gibt kein richtiges Tool dafür."*

Daraus: die Grenze liegt bei **85 %** statt 90 % (`boundaryRatio` 0,85). Worauf sich die 85 %
beziehen (Anfrage-Budget oder Fensteranzeige) und die zweite Stufe sind in 9.4 als offene
Fragen festgehalten, nicht entschieden.

### 9.2 Gemessener Hergang (Sitzung `a856b862-…`, VST-Dev, Route `pcserve/swift-1.5-iq2_xs`)

Alle Zeiten Ortszeit (Log in UTC, +1 Stunde). Quelle: das entpackte Sitzungsprotokoll
`session.v4.jsonl.zstd`, Ereignisse `assistant/message` (`usage.totalTokens`),
`compaction/start`, `compaction/end`, `request/header`, `request/context`.

1. Fenster 512.000 (`request/context`, seq 1567), Antwort-Reserve 65.536 (`request/header`,
   `maxTokens`), `safetyTokens` 4.096 → Prompt-Budget 442.368; Grenze bei 0,9 = 398.131.
   (MESSUNG, Rechnung aus den Kopfzahlen der Sitzung.)
2. Ab 20:24 (Zug 105, Schritt 1) liegt der Prompt bei 447.352 Token, also **über dem Budget**
   (101 %). Von da an steht `wouldOverflow` auf wahr: der Guard darf (Lage 3a) in **jedem**
   Schritt verdichten und setzt dabei die Sperre `spent` **nicht**.
3. Von 20:24 bis 21:29 begann der Guard **19 Verdichtungen**, **16 scheiterten** mit „surface
   replace: node 0 holds the system prompt …" (die Sperre `compaction-guard-head` des Profils
   verweigert sie, bevor etwas geschrieben wird), **3 endeten mit „Request was aborted"**
   (Züge 105, 106 und 107; die beiden letzten beginnen eine Sekunde nach dem Zugstart; dass der
   Mensch sie abgebrochen hat, ist eine SCHÄTZUNG, das Protokoll nennt den Grund nicht).
   Jeder Versuch dauerte zwei bis sechs Minuten, die Gesamtzeit beträgt rund eine Stunde. Der Prompt wuchs in
   dieser Zeit von 447.352 auf 490.008 Token (Anzeige: 92 % bis 96 % des Fensters).
4. Eine erfolgreiche Verdichtung fand erst um 21:33:57 statt, und zwar durch den **Aufruf des
   Modells** (`context_compact` mit `turns=6`, `keep_turns=1`), nicht durch den Guard. Danach lag
   der Prompt bei 85.934 Token. Auch die früheren Fehlschläge (15:53, 19:21 Zug 104) tragen
   dieselbe Meldung.
5. Die 92 %, die du gesehen hast, sind 471.377 ÷ 512.000 = 92,1 % des Fensters, gegen das
   Anfrage-Budget aber 106,6 %. (MESSUNG.)

### 9.3 Ursache (gelesen im Quelltext, `src/index.ts`, `src/compaction-guard.ts`)

1. Der Guard plant seinen Schnitt in `cutOf` (index.ts Z. 470) mit `planRows` und nimmt den
   Anfang der ersten Zeile unverändert. Das Werkzeug `context_compact` ruft vor demselben
   Schnitt `offSystemHead` auf (index.ts Z. 766, seit trunk.27), der Guard **nicht**. Beginnt
   die erste Zeile der Turn-Tabelle auf dem Systemprompt, lehnt die Sperre den Schnitt ab.
2. `forceCompact` (compaction-guard.ts Z. 78 bis 115) fängt den Fehler von `compactCut` im
   äußeren `catch` ab und gibt `false` zurück. Die Rettung des Kerns (`compactEmergency`) wird
   nur versucht, wenn `planCut` gar keinen Schnitt liefert oder `compactCut` `null` meldet,
   **nie nach einem geworfenen Fehler**.
3. Lage 3a (Überlauf) wiederholt sich deshalb in jedem Schritt, ohne Sperre und ohne
   Rückzug; jeder Versuch lässt das Modell zwei bis sechs Minuten einen Zusammenfassungstext
   schreiben, der danach verworfen wird.

Nicht geprüft (SCHÄTZUNG): dass `compactEmergency` an dieser Stelle gelungen wäre. Es wählt
seinen Bereich selbst und hat eigene Regeln; erst ein Lauf zeigt es.

### 9.4 Offene Fragen an den Menschen (vor dem Bau zu klären)

1. Bezugsgröße der 85 %: Anfrage-Budget (wie heute; in dieser Sitzung 376.013 Token, in der
   Fensteranzeige 73,4 %) oder Fensteranzeige (435.200 Token, im Budget 98,4 %).
2. Zweite Stufe („immer, hart, lossy"): darf sie auch dann verdichten, wenn die Sperre `spent`
   für diese Überschreitung schon gesetzt ist, und darf sie das Arbeitsfenster (`keepTurns`)
   opfern, wenn sonst nichts mehr geht?
3. Anzahl und Rhythmus: nach einem fehlgeschlagenen Versuch soll der Guard nicht in jedem
   Schritt neu anfangen. Vorschlag: höchstens ein Versuch je Zug und je Stufe.

Der Bau beginnt nach der Antwort. Dann gehören dazu: `offSystemHead` im Guard, Übergang zur
Rettung nach einem geworfenen Fehler, Rückzugsregel für wiederholte Fehlschläge,
`boundaryRatio` 0,85, Tests in `test/compaction-guard.test.mjs`.

