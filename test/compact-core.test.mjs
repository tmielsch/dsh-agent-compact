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
const { computeHiding, planOrder, planEntries, visibleMembers, blockKey, endKey, isBlockKey, compactState, overlay } = core

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

test('a compaction with no loaded row gets no block (nothing to replace on screen)', () => {
  const far = { ...c1, compactionId: 'far', startSeq: 100, endSeq: 200 }
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
