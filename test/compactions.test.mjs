import test from 'node:test'
import assert from 'node:assert/strict'

import { readCompactions } from '../lib/compactions.js'

// A minimal log shaped like a real one (measured 2026-10-29 on session 4ddfac88:
// first compaction range 58..292, 43 shadowed seqs, 16531 tokens, checkpoint seq 498).
function log({ withCheckpoint = true, withSummary = true } = {}) {
  const events = [
    { type: 'user/message', seq: 10, data: { source: { kind: 'user' } } },
    { type: 'compaction/start', seq: 20, data: { compactionId: 'c1', turn: 1 } },
  ]
  if (withSummary) {
    events.push({
      type: 'compaction/summary',
      seq: 21,
      data: {
        compactionId: 'c1',
        summary: [{ type: 'text', text: '## Checkpoint\n- kept' }, { type: 'image', text: 'ignored' }],
        shadowedRange: { start: 3, end: 9 },
        shadowedSeqs: [3, 5, 9],
        shadowedTokenCount: 120,
      },
    })
  }
  if (withCheckpoint) {
    events.push({
      type: 'user/message',
      seq: 22,
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 9 },
      data: { source: { kind: 'compact-checkpoint', compactionId: 'c1' } },
    })
  }
  events.push({ type: 'compaction/end', seq: 23, data: { compactionId: 'c1', turn: 1 } })
  return events
}

test('reads one compaction with its exact replaced seqs and text', () => {
  const [c, ...rest] = readCompactions(log())
  assert.equal(rest.length, 0)
  assert.equal(c.compactionId, 'c1')
  assert.equal(c.checkpointSeq, 22)
  assert.equal(c.startSeq, 3)
  assert.equal(c.endSeq, 9)
  assert.deepEqual([...c.shadowedSeqs], [3, 5, 9])
  assert.equal(c.shadowedTokenCount, 120)
  assert.equal(c.summaryText, '## Checkpoint\n- kept')
})

test('skips a compaction that has no checkpoint message yet', () => {
  assert.deepEqual(readCompactions(log({ withCheckpoint: false })), [])
})

test('skips a checkpoint whose summary is missing (nothing to show as original)', () => {
  assert.deepEqual(readCompactions(log({ withSummary: false })), [])
})

test('orders compactions by checkpoint position and ignores junk', () => {
  const second = [
    { type: 'compaction/summary', seq: 40, data: { compactionId: 'c2', summary: [], shadowedSeqs: [30], shadowedRange: { start: 30, end: 30 }, shadowedTokenCount: 1 } },
    { type: 'user/message', seq: 41, surfaceOp: { op: 'replace', startSeq: 30, endSeq: 30 }, data: { source: { kind: 'compact-checkpoint', compactionId: 'c2' } } },
  ]
  const out = readCompactions([null, 7, { type: 'x' }, ...second, ...log()])
  assert.deepEqual(out.map((c) => c.compactionId), ['c1', 'c2'])
})
