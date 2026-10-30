// Phasenregel (2026-10-30, Entscheidungen des Menschen):
//
// 1. Verdichtet wird nur am Ende einer abgeschlossenen Phase, die ganze Phase in
//    einem Checkpoint, als letzte Handlung des Zugs, nie als Antwort auf eine
//    Nachricht des Menschen. Diese Regel steht im Werkzeugtext und im
//    Systemprompt. Der Phasenhinweis ist am 30.10.2026 entfernt worden
//    (Anordnung des Menschen, wörtlich: „der phasenhinweis muss raus“), weil er
//    das Modell zum Verdichten triez — der Belegfall der drei Verdichtungen in
//    Folge.
// 2. Lossless ist Pflicht (Anordnung des Menschen vom 30.10.2026, wörtlich:
//    „Lossless ist Pflicht. Auch kleine Details sind nachher wichtig und dürfen
//    nicht verloren gehen“). Die frühere Größenregel — der Checkpoint dürfe höchstens
//    ein Fünftel des ersetzten Abschnitts füllen — ist verworfen: sie steht im
//    Widerspruch zu Lossless und zum Schutz des Kerns
//    (`dsh-compaction-basic` Zeile 601: die Zusammenfassung darf nicht kleiner
//    sein als der verdeckte Inhalt).
// 3. Die einzige Auslöser-Meldung, die bleibt, ist die harte Obergrenze: wird der
//    Kontext zu groß, wird trotzdem verdichtet, auch ohne abgeschlossene Phase.
//
// Die Aufgabenliste lebt in der Projektion `todos` (dsh-tool-todo): ein Array aus
// { content, status } oder null, bei jedem `turn/start` zurückgesetzt.
// `phaseComplete` bleibt als reine Hilfsfunktion für die Regel 1; der Hinweis
// feuert nicht mehr.

export interface TodoItemLike {
  content?: unknown
  status?: unknown
}

/** Wahr, wenn eine Aufgabenliste existiert, nicht leer ist und jeder Punkt `completed` ist. */
export function phaseComplete(todos: unknown): boolean {
  if (!Array.isArray(todos) || todos.length === 0) return false
  return (todos as TodoItemLike[]).every((t) => !!t && t.status === 'completed')
}

/** Anzahl der Punkte und der abgeschlossenen Punkte. */
export function phaseCounts(todos: unknown): { total: number; completed: number } {
  if (!Array.isArray(todos)) return { total: 0, completed: 0 }
  const list = todos as TodoItemLike[]
  return { total: list.length, completed: list.filter((t) => !!t && t.status === 'completed').length }
}

/**
 * Entscheidet, ob der Hinweis erscheint. Der Phasenhinweis ist entfernt; es gibt
 * nur die harte Obergrenze.
 *  - 'limit': Belegung erreicht die Obergrenze, unabhängig von der Liste.
 *  - null: kein Hinweis. Obergrenze 0 oder kleiner schaltet sie ab.
 */
export type NudgeMode = 'limit' | null

export function nudgeMode(occupancyTokens: number, hardLimitTokens: number): NudgeMode {
  return hardLimitTokens > 0 && occupancyTokens >= hardLimitTokens ? 'limit' : null
}

/**
 * Der Zwischenfazit-Block als Teil des Checkpoints (Anordnung des Menschen vom
 * 30.10.2026): Der Checkpoint ist der scrollbare Block im Chat, nicht ein
 * verborgenes Artefakt. Er beginnt mit einer Überschrift, die der Mensch beim
 * Durchscrollen sofort erkennt, und steht am Ende des Zugs.
 *
 * Lossless ist Pflicht: Der Checkpoint trägt jedes Detail, das nachher gebraucht
 * wird, auch die kleinen. Der Zwischenfazit-Block oben ist kurz (Stand,
 * Entscheidung, nächste Handgriffe), die technischen Abschnitte darunter sind
 * vollständig.
 */
export function zwischenfazitText(): string {
  return (
    'The checkpoint is the human\'s scrollable marker, not a hidden artifact: it opens with a ' +
    'real Markdown H1 heading `# 📌 ZWISCHENFAZIT — <three words naming what this phase was about>`, ' +
    'then the sections below. Never a code block (a code block renders monospace and does not stand out ' +
    'while scrolling), never a heading smaller than H1, and the word ZWISCHENFAZIT always spelled ' +
    'identically so the human can search for it. The heading carries the theme, so the block is readable ' +
    'without opening it. Under the heading, the first lines are the standing, the decision, and the ' +
    'handgrips that come next in the order the human performs them — a checkpoint that only reports is ' +
    'noise. Keep that top block short; the technical sections below it are complete. ' +
    'Lossless is mandatory: the checkpoint must carry every detail that will be needed afterwards, small ' +
    'details included — exact paths, commands, IDs, names, numbers, the human\'s decisions and wording. ' +
    'There is no size cap on the checkpoint: a checkpoint that drops a detail to stay small is a failed ' +
    'compaction. Nothing that served the work may be lost by the compaction. The archive behind ' +
    'context_recall is the safety net for the raw span, never for a detail the checkpoint dropped.'
  )
}

/** Der Hinweis an der harten Obergrenze: kein Phasenende, aber der Kontext ist zu groß. */
export function limitNudgeText(occupancyTokens: number): string {
  const approxK = Math.round(occupancyTokens / 1000)
  return (
    '`context_compact` — size limit: the context holds roughly ' + approxK + 'k tokens, above the hard limit of this profile. ' +
    'A compaction is allowed now even without a finished todo list, under these conditions: ' +
    '(1) it is the LAST action of this turn, after you have answered the human — never a reply to a message of the human; ' +
    '(2) take the largest finished stretch at the BACK end of the surface in one checkpoint, not many small ones; ' +
    '(3) ' + zwischenfazitText() + ' ' +
    '(4) the price of a cut is listed per marker below — prefer the cheapest cut that frees enough.'
  )
}
