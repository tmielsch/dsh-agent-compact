// @tmielsch/rolling-compaction: 上下文压缩工具（bundle 插件）。
// 注册模型可见的 context_compact 工具，并在首次使用时修补压缩引擎，
// 使其 summarize() 尊重 agent 自行编写的检查点（参见 ./optimizer.js）。

import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 0.2 起 `JsonValue` 从 dsh-tools / dsh-session 移到 dsh-util-values。
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createShadowUserMessage } from './shadow-message.js'
import { effectiveCut, patchEngine, planTrunk, runTrunkCompaction } from './optimizer.js'
import { normText } from './normalize.js'
import { CtxSurfaceService } from './ctx-surface.js'
import { balancedAfterEach, prefixHits, resolveBoundaries, soleToolCall, spanText, tailCutPrice } from './boundary.js'
import { markerTag } from './anchor.js'
import { limitNudgeText, nudgeMode } from './phase.js'
import { nodeFlatText } from './surface-text.js'
import { ForkRegistry, SharedTrunkMemo } from './memo.js'
import { forkCut, forkParent, lockedSpanError, surfaceEvents } from './trunk.js'
import { DEFAULT_MAX_CHARS, MAX_CHARS, TrunkArchive, referencedIds, renderRecall, spanArchiveId, splitBlocks, trunkRecallId } from './recall.js'
import { SummaryStash, keptLabel, type KeptSummary } from './summary-stash.js'
import { buildTurnTable, planRows, turnCutRow, turnTableText, type TurnLogEvent, type TurnTable } from './turns.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode, TrunkDeps } from './optimizer.js'
import type { TrunkSessionLike } from './trunk.js'

export const name = 'tool-context-compression'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  autoArchive: boolean
  contextHardLimitTokens: number
  sharedStoreDir: string
  trunkGuard: boolean
  keepFailedSummary: boolean
  keepTurns: number
}

export const Config: Schema<Config> = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  keepFailedSummary: Schema.boolean().default(true).description('A failed compaction keeps the written checkpoint text: the retry may omit `summary` to reuse it unchanged (in memory for this process only; a rewrite after a restart copies it from the previous message).'),
  contextHardLimitTokens: Schema.number().default(300000).description('Upper bound: when the context occupancy reaches this many tokens, the hint appears. Set to 0 to disable. This is the only trigger message the plugin sends; the phase hint was removed on 2026-10-30 by the human\'s order ("der phasenhinweis muss raus"), because a hint that fires on growth pushed the session into compactions it did not need.'),
  sharedStoreDir: Schema.string().default('').description('Directory for the shared-trunk memo (content-addressed trunk checkpoints) and the fork registry. Empty keeps both in memory only, so they do not survive a restart.'),
  trunkGuard: Schema.boolean().default(true).description('Guard automatic compaction in forked sessions (and in parents with known forks): a range reaching into the inherited trunk becomes the shared trunk compaction, or is clamped to start after it.'),
  keepTurns: Schema.number().default(3).description('Working-memory window: the newest N finished turns are never part of a turn-based compaction. The human\'s order (2026-10-30): "Wir haben 10 Turns, 3 oder 4 dürfen maximal" — compact everything older than this window, in one checkpoint per stretch.'),
})

export function apply(ctx: Context, config: Config) {
  // 注意：sessionQuery 与 agentPresets 必须在每次调用时解析——它们在 apply
  // 时可能尚未挂载，此时捕获会让 context_compact 工具失效。
  const tools = ctx.get('tools')
  if (!tools) throw new Error('@tmielsch/rolling-compaction: tools service unavailable')

  // ---- Shared trunk: memo, fork registry and the engine patch's dependencies ----
  const storeDir = typeof config.sharedStoreDir === 'string' && config.sharedStoreDir.trim() ? config.sharedStoreDir.trim() : null
  const logWarn = (msg: string) => ctx.logger.warn('%s', msg)
  const memo = new SharedTrunkMemo(storeDir, logWarn)
  const registry = new ForkRegistry(storeDir, logWarn)
  const trunkArchive = new TrunkArchive(storeDir)
  // Failed compactions keep their checkpoint text here (see ./summary-stash.ts):
  // the retry may omit `summary` and take the kept text unchanged.
  const stash = new SummaryStash()
  const trunkDeps: TrunkDeps = {
    memo,
    registry,
    guard: config.trunkGuard !== false,
    log: (level, msg) => (level === 'warn' ? ctx.logger.warn('%s', msg) : ctx.logger.info('%s', msg)),
    // Recall: the raw trunk goes to its content-addressed archive (once for all siblings).
    archiveTrunk: async (agent, plan) => {
      if (!config.autoArchive || !agent.session) return null
      const a = agent as AgentWithSession
      return trunkArchive.ensure(plan.key, async () => {
        const nodes = await readSurfaceNodes(a)
        const si = nodes ? nodes.findIndex((n) => n.seq === plan.startSeq) : -1
        const ei = nodes ? nodes.findIndex((n) => n.seq === plan.endSeq) : -1
        if (!nodes || si < 0 || ei < si) throw new Error('trunk ' + plan.startSeq + '..' + plan.endSeq + ' not found on the read surface')
        return spanText(nodes, si, ei)
      })
    },
    // Recall: an automatic compaction's raw span goes to the session's spill archive.
    archiveRange: async (agent, startSeq, endSeq) => {
      if (!config.autoArchive || !agent.session) return null
      const a = agent as AgentWithSession
      const spillStore = resolveService(a, 'spillStore') as SpillStoreLike | undefined
      if (!spillStore) return null
      const nodes = await readSurfaceNodes(a)
      const si = nodes ? nodes.findIndex((n) => n.seq === startSeq) : -1
      const ei = nodes ? nodes.findIndex((n) => n.seq === endSeq) : -1
      if (!nodes || si < 0 || ei < si) return null
      const archived = await archiveSpan(a, spillStore, nodes, si, ei)
      return archived ? spanArchiveId(spillRootOf(spillStore), String(archived.locator)) : null
    },
  }

  // 为浏览器「上下文」面板注册 ctxSurface 服务（`ctxSurface/read`）。
  new CtxSurfaceService(ctx)

  interface AgentWithSession extends AgentLike {
    session: SessionLike
  }

  interface SpillSaveArgs {
    owner: { sessionId: string }
    source: { toolName: string; callId: unknown; label: string }
    suggestedName: string
    content: string
  }

  interface SpillStoreLike {
    saveText(args: SpillSaveArgs): Promise<{ locator: JsonValue; bytes: JsonValue; retrievalHint: JsonValue }>
  }

  interface SessionQueryLike {
    readSurface(sessionId: string): Promise<{ events?: unknown } | null>
  }

  // 使用类型别名（而非 interface），使其携带隐式索引签名，
  // 嵌入工具结果时仍可赋值给 JsonValue。
  type SurfaceArchive = {
    locator: JsonValue
    bytes: JsonValue
    retrievalHint: JsonValue
    chars: number
    archivedSeqs: number[]
  }
  interface CompactionResultLike {
    compactionId: JsonValue
    shadowedRange?: { start: number; end: number } | null
    shadowedSeqs?: JsonValue[] | null
    shadowedTokenCount?: JsonValue | null
    summary?: JsonValue
  }

  interface CompactionLike {
    compactRegion(start: number, end: number, agent: AgentWithSession, signal?: AbortSignal): Promise<CompactionResultLike>
  }

  interface SessionEventLike {
    type?: string
    seq?: number
    data?: unknown
    sourceEventSeqs?: unknown
  }

  // 会话占用量作为提醒信号：达到 config.contextHardLimitTokens 时提示模型压缩。
  // Der Phasenhinweis (Wachstum seit der letzten Verdichtung) ist am 30.10.2026
  // vom Menschen entfernt worden; die Belegung ist das einzige Auslöser-Signal.
  // 度量指标按优先级：
  //  1. sessionProjections 的 contextPressure.projectedTokens（provider 真实
  //     usage 的投影，每次 LLM 调用都会重新同步到真实值）；
  //  2. tokenMeter 的 surfaceTokens（chars/4 启发式），仅当 (1) 不可用时使用。
  // 服务缺席时整个特性降级为 no-op。

  interface TokenMeterLike {
    measure(session: SessionLike): { surfaceTokens?: number } | null | undefined
  }

  interface SessionProjectionsLike {
    snapshot(session: SessionLike): { values?: Record<string, unknown> } | null | undefined
  }

  function surfaceTokensOf(session: SessionLike): number | null {
    const meter = ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (!meter || typeof meter.measure !== 'function') return null
    try {
      const m = meter.measure(session)
      const tokens = m && typeof m.surfaceTokens === 'number' ? m.surfaceTokens : null
      return tokens
    } catch (e) {
      return null
    }
  }

  function contextPressureProjectedTokensOf(session: SessionLike): number | null {
    const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    if (!projections || typeof projections.snapshot !== 'function') return null
    try {
      const snap = projections.snapshot(session)
      const values = snap && snap.values
      const contextPressure = values ? (values as { contextPressure?: { projectedTokens?: unknown } }).contextPressure : undefined
      const projected = contextPressure && typeof contextPressure.projectedTokens === 'number' ? contextPressure.projectedTokens : null
      return projected
    } catch (e) {
      return null
    }
  }

  function occupancyTokensOf(session: SessionLike): number | null {
    const projected = contextPressureProjectedTokensOf(session)
    if (projected !== null) return projected
    return surfaceTokensOf(session)
  }

  function resolveService(agent: AgentLike, serviceName: string): unknown {
    const direct = ctx.get(serviceName)
    if (direct) return direct
    // agentPresets 按每次调用解析（apply 时注册表可能尚未挂载）。
    const agentPresets = ctx.get('agentPresets')
    const presets = agentPresets as { serviceFor?: (agent: { ctx: unknown }, name: string) => unknown } | undefined
    if (presets && typeof presets.serviceFor === 'function' && agent && agent.ctx) {
      try {
        const viaPreset = presets.serviceFor({ ctx: agent.ctx }, serviceName)
        if (viaPreset) return viaPreset
      } catch (e) {
        /* 忽略错误，继续向下 */
      }
    }
    return undefined
  }

  function agentOf(exec: { agent?: unknown }): AgentWithSession | null {
    const agent = exec.agent as AgentLike | undefined
    if (!agent || !agent.session) return null
    return agent as AgentWithSession
  }

  async function readSurfaceNodes(agent: AgentWithSession): Promise<SurfaceNode[] | null> {
    const sessionQuery = resolveService(agent, 'sessionQuery') as SessionQueryLike | undefined
    if (!sessionQuery) return null
    const snap = await sessionQuery.readSurface(agent.session.id)
    return snap && Array.isArray(snap.events) ? (snap.events as SurfaceNode[]) : []
  }

  // Turn-basierte Schnitt-Planung (Anordnung des Menschen 2026-10-30). Der gemessene
  // Schaden: "kompaktiere aggressiv, mindestens 300.000 Token" kam jedes Mal als
  // 10.000 Token zurück, und das Modell behauptete danach, 300.000 gespart zu haben.
  // Der Grund ist nicht das Werkzeug, sondern die Messbarkeit — die Token-Distanz
  // zwischen zwei Anker-Markern steht an keiner Stelle, die das Modell lesen kann,
  // also rät es und greift den letzten kleinen Brocken. Diese Zählung nach Zügen
  // macht die Größe jeder möglichen Verdichtung lesbar, und die Werkzeug-Antwort
  // nennt die frei gewordenen Token aus dem Kern, nicht aus dem Modellmund.
  interface MeterNodeLike { seq?: unknown; tokens?: unknown }
  interface TokenMeterFullLike { measure(session: SessionLike): { nodes?: readonly MeterNodeLike[] } | null | undefined }

  /** The turn table of a live session, read synchronously (the nudge provider must be sync). */
  function turnTableOf(session: SessionLike & TrunkSessionLike): TurnTable | null {
    const nodes = surfaceEvents(session)
    if (!nodes.length) return null
    const tokensBySeq = new Map<number, number>()
    const meter = ctx.get('tokenMeter') as TokenMeterFullLike | undefined
    if (meter && typeof meter.measure === 'function') {
      try {
        const m = meter.measure(session)
        const list = m && Array.isArray(m.nodes) ? m.nodes : []
        for (const n of list) {
          if (typeof n.seq === 'number' && typeof n.tokens === 'number') tokensBySeq.set(n.seq, n.tokens)
        }
      } catch (e) {
        /* sizes stay absent: rows report 0 tokens and the tool says so */
      }
    }
    const logEvents: TurnLogEvent[] = []
    if (typeof session.snapshotEvents === 'function') {
      try {
        for (const ev of session.snapshotEvents()) {
          if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) logEvents.push({ seq: ev.seq, type: ev.type, data: ev.data })
        }
      } catch (e) {
        /* no log access: the table stays empty and the tool reports that */
      }
    }
    return buildTurnTable(logEvents, nodes.map((n) => ({ seq: n.seq, type: String(n.type ?? '') })), tokensBySeq)
  }

  /** The working-memory window: newest finished turns a compaction must not touch. */
  function keepTurnsOf(override?: unknown): number {
    if (typeof override === 'number' && Number.isFinite(override)) return Math.max(0, Math.floor(override))
    const n = typeof config.keepTurns === 'number' && Number.isFinite(config.keepTurns) ? config.keepTurns : 3
    return Math.max(0, Math.floor(n))
  }

  // 按会话顺序编号的归档：从会话 spill 目录已有的最大数字后缀推导下一个编号；
  // 无 `root` 字段的后端降级为内存计数器。
  const archiveCounters = new Map<string, number>()

  function spillRootOf(spillStore: SpillStoreLike): string | null {
    const s = spillStore as unknown as { root?: unknown } | null
    return s && typeof s.root === 'string' && s.root ? s.root : null
  }

  function sessionSpillDir(root: string, sessionId: string): string {
    return join(root, 'session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 12))
  }

  // 会话 spill 目录中已存在的最大数字后缀，不存在则为 0。
  async function maxArchiveNumber(root: string, sessionId: string): Promise<number> {
    try {
      const entries = await readdir(sessionSpillDir(root, sessionId))
      let max = 0
      for (const name of entries) {
        const m = /-(\d+)\.txt$/.exec(name)
        if (m) max = Math.max(max, Number(m[1]))
      }
      return max
    } catch (e) {
      return 0 // 目录缺失或不可读：回退到内存计数器
    }
  }

  async function archiveSpan(agent: AgentWithSession, spillStore: SpillStoreLike, nodes: SurfaceNode[], si: number, ei: number): Promise<SurfaceArchive | null> {
    if (!spillStore) return null
    const content = spanText(nodes, si, ei)
    const sid = agent.session.id
    const root = spillRootOf(spillStore)
    const scanned = root ? await maxArchiveNumber(root, sid) : 0
    const n = Math.max(scanned, archiveCounters.get(sid) ?? 0) + 1
    archiveCounters.set(sid, n)
    const ref = await spillStore.saveText({
      owner: { sessionId: sid },
      source: { toolName: 'context_compact', callId: null, label: 'auto-archive' },
      suggestedName: String(n).padStart(6, '0') + '.txt',
      content,
    })
    return {
      locator: ref.locator,
      bytes: ref.bytes,
      retrievalHint: ref.retrievalHint,
      chars: content.length,
      archivedSeqs: nodes.slice(si, ei + 1).map((n) => n.seq),
    }
  }

  // 从持久的 compaction/summary 事件中读取摘要用量。
  function findSummaryUsage(session: SessionLike, compactionId: unknown): JsonValue | null {
    try {
      const events = session.events
      if (!events) return null
      const keys = Object.keys(events)
      for (let i = keys.length - 1; i >= 0; i--) {
        const ev = (events as unknown as Record<string, unknown>)[keys[i]] as { type?: string; data?: { compactionId?: unknown; usage?: JsonValue } } | undefined
        if (ev && ev.type === 'compaction/summary' && ev.data && ev.data.compactionId === compactionId) {
          return ev.data.usage ?? null
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    return null
  }

  const disposers: (() => void)[] = []

  // `context_compact` 的主机级 system-prompt 指引（order 118，全局提示层）。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    disposers.push(systemPrompt.section({
      name: 'tool:context_compact',
      order: 118,
      text: 'Use the context_compact tool only at the end of a finished phase: a brainstorming or finding stretch, or an implementation run whose todo list is complete. Compact the whole finished phase in one checkpoint, as the last action of your own turn after you have answered the human. Never compact in reply to a message of the human, never for a single step or a few tool calls, and never to get rid of one large tool result. Lossless is mandatory: the checkpoint must carry every detail that will be needed afterwards, small details included — exact paths, commands, IDs, names, numbers, the human\'s decisions and wording. Nothing that served the work may be lost by the compaction; there is no size cap on the checkpoint, and a checkpoint that drops a detail to stay small is a failed compaction. Compress only a span whose information a summary fully covers for the rest of the conversation, and never compress the opening, the in-flight task, or the active instruction. Write the checkpoint for the next similar task: keep exact paths, commands, IDs, measured pitfalls, numbers, rejected approaches with the reason, and the human\'s decisions and preferences; drop only real noise. Expert sessions: if you work as a teammate in an Agent Team, you are the standing expert for your area and will be woken again later for similar tasks, so a finished topic is stock for the next one, not dead weight. For you, "a summary fully covers the span" also means it covers what a later, similar task would need: keep measured pitfalls, exact node, parameter and function names, commands verbatim, paths, intermediate results with their numbers, rejected approaches together with the reason, and the human\'s decisions and preferences. Drop only real noise, such as repeated failed attempts and bulky output without a finding. Write the checkpoint too detailed rather than too terse; the archive behind context_recall is the safety net, not a substitute for a good checkpoint, because you only recall what you notice is missing. Forked sessions: when this session was forked from another (a teammate or subagent created as a fork) or has forks of its own, the inherited history is a trunk shared with them, and the inference engine reuses its prompt cache only while that trunk stays byte-identical everywhere. Never compact a span inside that trunk with the default scope; when the trunk itself must shrink, call context_compact with scope "trunk", which compacts the whole inherited trunk into one shared checkpoint that every sibling reuses byte for byte. When a detail you need was compacted away, read it back with context_recall instead of guessing or redoing the work. Measuring before cutting is not optional: call context_compact_plan to see the session\'s finished turns and the token size of every candidate span, then compact with `turns=N` for a bulk cut that folds several finished scenes into one checkpoint (the human\'s order 2026-10-30: bundle scenes in one rutsch, stay incremental, never stop at the last small block). The newest finished turns inside the working-memory window are never touched. The result carries `freedTokens` measured by the engine — report that number and never a bigger saving you estimated.',
    }))
  }

  // Shared trunk: learn which fork points each parent handed out, from the
  // children's own session headers (durable: the registry persists them).
  disposers.push(ctx.on('session/event', (session: SessionLike | undefined) => {
    try {
      const s = session as (SessionLike & TrunkSessionLike) | undefined
      if (!s || registry.seen(s.id)) return
      const parent = forkParent(s)
      if (!parent) return
      void registry.record(parent, s.id, forkCut(s))
    } catch (e) {
      /* ignore: the registry is an optimization */
    }
  }))

  // Shared trunk: patch the compaction engine as soon as an agent exists, so the
  // automatic compaction path is guarded before it first runs. The engine may
  // live in a preset realm, hence the per-agent resolution.
  const patchFor = (agent: AgentLike | undefined) => {
    try {
      if (!agent) return
      const engine = resolveService(agent, 'compaction') as OptimizedEngineLike | undefined
      if (engine) patchEngine(engine, trunkDeps)
    } catch (e) {
      ctx.logger.warn('[context_compact] could not patch the compaction engine: %s', e instanceof Error ? e.message : String(e))
    }
  }
  disposers.push(ctx.on('agent/created', (payload) => {
    patchFor(payload ? (payload.agent as unknown as AgentLike) : undefined)
    return undefined
  }))
  try {
    const agentsService = ctx.get('agents') as { list?: () => Iterable<AgentLike> } | undefined
    if (agentsService && typeof agentsService.list === 'function') for (const agent of agentsService.list()) patchFor(agent)
  } catch (e) {
    /* agents service not mounted yet: agent/created covers later agents */
  }

  // 通过 systemPrompt.context() 注入尾部实时提示：仅在增长跨过整数倍的那几步
  // Fork: Anker-Marker im Nudge. Der Hinweis listet die letzten verankerbaren
  // Nachrichten mit einer festen Kennung `[a###]` auf. Ein Modell, das diese
  // Kennung als startAnchor/endAnchor uebernimmt, trifft genau den gemeinten
  // Knoten — nie mehrdeutig, nie nicht gefunden. Das ist die Antwort auf das
  // gemessene Hauptproblem (60 von 73 Fehlversuchen waren Anker-Fehler, fast
  // alle AMBIGUOUS). Die Kennung ist die Pruefsumme der seq: das Modell kann
  // sie nicht raten, also kann ein zitierter Marker nie einen Knoten meinen,
  // den es nicht gibt.
  if (systemPrompt) {
    // Synchron und ohne sessionQuery: die Oberflaeche kommt aus der Sitzung
    // selbst (session.surface.nodes + eventAt), so wie es der Trunk-Schutz
    // auch macht. Der Kontext-Provider muss synchron sein.
    //
    // Fork (2026-10-29): das Fenster ist 24 Meldungen statt 8. Der Grund ist
    // gemeldet: ein Span, der weiter zurueckliegt, hat in der Liste keinen
    // Marker fuer seinen Anfang — das Modell muss Worte zitieren, und die
    // Anfaenge der Harness-Meldungen sind vorgeschrieben, also trifft der
    // Zitat-Anker mehrere Knoten (AMBIGUOUS). Die Liste erscheint nur, wenn
    // die harte Obergrenze feuert (Belegung >= contextHardLimitTokens), 24
    // Zeilen kosten dafuer rund 400 Token — gegen ein 300k-Fenster billig.
    const MARKER_WINDOW = 24
    // Layer-Cake (2026-10-29): die Preis-Schätzung. Der Mensch hat entschieden,
    // dass das Modell den Preis in Token kennen muss, bevor es einen Schnitt in
    // der Mitte wählen darf (Entscheidung 1: „Verdichtung dem Modell überlassen
    // MIT Preis“). Der Preis eines Schnitts ist die Zahl der Token, die nach
    // dem Schnitt neu gelesen werden — alles hinter dem Schnitt ist nach der
    // Umschreibung nicht mehr byte-gleich, also nicht mehr cache-gültig.
    // Gemessen am Strata-Log: Schnitt am Anfang 108428, in der Mitte 130562, am
    // Ende nur 31951. Die Zeile muss den Preis nennen, sonst rät das Modell.
    const surfaceNodesOf = (session: SessionLike): SurfaceNode[] => {
      const evs = surfaceEvents(session as never)
      return evs.map((e) => {
        const ev = e as { seq?: unknown; type?: unknown; data?: unknown }
        return { seq: ev.seq as number, type: ev.type as string, data: ev.data } as SurfaceNode
      })
    }
    const tailPriceOfSeq = (nodes: SurfaceNode[], seq: number): number | null => {
      const i = nodes.findIndex((n) => n.seq === seq)
      if (i < 0) return null
      return tailCutPrice(nodes, i)
    }
    const markerLines = (session: SessionLike): string => {
      try {
        const evs = surfaceEvents(session as never)
        if (!evs.length) return ''
        const nodes = surfaceNodesOf(session)
        const eligible: { seq: number; type: string }[] = []
        for (let i = evs.length - 1; i >= 0 && eligible.length < MARKER_WINDOW; i--) {
          const e = evs[i] as { seq?: unknown; type?: unknown }
          if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
          eligible.unshift({ seq: e.seq as number, type: e.type as string })
        }
        if (!eligible.length) return ''
        return eligible.map((e) => {
          const ev = evs.find((x) => (x as { seq?: unknown }).seq === e.seq) as { data?: unknown } | undefined
          const n: SurfaceNode = { seq: e.seq, type: e.type, data: ev?.data }
          const opening = nodeFlatText(n, { skipReasoning: true, dropImages: false }).replace(/\s+/g, ' ').slice(0, 60)
          const price = tailPriceOfSeq(nodes, e.seq)
          return markerTag(e.seq) + (opening ? ' ' + opening : '') + (price !== null ? ' | cut price ≈ ' + price + ' tokens' : '')
        }).join('\n')
      } catch (err) {
        return ''
      }
    }

    disposers.push(systemPrompt.context({
      name: 'agent-compact:volume-nudge',
      order: 50,
      text: () => {
        try {
          const hardLimit = config.contextHardLimitTokens
          if (!(hardLimit > 0)) return ''
          const agentsService = ctx.get('agents')
          const current = agentsService && typeof (agentsService as { currentInitiator?: unknown }).currentInitiator === 'function'
            ? (agentsService as { currentInitiator: () => unknown }).currentInitiator()
            : undefined
          const agent = current as { session?: SessionLike } | undefined
          if (!agent || !agent.session) return ''
          const now = occupancyTokensOf(agent.session)
          if (now === null) return ''
          // Der Phasenhinweis ist entfernt (Anordnung des Menschen 2026-10-30:
          // „der phasenhinweis muss raus“). Die einzige Auslöser-Meldung ist die
          // harte Obergrenze; das Modell verdichtet sonst aus der Regel im
          // Werkzeugtext, am Ende einer abgeschlossenen Phase.
          if (nudgeMode(now, hardLimit) !== 'limit') return ''
          const markers = markerLines(agent.session)
          // Turn-basierte Größe (Anordnung des Menschen 2026-10-30): die harte
          // Obergrenze nennt die größte sichere Bündel-Verdichtung in Token, damit
          // das Modell nicht rät und den letzten 10.000-Token-Brocken nimmt.
          const table = turnTableOf(agent.session as SessionLike & TrunkSessionLike)
          const rows = table ? planRows(table, keepTurnsOf(), 3) : []
          const bulk = rows.length
            ? '\n\nBulk compaction by turns — the sizes are measured, not guessed. The newest ' + keepTurnsOf() + ' finished turn(s) stay untouched:\n' +
              rows.map((r) => 'turns=' + r.k + ': frees ~' + r.grossTokens + ' tokens (' + r.nodes + ' nodes), cut price ~' + r.priceTokens + ' tokens').join('\n') +
              '\nCall context_compact with turns=' + rows[0].k + ' and your summary; call context_compact_plan for the markers.'
            : ''
          return limitNudgeText(now) + bulk +
            (markers ? '\n\nAnchor markers for the most recent messages, each with its cut price — using one as startAnchor or endAnchor names exactly one message and never fails (preferred over quoting text). The price is the tokens re-read if you cut at that marker; a lower price means a cheaper cut:\n' + markers : '')
        } catch (e) {
          return ''
        }
      },
    }))
  }

  // Was der Aufrufer tun soll, wenn ein frisches compaction kein summary mitbringt.
  function summaryRequiredError(sid: string): string {
    const kept = stash.list(sid)
    const head = 'summary is REQUIRED for a fresh compaction: write the Markdown checkpoint yourself (this tool makes no LLM summarizer call)'
    if (!config.keepFailedSummary || !kept.length) return head
    return head + '\nthe kept text of a previous failure is reused ONLY for the SAME span: retry that span with the same anchors and WITHOUT summary. If you change an anchor, that is a different span and it needs its own summary — the kept text will not be reused for it. After an AMBIGUOUS anchor, the neighbour-anchored retry the hint recommends (the span one node shorter) reuses it too' + (keptLabel(kept[0]) ? ' (the newest kept text belongs to ' + keptLabel(kept[0]) + ')' : '')
  }

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Compress a past conversation span into one Markdown checkpoint you write; the raw span stays readable with context_recall, the compaction recorded. Anchor matching: anchors match the opening text of a message body (user/assistant messages only; tool-call blocks, tool results, and other transcript structure excluded). Whitespace, tool-call markers, and full/half-width punctuation differences are ignored; each anchor must match exactly one user or assistant message. When to compact: only at the end of a finished phase (a brainstorming or finding stretch, or an implementation run whose todo list is complete), the whole phase in one checkpoint, as the last action of your own turn — never as the reply to a message of the human and never for a single step. The scenes below describe what to write: ① Progress — a finished phase, keeping the active instruction and remaining steps live; ② Course correction — compact the failed span into a checkpoint recording what went wrong and the corrected direction, instead of carrying noise forward; ③ Rebaseline — stale opening requirements: compact the start too, restating current intent and what survives. Checkpoint: Markdown bullets under ## sections, complete rather than terse; keep exact paths/commands/IDs and the user\'s requirements and direction. The checkpoint is also the human\'s scrollable marker in the chat: it opens with a real Markdown H1 heading `# 📌 ZWISCHENFAZIT — <three words naming what this phase was about>`, never a code block, never a smaller heading, and the word ZWISCHENFAZIT always spelled identically so it can be searched. Under the heading the first lines are the standing, the decision, and the handgrips that come next in the order the human performs them; a checkpoint that only reports is noise. Write it for the next similar task, not only for this one: keep measured pitfalls, exact names, numbers, rejected approaches with the reason and the human\'s decisions; a teammate or expert session errs on too detailed rather than too terse. Per scene — Progress: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Current Work / Next Step; Correction: what went wrong / root cause / fix / next; Rebaseline: current intent / surviving decisions / plan ahead. Constraints: one compaction per session at a time; the checkpoint is lossless — it must carry every detail that will be needed afterwards, small details included, and there is no size cap on it; edges snap to balanced tool-call/result boundaries. A failed compaction keeps the checkpoint text you wrote: retry the same span WITHOUT summary to reuse it unchanged (write a new summary only to rewrite the text) — never rewrite a kept checkpoint from memory when the retry can take it back. Shared trunk: in a forked session (or one with forks of its own) the inherited history is shared with the other forks; a default-scope span may not start inside it. scope "trunk" compacts exactly that inherited trunk — no anchors, no summary — into one checkpoint that is generated once and reused byte for byte by every sibling, keeping the shared prompt cache intact. Choosing anchors (this is where most calls fail — read it before the first attempt): an anchor must be the VERBATIM opening of a message that is still on the surface, and it must fit exactly ONE message. Three rules, in order: (1) Anchor on TEXT YOU WROTE, not on text you remember thinking. Only the visible messages are on the surface; anything that stood solely in your reasoning is not, so it can never match. Quote the first words of a message exactly as they were written, including the opening punctuation. (2) Copy the opening, do not paraphrase it. "The list is done" does not match "Die Leseliste ist durchgearbeitet"; a reworded or translated anchor never matches, and neither does the middle of a message — only its beginning. (3) Make it unique. Openings repeat: several tool calls of the same tool, several messages beginning with "Ok", every checkpoint beginning the same way. If the opening is generic, extend it into the part that is unique to that one message — for a tool call quote the marker AND the first characters of its argument, e.g. `[tool-call Bash] {"command":"cd /repo && ls`; a marker without an argument names one of hundreds of calls and is rejected as ambiguous. If a call fails, the error names the reason and lists the last messages of the surface with copyable openings — copy one of those openings verbatim instead of retrying a variant of the same anchor. Do not retry the same anchor twice. LAYER-CAKE (the default for choosing WHERE to compact): lay a thick layer, then compact the backmost finished section into one thin checkpoint appended at the end; only the newest layer is ever touched, everything before it stays byte-identical and cache-valid. A cut in the middle re-reads every token after it (the price is the tokens after the cut, shown per marker in the reminder); a cut at the end re-reads only the tail, so prefer rare, big compactions of the backmost section over many small ones, and prefer a boundary at a 16384-token grid edge — the engine places cache checkpoints only there. A small span at the end has obvious, unique anchors and is much easier to get right. The endAnchor may be OMITTED: the span then ends at the LAST node on the surface, which is exactly the Layer-Cake cut, so a single start marker is enough. Never anchor the end on your own in-flight answer — the turn you are writing is not on the surface, so such an anchor can never be found; omit the endAnchor instead. BULK COMPACT BY TURNS (the way to reach a large saving): call context_compact_plan first — it measures the session by finished turns and lists each candidate span with its size in tokens; then pass `turns=N` plus your summary, and the span comes from that measurement, not from quoted openings. A bulk compaction folds several finished scenes into ONE checkpoint (bundling scenes is the point), and the newest finished turns inside the working-memory window stay untouched. MEASURED, NOT CLAIMED: the result carries `freedTokens` counted by the engine; report that number. Saying you saved 300k tokens after a 10k cut is a fabrication — the human sees the measured number.',
    parameters: {
      scope: { type: 'string', enum: ['span', 'trunk'], description: 'Optional. "span" (default) compacts the span between the anchors with your summary. "trunk" compacts the whole history this forked session shares with its siblings or forks into the shared checkpoint; startAnchor, endAnchor and summary are ignored.' },
      startAnchor: { type: 'string', description: 'Verbatim opening of the span\'s first message — or, PREFERRED, a marker id like `[a7730ed]` from the reminder\'s anchor-marker list: it names exactly one message and never fails. Otherwise see "Choosing anchors" in the description. Omit it only to rebaseline from the beginning; the span then starts after the system prompt.' },
      endAnchor: { type: 'string', description: 'Verbatim opening of the span\'s last message, or PREFERRED a marker id like `[a7730ed]` from the reminder\'s anchor-marker list. OPTIONAL and the SAFE default: omit it and the span ends at the last FINISHED node on the surface (everything before your own, still unanswered context_compact call), which is the Layer-Cake cut. An endAnchor on a node inside a step that is still open is rejected as "not a balanced boundary"; omitting it never is. Never anchor the end on your own in-flight answer — the current turn is not on the surface, so such an anchor can never match; omit the endAnchor instead. This node is replaced — pass its predecessor\'s marker to keep it.' },
      summary: { type: 'string', description: 'Required for scope "span" on a fresh compaction. The full Markdown checkpoint replacing the span, written by you from the conversation; never verbatim. Per-scene structure as in the description; lossless is mandatory — keep every detail a later similar task could need, small details included, with no size cap on the checkpoint. After a failed compaction you may OMIT it to reuse the kept text of that failure unchanged (retried for the same span, or for the neighbour-anchored retry the AMBIGUOUS hint recommends); pass a new one to rewrite it.' },
      turns: { type: 'number', description: 'BULK COMPACT (the way to reach a large token saving): fold the oldest `turns` finished turns into ONE checkpoint, as counted by context_compact_plan. Use this instead of startAnchor/endAnchor for a bulk cut — the plan tool names the exact number and its size in tokens. The newest finished turns inside the working-memory window are never included. Pass summary together with it.' },
      keep_turns: { type: 'number', description: 'Optional override of the working-memory window (newest finished turns that must stay untouched) for this call. Defaults to the profile setting (3).' },
    },
    output: {
      // 显式声明真实字段（而非开放的 additionalProperties:true 空对象），
      // 使 Code Mode 的 ToolOutputMap 能推导出这个工具的真实返回类型。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Always true on a successful call (a failure throws instead).' },
          archived: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  locator: { type: 'json', required: true, description: 'Opaque spill-store locator for the archived raw span.' },
                  retrievalHint: { type: 'json', required: true, description: 'Backend-specific hint for retrieving the archived span.' },
                },
              },
            ],
            description: 'Archive record when the raw span was saved, or null when it was not.',
          },
          archiveError: { type: 'string', description: 'Present only when autoArchive was requested but archiving failed; compaction still succeeded.' },
          sharedTrunk: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string', required: true, description: 'Content address of the inherited trunk.' },
              reused: { type: 'boolean', required: true, description: 'True when the checkpoint already existed (written by a sibling) and was reused byte for byte.' },
            },
            description: 'Present only for scope "trunk".',
          },
          recall: { type: 'string', description: 'Archive id of the compacted original, for context_recall.' },
          reused: { type: 'boolean', description: 'Present and true when summary was omitted and the kept text of the previous failure was reused.' },
          kept: { type: 'boolean', description: 'Present and true when this call failed and its checkpoint text was kept for the retry (omit summary on the retry to reuse it).' },
          freedTokens: { type: 'number', description: 'The MEASURED tokens this compaction freed, counted by the engine over the shadowed nodes. Report this number, never your own estimate; a claim of a larger saving is a fabrication.' },
          bulkTurns: { type: 'number', description: 'Present for a turns=N bulk compaction: the number of finished turns folded into this one checkpoint.' },
        },
      },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const sid = agent.session.id
      const rawScope = args.scope as unknown
      const scope = rawScope === undefined || rawScope === null || rawScope === '' ? 'span' : rawScope
      if (scope !== 'span' && scope !== 'trunk') throw new Error('scope must be "span" or "trunk"')
      const summaryArg = typeof args.summary === 'string' && args.summary.trim() ? args.summary : null
      const rawStartAnchor = typeof args.startAnchor === 'string' && args.startAnchor.trim() ? args.startAnchor : undefined
      const rawEndAnchor = typeof args.endAnchor === 'string' && args.endAnchor.trim() ? args.endAnchor : undefined
      const engine = resolveService(agent, 'compaction') as CompactionLike | undefined
      if (!engine) throw new Error('compaction service is not available in this runtime (tried host plane and preset realm)')
      patchEngine(engine as unknown as OptimizedEngineLike, trunkDeps)
      const nodes = await readSurfaceNodes(agent)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const session = agent.session as SessionLike & TrunkSessionLike
      const cut = await effectiveCut(session, registry)

      let si = -1
      let ei = -1
      let startSeq = -1
      let endSeq = -1
      let trunkPlan: ReturnType<typeof planTrunk> = null
      let trunkReused = false
      // Bulk-Schnitt nach Zügen: declared here so the result can report it.
      let bulk = false
      let turnsArg: number | undefined
      // For scope "span" without summary: the kept entry the retry reuses.
      let keptEntry: KeptSummary | null = null
      // The checkpoint text handed to the engine (scope "span" only).
      let summaryText: string | null = null
      if (scope === 'trunk') {
        if (!(cut > 0)) {
          throw new Error('scope "trunk" applies only to a forked session (a teammate or subagent created as a fork) or to a session with known forks of its own; this session has no inherited trunk. Use the default scope with startAnchor, endAnchor and summary.')
        }
        trunkPlan = planTrunk(session, cut)
        if (!trunkPlan) {
          throw new Error('the inherited trunk is already compacted into the shared checkpoint; nothing is left to compact there. Compact your own later spans with the default scope.')
        }
        startSeq = trunkPlan.startSeq
        endSeq = trunkPlan.endSeq
        si = nodes.findIndex((n) => n.seq === startSeq)
        ei = nodes.findIndex((n) => n.seq === endSeq)
      } else {
        // Checkpoint-Wiederverwendung (./summary-stash.ts): der Text eines
        // Fehlschlags bleibt in der Ablage, ein erneuter Aufruf ohne summary
        // nimmt ihn unverändert wieder auf — der Wiederversuch kostet dann nur
        // den Werkzeugaufruf, nicht die erneute Niederschrift des Checkpoints.
        summaryText = summaryArg
        // Bulk-Schnitt nach Zügen (Anordnung des Menschen 2026-10-30): „nicht nur
        // ein Ding, sondern mehrere, hintereinander — halt in einem Riesenrutsch“
        // und „immer noch inkrementell“. Das Modell nennt die Zahl der fertigen
        // Züge, die in EINEN Checkpoint gebündelt werden; die Grenzen kommen aus
        // der Turn-Tabelle, nicht aus zitierten Anfängen, weil die Ankerwahl das
        // gemessene Versagen war (10.000 statt 300.000 Token).
        const turnsArgLocal = typeof args.turns === 'number' && Number.isFinite(args.turns) ? Math.max(0, Math.floor(args.turns)) : undefined
        turnsArg = turnsArgLocal
        if (turnsArg !== undefined && turnsArg > 0) {
          const table = turnTableOf(session)
          if (!table) throw new Error('the turn table is not available for this session; call context_compact_plan to measure, then compact with startAnchor/endAnchor')
          const keep = keepTurnsOf(args.keep_turns)
          const row = turnCutRow(table, turnsArg, keep)
          if (!row) {
            throw new Error('turns=' + turnsArg + ' is not a safe bulk compaction: the working-memory window keeps the newest ' + keep + ' finished turn(s) untouched, and ' + table.turns.filter((g) => g.finished).length + ' finished turn(s) exist. Call context_compact_plan to see the allowed rows.')
          }
          if (!summaryArg) throw new Error('turns=' + turnsArg + ' needs summary: write the checkpoint that covers all ' + turnsArg + ' turns (lossless, one checkpoint for the whole stretch)')
          si = nodes.findIndex((n) => n.seq === row.startSeq)
          ei = nodes.findIndex((n) => n.seq === row.endSeq)
          if (si < 0 || ei < si) throw new Error('the turn table range [' + row.startSeq + ',' + row.endSeq + '] is no longer on the surface; call context_compact_plan again')
          startSeq = row.startSeq
          endSeq = row.endSeq
          bulk = true
          // A turn boundary is balanced by construction (the turn ended, so every
          // tool call in the span has its result); check it here rather than let
          // the core reject a mid-step end after the checkpoint was written.
          if (!balancedAfterEach(nodes)[ei]) {
            throw new Error('turns=' + turnsArg + ' ends inside a step that is still open (seq ' + endSeq + '); call context_compact_plan again — the running turn is never included')
          }
          if (config.keepFailedSummary) stash.save(sid, { text: summaryText as string, startAnchor: rawStartAnchor, endAnchor: rawEndAnchor, startSeq, endSeq })
        }
        if (summaryArg && config.keepFailedSummary && !bulk) {
          // Sofort merken: auch wenn die Anker-Auflösung gleich scheitert
          // (AMBIGUOUS / not found), bleibt der Text erhalten.
          stash.save(sid, { text: summaryArg, startAnchor: rawStartAnchor, endAnchor: rawEndAnchor })
        } else if (!summaryArg && rawStartAnchor === undefined && rawEndAnchor === undefined) {
          // Ohne Anker und ohne summary: der blanke Wiederversuch des letzten
          // Fehlschlags — derselbe Bereich, derselbe Text.
          const last = stash.list(sid)[0] ?? null
          if (!last || last.startSeq === undefined || last.endSeq === undefined) throw new Error(summaryRequiredError(sid))
          keptEntry = last
          summaryText = last.text
          si = nodes.findIndex((n) => n.seq === last.startSeq)
          ei = nodes.findIndex((n) => n.seq === last.endSeq)
          if (si < 0 || ei < si) {
            throw new Error('the kept checkpoint text targets range [' + last.startSeq + ',' + last.endSeq + '], which is no longer on the surface; pass startAnchor, endAnchor and summary again')
          }
          startSeq = last.startSeq
          endSeq = last.endSeq
          // Herausnehmen wie beim Anker-Wiederversuch: bei Erfolg ist der
          // Eintrag verbraucht, bei Fehlschlag wird er unten wieder abgelegt.
          stash.takeMatched(sid, { startSeq: last.startSeq, endSeq: last.endSeq })
        }
        if (!keptEntry && !bulk) {
          let b: ReturnType<typeof resolveBoundaries>
          try {
            b = resolveBoundaries(nodes, args)
          } catch (e) {
            const msg = e && (e as Error).message ? (e as Error).message : String(e)
            throw new Error(summaryArg && config.keepFailedSummary
              ? msg + '\nthe checkpoint text you wrote is kept; retry with a corrected endAnchor and omit summary to reuse it'
              : msg)
          }
          si = b.si
          ei = b.ei
          startSeq = b.startSeq
          endSeq = b.endSeq
          if (summaryArg) {
            if (config.keepFailedSummary) {
              // Mit den aufgelösten Grenzen aktualisieren (gleicher Text und
              // dieselben Anker ersetzen den Eintrag an derselben Stelle).
              stash.save(sid, { text: summaryText as string, startAnchor: rawStartAnchor, endAnchor: rawEndAnchor, startSeq, endSeq })
            }
          } else {
            const hit = stash.takeMatched(sid, { startAnchor: rawStartAnchor, endAnchor: rawEndAnchor, startSeq, endSeq })
            if (hit) {
              keptEntry = hit
              summaryText = hit.text
            } else {
              // Regel 4 (./summary-stash.ts): der Wiederversuch, den die
              // AMBIGUOUS-Meldung empfiehlt — der Anker sitzt jetzt auf dem
              // Vorgaenger des Kandidaten, also endet die Spanne einen Knoten
              // kuerzer. Der Text des Fehlschlags gehoert zu genau diesem
              // Versuch und wird unverändert wiederbenutzt.
              const nextSeq = ei + 1 < nodes.length ? nodes[ei + 1].seq : null
              const resolve = (anchor: string): number[] => {
                const h = prefixHits(nodes, anchor)
                return h.map((i) => nodes[i].seq)
              }
              const nb = stash.takeNeighbourMatched(sid, { startAnchor: rawStartAnchor, endAnchor: rawEndAnchor, startSeq, endSeq }, nextSeq, resolve)
              if (!nb) throw new Error(summaryRequiredError(sid))
              keptEntry = nb
              summaryText = nb.text
            }
          }
        }
        // Shared trunk lock: a default-scope span must start after the protected prefix.
        if (cut > 0) {
          const locked = lockedSpanError(surfaceEvents(session), cut, startSeq)
          if (locked) throw new Error(locked)
        }
        // 把 agent 编写的检查点交给引擎；被修补的 summarizer 消费它（一次性）
        // 并完全跳过 LLM 调用。
        const ext = ((engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary ??= {})
        ext[sid] = summaryText as string
      }

      // Span scope keeps its raw span in the session's spill archive here; the
      // trunk scope keeps it in the shared trunk archive (runTrunkCompaction).
      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      const optimized = engine as unknown as OptimizedEngineLike
      let archived: SurfaceArchive | null = null
      let archiveError: JsonValue | null = null
      let recallId: string | null = null
      if (!trunkPlan && config.autoArchive && spillStore && si >= 0 && ei >= si) {
        try {
          archived = await archiveSpan(agent, spillStore, nodes, si, ei)
          recallId = archived ? spanArchiveId(spillRootOf(spillStore), String(archived.locator)) : null
        } catch (err) {
          archiveError = err && (err as Error).message ? (err as Error).message : String(err)
        }
      } else if (!trunkPlan && config.autoArchive) {
        archiveError = spillStore ? 'span not found on the read surface; raw copy not saved (compaction still proceeds)' : 'spillStore unavailable; raw copy not saved (compaction still proceeds)'
      }
      // One shot: the patched summarize() appends the recall reference to this checkpoint.
      if (recallId) (optimized._acArchiveIds ??= {})[sid] = recallId

      // `undefined` marks "not yet compacted"; the catch below either retries
      // once (system-head case) or throws, so the read after the try block is
      // always a real result — checked explicitly instead of non-null asserted.
      let result: CompactionResultLike | undefined
      try {
        result = trunkPlan
          ? await runTrunkCompaction(optimized, agent, trunkPlan, exec.signal) as CompactionResultLike
          : await engine.compactRegion(startSeq, endSeq, agent, exec.signal)
      } catch (err) {
        let msg = err && (err as Error).message ? (err as Error).message : String(err)
        // Never leave a one-shot summary behind for a later, unrelated compaction.
        const ext = (engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary
        if (ext) delete ext[sid]
        // Systemkopf-Falle (gemessen 2026-10-30): der Kern schützt Position 0,
        // wenn sie die Systemnachricht trägt (`assertSystemHeadRewrite` in
        // dsh-session), und lehnt jeden Schnitt ab, der dort beginnt. Beginnt
        // die Spanne nach unserer Zählung nicht auf 0, der Kern sieht sie aber
        // auf seiner eigenen Oberfläche so, dann ist die Antwort: den Start um
        // einen Knoten verschieben und denselben Bereich noch einmal
        // verdichten. Der Checkpoint-Text liegt bereit, es wird nichts neu
        // geschrieben, und das Modell sieht die Meldung nie.
        if (!trunkPlan && /node 0 holds the system prompt/.test(msg) && si === 0 && ei > si) {
          si += 1
          startSeq = nodes[si].seq
          if (ext && summaryText) ext[sid] = summaryText
          try {
            result = await engine.compactRegion(startSeq, endSeq, agent, exec.signal)
            msg = ''
          } catch (err2) {
            msg = err2 && (err2 as Error).message ? (err2 as Error).message : String(err2)
            const ext2 = (engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary
            if (ext2) delete ext2[sid]
          }
        }
        if (msg) {
          // Den geschriebenen Checkpoint-Text behalten: der nächste Versuch darf
          // ihn ohne summary unverändert wiederverwenden (./summary-stash.ts).
          let kept = false
          if (!trunkPlan && config.keepFailedSummary && summaryText) {
            stash.save(sid, { text: summaryText, startAnchor: rawStartAnchor, endAnchor: rawEndAnchor, startSeq, endSeq })
            kept = true
          }
          throw new Error('compaction rejected range [' + startSeq + ',' + endSeq + ']: ' + msg + (kept
            ? '\nthe checkpoint text you wrote is kept; retry the same range without summary to reuse it unchanged (the raw span is still in the conversation; pass summary only to rewrite it)'
            : ''))
        }
      } finally {
        if (optimized._acArchiveIds) delete optimized._acArchiveIds[sid]
      }
      if (!result) throw new Error('compaction produced no result for range [' + startSeq + ',' + endSeq + ']')
      if (trunkPlan) {
        // Decide "reused" from the stored entry's origin: with concurrent siblings
        // a pre-check cannot tell who generated the text.
        const entry = await memo.get(trunkPlan.key)
        trunkReused = !!entry && entry.origin.sessionId !== agent.session.id
        // The trunk archive id follows from the key (see trunkRecallId).
        recallId = entry ? trunkRecallId(trunkPlan.key, entry.blocks) : null
      }
      const usage = findSummaryUsage(agent.session, result.compactionId)
      // 成对清理：检查点是单独注入的，为避免检查点文本在 surface 出现两次，
      // 将该 tool-call 的 assistant/message 与其 tool/result 各 shadow 为一个
      // 占位符（仅当该消息恰好只含这一个 tool-call 时才安全）。
      const callId = (exec as { callId?: unknown }).callId
      if (typeof callId === 'string' && callId) {
        const holder = nodes.filter((n) => soleToolCall(n, callId)).pop()
        const assistantSeq = holder ? holder.seq : undefined
        if (assistantSeq !== undefined && assistantSeq > endSeq) {
          let done = false
          const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
            if (done) return
            if (!s || s.id !== sid) return
            if (ev.type !== 'tool/result') return
            const d = ev.data as { message?: { source?: { callId?: unknown } } } | null | undefined
            const src = d && d.message && d.message.source ? d.message.source.callId : undefined
            if (src !== callId) return
            done = true
            try {
              off()
            } catch (e) {
              /* 忽略 */
            }
            try {
              const session = agent.session as unknown as { append: (type: string, data: unknown, opts: unknown) => unknown }
              if (!session || typeof session.append !== 'function') return
              // 监听器在框架的 tool/result 发布流程内同步执行（appending 仍为
              // true），同步 append 会触发重入保护；延迟到微任务队列。
              const resultSeq = ev.seq
              const run = () => {
                try {
                  // 把归档定位符写进完成消息（承载它的 tool/result 随后被 shadow）。
                  const locText = archived && archived.locator ? String(archived.locator) : ''
                  const freedText = result.shadowedTokenCount !== undefined && result.shadowedTokenCount !== null
                    ? '; freed ~' + String(result.shadowedTokenCount) + ' tokens'
                    : ''
                  const doneText = (trunkPlan
                    ? '`context_compact` scope "trunk" done: the inherited trunk is now the shared checkpoint above (' + (trunkReused ? 'reused byte for byte from a sibling' : 'generated here; siblings will reuse it byte for byte') + '); do not call scope "trunk" again'
                    : '`context_compact` done: checkpoint above') + freedText + (recallId
                    ? '; full original kept for context_recall archive="' + recallId + '".'
                    : locText
                      ? '; raw span archived at ' + locText + '.'
                      : '; raw span not archived.')
                  session.append('user/message', createShadowUserMessage(doneText), {
                    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq },
                    sourceEventSeqs: [assistantSeq],
                  })
                  // 复用该占位槽位作为自我触发的习惯提醒：每次成功调用都给
                  // 下一次留下提示，引导模型自主管理上下文。
                  session.append('user/message', createShadowUserMessage('`context_compact` result shadowed. Keep managing context this way on your own: once the next sub-task finishes, an error gets resolved, or a large tool result has been fully digested, compact that span before it goes stale — do not wait to be asked again.'), {
                    surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
                    sourceEventSeqs: [resultSeq],
                  })
                  ctx.logger.info('[context_compact] %s paired cleanup: shadowed assistant/message %d + tool/result %d', sid, assistantSeq, resultSeq)
                } catch (e) {
                  ctx.logger.warn('[context_compact] %s paired cleanup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
                }
              }
              if (typeof queueMicrotask === 'function') queueMicrotask(run)
              else setTimeout(run, 0)
            } catch (e) {
              ctx.logger.warn('[context_compact] %s paired cleanup setup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
            }
          })
        }
      }
      // 调试指标只进日志，不进入模型可见的工具结果。
      ctx.logger.info('[context_compact] %s %s %d..%d, shadowed %d nodes / %s tokens, surface %d -> after, usage=%o', agent.session.id, trunkPlan ? 'shared trunk' : 'span', startSeq, endSeq, Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0, String(result.shadowedTokenCount ?? '?'), nodes.length, usage)
      // Die gemessene Zahl geht INS Modell-Ergebnis (Anordnung des Menschen
      // 2026-10-30): das Modell behauptete „300.000 Token gespart“ nach einem
      // 10.000-Token-Schnitt. Es hat keine eigene Messung; die Zahl des Kerns
      // ist die einzige, die es nennen darf, also steht sie im Ergebnis und in
      // der Fertig-Meldung, die der Kern an den Checkpoint hängt.
      const freedMeasured = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : null
      const out: {
        ok: boolean
        archived: { locator: JsonValue; retrievalHint: JsonValue } | null
        archiveError?: string
        sharedTrunk?: { key: string; reused: boolean }
        recall?: string
        reused?: boolean
        freedTokens?: number
        bulkTurns?: number
      } = {
        ok: true,
        archived: archived ? {
          locator: archived.locator,
          retrievalHint: archived.retrievalHint,
        } : null,
      }
      if (archiveError) out.archiveError = typeof archiveError === 'string' ? archiveError : String(archiveError)
      if (trunkPlan) out.sharedTrunk = { key: trunkPlan.key, reused: trunkReused }
      if (recallId) out.recall = recallId
      if (keptEntry) out.reused = true
      if (freedMeasured !== null) out.freedTokens = freedMeasured
      if (bulk && turnsArg !== undefined) out.bulkTurns = turnsArg
      return out
    },
  })))

  // The measuring tool (Anordnung des Menschen 2026-10-30: "da müssen wir vielleicht
  // ein Tool bauen, was womit es das messen kann"). It answers the question the
  // model cannot answer from the transcript: how big is each candidate compaction.
  disposers.push(tools.register(defineTool({
    name: 'context_compact_plan',
    description: 'Measure compaction candidates before compacting: the turn table of this session — every finished turn, its token size, and the spans a bulk compaction can fold into one checkpoint. Use this instead of guessing an anchor span. It names the working-memory window (the newest finished turns you must keep) and flags rows below a requested minimum. Pass the row\'s `turns` number to context_compact as `turns`; do not quote openings for a bulk compaction.',
    parameters: {
      keep_turns: { type: 'number', description: 'Working-memory window: the newest N finished turns must stay untouched. Defaults to this profile\'s setting (3).' },
      min_freed: { type: 'number', description: 'Optional: the minimum tokens one compaction must free. Rows below it are flagged as too small.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The turn table: one line per candidate span, with the markers to copy and the tokens each cut frees.' },
        },
      },
      render(args, value) { return [{ type: 'text', text: (value as { text: string }).text }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const session = agent.session as SessionLike & TrunkSessionLike
      const table = turnTableOf(session)
      if (!table) throw new Error('the turn table is not available: this session surface holds no nodes (a fresh session has nothing to measure yet)')
      const keep = keepTurnsOf(args.keep_turns)
      const minFreed = typeof args.min_freed === 'number' && Number.isFinite(args.min_freed) ? Math.max(0, Math.floor(args.min_freed)) : undefined
      const rows = planRows(table, keep, 8)
      const finished = table.turns.filter((g) => g.finished).length
      const running = table.turns.length - finished
      const head =
        'Turn table: ' + table.totalSurfaceTokens + ' tokens on the surface, ' + finished + ' finished turn(s)' +
        (running > 0 ? ' plus ' + running + ' running turn (never compactable)' : '') +
        '. Working-memory window: the newest ' + keep + ' finished turn(s) stay untouched.'
      if (!rows.length) {
        return { text: head + '\nNothing is safe to compact yet: every finished turn sits inside the working-memory window. Keep working, then measure again when a longer stretch has closed.' }
      }
      const lines = rows.map((r) =>
        'turns=' + r.k + ': ' + r.startMarker + ' .. ' + r.endMarker +
        ' | frees ~' + r.grossTokens + ' tokens (' + r.nodes + ' nodes)' +
        ' | cut price ~' + r.priceTokens + ' tokens' +
        (minFreed !== undefined && r.grossTokens < minFreed ? ' | TOO SMALL for the requested minimum of ' + minFreed : ''),
      )
      const deepest = rows[0]
      return {
        text: head + '\n' + lines.join('\n') +
          '\n\nCall context_compact with turns=' + deepest.k + ' (plus your checkpoint as summary) for the largest safe compaction. ' +
          'A bulk compaction folds whole scenes into ONE checkpoint — do not split a finished stretch into several small ones, and do not stop at the last small block. ' +
          'The freed-token number you get back from context_compact is measured by the engine; report that number, never your own estimate.',
      }
    },
  })))

  // Recall: read a compacted span's original back. The result is a tool result
  // at the end of the conversation, so the cached prefix stays as it is.
  disposers.push(tools.register(defineTool({
    name: 'context_recall',
    description: 'Read the original messages behind a checkpoint. Every checkpoint ends with a reference `context_recall archive="…"`; pass that id to read the compacted span verbatim, page by page, or with query only the messages that contain it. The result is appended at the end of the conversation; earlier context stays unchanged. Without archive, lists the archives the checkpoints in this conversation reference.',
    parameters: {
      archive: { type: 'string', description: 'Archive id from a checkpoint\'s context_recall reference. Omit to list the referenced archives.' },
      query: { type: 'string', description: 'Optional. Return only the messages that contain every word of this text (case-insensitive) instead of all messages in order.' },
      offset: { type: 'number', description: 'Optional. Skip this many messages (matches when query is set). Default 0; the result names the offset that continues it.' },
      maxChars: { type: 'number', description: 'Optional size of the returned page in characters. Default ' + DEFAULT_MAX_CHARS + ', at most ' + MAX_CHARS + '.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The page: a status line, then the messages.' },
        },
      },
      render(args, value) { return [{ type: 'text', text: (value as { text: string }).text }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      const roots = { spillRoot: spillStore ? spillRootOf(spillStore) : null, storeDir }
      const id = typeof args.archive === 'string' ? args.archive.trim() : ''
      if (!id) {
        const nodes = await readSurfaceNodes(agent)
        if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
        const ids = referencedIds(nodes.map((n) => JSON.stringify(n)).join('\n'))
        if (!ids.length) return { text: 'No checkpoint in this conversation references an archive.' }
        const lines: string[] = []
        for (const ref of ids.slice(0, 50)) {
          try {
            const { text } = await trunkArchive.read(ref, roots)
            lines.push('- ' + ref + ': ' + splitBlocks(text).length + ' messages, ' + text.length + ' characters')
          } catch (e) {
            lines.push('- ' + ref + ': unavailable (' + (e instanceof Error ? e.message : String(e)) + ')')
          }
        }
        return { text: ids.length + ' archive(s) referenced by checkpoints in this conversation, oldest first:\n' + lines.join('\n') }
      }
      const { text, path } = await trunkArchive.read(id, roots)
      return {
        text: renderRecall(id, text, path, {
          query: typeof args.query === 'string' ? args.query : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
        }),
      }
    },
  })))

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

