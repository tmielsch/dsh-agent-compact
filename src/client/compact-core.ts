// Compact Chat: pure logic (no React, no DSH imports) so it can be tested offline.
//
// The Compact Chat tab renders DSH's own Chat component over a FILTERED view of the
// Chat snapshot. For every compaction it either
//   - collapsed: hides the original rows of the replaced span and shows ONE block
//     with the checkpoint text (what the model really has in its context), or
//   - expanded:  keeps the original rows and shows the block header above them.
// Which rows belong to a compaction comes from the session log (`startSeq..endSeq`
// of the replace operation), never from guessing by text.

export const BLOCK_KIND = 'compact-block'

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

export function isBlockKey(key: string): boolean {
  return key.startsWith(BLOCK_KIND + ':')
}

export interface Hiding {
  /** Keys of original rows that are hidden (collapsed compactions only). */
  readonly hidden: ReadonlySet<string>
  /** compactionId -> key of the first original row inside its range (where the block goes). */
  readonly firstKey: ReadonlyMap<string, string>
  readonly blocks: ReadonlyMap<string, BlockNode>
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
): Hiding {
  const hidden = new Set<string>()
  const firstKey = new Map<string, string>()
  const blocks = new Map<string, BlockNode>()
  if (compactions.length === 0) return { hidden, firstKey, blocks }
  const sorted = [...compactions].sort((a, b) => a.checkpointSeq - b.checkpointSeq)
  for (const key of order) {
    const node = nodeOf(key)
    if (!node || KEEP_KINDS.has(node.kind) || node.kind === BLOCK_KIND) continue
    for (const c of sorted) {
      if (node.anchorSeq < c.startSeq || node.anchorSeq > c.endSeq) continue
      if (!firstKey.has(c.compactionId)) firstKey.set(c.compactionId, key)
      if (!expanded.has(c.compactionId)) hidden.add(key)
      break
    }
  }
  for (const c of sorted) {
    if (!firstKey.has(c.compactionId)) continue
    const key = blockKey(c.compactionId)
    blocks.set(key, {
      key,
      kind: BLOCK_KIND,
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
      },
    })
  }
  return { hidden, firstKey, blocks }
}

/** Flat row order: hidden rows removed, each block inserted where its span began. */
export function planOrder(order: readonly string[], hiding: Hiding): readonly string[] {
  if (hiding.blocks.size === 0) return order
  const blockAt = new Map<string, string[]>()
  for (const [compactionId, key] of hiding.firstKey) {
    const bk = blockKey(compactionId)
    if (!hiding.blocks.has(bk)) continue
    blockAt.set(key, [...(blockAt.get(key) ?? []), bk])
  }
  const out: string[] = []
  for (const key of order) {
    const here = blockAt.get(key)
    if (here) out.push(...here)
    if (!hiding.hidden.has(key)) out.push(key)
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
  const touching = (entry: EntryLike): string[] => {
    const keys = entry.kind === 'group' ? (membersOf(entry.key) ?? []).map((m) => m.key) : [entry.key]
    const ids: string[] = []
    for (const [compactionId, first] of hiding.firstKey) if (keys.includes(first)) ids.push(compactionId)
    return ids
  }
  const out: (E | EntryLike)[] = []
  for (const entry of entries) {
    for (const id of touching(entry)) {
      const bk = blockKey(id)
      if (hiding.blocks.has(bk)) out.push({ kind: 'node', key: bk })
    }
    if (entry.kind === 'group') {
      const members = membersOf(entry.key)
      if (members !== undefined && members.length > 0 && members.every((m) => hiding.hidden.has(m.key))) continue
      out.push(entry)
    } else if (!hiding.hidden.has(entry.key)) {
      out.push(entry)
    }
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
