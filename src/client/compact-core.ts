// Compact Chat: pure logic (no React, no DSH imports) so it can be tested offline.
//
// The Compact Chat tab renders DSH's own Chat component over a FILTERED view of the
// Chat snapshot. Per compaction, two display states (a pure UI toggle, the model never
// sees it):
//   - collapsed (default): the original rows of the replaced span are hidden and ONE
//     row (`compact-block`) shows the checkpoint like an ordinary chat message, with a
//     button "Expand original context";
//   - expanded: the originals are shown again; the block row is replaced by a thin bar
//     at the START of the span and a second thin bar (`compact-end`) at its END, each
//     with a "Collapse to checkpoint" button, so the way back is always in reach.
// Which rows belong to a compaction comes from the session log (`startSeq..endSeq` of
// the replace operation), never from guessing by text.

export const BLOCK_KIND = 'compact-block'
export const END_KIND = 'compact-end'

/** One compaction as returned by the `ctxSurface.compactions` remote. */
export interface CompactionLite {
  readonly compactionId: string
  readonly checkpointSeq: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly summaryText: string
}

/** The few fields of a Chat node this logic reads. */
export interface NodeLike {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  /** Optional turn number, read by the default `turnOf` of `computeHiding`. */
  readonly turn?: number
}

/** Synthetic Chat node that renders one compaction block. */
export interface BlockNode extends NodeLike {
  readonly id: string
  readonly target: 'chat'
  readonly location: { readonly kind: 'unresolved' }
  readonly visibility: 'visible'
  readonly data: {
    readonly sessionId: string
    readonly compactionId: string
    readonly summaryText: string
    readonly itemCount: number
    readonly tokens: number
    readonly startSeq: number
    readonly endSeq: number
    /** true: originals are shown, this row is the thin start bar; false: the checkpoint message. */
    readonly open: boolean
    /** 'start' bar / checkpoint block, or 'end' bar. */
    readonly role: 'block' | 'end'
  }
}

/** One root entry of DSH's grouped Chat list. */
export interface EntryLike {
  readonly kind: string
  readonly key: string
  readonly groupPart?: string
}

/** One member reference of a process group. */
export interface MemberLike {
  readonly key: string
}

// Row kinds that belong to a turn as a whole, not to the replaced content. They stay
// visible so the turn's own disclosure and tail keep working.
const KEEP_KINDS = new Set(['turn-process', 'turn-tail', 'turn-error', 'turn-max-tokens', 'turn-trigger', 'system-prompt'])

export function blockKey(compactionId: string): string {
  return `${BLOCK_KIND}:${compactionId}`
}

export function endKey(compactionId: string): string {
  return `${END_KIND}:${compactionId}`
}

/** True for both synthetic row kinds (checkpoint/start bar and end bar). */
export function isBlockKey(key: string): boolean {
  return key.startsWith(BLOCK_KIND + ':') || key.startsWith(END_KIND + ':')
}

export interface Hiding {
  /** Keys of original rows that are hidden (collapsed compactions only). */
  readonly hidden: ReadonlySet<string>
  /** compactionId -> key of the first original row inside its range (where the block goes). */
  readonly firstKey: ReadonlyMap<string, string>
  /** compactionId -> key of the last original row inside its range (where the end bar goes). */
  readonly lastKey: ReadonlyMap<string, string>
  readonly blocks: ReadonlyMap<string, BlockNode>
  /** compactionId -> number of loaded original rows inside its span (0 = span not loaded). */
  readonly rows: ReadonlyMap<string, number>
}

/**
 * Which original rows a compaction replaced, as inclusive seq intervals, and which other
 * compactions enclose it.
 *
 * The replace range of the log (`surfaceOp.startSeq/endSeq`) is NOT reliable: when a
 * compaction swallows an earlier checkpoint, DSH gives replacement positions the seq of
 * their START, and the range can run backwards (measured: 6 of 8 compactions of one real
 * session, e.g. "1853..1822"). The exact list `shadowedSeqs` is reliable. A compaction
 * therefore covers: the span of its own shadowed events (earlier checkpoints excluded)
 * plus, recursively, everything covered by each earlier checkpoint it swallowed.
 */
export function coverageOf(compactions: readonly CompactionLite[]): {
  readonly cover: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>
  readonly enclosing: ReadonlyMap<string, ReadonlySet<string>>
} {
  const byCheckpoint = new Map<number, CompactionLite>()
  for (const c of compactions) byCheckpoint.set(c.checkpointSeq, c)
  const enclosing = new Map<string, Set<string>>()
  for (const c of compactions) enclosing.set(c.compactionId, new Set())
  const walk = (c: CompactionLite, ancestors: readonly string[], seen: Set<string>): Array<readonly [number, number]> => {
    if (seen.has(c.compactionId)) return []
    seen.add(c.compactionId)
    let lo = Infinity
    let hi = -Infinity
    for (const q of c.shadowedSeqs) {
      if (byCheckpoint.has(q)) continue
      if (q < lo) lo = q
      if (q > hi) hi = q
    }
    const out: Array<readonly [number, number]> = lo <= hi ? [[lo, hi]] : []
    for (const q of c.shadowedSeqs) {
      const inner = byCheckpoint.get(q)
      if (!inner || inner === c) continue
      for (const a of [...ancestors, c.compactionId]) enclosing.get(inner.compactionId)?.add(a)
      out.push(...walk(inner, [...ancestors, c.compactionId], seen))
    }
    return out
  }
  const cover = new Map<string, ReadonlyArray<readonly [number, number]>>()
  for (const c of compactions) cover.set(c.compactionId, walk(c, [], new Set()))
  return { cover, enclosing }
}

/**
 * Decide which rows are hidden and where each block goes.
 * A block is only produced when at least one original row of its span is loaded;
 * with no such row there is nothing on screen to replace and no correct place.
 */
export function computeHiding(
  order: readonly string[],
  nodeOf: (key: string) => NodeLike | undefined,
  compactions: readonly CompactionLite[],
  expanded: ReadonlySet<string>,
  sessionId: string,
  /** Turn number of a node (DSH: `node.location.turn.turn`, or `node.data.turn` for turn rows). */
  turnOf: (node: NodeLike) => number | undefined = (node) => node.turn,
): Hiding {
  const hidden = new Set<string>()
  const firstKey = new Map<string, string>()
  const lastKey = new Map<string, string>()
  const blocks = new Map<string, BlockNode>()
  const rows = new Map<string, number>()
  if (compactions.length === 0) return { hidden, firstKey, lastKey, blocks, rows }
  const sorted = [...compactions].sort((a, b) => a.checkpointSeq - b.checkpointSeq)
  const { cover, enclosing } = coverageOf(sorted)
  const covers = (id: string, seq: number): boolean => (cover.get(id) ?? []).some(([lo, hi]) => seq >= lo && seq <= hi)
  for (const key of order) {
    const node = nodeOf(key)
    if (!node || KEEP_KINDS.has(node.kind) || node.kind === BLOCK_KIND || node.kind === END_KIND) continue
    // A row is covered by every compaction whose span includes it (an inner and the outer
    // one that swallowed it). It is hidden while ANY of them is collapsed.
    for (const c of sorted) {
      if (!covers(c.compactionId, node.anchorSeq)) continue
      if (!firstKey.has(c.compactionId)) firstKey.set(c.compactionId, key)
      lastKey.set(c.compactionId, key)
      rows.set(c.compactionId, (rows.get(c.compactionId) ?? 0) + 1)
      if (!expanded.has(c.compactionId)) hidden.add(key)
    }
  }
  // A turn whose whole content is hidden must not leave its header ("Completed in 12s",
  // kind turn-process) or its footer (usage line, kind turn-tail) behind: they would be empty
  // shells. Turns that keep at least one visible row keep both.
  if (hidden.size > 0) {
    const content = new Map<number, { total: number; hiddenCount: number }>()
    const shells: Array<{ key: string; turn: number }> = []
    for (const key of order) {
      const node = nodeOf(key)
      if (!node || node.kind === BLOCK_KIND || node.kind === END_KIND) continue
      const turn = turnOf(node)
      if (turn === undefined) continue
      if (node.kind === 'turn-process' || node.kind === 'turn-tail') { shells.push({ key, turn }); continue }
      if (KEEP_KINDS.has(node.kind)) continue
      const entry = content.get(turn) ?? { total: 0, hiddenCount: 0 }
      entry.total += 1
      if (hidden.has(key)) entry.hiddenCount += 1
      content.set(turn, entry)
    }
    for (const { key, turn } of shells) {
      const entry = content.get(turn)
      if (entry && entry.hiddenCount > 0 && entry.hiddenCount === entry.total) hidden.add(key)
    }
  }
  for (const c of sorted) {
    if (!firstKey.has(c.compactionId)) continue
    // An inner compaction only shows while every compaction that swallowed it is expanded.
    if ([...(enclosing.get(c.compactionId) ?? [])].some((outer) => !expanded.has(outer))) continue
    const open = expanded.has(c.compactionId)
    const make = (key: string, role: 'block' | 'end'): BlockNode => ({
      key,
      kind: role === 'end' ? END_KIND : BLOCK_KIND,
      id: key,
      target: 'chat',
      anchorSeq: c.checkpointSeq,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        sessionId,
        compactionId: c.compactionId,
        summaryText: c.summaryText,
        itemCount: c.shadowedSeqs.length,
        tokens: c.shadowedTokenCount,
        startSeq: c.startSeq,
        endSeq: c.endSeq,
        open,
        role,
      },
    })
    blocks.set(blockKey(c.compactionId), make(blockKey(c.compactionId), 'block'))
    if (open) blocks.set(endKey(c.compactionId), make(endKey(c.compactionId), 'end'))
  }
  return { hidden, firstKey, lastKey, blocks, rows }
}

/** Flat row order: hidden rows removed, each block before its span, each end bar after it. */
export function planOrder(order: readonly string[], hiding: Hiding): readonly string[] {
  if (hiding.blocks.size === 0) return order
  const seqOf = (key: string): number => hiding.blocks.get(key)?.anchorSeq ?? 0
  const before = new Map<string, string[]>()
  const after = new Map<string, string[]>()
  for (const [compactionId, key] of hiding.firstKey) {
    const bk = blockKey(compactionId)
    if (hiding.blocks.has(bk)) before.set(key, [...(before.get(key) ?? []), bk])
  }
  for (const [compactionId, key] of hiding.lastKey) {
    const ek = endKey(compactionId)
    if (hiding.blocks.has(ek)) after.set(key, [...(after.get(key) ?? []), ek])
  }
  const out: string[] = []
  for (const key of order) {
    const b = before.get(key)
    if (b) out.push(...b.sort((x, y) => seqOf(y) - seqOf(x))) // outer (later checkpoint) first
    if (!hiding.hidden.has(key)) out.push(key)
    const a = after.get(key)
    if (a) out.push(...a.sort((x, y) => seqOf(x) - seqOf(y))) // inner (earlier checkpoint) first
  }
  return out
}

/**
 * Grouped root entries (DSH prefers these over the flat order): hidden nodes removed,
 * groups reduced to their visible members and dropped when none is left, each block
 * inserted before the first entry that touches its span.
 * @param membersOf - member keys of a group entry (undefined for a missing group).
 */
export function planEntries<E extends EntryLike>(
  entries: readonly E[],
  membersOf: (groupKey: string) => readonly MemberLike[] | undefined,
  hiding: Hiding,
): readonly (E | EntryLike)[] {
  if (hiding.blocks.size === 0) return entries
  const touching = (entry: EntryLike, edge: ReadonlyMap<string, string>): string[] => {
    const keys = entry.kind === 'group' ? (membersOf(entry.key) ?? []).map((m) => m.key) : [entry.key]
    const ids: string[] = []
    for (const [compactionId, k] of edge) if (keys.includes(k)) ids.push(compactionId)
    const seqOf = (id: string): number => hiding.blocks.get(blockKey(id))?.anchorSeq ?? 0
    return ids.sort((x, y) => (edge === hiding.firstKey ? seqOf(y) - seqOf(x) : seqOf(x) - seqOf(y)))
  }
  const out: (E | EntryLike)[] = []
  const placed = new Set<string>() // a bar is placed once, even if a key shows up in two entries
  const place = (key: string): void => {
    if (placed.has(key) || !hiding.blocks.has(key)) return
    placed.add(key)
    out.push({ kind: 'node', key })
  }
  for (const entry of entries) {
    for (const id of touching(entry, hiding.firstKey)) place(blockKey(id))
    if (entry.kind === 'group') {
      const members = membersOf(entry.key)
      if (!(members !== undefined && members.length > 0 && members.every((m) => hiding.hidden.has(m.key)))) out.push(entry)
    } else if (!hiding.hidden.has(entry.key)) {
      out.push(entry)
    }
    for (const id of touching(entry, hiding.lastKey)) place(endKey(id))
  }
  return out
}

/** Members of a group that stay visible. */
export function visibleMembers<M extends MemberLike>(members: readonly M[], hidden: ReadonlySet<string>): readonly M[] {
  if (hidden.size === 0) return members
  const kept = members.filter((m) => !hidden.has(m.key))
  return kept.length === members.length ? members : kept
}

// ---- expand/collapse state (module level: block rows are rendered by DSH's slot
// machinery and cannot receive props from the tab) ----

type Listener = () => void

const expandedBySession = new Map<string, Set<string>>()
const listeners = new Set<Listener>()
let version = 0

function emit(): void {
  version += 1
  for (const fn of [...listeners]) fn()
}

const EMPTY_SET: ReadonlySet<string> = new Set()

export const compactState = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
  version(): number {
    return version
  },
  expanded(sessionId: string): ReadonlySet<string> {
    return expandedBySession.get(sessionId) ?? EMPTY_SET
  },
  toggle(sessionId: string, compactionId: string): void {
    const next = new Set(expandedBySession.get(sessionId) ?? [])
    if (next.has(compactionId)) next.delete(compactionId)
    else next.add(compactionId)
    expandedBySession.set(sessionId, next)
    emit()
  },
  setAll(sessionId: string, ids: readonly string[], on: boolean): void {
    expandedBySession.set(sessionId, on ? new Set(ids) : new Set())
    emit()
  },
}

/** Short human text for a token count: 16531 -> "16.5k". */
export function tokensText(tokens: number): string {
  if (tokens >= 1000) return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(tokens)
}

/**
 * Wrap `base` in a plain object that reads every property live from `base` (methods stay
 * bound to it, so private fields keep working) and replaces only the keys in `over`.
 * A Proxy cannot do this: DSH hands out frozen objects whose non-writable,
 * non-configurable properties a Proxy `get` trap must report unchanged (measured crash:
 * "proxy must report the same value for the non-writable, non-configurable property 'views'").
 */
export function overlay<T extends object>(base: T, over: Record<string, unknown>): T {
  const out: Record<PropertyKey, unknown> = {}
  const seen = new Set<PropertyKey>()
  for (let o: object | null = base; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Reflect.ownKeys(o)) {
      if (key === 'constructor' || seen.has(key)) continue
      seen.add(key)
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(over, key)) continue
      Object.defineProperty(out, key, {
        enumerable: true,
        configurable: true,
        get: () => {
          const value = Reflect.get(base, key, base)
          return typeof value === 'function' ? value.bind(base) : value
        },
      })
    }
  }
  for (const key of Object.keys(over)) {
    Object.defineProperty(out, key, { enumerable: true, configurable: true, value: over[key], writable: true })
  }
  return out as T
}
