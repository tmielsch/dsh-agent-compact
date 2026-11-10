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

### 9.4 Antworten des Menschen (2026-11-09, ~22:05) und Stand

Antwort auf die drei Fragen, wörtlich: *„90% vom gesamtbudget. 2. Ja 3 ja einen"*

1. **Bezugsgröße: ungeklärt.** Der Satz „90% vom gesamtbudget" nennt 90 %, während der Mensch
   kurz davor „90 ist zu viel. 85." gesagt hat; und „Gesamtbudget" kann das Anfrage-Budget
   (Fenster minus Antwort-Reserve minus Sicherheitsabstand, so rechnet der Wächter heute) oder
   das ganze Fenster meinen. Der Wächter bleibt deshalb bei den heutigen Werten
   (`boundaryRatio` 0,9 vom Anfrage-Budget). Rückfrage an den Menschen steht offen (9.5).
2. **Zweite Stufe: ja.** Sie verdichtet auch dann, wenn die Sperre `spent` für diese
   Überschreitung schon gesetzt ist, und sie darf das Arbeitsfenster opfern (Rettung des Kerns,
   `compactIfNeeded` mit Trigger `context-overflow`, kennt kein `keepTurns`).
3. **Versuche: einen.** Je Zug und Stufe höchstens ein Versuch.

### 9.5 Gebaut (Version `0.2.1-trunk.30`, Commit 317ee17, Release veröffentlicht, im Profil `web` installiert; Neustart von `dsh web` am 2026-11-09 gegen 22:45)

- `offSystemHead` im Wächter (`src/index.ts`, `cutOf`): der Kopf wird aus der Spanne genommen,
  Zeilen, die danach leer wären, werden übersprungen. Das ist die Ursache aus 9.3 Punkt 1.
- Zwei Stufen in `forceCompact` (`src/compaction-guard.ts`): erst der turn-basierte Schnitt,
  danach — auch nach einem **geworfenen Fehler** — die Rettung des Kerns. Je Zug und Stufe ein
  Versuch; nach einer Verdichtung, die die Belegung unter die Grenze bringt, zählen die Versuche
  von vorn; bleibt die Belegung darüber, eskaliert der nächste Schritt zur harten Stufe.
- Die Sperre „einmal je Überschreitung" (Entscheidung 2026-11-06) sperrt nur noch die erste
  Stufe; die harte Stufe läuft auch nach gesetzter Sperre (Punkt 2).
- Tests: `test/harte-stufe.test.mjs` (7 neu), `test/einmal-je-ueberschreitung.test.mjs` angepasst
  (die Meldung „not again“ heißt jetzt „hard stage“). 213 Tests grün (`npm run build`, dann
  `node --test test/*.test.mjs`). Das ist eine MESSUNG an Nachbildungen des Harness; ein Lauf in
  einer echten Sitzung (A2 bis A4) steht aus.

Offene Frage 9.5: Welche Zahl und welche Bezugsgröße gilt für die Grenze? Optionen: (a) 0,85 vom
Anfrage-Budget, (b) 0,90 vom Anfrage-Budget (heute), (c) 0,90 vom ganzen Fenster, (d) zwei
Stufen: 0,85 für die normale Verdichtung und 0,90 für die harte Stufe.

### 9.6 Entscheidung des Menschen zur Grenze (2026-11-09, ~22:15)

Auf die Frage nach Zahl und Bezugsgröße (Möglichkeiten a bis d): *„dann a)“*. Das ist **85 %
vom Anfrage-Budget** (Fenster minus Antwort-Reserve minus Sicherheitsabstand). Gebaut:
`boundaryRatio` 0,85 als Vorgabe in `src/index.ts` (Schema und Rückfallwert), `src/budget.ts`
(`clampRatio`) und `README.md`. Die Grenze der Sitzung a856b862 läge damit bei 376.012 Token
(floor von 0,85 mal 442.368; MESSUNG im Test `test/budget.test.mjs`, letzter Test). Der
Befehl an das Modell (R6) erscheint ebenfalls bei 85 %, denn er hängt an derselben Grenze.
`nudgeRatio` (0,75) sendet weiterhin nichts.

### 9.7 Stand der Abnahme (2026-11-09, ~22:50)

- Gemessen: Release `v0.2.1-trunk.30` im Repo `tmielsch/dsh-agent-compact`, Paket SHA-256
  `397d2f74b2de1ea74a7248c47655f2e7a8935841f34fca7362c340ba34988a77`; installiert in
  `~/.dsh/profiles/web/node_modules/@tmielsch/rolling-compaction` (Version `0.2.1-trunk.30`, 0,85 in
  `lib/budget.js`, harte Stufe in `lib/compaction-guard.js`); 214 Tests grün. `dsh web` wurde vom
  Menschen neu gestartet.
- Ausstehend (A2 bis A4 aus Abschnitt 5): die Sichtprüfung in einer echten Sitzung über der Grenze.
  Erwartung: kein `compaction/end` mit `compaction-guard-head`, im Host-Log die Zeilen
  `compaction guard …` mit `hard stage`, falls die erste Stufe scheitert. Das Ziel der Wächter-Zeilen
  ist noch nicht gefunden (`~/.dsh/logs` enthält sie nicht); bis dahin ist das Sitzungsprotokoll
  (`compaction/start`, `compaction/end`) der Beleg.
- Nicht Teil dieser Spec: Rollen für Facharbeiter (anderes Thema, vom Menschen zurückgestellt).

## 10. Nachtrag 2026-11-10: der Plan zählt den Systemprompt als freigebbar

### 10.1 Anordnung des Menschen

2026-11-10, ~00:14, Meldung aus der Sitzung `0b9ffeb1-4e52-4144-bb21-c87476e6e71e` (Lead-Unteragent,
Route `pcserve/swift-1.5-iq2_xs`): *„The last compaction freed 1857 tokens measured by the engine, not
the 67257 that the plan suggested“*, dazu *„Bitte nachgucken.“* Auf den Vorschlag, die Tabelle an der Quelle
zu korrigieren, den Plan ehrlich zu machen und einen Regressionstest anzulegen: *„ja go“*.

### 10.2 Gemessener Hergang (Sitzungsprotokoll, Ortszeit 22:57 bis 22:59)

1. `context_compact_plan` nannte `turns=2: [aa0cb28] .. [a93a957] | frees ~67257 tokens (3 nodes)`; die
   Oberfläche war 228.113 Token groß. `context_compact` mit `turns=2` meldete `freedTokens: 1857`
   (Engine-Zähler). Die Belegung stand davor bei 218.894 und danach bei 218.992 Token
   (`usage.totalTokens`, Schritt 56 und 57): sie stieg um 98. (MESSUNG)
2. Die erste Plan-Zeile begann bei `seq 9`, der `system/message` auf Oberflächenposition 0
   (273.178 Zeichen im Protokoll, rund 67.000 bis 76.000 Token). In dieser Sitzung steht `turn/start`
   von Zug 1 bei `seq 6`, **vor** dem Systemprompt (`seq 9`). `buildTurnTable` ordnet jeden Knoten dem Zug
   zu, in dessen Bereich er liegt; der Kopf gehörte damit zu Zug 1, und Zug 1 liegt außerhalb des
   Arbeitsfensters.
3. `context_compact` schiebt den Start hinter den Kopf (`offSystemHead`, seit trunk.27). Es blieb die
   Spanne `2393..2209`: der alte Checkpoint (rund 2.000 Token) und zwei Nachrichten von zusammen 298
   Zeichen. Die Zahl im Plan wurde dabei nicht angepasst.
4. Nachgerechnet an der aus dem Protokoll nachgebauten Oberfläche (172 Knoten; SCHÄTZUNG, Token aus
   Zeichen geteilt durch 3,6): Plan heute `turns=2` ≈ 76.000; mit dem Kopf als Präfix bei Arbeitsfenster 3
   nur `turns=1` ≈ 266, bei Arbeitsfenster 1 `turns=3` ≈ 37.800, bei Arbeitsfenster 0 `turns=4` ≈ 204.600.

### 10.3 Anforderungen

R9. **Der Systemkopf ist Präfix.** Führende `system/message`-Knoten der Oberfläche gehören in der
    Turn-Tabelle nie zu einem Zug, gleich wo `turn/start` im Log steht. Sie zählen zur Oberfläche
    (`totalSurfaceTokens`), aber zu keiner Plan-Zeile. Damit rechnen Plan, `turns=N` und der Wächter
    (R3, R4) mit derselben Zahl, die die Engine später misst. `offSystemHead` bleibt als Sicherheitsnetz.

R10. **Der Plan sagt, was das Arbeitsfenster kostet.** Ist keine Zeile erlaubt oder erreicht die größte
    Zeile `min_freed` nicht, nennt der Plan, bei welchem kleineren `keep_turns` was frei würde
    (`turns=N`, Token). Er verändert das Arbeitsfenster nicht selbst; die Wahl bleibt beim Modell und
    beim Menschen (Anordnung 2026-10-30: `keepTurns` 3).

### 10.4 Abnahme

A6. Regressionstest mit der Lage aus `0b9ffeb1`: `turn/start` vor dem Systemkopf, der Kopf ist 76.000
    Token groß; Plan bei Arbeitsfenster 3 darf keine Zeile über 1.000 Token zeigen. Beleg:
    `node --test test/kopf-im-praefix.test.mjs`.
A7. Der Plan nennt in derselben Lage den Weg über ein kleineres `keep_turns` mit Zahl.

### 10.5 Gebaut (Version `0.2.1-trunk.31`, noch nicht veröffentlicht)

- `src/turns.ts`, `buildTurnTable`: führende `system/message`-Knoten sind Präfix und gehören zu keinem Zug (R9).
- `src/turns.ts`, neu `keepTurnsHint`; `src/index.ts`, `context_compact_plan`: der Plan nennt das größte kleinere
  `keep_turns`, bei dem eine Zeile das Verlangte erreicht, mit `turns=N` und Token (R10). Er senkt das Fenster nicht selbst.
- `test/kopf-im-praefix.test.mjs` (7 neu): die Lage aus `0b9ffeb1`. 221 Tests grün.
- An den echten Daten der Sitzung geprüft (Oberfläche aus dem Protokoll nachgebaut, SCHÄTZUNG aus Zeichen): Plan bei
  Arbeitsfenster 3 zeigt nur `turns=1` ≈ 266 Token (vorher `turns=2` ≈ 76.000); der Hinweis nennt `keep_turns=0`
  mit `turns=4` ≈ 204.580.
- Nicht geprüft: das Verhalten des Wächters in einer echten Sitzung mit dieser Lage.

## 11. Nachtrag 2026-11-10: doppelte Verdichtung durch Wächter und Befehl im selben Schritt

### 11.1 Anordnung des Menschen (seine Worte)

2026-11-10, ~03:28, mit Bildschirmfoto der Sitzung `0b9ffeb1-4e52-4144-bb21-c87476e6e71e` (das Modell schreibt
„Der 上下文 ist an der harten Grenze. Ich verkleinere den ältesten abgeschlossenen Turn …“, der Mensch tippt „du hast
schobn“): *„Neues problem. Die grenze scheint zu funktionieren, aber doppelte compaction geht gar nicht“*

### 11.2 Gemessener Hergang (Sitzungsprotokoll, Ortszeit, Route `pcserve/swift-1.5-iq2_xs`)

Fenster 512.000, Antwort-Reserve 65.536, Sicherheit 4.096, Anfrage-Budget 442.368, Grenze bei 0,85 = 376.012.

1. 03:06:23, Zug 18 Schritt 58: `usage.totalTokens` 376.871, also 859 Token über der Grenze. (MESSUNG)
2. 03:06:24 `compaction/start` ohne Werkzeugaufruf davor: der Wächter (Lage 2, mitten im Zug). 03:12:55
   `compaction/end`, also 6 Minuten 31 Sekunden. Prompt danach 300.157 (Schritt 59), 67,9 % des Budgets. (MESSUNG)
3. 03:12:55: der Kontextblock mit dem `ABSOLUTE COMMAND` (`seq 4954`) steht **nach** dem Checkpoint (`seq 4950`,
   `compaction/end` `seq 4951`). Der Block ist nach der Verdichtung angehängt worden. (MESSUNG)
4. 03:19:03 das Modell ruft `context_compact_plan`: 3 fertige Züge, Arbeitsfenster 3, nichts erlaubt; Hinweis
   `keep_turns=2` bringe `turns=1` mit rund 10.806 Token.
5. 03:21:32 das Modell ruft `context_compact` mit `turns=1`, `keep_turns=2`: `freedTokens` 10.806. Das ist die
   **zweite** Verdichtung innerhalb von 15 Minuten, bei 304.297 Token (68,8 % des Budgets, 16 Punkte unter der Grenze).
6. 03:25:04 Schritt 61: das Modell will ein drittes Mal verdichten („I must compact now: the harness says …“). Der
   Mensch bricht ab (`turn/end`, Grund `user`). (MESSUNG)

### 11.3 Ursache (gelesen im Quelltext)

- `dsh-agent-loop/lib/index.js`, `preStep` (Zeilen 902 bis 925): **zuerst** `systemPrompt.assemble`, und dabei ruft das
  Plugin `agent-compact:volume-nudge` auf und liest die Belegung; **danach** der Waterfall `agent/pre-step`, in dem der
  Wächter verdichtet; **danach** werden die Kontextnachrichten an die Oberfläche angehängt. Der Befehl wird also mit
  der Belegung **vor** der Verdichtung berechnet und erst **nach** ihr geschrieben.
- Der Befehlstext (R6) sagt, er sei erledigt, wenn über ihm eine neuere Verdichtung steht. Hier steht der Block aber
  unter dem Checkpoint, wirkt also frisch.
- Der Wächter verdichtet ab dem zweiten Schritt eines Zuges sofort (`compactMidTurn`). Der Befehl erscheint in
  demselben Schritt. Mitten im Zug kommt er damit immer zu spät: jede Überschreitung der Grenze mitten im Zug löst
  eine Verdichtung durch den Wächter **und** einen Auftrag an das Modell aus. Sinnvoll ist der Befehl nur im ersten
  Schritt eines Zuges, wo der Wächter nicht verdichtet (Anordnung 2026-10-30).

### 11.4 Mögliche Lösungen (nicht entschieden)

- (a) **Der Wächter hat Vorrang.** Der Befehl erscheint nur, wenn der Wächter in diesem Schritt nicht verdichtet:
  im ersten Schritt eines Zuges und nur, wenn die Anfrage nicht ohnehin abgelehnt würde. Mitten im Zug und im
  Überlauf entfällt er.
- (b) Das Modell hat Vorrang: der Wächter verdichtet mitten im Zug nicht (`compactMidTurn` aus). Das widerspricht
  „immer, hart“ (9.1).
- (c) Der Befehl entfällt ganz, nur der Wächter verdichtet. Das ändert R6.

Empfehlung: (a). Es hält die Zwangs-Verdichtung „immer, hart“ (9.1) und lässt R6 dort bestehen, wo er sinnvoll ist.

### 11.5 Abnahme (vorgesehen)

A8. Test: Überschreitung der Grenze mitten im Zug und bei drohender Ablehnung liefert vom Anbieter `volume-nudge`
    keinen Text; im ersten Schritt eines Zuges liefert er ihn. Beleg: `node --test test/…`.
A9. Live: in einer Sitzung, die die Grenze mitten im Zug überschreitet, erscheint genau ein `compaction/start`, und
    kein Block `ABSOLUTE COMMAND` steht nach dem Checkpoint.
