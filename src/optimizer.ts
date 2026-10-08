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
//    session that cannot shrink must still be able to recover.

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
}

/** The engine surface the patch relies on (structural and defensive; the real engine is BasicCompactionEngine). */
export interface OptimizedEngineLike {
  /**
   * Agent-written checkpoint text keyed by session id (one shot: consumed by
   * that session's next summarize). When present, the patched summarize()
   * returns it directly and makes no LLM call.
   */
  _externalSummary?: Record<string, string>
  /** Shared-trunk key per session id while a trunk compaction runs. */
  _acTrunkRequests?: Record<string, string>
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
export const PATCH_VERSION = 4

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
      const { entry, created } = await d.memo.getOrCreate(trunk, async () => {
        const r = (await orig.summarize(input, agent, signal)) as { summary?: unknown; provider?: string; model?: string; usage?: unknown }
        holder.usage = r.usage
        return { blocks: textBlocks(r.summary), sessionId: sid, provider: r.provider ?? null, model: r.model ?? null }
      })
      d.log('info', '[context_compact] ' + sid + ' shared trunk ' + trunk.slice(0, 12) + (created ? ': checkpoint generated' : ': checkpoint reused from memo'))
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
    const ext = engine._externalSummary
    if (sid && ext && typeof ext[sid] === 'string') {
      const text = ext[sid]
      delete ext[sid]
      // Same runtime shape as the stock summarizer (text summary + usage envelope);
      // the engine's frameSummary and size check still apply.
      return {
        summary: [{ type: 'text', text }],
        rawOutput: [],
        llmStreamCall: false,
        provider: 'agent',
        model: 'agent',
        maxTokens: 0,
      }
    }
    return orig.summarize(input, agent, signal)
  }

  if (orig.compactRegion) {
    const origCompact = orig.compactRegion
    engine.compactRegion = async function (start: number, end: number, agent: AgentLike, signal?: AbortSignal) {
      const d = engine._acDeps
      const session = agent ? (agent.session as (SessionLike & TrunkSessionLike) | undefined) : undefined
      if (!d || !d.guard || !session) return origCompact(start, end, agent, signal)
      let plan: GuardPlan
      try {
        plan = await planGuard(session, start, end, d.registry)
      } catch (e) {
        d.log('warn', '[context_compact] guard planning failed, compacting as requested: ' + message(e))
        return origCompact(start, end, agent, signal)
      }
      if (plan.kind === 'passthrough') return origCompact(start, end, agent, signal)
      try {
        if (plan.kind === 'trunk') {
          d.log('info', '[context_compact] ' + session.id + ' automatic compaction ' + start + '..' + end + ' turned into the shared trunk block ' + plan.startSeq + '..' + plan.endSeq)
          return await runTrunkCompaction(engine, agent, plan, signal)
        }
        d.log('info', '[context_compact] ' + session.id + ' automatic compaction clamped to start after the protected trunk: ' + plan.startSeq + '..' + end)
        return await origCompact(plan.startSeq, end, agent, signal)
      } catch (e) {
        if (signal?.aborted) throw e
        d.log('warn', '[context_compact] ' + session.id + ' trunk-preserving compaction failed (' + message(e) + '); compacting the requested range ' + start + '..' + end + ' instead')
        return origCompact(start, end, agent, signal)
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
  requests[sid] = plan.key
  try {
    return await compact(plan.startSeq, plan.endSeq, agent, signal)
  } finally {
    delete requests[sid]
  }
}
