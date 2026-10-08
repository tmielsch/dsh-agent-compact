// @mimichunterz/agent-compact: shared optimizer core (no runtime dependencies on DSH packages).
//
// patchEngine() patches the host compaction engine (BasicCompactionEngine)
// once per engine instance:
//
//  - summarize() honours an agent-written checkpoint (_externalSummary, one
//    shot, keyed by session id) and skips the LLM call for it — the original
//    agent-compact behaviour;
//  - summarize() serves a shared-trunk request (_acTrunkRequests, keyed by
//    session id) from the content-addressed memo: the first sibling generates
//    the checkpoint with the stock summarizer, every other sibling receives the
//    exact same text blocks;
//  - compactRegion() — which the automatic pressure/overflow path calls — is
//    guarded for forked sessions (and for parents whose forks are registered):
//    a range that reaches into the protected trunk is turned into the canonical
//    shared-trunk compaction, or clamped to start after the protected prefix.
//    When neither is possible the original range runs unchanged, because a
//    session that cannot shrink must still be able to recover;
//  - every checkpoint ends with a recall reference to its raw span (./recall.js):
//    the trunk's lives in the memo text (same bytes for every sibling), a span's
//    is appended by summarize() from a one-shot archive id. Archiving never
//    blocks a compaction: without an archive the checkpoint carries no reference.

import {
  eventsBefore,
  forkCut,
  protectedEndIndex,
  surfaceEvents,
  trunkKey,
  trunkSpan,
} from './trunk.js'
import type { TrunkEvent, TrunkSessionLike } from './trunk.js'
import type { ForkRegistry, SharedTrunkMemo } from './memo.js'
import { footerText, withFooter } from './recall.js'

export interface SurfaceNode {
  seq: number
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  surface?: { nodes?: readonly number[] }
  events?: readonly unknown[]
  // `SessionEvent` is not exported by these packages; `any` lets the structural
  // shape stay assignable to the real `(event: SessionEvent) => Message | null`.
  deriveEventMessage?: (event: any) => unknown
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: { provider?: string; model?: string }
  ctx?: unknown
}

export interface CompactionResultLike {
  compactionId: unknown
  shadowedRange?: { start: number; end: number } | null
  shadowedSeqs?: unknown[] | null
  shadowedTokenCount?: unknown
  summary?: unknown
}

type CompactRegionFn = (start: number, end: number, agent: AgentLike, signal?: AbortSignal) => Promise<CompactionResultLike>
type SummarizeFn = (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>

/** Dependencies of the shared-trunk extension. */
export interface TrunkDeps {
  memo: SharedTrunkMemo
  registry: ForkRegistry
  /** Guard the automatic compaction path (default true). */
  guard: boolean
  log: (level: 'info' | 'warn', msg: string) => void
  /**
   * Keep the raw shared trunk in its content-addressed archive and return the
   * archive id, or null when it cannot be kept. Absent: trunk checkpoints carry
   * no recall reference.
   */
  archiveTrunk?: (agent: AgentLike, plan: TrunkPlan) => Promise<string | null>
  /**
   * Keep a raw span (by surface seqs) in the session's archive and return the
   * archive id, or null. Absent: automatic compactions carry no recall reference.
   */
  archiveRange?: (agent: AgentLike, startSeq: number, endSeq: number) => Promise<string | null>
}

/** A shared-trunk request while its compaction runs. */
export interface TrunkRequest {
  key: string
  /** Archive id the generated checkpoint references, when the raw trunk was kept. */
  archiveId: string | null
}

/** The engine surface the patch relies on (structural and defensive; the real engine is BasicCompactionEngine). */
export interface OptimizedEngineLike {
  /**
   * Agent-written checkpoint text keyed by session id (one shot: consumed by
   * that session's next summarize). When present, the patched summarize()
   * returns it directly and makes no LLM call.
   */
  _externalSummary?: Record<string, string>
  /** Shared-trunk request per session id while a trunk compaction runs. */
  _acTrunkRequests?: Record<string, TrunkRequest>
  /**
   * Archive id per session id for the next span checkpoint (one shot): the
   * patched summarize() appends its recall reference to the checkpoint text.
   */
  _acArchiveIds?: Record<string, string>
  _acDeps?: TrunkDeps
  /** The unpatched methods, kept so re-patching never stacks wrappers. */
  _acOrig?: { summarize: SummarizeFn; compactRegion?: CompactRegionFn }
  summarize?: SummarizeFn
  compactRegion?: CompactRegionFn
  /** Patch version; bumped whenever the patched behaviour changes. */
  __ctxcOptimized?: number
}

// The compaction engine is a host-level singleton that survives HMR; the
// versioned guard rebinds the wrappers on every patch so code changes apply hot.
export const PATCH_VERSION = 5

/** Provider tag recorded on compaction/summary events of a shared-trunk compaction. */
export const TRUNK_PROVIDER = 'agent-compact:shared-trunk'

function textBlocks(summary: unknown): string[] {
  if (!Array.isArray(summary)) return []
  return summary
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => (b as { text: string }).text)
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Text blocks with the recall reference appended to the last one (a new block when there is none). */
export function blocksWithFooter(blocks: readonly string[], archiveId: string | null): string[] {
  if (!archiveId) return [...blocks]
  if (!blocks.length) return [footerText(archiveId)]
  const out = [...blocks]
  out[out.length - 1] = withFooter(out[out.length - 1], archiveId)
  return out
}

/** A summarizer result whose text summary carries the recall reference. */
function resultWithFooter(result: unknown, archiveId: string | undefined): unknown {
  if (!archiveId || !result || typeof result !== 'object') return result
  const r = result as { summary?: unknown }
  if (!Array.isArray(r.summary)) return result
  const summary = [...r.summary]
  let last = -1
  for (let i = summary.length - 1; i >= 0; i--) {
    const b = summary[i] as { type?: unknown; text?: unknown } | null
    if (b && b.type === 'text' && typeof b.text === 'string') { last = i; break }
  }
  if (last < 0) summary.push({ type: 'text', text: footerText(archiveId) })
  else summary[last] = { ...(summary[last] as object), text: withFooter((summary[last] as { text: string }).text, archiveId) }
  return { ...r, summary }
}

/** Take the one-shot archive id registered for a session's next span checkpoint. */
function takeArchiveId(engine: OptimizedEngineLike, sid: string | undefined): string | undefined {
  if (!sid || !engine._acArchiveIds) return undefined
  const id = engine._acArchiveIds[sid]
  delete engine._acArchiveIds[sid]
  return id
}

export function patchEngine(engine: OptimizedEngineLike, deps?: TrunkDeps): boolean {
  if (!engine || typeof engine.summarize !== 'function') return false
  if (deps) engine._acDeps = deps
  if (engine.__ctxcOptimized === PATCH_VERSION) return true
  // Keep the true originals across re-patching so wrappers never stack.
  if (!engine._acOrig) {
    engine._acOrig = {
      summarize: engine.summarize.bind(engine),
      ...(typeof engine.compactRegion === 'function' ? { compactRegion: engine.compactRegion.bind(engine) } : {}),
    }
  }
  const orig = engine._acOrig
  engine._acTrunkRequests ??= {}

  engine.summarize = async function (input: unknown, agent: unknown, signal?: AbortSignal) {
    const a = agent as AgentLike | undefined
    const sid = a && a.session && a.session.id ? a.session.id : undefined
    const trunk = sid ? engine._acTrunkRequests?.[sid] : undefined
    const d = engine._acDeps
    if (sid && trunk && d) {
      const holder: { usage?: unknown } = {}
      // The recall reference is part of the stored text, so every sibling lands the same bytes.
      const { entry, created } = await d.memo.getOrCreate(trunk.key, async () => {
        const r = (await orig.summarize(input, agent, signal)) as { summary?: unknown; provider?: string; model?: string; usage?: unknown }
        holder.usage = r.usage
        return { blocks: blocksWithFooter(textBlocks(r.summary), trunk.archiveId), sessionId: sid, provider: r.provider ?? null, model: r.model ?? null }
      })
      d.log('info', '[context_compact] ' + sid + ' shared trunk ' + trunk.key.slice(0, 12) + (created ? ': checkpoint generated' : ': checkpoint reused from memo'))
      return {
        // Normalized blocks for everyone, the generating sibling included, so all land identical bytes.
        summary: entry.blocks.map((text) => ({ type: 'text', text })),
        rawOutput: [],
        provider: TRUNK_PROVIDER,
        model: trunk,
        maxTokens: 0,
        ...(created && holder.usage !== undefined ? { usage: holder.usage } : {}),
      }
    }
    const archiveId = takeArchiveId(engine, sid)
    const ext = engine._externalSummary
    if (sid && ext && typeof ext[sid] === 'string') {
      const text = ext[sid]
      delete ext[sid]
      // Same runtime shape as the stock summarizer (text summary + usage envelope);
      // the engine's frameSummary and size check still apply.
      return {
        summary: [{ type: 'text', text: archiveId ? withFooter(text, archiveId) : text }],
        rawOutput: [],
        llmStreamCall: false,
        provider: 'agent',
        model: 'agent',
        maxTokens: 0,
      }
    }
    return resultWithFooter(await orig.summarize(input, agent, signal), archiveId)
  }

  if (orig.compactRegion) {
    const origCompact = orig.compactRegion
    engine.compactRegion = async function (start: number, end: number, agent: AgentLike, signal?: AbortSignal) {
      const d = engine._acDeps
      const session = agent ? (agent.session as (SessionLike & TrunkSessionLike) | undefined) : undefined
      if (!d || !session) return origCompact(start, end, agent, signal)
      // Recall: an automatic compaction keeps its raw span as well. The tool
      // path registers its own archive before it calls in, so this skips it.
      const sid = session.id
      const keepOwn = !!d.archiveRange && !(engine._acArchiveIds && engine._acArchiveIds[sid])
      const span = async (s: number, e: number) => {
        if (keepOwn) {
          try {
            const id = await d.archiveRange!(agent, s, e)
            if (id) (engine._acArchiveIds ??= {})[sid] = id
          } catch (err) {
            d.log('warn', '[context_compact] ' + sid + ' raw span ' + s + '..' + e + ' not archived: ' + message(err))
          }
        }
        try {
          return await origCompact(s, e, agent, signal)
        } finally {
          if (keepOwn && engine._acArchiveIds) delete engine._acArchiveIds[sid]
        }
      }
      if (!d.guard) return span(start, end)
      let plan: GuardPlan
      try {
        plan = await planGuard(session, start, end, d.registry)
      } catch (e) {
        d.log('warn', '[context_compact] guard planning failed, compacting as requested: ' + message(e))
        return span(start, end)
      }
      if (plan.kind === 'passthrough') return span(start, end)
      try {
        if (plan.kind === 'trunk') {
          d.log('info', '[context_compact] ' + session.id + ' automatic compaction ' + start + '..' + end + ' turned into the shared trunk block ' + plan.startSeq + '..' + plan.endSeq)
          return await runTrunkCompaction(engine, agent, plan, signal)
        }
        d.log('info', '[context_compact] ' + session.id + ' automatic compaction clamped to start after the protected trunk: ' + plan.startSeq + '..' + end)
        return await span(plan.startSeq, end)
      } catch (e) {
        if (signal?.aborted) throw e
        d.log('warn', '[context_compact] ' + session.id + ' trunk-preserving compaction failed (' + message(e) + '); compacting the requested range ' + start + '..' + end + ' instead')
        return span(start, end)
      }
    }
  }
  engine.__ctxcOptimized = PATCH_VERSION
  return true
}

/** A planned shared-trunk compaction. */
export interface TrunkPlan {
  kind: 'trunk'
  cut: number
  key: string
  startSeq: number
  endSeq: number
}

export type GuardPlan = { kind: 'passthrough' } | TrunkPlan | { kind: 'clamp'; startSeq: number }

/**
 * The cut a session protects: its own fork cut, or — for a parent that handed
 * out forks — the most recent fork point it gave its children.
 */
export async function effectiveCut(session: TrunkSessionLike, registry: ForkRegistry): Promise<number> {
  const own = forkCut(session)
  if (own > 0) return own
  const cuts = await registry.cutsOf(session.id)
  return cuts.length ? cuts[cuts.length - 1] : 0
}

/** Plan the canonical shared-trunk compaction for a session, or null when there is no trunk left to compact. */
export function planTrunk(session: TrunkSessionLike, cut: number, nodes?: readonly TrunkEvent[]): TrunkPlan | null {
  if (!(cut > 0)) return null
  const surface = nodes ?? surfaceEvents(session)
  const span = trunkSpan(surface, cut)
  if (!span) return null
  return {
    kind: 'trunk',
    cut,
    key: trunkKey(eventsBefore(session, cut)),
    startSeq: surface[span.si].seq,
    endSeq: surface[span.ei].seq,
  }
}

/** Decide how a requested compaction range is executed for a session. */
export async function planGuard(session: TrunkSessionLike, start: number, end: number, registry: ForkRegistry): Promise<GuardPlan> {
  const cut = await effectiveCut(session, registry)
  if (!(cut > 0)) return { kind: 'passthrough' }
  const nodes = surfaceEvents(session)
  const p = protectedEndIndex(nodes, cut)
  const si = nodes.findIndex((n) => n.seq === start)
  const ei = nodes.findIndex((n) => n.seq === end)
  if (si < 0 || ei < 0 || si > p) return { kind: 'passthrough' }
  const trunk = planTrunk(session, cut, nodes)
  if (trunk) return trunk
  const cs = p + 1
  if (cs <= ei && nodes[cs].type !== 'tool/result') return { kind: 'clamp', startSeq: nodes[cs].seq }
  return { kind: 'passthrough' }
}

/** Run one shared-trunk compaction: the memo-backed summarize() serves the checkpoint text. */
export async function runTrunkCompaction(engine: OptimizedEngineLike, agent: AgentLike, plan: TrunkPlan, signal?: AbortSignal): Promise<CompactionResultLike> {
  const compact = engine._acOrig?.compactRegion
  const sid = agent.session?.id
  if (!compact || !sid) throw new Error('shared trunk: the compaction engine cannot compact a region')
  const requests = (engine._acTrunkRequests ??= {})
  if (requests[sid]) throw new Error('shared trunk: a trunk compaction is already running for this session')
  const request: TrunkRequest = { key: plan.key, archiveId: null }
  requests[sid] = request
  try {
    // Keep the raw trunk first, so the checkpoint can reference it (the memo
    // stores that reference with the text: every sibling gets the same bytes).
    const d = engine._acDeps
    if (d && d.archiveTrunk) {
      try {
        request.archiveId = await d.archiveTrunk(agent, plan)
      } catch (e) {
        d.log('warn', '[context_compact] ' + sid + ' raw trunk not archived: ' + message(e))
      }
    }
    return await compact(plan.startSeq, plan.endSeq, agent, signal)
  } finally {
    delete requests[sid]
  }
}
