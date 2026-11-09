// @tmielsch/rolling-compaction: turn-basierte Schnitt-Planung.
//
// Das gemessene Problem (Anordnung des Menschen 2026-10-30): Ein Modell, das
// "kompaktiere aggressiv, mindestens 300.000 Token" verlangt, bekommt 10.000
// Token zurück — und behauptet dann, 300.000 gespart zu haben. Der Grund ist
// nicht das Werkzeug, sondern die Messbarkeit: Die Oberfläche listet Meldungen,
// aber die Token-Distanz zwischen zwei Anker-Markern steht an keiner Stelle,
// die das Modell lesen kann. Es rät also und greift den letzten kleinen Brocken.
//
// Die Antwort ist eine Zählung nach Zügen (Turns), nicht nach Einzelankern:
//  - jeder Zug ist eine abgeschlossene Arbeitseinheit;
//  - die letzten N Züge sind das Arbeitsgedächtnis, das ein Checkpoint nicht
//    anfassen darf;
//  - alles davor ist Kandidat, und jede Zeile nennt die Token, die frei werden,
//    und den Preis des Schnitts.
//
// Alles hier ist eine reine Funktion von Daten (Log-Ereignisse, Surface-Knoten,
// Token-Größen), ohne ctx und ohne I/O, damit es ohne laufenden Cordis-Kern
// geprüft werden kann (siehe test/turns.test.mjs).

import { markerTag } from './anchor.js'

/** Minimal log event shape (see dsh-session: `turn/start`, `turn/end`). */
export interface TurnLogEvent {
  seq: number
  type?: string
  data?: unknown
}

/** Minimal surface node shape (the real one is a session surface event). */
export interface TurnSurfaceNode {
  seq: number
  type: string
}

/** One turn group: the nodes a single model turn produced. */
export interface TurnGroup {
  /** the turn number recorded by `turn/start` / `turn/end` */
  turn: number
  firstSeq: number
  lastSeq: number
  /** surface positions of the group's nodes, in order */
  positions: number[]
  /** token size of each node at the matching position, same order as `positions` */
  nodeTokens: number[]
  tokens: number
  nodes: number
  /** true when `turn/end` is recorded for this turn; false while it is running */
  finished: boolean
}

/** The whole turn table of one session surface. */
export interface TurnTable {
  /** everything before the first `turn/start` (system head, opening, early checkpoints) */
  prefix: { firstSeq: number; lastSeq: number; tokens: number; nodes: number } | null
  turns: TurnGroup[]
  totalSurfaceTokens: number
}

/**
 * Pair every `turn/start` with its `turn/end`, keyed by the turn number.
 * A turn that has started and not ended yet is present with `endSeq = null`.
 */
export function turnBoundaries(logEvents: readonly TurnLogEvent[]): Map<number, { startSeq: number; endSeq: number | null }> {
  const out = new Map<number, { startSeq: number; endSeq: number | null }>()
  for (const ev of logEvents) {
    if (typeof ev.seq !== 'number') continue
    const turn = (ev.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn !== 'number') continue
    if (ev.type === 'turn/start') out.set(turn, { startSeq: ev.seq, endSeq: null })
    else if (ev.type === 'turn/end') {
      const rec = out.get(turn)
      if (rec) rec.endSeq = ev.seq
      else out.set(turn, { startSeq: -1, endSeq: ev.seq })
    }
  }
  return out
}

/**
 * Group the surface nodes by the turn that produced them.
 *
 * A node belongs to a turn when it sits after that turn's `turn/start` and at
 * or before its `turn/end`. Turns are sequential and never overlap, so the
 * first matching turn in start order owns the node. Nodes before the first
 * `turn/start` are the prefix; nodes after the last recorded `turn/end` belong
 * to the running turn and are marked unfinished, so no plan cuts through a step
 * that is still open.
 */
export function buildTurnTable(
  logEvents: readonly TurnLogEvent[],
  surfaceNodes: readonly TurnSurfaceNode[],
  tokensBySeq: Map<number, number>,
): TurnTable {
  const boundaries = turnBoundaries(logEvents)
  const ordered = [...boundaries.entries()]
    .filter(([, b]) => b.startSeq >= 0)
    .sort((a, b) => a[1].startSeq - b[1].startSeq)

  const groups: TurnGroup[] = ordered.map(([turn, b]) => ({
    turn,
    firstSeq: -1,
    lastSeq: -1,
    positions: [],
    nodeTokens: [],
    tokens: 0,
    nodes: 0,
    finished: b.endSeq !== null,
  }))

  // Der Systemkopf (führende `system/message`-Knoten) gehört nie zu einem Zug, gleich wo
  // `turn/start` im Log steht. Gemessen in Sitzung 0b9ffeb1 (2026-11-09): `turn/start` von Zug 1
  // stand bei seq 6, der Systemprompt bei seq 9; der Kopf (~76.000 Token) zählte damit zu Zug 1,
  // der Plan bot ihn als freigebbar an (`frees ~67257`), die Engine maß 1857.
  let headNodes = 0
  while (headNodes < surfaceNodes.length && surfaceNodes[headNodes].type === 'system/message') headNodes++

  let prefixTokens = 0
  let prefixNodes = 0
  let prefixFirst = -1
  let prefixLast = -1
  let total = 0

  for (let i = 0; i < surfaceNodes.length; i++) {
    const n = surfaceNodes[i]
    const size = tokensBySeq.get(n.seq) ?? 0
    total += size
    let g: TurnGroup | null = null
    for (let t = 0; i >= headNodes && t < ordered.length; t++) {
      const b = ordered[t][1]
      if (n.seq > b.startSeq && (b.endSeq === null || n.seq <= b.endSeq)) {
        g = groups[t]
        break
      }
    }
    if (!g) {
      prefixNodes++
      prefixTokens += size
      if (prefixFirst < 0) prefixFirst = n.seq
      prefixLast = n.seq
      continue
    }
    g.positions.push(i)
    g.nodeTokens.push(size)
    g.tokens += size
    g.nodes++
    if (g.firstSeq < 0) g.firstSeq = n.seq
    g.lastSeq = n.seq
  }

  return {
    prefix: prefixNodes > 0 ? { firstSeq: prefixFirst, lastSeq: prefixLast, tokens: prefixTokens, nodes: prefixNodes } : null,
    turns: groups.filter((g) => g.nodes > 0),
    totalSurfaceTokens: total,
  }
}

/** Tokens of every surface node after position `pos` — the re-read price of a cut there. */
export function tailTokensAfter(table: TurnTable, pos: number): number {
  let sum = 0
  for (const g of table.turns) {
    for (let i = 0; i < g.positions.length; i++) {
      if (g.positions[i] > pos) sum += g.nodeTokens[i]
    }
  }
  return sum
}

/** One candidate cut: compact `k` finished turns in one checkpoint. */
export interface TurnCutRow {
  /** how many finished turns the row covers */
  k: number
  startSeq: number
  endSeq: number
  /** marker ids to copy into startAnchor / endAnchor */
  startMarker: string
  endMarker: string
  /** tokens the span holds — what a compaction of it frees */
  grossTokens: number
  /** tokens re-read after the cut (everything behind `endSeq`) */
  priceTokens: number
  nodes: number
}

/**
 * Rows for turn-based cuts, largest first.
 *
 * @param table - the turn table of the session.
 * @param keepTurns - how many newest finished turns must stay untouched (the working memory).
 * @param maxRows - how many rows to list.
 */
export function planRows(table: TurnTable, keepTurns: number, maxRows = 6): TurnCutRow[] {
  const finished = table.turns.filter((g) => g.finished)
  if (!finished.length) return []
  // The newest `keepTurns` finished turns are the working memory: a row may not
  // reach into them. The deepest allowed row therefore covers everything up to
  // the turn that is `keepTurns` from the end.
  const usable = finished.slice(0, Math.max(0, finished.length - Math.max(0, keepTurns)))
  if (!usable.length) return []
  const rows: TurnCutRow[] = []
  for (let k = usable.length; k >= 1 && rows.length < maxRows; k--) {
    const span = usable.slice(usable.length - k)
    const first = span[0]
    const last = span[span.length - 1]
    let gross = 0
    let nodes = 0
    for (const g of span) {
      gross += g.tokens
      nodes += g.nodes
    }
    const lastPos = last.positions[last.positions.length - 1]
    rows.push({
      k,
      startSeq: first.firstSeq,
      endSeq: last.lastSeq,
      startMarker: markerTag(first.firstSeq),
      endMarker: markerTag(last.lastSeq),
      grossTokens: gross,
      priceTokens: tailTokensAfter(table, lastPos),
      nodes,
    })
  }
  return rows
}

/**
 * Shrink a turn-row cut so it never starts on the system head.
 *
 * Die Turn-Tabelle beginnt eine Spanne am ersten Knoten des ersten Zuges. Sitzt
 * dieser Knoten auf dem Systemkopf (surface node 0 traegt den Systemprompt), lehnt
 * der Kern den Schnitt ab — und die bereits geschriebene `compaction/summary`
 * macht den Log beim naechsten Start unladbar (gemessen 2026-10-31:
 * "compaction cannot shadow the protected system head").
 *
 * Der Anker-Weg (`resolveBoundaries` in ./boundary.ts) nimmt den Kopf seit jeher
 * aus; der Massenschnitt tat es nicht. Diese Funktion schliesst die Luecke an
 * einer Stelle, die ohne laufenden Kern pruefbar ist.
 *
 * @param startPos - Oberflaechen-Position, an der die Spanne beginnen soll.
 * @param endPos - Oberflaechen-Position, an der sie enden soll (inklusive).
 * @param headCount - Anzahl der `system/message`-Knoten am Kopf (`systemHeadCount`).
 * @returns die verschobene Startposition; sie liegt nie auf dem Kopf.
 * @throws RangeError wenn nach dem Verschieben keine Spanne mehr uebrig bleibt.
 */
export function offSystemHead(startPos: number, endPos: number, headCount: number): number {
  if (headCount <= 0) return startPos
  const shifted = Math.max(startPos, headCount)
  if (shifted > endPos) {
    throw new RangeError(
      'span ' + startPos + '..' + endPos + ' lies entirely on the system head (' +
      headCount + ' node(s)); nothing is left to compress after it',
    )
  }
  return shifted
}

/**
 * Was ein kleineres Arbeitsfenster freigeben würde — als Satz für den Plan, oder null.
 *
 * Der Plan zeigt nur Zeilen, die das Arbeitsfenster (`keepTurns`) respektieren. Ist keine Zeile
 * erlaubt oder erreicht die größte `minFreed` nicht, sucht diese Funktion das größte
 * Arbeitsfenster unterhalb des gewählten, bei dem eine Zeile `minFreed` erreicht (ohne `minFreed`:
 * irgendeine Zeile mit Inhalt). Sie ändert das Fenster nicht; die Wahl bleibt beim Modell.
 *
 * @param table - die Turn-Tabelle der Sitzung.
 * @param keepTurns - das gewählte Arbeitsfenster.
 * @param minFreed - gewünschte Mindestfreigabe in Token, falls genannt.
 * @returns der Hinweis, oder null, wenn kein kleineres Fenster etwas bringt oder nichts fehlt.
 */
export function keepTurnsHint(table: TurnTable, keepTurns: number, minFreed?: number): string | null {
  const want = minFreed && minFreed > 0 ? minFreed : 1
  const best = planRows(table, keepTurns, 1)[0]
  if (best && best.grossTokens >= want) return null
  for (let k = Math.max(0, Math.floor(keepTurns) - 1); k >= 0; k--) {
    const row = planRows(table, k, 1)[0]
    if (row && row.grossTokens >= want) {
      return 'With the working-memory window kept at ' + keepTurns + ' turn(s) the largest cut frees only ~' + (best ? best.grossTokens : 0) +
        ' tokens. keep_turns=' + k + ' would offer turns=' + row.k + ' freeing ~' + row.grossTokens +
        ' tokens, at the price of the ' + (keepTurns - k) + ' newest finished turn(s) of working memory. Pass keep_turns=' + k +
        ' to context_compact_plan to see that row; the window is your decision, the plugin does not lower it by itself.'
    }
  }
  return null
}

/** The single row for exactly `k` finished turns, or null when it is not allowed. */
export function turnCutRow(table: TurnTable, k: number, keepTurns: number): TurnCutRow | null {
  const rows = planRows(table, keepTurns, 1000)
  return rows.find((r) => r.k === k) ?? null
}

/** Render the rows as the model sees them (one line per candidate). */
export function turnTableText(table: TurnTable, keepTurns: number, minFreed?: number): string {
  const rows = planRows(table, keepTurns, 6)
  const head =
    'Surface: ' + table.totalSurfaceTokens + ' tokens. Finished turns: ' +
    table.turns.filter((g) => g.finished).length + '. The newest ' + keepTurns +
    ' finished turns are your working memory and stay untouched.'
  if (!rows.length) {
    return head + '\nNothing is safe to compact yet: every finished turn is inside the working-memory window. Keep working; compact when a longer stretch has closed.'
  }
  const lines = rows.map((r) =>
    'compact turns -' + r.k + ': ' + r.startMarker + ' .. ' + r.endMarker +
    ' | frees ~' + r.grossTokens + ' tokens (' + r.nodes + ' nodes)' +
    ' | cut price ~' + r.priceTokens + ' tokens' +
    (minFreed && r.grossTokens < minFreed ? ' | BELOW the requested minimum' : ''),
  )
  return head + '\n' + lines.join('\n')
}
