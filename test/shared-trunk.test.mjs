// Shared-trunk extension: fork detection, protected prefix, content address,
// memo, fork registry and the guarded engine — all against synthetic sessions
// shaped like @deepseek-ai/dsh-session's Session (no Cordis runtime needed).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson,
  forkCut,
  forkParent,
  lockedSpanError,
  protectedEndIndex,
  surfaceEvents,
  trunkKey,
  trunkSpan,
} from '../lib/trunk.js'
import { ForkRegistry, SharedTrunkMemo } from '../lib/memo.js'
import { patchEngine, planGuard, TRUNK_PROVIDER } from '../lib/optimizer.js'

// ---- synthetic sessions ------------------------------------------------------

const sys = (seq) => ({ seq, type: 'system/message', time: 1, data: { message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] } } })
const user = (seq, text) => ({ seq, type: 'user/message', time: 1, data: { role: 'user', content: [{ type: 'text', text }] } })
const asst = (seq, text) => ({ seq, type: 'assistant/message', time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const mark = (seq, type, data = {}) => ({ seq, type, time: 1, data })

/** Parent log: two completed turns. Surface [0, 2, 3, 6, 7]. */
function parentEvents() {
  return [
    sys(0),
    mark(1, 'turn/start', { turn: 1 }),
    user(2, 'task A: read the logs'),
    asst(3, 'did A, found three errors'),
    mark(4, 'turn/end', { turn: 1, reason: 'stop' }),
    mark(5, 'turn/start', { turn: 2 }),
    user(6, 'task B: fix error one'),
    asst(7, 'fixed error one'),
    mark(8, 'turn/end', { turn: 2, reason: 'stop' }),
  ]
}

function makeSession({ id, log, surface, isSeeded = false, parentSession, inheritedEventCount = 0 }) {
  return {
    id,
    header: { isSeeded, ...(parentSession ? { parentSession } : {}) },
    inheritedEventCount,
    log,
    surface: { nodes: surface },
    eventAt(seq) { return this.log[seq] },
    snapshotEvents(from = 0, to = this.log.length) { return this.log.slice(from, to) },
  }
}

function makeParent(id = 'session-lead') {
  return makeSession({ id, log: parentEvents(), surface: [0, 2, 3, 6, 7] })
}

/** A fork of the parent, with the seed copied the way DSH copies it (JSON snapshot). */
function makeFork(id, ownText, { shuffleKeys = false } = {}) {
  let seed = JSON.parse(JSON.stringify(parentEvents()))
  if (shuffleKeys) seed = seed.map((ev) => Object.fromEntries(Object.entries(ev).reverse()))
  const log = [
    ...seed,
    mark(9, 'session/end-seed', { inherited: true }),
    mark(10, 'turn/start', { turn: 3 }),
    user(11, 'child task: ' + ownText),
    asst(12, 'working on ' + ownText),
    user(13, 'more for ' + ownText),
    asst(14, 'still on ' + ownText),
  ]
  return makeSession({ id, log, surface: [0, 2, 3, 6, 7, 11, 12, 13, 14], isSeeded: true, parentSession: 'session-lead', inheritedEventCount: 9 })
}

/** A minimal BasicCompactionEngine double: same compactRegion/summarize contract. */
class FakeEngine {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs
    this.summarizeCalls = 0
    this.regions = []
  }
  async summarize(input, agent) {
    this.summarizeCalls++
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    return {
      summary: [{ type: 'text', text: 'SUMMARY by ' + agent.session.id + ' of ' + input.length + ' nodes', extra: 'provider-specific' }],
      rawOutput: [],
      llmStreamCall: true,
      provider: 'fake',
      model: 'fake-model',
      usage: { input: 10, output: 5 },
    }
  }
  async compactRegion(start, end, agent) {
    const s = agent.session
    const nodes = s.surface.nodes
    const si = nodes.indexOf(start)
    const ei = nodes.indexOf(end)
    if (si < 0 || ei < 0 || si > ei) throw new Error('compactRegion: bad range ' + start + '..' + end)
    const shadowed = nodes.slice(si, ei + 1)
    const r = await this.summarize(shadowed, agent)
    const sumSeq = s.log.length
    s.log.push(mark(sumSeq, 'compaction/summary', { summary: r.summary, provider: r.provider, model: r.model }))
    const seq = s.log.length
    s.log.push({
      seq,
      type: 'user/message',
      time: 1,
      data: { role: 'user', content: [{ type: 'text', text: 'PREAMBLE <compacted-summary>' }, ...r.summary, { type: 'text', text: '</compacted-summary>' }], source: { kind: 'compact-checkpoint', compactionId: 'c' + seq } },
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [sumSeq, ...shadowed],
    })
    s.surface.nodes = [...nodes.slice(0, si), seq, ...nodes.slice(ei + 1)]
    this.regions.push([start, end])
    return { compactionId: 'c' + seq, shadowedSeqs: shadowed, shadowedRange: { start, end }, summary: r.summary, provider: r.provider }
  }
  /** The automatic path: compact from the first non-system node through the second-to-last node. */
  async compactIfNeeded(agent) {
    const n = agent.session.surface.nodes
    return this.compactRegion(n[1], n[n.length - 2], agent)
  }
}

function deps(memo, registry, guard = true) {
  const logs = []
  return { memo, registry, guard, log: (level, msg) => logs.push(level + ' ' + msg), logs }
}

const checkpointContent = (session) => {
  const ev = session.log[session.surface.nodes[1]]
  return ev.data.content
}

// ---- pure helpers ------------------------------------------------------------

test('fork cut and parent come from the session header and inherited count', () => {
  assert.equal(forkCut(makeParent()), 0)
  assert.equal(forkParent(makeParent()), null)
  const child = makeFork('session-a', 'x')
  assert.equal(forkCut(child), 9)
  assert.equal(forkParent(child), 'session-lead')
})

test('protected prefix covers inherited nodes and checkpoints that replaced inherited nodes', () => {
  const child = makeFork('session-a', 'x')
  const surface = surfaceEvents(child)
  assert.equal(protectedEndIndex(surface, 9), 4) // seq 7 is the last inherited node
  assert.deepEqual(trunkSpan(surface, 9), { si: 1, ei: 4 })
  assert.equal(protectedEndIndex(surface, 0), -1)
  assert.equal(trunkSpan(surface, 0), null)
})

test('the lock refuses spans that start inside the trunk and names the first own message', () => {
  const child = makeFork('session-a', 'parser')
  const surface = surfaceEvents(child)
  const err = lockedSpanError(surface, 9, 2)
  assert.match(err, /^LOCKED/)
  assert.match(err, /child task: parser/)
  assert.equal(lockedSpanError(surface, 9, 11), null)
  assert.equal(lockedSpanError(surface, 0, 2), null)
})

test('canonical JSON ignores key order and mirrors JSON.stringify omissions', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, undefined, 'x'], c: undefined }), '{"a":[1,null,"x"],"b":1}')
  assert.equal(canonicalJson({ a: { y: 2, x: 1 } }), canonicalJson({ a: { x: 1, y: 2 } }))
})

test('trunk key: identical for parent and every fork, different when the trunk differs', () => {
  const parent = makeParent()
  const a = makeFork('session-a', 'x')
  const b = makeFork('session-b', 'y', { shuffleKeys: true })
  const kParent = trunkKey(parent.snapshotEvents(0, 9))
  const kA = trunkKey(a.snapshotEvents(0, 9))
  const kB = trunkKey(b.snapshotEvents(0, 9))
  assert.match(kA, /^[0-9a-f]{64}$/)
  assert.equal(kA, kB)
  assert.equal(kA, kParent)
  const changed = a.snapshotEvents(0, 9).map((e) => (e.seq === 3 ? asst(3, 'did A, found FOUR errors') : e))
  assert.notEqual(trunkKey(changed), kA)
})

// ---- memo and registry -------------------------------------------------------

test('memo: concurrent requests for one key run the generator once', async () => {
  const memo = new SharedTrunkMemo(null)
  const key = 'a'.repeat(64)
  let runs = 0
  const gen = async () => {
    runs++
    await new Promise((r) => setTimeout(r, 20))
    return { blocks: ['shared text'] }
  }
  const [x, y] = await Promise.all([memo.getOrCreate(key, gen), memo.getOrCreate(key, gen)])
  assert.equal(runs, 1)
  assert.deepEqual(x.entry.blocks, ['shared text'])
  assert.deepEqual(y.entry.blocks, ['shared text'])
  assert.equal([x.created, y.created].filter(Boolean).length, 1)
})

test('memo: a failed generation is not remembered', async () => {
  const memo = new SharedTrunkMemo(null)
  const key = 'b'.repeat(64)
  await assert.rejects(memo.getOrCreate(key, async () => { throw new Error('llm down') }), /llm down/)
  const ok = await memo.getOrCreate(key, async () => ({ blocks: ['second try'] }))
  assert.equal(ok.created, true)
  assert.deepEqual(ok.entry.blocks, ['second try'])
})

test('memo and registry persist across instances (restart)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-compact-test-'))
  try {
    const key = 'c'.repeat(64)
    await new SharedTrunkMemo(dir).getOrCreate(key, async () => ({ blocks: ['persisted'], sessionId: 's1' }))
    const again = await new SharedTrunkMemo(dir).get(key)
    assert.deepEqual(again.blocks, ['persisted'])
    assert.equal(again.origin.sessionId, 's1')
    const reg = new ForkRegistry(dir)
    await reg.record('session-lead', 'session-a', 9)
    await reg.record('session-lead', 'session-b', 9)
    await reg.record('session-lead', 'session-c', 15)
    assert.deepEqual(await new ForkRegistry(dir).cutsOf('session-lead'), [9, 15])
    assert.deepEqual((await readdir(join(dir, 'trunk'))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('memo rejects malformed keys', async () => {
  const memo = new SharedTrunkMemo(null)
  await assert.rejects(memo.get('../etc/passwd'), /invalid key/)
})

// ---- guarded engine ----------------------------------------------------------

test('siblings compacting automatically land byte-identical trunk checkpoints with one summarizer call', async () => {
  const engine = new FakeEngine()
  const d = deps(new SharedTrunkMemo(null), new ForkRegistry(null))
  assert.equal(patchEngine(engine, d), true)
  const a = makeFork('session-a', 'parser')
  const b = makeFork('session-b', 'renderer')

  await engine.compactIfNeeded({ session: a })
  await engine.compactIfNeeded({ session: b })

  assert.equal(engine.summarizeCalls, 1, 'the second sibling reuses the memo')
  assert.deepEqual(engine.regions, [[2, 7], [2, 7]], 'both compacted exactly the trunk block')
  assert.deepEqual(checkpointContent(a), checkpointContent(b))
  // Normalized blocks: the provider-specific field is gone for the generating sibling too.
  assert.deepEqual(checkpointContent(a)[1], { type: 'text', text: 'SUMMARY by session-a of 4 nodes' })
  // Own history after the trunk is untouched.
  assert.deepEqual(a.surface.nodes.slice(2), [11, 12, 13, 14])
  const summaryEvent = a.log.find((e) => e.type === 'compaction/summary')
  assert.equal(summaryEvent.data.provider, TRUNK_PROVIDER)
})

test('concurrent sibling compactions share one in-flight generation', async () => {
  const engine = new FakeEngine({ delayMs: 30 })
  patchEngine(engine, deps(new SharedTrunkMemo(null), new ForkRegistry(null)))
  const a = makeFork('session-a', 'parser')
  const b = makeFork('session-b', 'renderer')
  await Promise.all([engine.compactIfNeeded({ session: a }), engine.compactIfNeeded({ session: b })])
  assert.equal(engine.summarizeCalls, 1)
  assert.deepEqual(checkpointContent(a), checkpointContent(b))
})

test('after the trunk is compacted, automatic compaction is clamped behind it', async () => {
  const engine = new FakeEngine()
  patchEngine(engine, deps(new SharedTrunkMemo(null), new ForkRegistry(null)))
  const a = makeFork('session-a', 'parser')
  await engine.compactIfNeeded({ session: a })
  const trunkCheckpoint = a.surface.nodes[1]
  await engine.compactIfNeeded({ session: a })
  assert.deepEqual(engine.regions[1], [11, 13], 'second compaction starts after the shared checkpoint')
  assert.equal(a.surface.nodes[1], trunkCheckpoint, 'the shared checkpoint stays in place')
})

test('sessions without a trunk pass through unchanged', async () => {
  const engine = new FakeEngine()
  patchEngine(engine, deps(new SharedTrunkMemo(null), new ForkRegistry(null)))
  const lead = makeParent()
  await engine.compactIfNeeded({ session: lead })
  assert.deepEqual(engine.regions, [[2, 6]])
  assert.equal(engine.summarizeCalls, 1)
  const ev = lead.log[lead.surface.nodes[1]]
  assert.equal(ev.data.content[1].extra, 'provider-specific', 'stock summarizer output is untouched')
})

test('a parent with registered forks compacts the same canonical trunk and reuses the siblings\' checkpoint', async () => {
  const engine = new FakeEngine()
  const registry = new ForkRegistry(null)
  patchEngine(engine, deps(new SharedTrunkMemo(null), registry))
  const a = makeFork('session-a', 'parser')
  await registry.record(forkParent(a), a.id, forkCut(a))
  await engine.compactIfNeeded({ session: a })

  // The lead kept working after the fork: two more own nodes.
  const lead = makeParent()
  lead.log.push(mark(9, 'turn/start', { turn: 3 }), user(10, 'lead continues'), asst(11, 'lead answer'), user(12, 'lead next'))
  lead.surface.nodes = [...lead.surface.nodes, 10, 11, 12]
  await engine.compactIfNeeded({ session: lead })

  assert.equal(engine.summarizeCalls, 1, 'the lead reuses the trunk checkpoint its fork generated')
  assert.deepEqual(engine.regions[1], [2, 7])
  assert.deepEqual(checkpointContent(lead), checkpointContent(a))
  assert.deepEqual(lead.surface.nodes.slice(2), [10, 11, 12])
})

test('the agent-written checkpoint path still works for own spans after the trunk', async () => {
  const engine = new FakeEngine()
  patchEngine(engine, deps(new SharedTrunkMemo(null), new ForkRegistry(null)))
  const a = makeFork('session-a', 'parser')
  engine._externalSummary = { 'session-a': 'MY OWN CHECKPOINT' }
  await engine.compactRegion(11, 12, { session: a })
  assert.equal(engine.summarizeCalls, 0, 'no LLM call for an agent-written checkpoint')
  assert.deepEqual(engine.regions, [[11, 12]])
  assert.equal(checkpointContentAt(a, 5)[1].text, 'MY OWN CHECKPOINT')
  assert.deepEqual(a.surface.nodes.slice(0, 5), [0, 2, 3, 6, 7], 'trunk untouched')
})

function checkpointContentAt(session, index) {
  return session.log[session.surface.nodes[index]].data.content
}

test('guard disabled: ranges reaching into the trunk run as requested', async () => {
  const engine = new FakeEngine()
  patchEngine(engine, deps(new SharedTrunkMemo(null), new ForkRegistry(null), false))
  const a = makeFork('session-a', 'parser')
  await engine.compactIfNeeded({ session: a })
  assert.deepEqual(engine.regions, [[2, 13]])
})

test('planGuard: passthrough for spans after the trunk, trunk plan for spans inside it', async () => {
  const registry = new ForkRegistry(null)
  const a = makeFork('session-a', 'parser')
  assert.deepEqual(await planGuard(a, 11, 13, registry), { kind: 'passthrough' })
  const plan = await planGuard(a, 3, 12, registry)
  assert.equal(plan.kind, 'trunk')
  assert.equal(plan.startSeq, 2)
  assert.equal(plan.endSeq, 7)
  assert.equal(plan.key, trunkKey(a.snapshotEvents(0, 9)))
})

test('re-patching does not stack wrappers', async () => {
  const engine = new FakeEngine()
  const d = deps(new SharedTrunkMemo(null), new ForkRegistry(null))
  patchEngine(engine, d)
  const first = engine.summarize
  engine.__ctxcOptimized = 0 // simulate a hot reload of an older patch version
  patchEngine(engine, d)
  assert.notEqual(engine.summarize, first)
  const a = makeFork('session-a', 'parser')
  await engine.compactIfNeeded({ session: a })
  assert.equal(engine.summarizeCalls, 1)
})
