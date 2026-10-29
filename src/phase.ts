// Phasenregel (2026-10-30, Entscheidung des Menschen): Verdichtet wird nur am
// Ende einer abgeschlossenen Phase, und dann die ganze Phase auf einmal.
// Eine Phase endet, wenn die Aufgabenliste des laufenden Zugs vollständig
// abgearbeitet ist. Ein einzelner abgeschlossener Handgriff ist kein Phasenende.
//
// Die Aufgabenliste lebt in der Projektion `todos` (dsh-tool-todo): ein Array
// aus { content, status } oder null, und sie wird bei jedem `turn/start`
// zurückgesetzt. Das Phasenende ist damit ein Ereignis innerhalb eines Zugs und
// kein Dauerzustand: Mit dem nächsten Nachricht des Menschen verschwindet es.

export interface TodoItemLike {
  content?: unknown
  status?: unknown
}

/** Wahr, wenn eine Aufgabenliste existiert, nicht leer ist und jeder Punkt `completed` ist. */
export function phaseComplete(todos: unknown): boolean {
  if (!Array.isArray(todos) || todos.length === 0) return false
  return (todos as TodoItemLike[]).every((t) => !!t && t.status === 'completed')
}

/** Anzahl der Punkte und der abgeschlossenen Punkte, für die Meldung an das Modell. */
export function phaseCounts(todos: unknown): { total: number; completed: number } {
  if (!Array.isArray(todos)) return { total: 0, completed: 0 }
  const list = todos as TodoItemLike[]
  return { total: list.length, completed: list.filter((t) => !!t && t.status === 'completed').length }
}

/**
 * Entscheidet, ob und in welcher Form der Hinweis erscheint.
 *  - 'phase': genug Wachstum seit dem letzten Checkpoint UND Phasenende.
 *  - 'limit': harte Obergrenze der Belegung erreicht, unabhängig von der Liste.
 *  - null: kein Hinweis. Schwellenwert 0 oder kleiner schaltet 'phase' ab,
 *    Obergrenze 0 oder kleiner schaltet 'limit' ab.
 */
export type NudgeMode = 'phase' | 'limit' | null

export function nudgeMode(grownTokens: number, thresholdTokens: number, occupancyTokens: number, hardLimitTokens: number, todos: unknown): NudgeMode {
  if (hardLimitTokens > 0 && occupancyTokens >= hardLimitTokens) return 'limit'
  if (!(thresholdTokens > 0)) return null
  if (!(grownTokens >= thresholdTokens)) return null
  return phaseComplete(todos) ? 'phase' : null
}

/** Der Hinweis selbst. Englisch, weil er an das Modell geht; ohne Ankerliste. */
export function phaseNudgeText(grownTokens: number, todos: unknown): string {
  const approxK = Math.round(grownTokens / 1000)
  const { total } = phaseCounts(todos)
  return (
    '`context_compact` — phase end: the todo list of this turn is complete (' + total + ' of ' + total + ' items done) and the surface has grown by roughly ' + approxK +
    'k tokens since the last compaction. A compaction is allowed now, under these conditions only: ' +
    '(1) it is the LAST action of this turn, after you have answered the human — never a reply to a message of the human; ' +
    '(2) it replaces the WHOLE finished phase in one checkpoint, never a single step or a few tool calls; ' +
    '(3) the checkpoint must stay clearly smaller than the span it replaces — about one fifth or less; if you cannot reach that, do not compact; ' +
    '(4) cut at the end, not in the middle: the price of a cut is the number of tokens after the cut that must be read again (listed per marker below), and the stage boundary should sit at a 16384-token grid edge. ' +
    'Write the checkpoint for the next similar task: keep measured pitfalls, exact paths/commands/IDs, numbers, rejected approaches with the reason, and the human\'s decisions.'
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
    '(3) the checkpoint must stay clearly smaller than the span it replaces; ' +
    '(4) the price of a cut is listed per marker below — prefer the cheapest cut that frees enough.'
  )
}
