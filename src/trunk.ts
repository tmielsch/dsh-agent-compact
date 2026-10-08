// Shared-trunk support: pure helpers that decide which part of a session's
// surface is the "trunk" — the history a forked team member inherited from its
// parent — and give that trunk a content address.
//
// Why this exists: a prefix-caching inference engine (llama.cpp-style prompt
// cache, Strata's conversation checkpoints, provider prompt caching) can only
// reuse work for an exact token prefix. Forked team members start with the
// same prefix, so the engine reads it once. As soon as each member compacts the
// inherited history on its own, every member carries a different summary and
// the shared prefix is gone. The rules implemented here keep it shared:
//
//   1. A forked session never compacts part of its inherited trunk on its own
//      (the "protected prefix").
//   2. The trunk is compacted only as one canonical block — from the first
//      non-system node through the last inherited node — and the checkpoint
//      text is looked up by a hash of the inherited events, so every sibling
//      that compacts the same trunk lands the same bytes.
//
// Everything in this file is a pure function of plain data so it can be unit
// tested without a Cordis runtime (see test/trunk.test.mjs).

import { createHash } from 'node:crypto'

/** Minimal session event shape these helpers read. */
export interface TrunkEvent {
  seq: number
  type?: string
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[] | null
}

/** Minimal session shape these helpers read (the real one is `@deepseek-ai/dsh-session`'s Session). */
export interface TrunkSessionLike {
  id: string
  header?: { isSeeded?: boolean; parentSession?: string } | null
  inheritedEventCount?: number
  surface?: { nodes?: readonly number[] } | null
  eventAt?: (seq: number) => TrunkEvent | undefined
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly TrunkEvent[]
}

/** Bumped whenever the content-address definition changes, so old memo entries stop matching. */
export const TRUNK_KEY_VERSION = 'agent-compact/shared-trunk/v1'

/**
 * The fork cut of a session: the number of leading events it inherited from
 * its parent, or 0 for a session that was not forked.
 */
export function forkCut(session: TrunkSessionLike | null | undefined): number {
  if (!session || !session.header || session.header.isSeeded !== true) return 0
  const n = session.inheritedEventCount
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** The parent session id of a forked session, if the header records one. */
export function forkParent(session: TrunkSessionLike | null | undefined): string | null {
  if (forkCut(session) <= 0) return null
  const p = session && session.header ? session.header.parentSession : undefined
  return typeof p === 'string' && p ? p : null
}

/** Whether an event is the system prompt head of a surface. */
export function isSystemHead(ev: TrunkEvent | undefined): boolean {
  return !!ev && ev.type === 'system/message'
}

/** Whether an event is a compaction checkpoint (the replacement user message a compaction lands). */
export function isCheckpoint(ev: TrunkEvent | undefined): boolean {
  if (!ev || ev.type !== 'user/message') return false
  const source = (ev.data as { source?: { kind?: unknown } } | undefined)?.source
  return !!source && source.kind === 'compact-checkpoint'
}

function coversInherited(ev: TrunkEvent, cut: number): boolean {
  const seqs = ev.sourceEventSeqs
  if (!Array.isArray(seqs)) return false
  return seqs.some((s) => typeof s === 'number' && s < cut)
}

/**
 * Index of the last surface node that belongs to the protected prefix, or -1.
 *
 * A node is protected when it was inherited (seq below the cut) or when it is a
 * compaction checkpoint that replaced inherited nodes (for example the shared
 * trunk checkpoint itself). Everything up to the last protected node is
 * protected, because a compaction that starts earlier would rewrite it.
 */
export function protectedEndIndex(nodes: readonly TrunkEvent[], cut: number): number {
  if (!(cut > 0)) return -1
  let end = -1
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.seq < cut || (isCheckpoint(n) && coversInherited(n, cut))) end = i
  }
  return end
}

/** First index a compaction may start at: after a system head, otherwise 0. */
export function firstCompactableIndex(nodes: readonly TrunkEvent[]): number {
  return nodes.length > 0 && isSystemHead(nodes[0]) ? 1 : 0
}

/**
 * The canonical trunk block of a surface: from the first non-system node
 * through the last node that is still an inherited (seq below the cut) node.
 * Returns null when no inherited non-system node remains — the trunk is
 * already compacted, or nothing was inherited.
 */
export function trunkSpan(nodes: readonly TrunkEvent[], cut: number): { si: number; ei: number } | null {
  if (!(cut > 0)) return null
  const si = firstCompactableIndex(nodes)
  let ei = -1
  for (let i = si; i < nodes.length; i++) {
    if (nodes[i].seq < cut) ei = i
  }
  if (ei < si) return null
  return { si, ei }
}

/**
 * JSON with sorted object keys: equal values always serialize to equal text,
 * independent of property insertion order. Mirrors JSON.stringify for what it
 * omits (undefined and functions in objects) and what it maps to null (the
 * same inside arrays, and non-finite numbers).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',') + ']'
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'object': {
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function').sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
    }
    default:
      return 'null'
  }
}

/**
 * Content address of an inherited trunk: a SHA-256 over the canonical form of
 * every inherited event (type, data, surface operation, source seqs; the
 * timestamp is left out). A fork's seed is a verbatim copy of the parent's
 * events, so the parent and all siblings forked at the same point compute the
 * same key, while any difference in content yields a different one.
 */
export function trunkKey(events: readonly TrunkEvent[]): string {
  const h = createHash('sha256')
  h.update(TRUNK_KEY_VERSION)
  for (const ev of events) {
    h.update('\n')
    h.update(canonicalJson({ seq: ev.seq, type: ev.type, data: ev.data, surfaceOp: ev.surfaceOp, sourceEventSeqs: ev.sourceEventSeqs }))
  }
  return h.digest('hex')
}

/** The events with seq below `cut`, read from a live session. */
export function eventsBefore(session: TrunkSessionLike, cut: number): TrunkEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    return [...session.snapshotEvents(0, cut)]
  }
  const out: TrunkEvent[] = []
  if (typeof session.eventAt !== 'function') return out
  for (let s = 0; s < cut; s++) {
    const ev = session.eventAt(s)
    if (ev) out.push(ev)
  }
  return out
}

/** The current surface of a live session as events, in surface order. */
export function surfaceEvents(session: TrunkSessionLike): TrunkEvent[] {
  const seqs = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const out: TrunkEvent[] = []
  if (typeof session.eventAt !== 'function') return out
  for (const seq of seqs) {
    const ev = session.eventAt(seq)
    if (ev) out.push(ev)
  }
  return out
}

/**
 * The lock for default-scope compactions: null when a span starting at
 * `startSeq` leaves the protected trunk alone, otherwise the error text that
 * explains the refusal and names the first message the session may compact.
 */
export function lockedSpanError(surface: readonly TrunkEvent[], cut: number, startSeq: number): string | null {
  if (!(cut > 0)) return null
  const p = protectedEndIndex(surface, cut)
  if (p < 0) return null
  const idx = surface.findIndex((n) => n.seq === startSeq)
  if (idx > p) return null
  const firstOwn = surface[p + 1]
  const hint = firstOwn
    ? ' The first message after the trunk begins: «' + nodePreview(firstOwn, 120) + '».'
    : ' Nothing after the trunk exists yet.'
  return 'LOCKED: this span starts inside the history this session shares with its fork siblings or forks (the protected trunk, surface positions 0..' + p + '). Compacting it alone would give this session a different prompt prefix than the others and break their shared prompt cache. Choose a span that starts after the trunk, or call context_compact with scope "trunk" to compact the whole inherited trunk into the shared checkpoint.' + hint
}

/** A short single-line preview of a surface node, for error hints. */
export function nodePreview(ev: TrunkEvent | undefined, max = 80): string {
  if (!ev) return ''
  const d = ev.data as { content?: unknown; message?: { content?: unknown } } | undefined
  const content = d && Array.isArray(d.content) ? d.content : d && d.message && Array.isArray(d.message.content) ? d.message.content : []
  const text = (content as { type?: unknown; text?: unknown }[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= max ? text : text.slice(0, max) + '…'
}
