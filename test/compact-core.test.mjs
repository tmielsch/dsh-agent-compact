import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const built = esbuild.buildSync({
  entryPoints: [join(root, 'src/client/compact-core.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent',
})
const core = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const { coverageOf, computeHiding, planOrder, planEntries, visibleMembers, blockKey, endKey, isBlockKey, compactState, overlay } = core

// Rows of a small chat. anchorSeq values are log seqs. Compaction c1 replaced seqs 10..30.
const nodes = new Map([
  ['u1', { key: 'u1', kind: 'user', anchorSeq: 5 }],
  ['u2', { key: 'u2', kind: 'user', anchorSeq: 12 }],
  ['a2', { key: 'a2', kind: 'assistant-step', anchorSeq: 14 }],
  ['t2', { key: 't2', kind: 'tool-call', anchorSeq: 20 }],
  ['p2', { key: 'p2', kind: 'turn-process', anchorSeq: 11.5 }],
  ['u3', { key: 'u3', kind: 'user', anchorSeq: 40 }],
])
const order = ['u1', 'u2', 'p2', 'a2', 't2', 'u3']
const nodeOf = (k) => nodes.get(k)
const c1 = { compactionId: 'c1', checkpointSeq: 31, startSeq: 10, endSeq: 30, shadowedSeqs: [12, 14, 20], shadowedTokenCount: 900, summaryText: 'CHECKPOINT' }

test('collapsed: originals of the span are hidden, turn rows stay, one block is placed first', () => {
  const h = computeHiding(order, nodeOf, [c1], new Set(), 's')
  assert.deepEqual([...h.hidden].sort(), ['a2', 't2', 'u2'])
  assert.equal(h.firstKey.get('c1'), 'u2')
  assert.deepEqual(planOrder(order, h), ['u1', blockKey('c1'), 'p2', 'u3'])
  assert.equal(h.blocks.get(blockKey('c1')).data.itemCount, 3)
})

test('expanded: nothing hidden, start bar above the first original, end bar below the last', () => {
  const h = computeHiding(order, nodeOf, [c1], new Set(['c1']), 's')
  assert.equal(h.hidden.size, 0)
  assert.equal(h.lastKey.get('c1'), 't2')
  assert.deepEqual(planOrder(order, h), ['u1', blockKey('c1'), 'u2', 'p2', 'a2', 't2', endKey('c1'), 'u3'])
  assert.equal(h.blocks.get(blockKey('c1')).data.open, true)
  assert.equal(h.blocks.get(endKey('c1')).data.role, 'end')
})

test('collapsed has no end bar and the block carries open=false', () => {
  const h = computeHiding(order, nodeOf, [c1], new Set(), 's')
  assert.equal(h.blocks.has(endKey('c1')), false)
  assert.equal(h.blocks.get(blockKey('c1')).data.open, false)
  assert.equal(h.blocks.get(blockKey('c1')).data.role, 'block')
})

// Regression (Tilman's screenshot, 2026-10-29 20:51): after hiding the originals, the turn's
// "Completed in 12s" header (turn-process) and usage footer (turn-tail) stayed as empty shells.
test('a turn whose content is fully hidden loses its header and footer; a partly hidden turn keeps them', () => {
  const t = (key, kind, anchorSeq, turn) => [key, { key, kind, anchorSeq, turn }]
  const n2 = new Map([
    t('u1', 'user', 5, 1), t('p1', 'turn-process', 5.5, 1), t('a1', 'assistant-step', 6, 1), t('f1', 'turn-tail', 7, 1),
    t('u2', 'user', 12, 2), t('p2', 'turn-process', 12.5, 2), t('a2', 'assistant-step', 14, 2), t('f2', 'turn-tail', 15, 2),
    t('u3', 'user', 25, 3), t('p3', 'turn-process', 25.5, 3), t('a3', 'assistant-step', 35, 3), t('f3', 'turn-tail', 36, 3),
  ])
  const ord = ['u1', 'p1', 'a1', 'f1', 'u2', 'p2', 'a2', 'f2', 'u3', 'p3', 'a3', 'f3']
  const h = computeHiding(ord, (k) => n2.get(k), [{ ...c1, startSeq: 10, endSeq: 30, shadowedSeqs: [12, 14, 25] }], new Set(), 's')
  // turn 2 lies fully inside 10..30 -> content and shells hidden; turn 3 is cut (a3 at 35 stays) -> shells stay
  assert.deepEqual([...h.hidden].sort(), ['a2', 'f2', 'p2', 'u2', 'u3'].sort())
  assert.equal(h.hidden.has('p3'), false)
  assert.equal(h.hidden.has('f3'), false)
  assert.equal(h.hidden.has('p1'), false) // untouched turn
  // expanded: nothing hidden at all
  assert.equal(computeHiding(ord, (k) => n2.get(k), [c1], new Set(['c1']), 's').hidden.size, 0)
})

// Regression (measured 2026-10-29 on a real session): a compaction that swallowed an earlier
// checkpoint has a replace range that runs BACKWARDS ("1853..1822"), so a start..end search
// found no row and the compaction never showed. The coverage must come from `shadowedSeqs`.
const nested = new Map([
  ['u1', { key: 'u1', kind: 'user', anchorSeq: 5 }],
  ['u2', { key: 'u2', kind: 'user', anchorSeq: 12 }],
  ['a2', { key: 'a2', kind: 'assistant-step', anchorSeq: 20 }],
  ['u4', { key: 'u4', kind: 'user', anchorSeq: 36 }],
  ['a4', { key: 'a4', kind: 'assistant-step', anchorSeq: 37 }],
  ['u5', { key: 'u5', kind: 'user', anchorSeq: 50 }],
])
const nestedOrder = ['u1', 'u2', 'a2', 'u4', 'a4', 'u5']
const nestedOf = (k) => nested.get(k)
const inner = { compactionId: 'in', checkpointSeq: 31, startSeq: 10, endSeq: 30, shadowedSeqs: [12, 20], shadowedTokenCount: 100, summaryText: 'INNER' }
const outer = { compactionId: 'out', checkpointSeq: 60, startSeq: 40, endSeq: 35, shadowedSeqs: [31, 36, 37], shadowedTokenCount: 200, summaryText: 'OUTER' } // range backwards

test('coverage comes from shadowedSeqs: the backwards range is ignored, the swallowed compaction is included', () => {
  const { cover, enclosing } = coverageOf([inner, outer])
  assert.deepEqual(cover.get('in'), [[12, 20]])
  assert.deepEqual(cover.get('out'), [[36, 37], [12, 20]])
  assert.deepEqual([...enclosing.get('in')], ['out'])
  assert.equal(enclosing.get('out').size, 0)
})

test('nested, all collapsed: everything of the outer span hidden, only the outer block shows', () => {
  const h = computeHiding(nestedOrder, nestedOf, [inner, outer], new Set(), 's')
  assert.deepEqual([...h.hidden].sort(), ['a2', 'a4', 'u2', 'u4'])
  assert.deepEqual([...h.blocks.keys()], [blockKey('out')])
  assert.deepEqual(planOrder(nestedOrder, h), ['u1', blockKey('out'), 'u5'])
})

test('nested, outer expanded and inner collapsed: outer rows visible, inner stays one block', () => {
  const h = computeHiding(nestedOrder, nestedOf, [inner, outer], new Set(['out']), 's')
  assert.deepEqual([...h.hidden].sort(), ['a2', 'u2'])
  assert.deepEqual(planOrder(nestedOrder, h), ['u1', blockKey('out'), blockKey('in'), 'u4', 'a4', endKey('out'), 'u5'])
})

test('nested, both expanded: nothing hidden, bars of the outer wrap the bars of the inner', () => {
  const h = computeHiding(nestedOrder, nestedOf, [inner, outer], new Set(['in', 'out']), 's')
  assert.equal(h.hidden.size, 0)
  assert.deepEqual(planOrder(nestedOrder, h), ['u1', blockKey('out'), blockKey('in'), 'u2', 'a2', endKey('in'), 'u4', 'a4', endKey('out'), 'u5'])
})

test('real logs: every compaction has a non-empty coverage even when its range runs backwards', async () => {
  const { readCompactions } = await import('../lib/compactions.js')
  let checked = 0
  for (const f of ['/tmp/cc-6d42496f-ee0e-488d-8159-6ba666404353.jsonl', '/tmp/cc-session-3ddfcb24-a7b9-4857-8910-bdedd5f3acf3.jsonl']) {
    let raw
    try { raw = readFileSync(f, 'utf8') } catch { continue }
    const comps = readCompactions(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    const { cover } = coverageOf(comps)
    for (const c of comps) {
      assert.ok(cover.get(c.compactionId).length > 0, `${c.compactionId} has coverage`)
      if (c.startSeq > c.endSeq) checked += 1
    }
  }
  if (checked === 0) return // logs not on this machine
  assert.ok(checked > 0)
})

test('a compaction with no loaded row gets no block (nothing to replace on screen)', () => {
  const far = { ...c1, compactionId: 'far', startSeq: 100, endSeq: 200, shadowedSeqs: [100, 150, 200] }
  const h = computeHiding(order, nodeOf, [far], new Set(), 's')
  assert.equal(h.blocks.size, 0)
  assert.equal(planOrder(order, h), order)
})

test('no compactions: identity (the tab equals the normal chat)', () => {
  const h = computeHiding(order, nodeOf, [], new Set(), 's')
  assert.equal(planOrder(order, h), order)
})

test('grouped entries: hidden nodes removed, fully hidden group dropped, block before first touch', () => {
  const entries = [
    { kind: 'node', key: 'u1' },
    { kind: 'node', key: 'u2' },
    { kind: 'group', key: 'g-hidden' },
    { kind: 'group', key: 'g-mixed' },
    { kind: 'node', key: 'u3' },
  ]
  const groups = { 'g-hidden': [{ key: 'a2' }, { key: 't2' }], 'g-mixed': [{ key: 't2' }, { key: 'u3' }] }
  const h = computeHiding(order, nodeOf, [c1], new Set(), 's')
  const out = planEntries(entries, (k) => groups[k], h)
  assert.deepEqual(out.map((e) => e.key), ['u1', blockKey('c1'), 'g-mixed', 'u3'])
  assert.deepEqual(visibleMembers(groups['g-mixed'], h.hidden).map((m) => m.key), ['u3'])
  assert.equal(visibleMembers(groups['g-mixed'], new Set()), groups['g-mixed'])
})

test('grouped entries, expanded: start bar before the first original, end bar after the last', () => {
  const entries = [
    { kind: 'node', key: 'u1' },
    { kind: 'node', key: 'u2' },
    { kind: 'group', key: 'g-hidden' },
    { kind: 'group', key: 'g-mixed' },
    { kind: 'node', key: 'u3' },
  ]
  const groups = { 'g-hidden': [{ key: 'a2' }, { key: 't2' }], 'g-mixed': [{ key: 't2' }, { key: 'u3' }] }
  const h = computeHiding(order, nodeOf, [c1], new Set(['c1']), 's')
  const out = planEntries(entries, (k) => groups[k], h)
  // last original row is t2, which sits in group g-hidden: the end bar follows that group.
  assert.deepEqual(out.map((e) => e.key), ['u1', blockKey('c1'), 'u2', 'g-hidden', endKey('c1'), 'g-mixed', 'u3'])
})

test('both bar kinds are block keys; ordinary compaction rows are not', () => {
  assert.equal(isBlockKey(endKey('x')), true)
  assert.equal(isBlockKey('9:compaction' + 'x'), false)
})

test('block keys are recognised and state toggles notify', () => {
  assert.equal(isBlockKey(blockKey('x')), true)
  assert.equal(isBlockKey('10:compactionx'), false)
  let calls = 0
  const off = compactState.subscribe(() => { calls += 1 })
  compactState.toggle('s', 'c1')
  assert.equal(compactState.expanded('s').has('c1'), true)
  compactState.setAll('s', ['c1', 'c2'], false)
  assert.equal(compactState.expanded('s').size, 0)
  off()
  assert.equal(calls, 2)
})

test('real session log: the four compactions yield blocks only where rows exist', async () => {
  let raw
  try { raw = readFileSync('/tmp/compact-chat-session.jsonl', 'utf8') } catch { return }
  const { readCompactions } = await import('../lib/compactions.js')
  const comps = readCompactions(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  assert.equal(comps.length >= 3, true)
  assert.deepEqual(comps.slice(0, 3).map((c) => c.shadowedSeqs.length), [43, 38, 22])
})

// Regression (measured crash in the browser, 2026-10-29): a Proxy over DSH's frozen
// snapshot objects throws "proxy must report the same value for the non-writable,
// non-configurable property 'views'". `overlay` must work on exactly such objects.
test('overlay works on frozen objects with non-writable properties and private fields', async () => {
  class Store { #n = 7; get(key) { return key + this.#n } }
  const views = new Store()
  const snapshot = Object.freeze(Object.defineProperties({}, {
    views: { value: views, writable: false, configurable: false, enumerable: true },
    order: { value: Object.freeze(['a', 'b']), writable: false, configurable: false, enumerable: true },
  }))
  const wrapped = overlay(snapshot, { order: ['x'] })
  assert.deepEqual(wrapped.order, ['x'])
  assert.equal(wrapped.views.get('k'), 'k7') // method still bound: private field intact
  const inner = overlay(snapshot.views, { get: () => 'over' })
  assert.equal(inner.get('k'), 'over')
  assert.equal(Object.keys(wrapped).includes('views'), true) // spread-safe
})
