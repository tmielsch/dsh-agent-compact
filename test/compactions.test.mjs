import test from 'node:test'
import assert from 'node:assert/strict'

import { readCompactions } from '../lib/compactions.js'

// A minimal log shaped like a real one (measured 2026-10-29 on session 4ddfac88:
// first compaction range 58..292, 43 shadowed seqs, 16531 tokens, checkpoint seq 498).
function log({ withCheckpoint = true, withSummary = true } = {}) {
  const events = [
    { type: 'user/message', seq: 10, data: { source: { kind: 'user' } } },
    { type: 'compaction/start', seq: 20, time: 1000, data: { compactionId: 'c1', turn: 1 } },
  ]
  if (withSummary) {
    events.push({
      type: 'compaction/summary',
      seq: 21,
      time: 106270,
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
      data: {
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
        content: [{ type: 'text', text: 'A'.repeat(6270) }, { type: 'image', text: 'ignored' }],
      },
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

// Nummer 2 — Größe des Checkpoints: die Zeichen der Checkpoint-Nachricht selbst,
// geteilt durch 6,27 (gemessener Wert aus `ZEICHEN_PRO_TOKEN`).
test('counts the checkpoint message text characters and estimates its size in tokens', () => {
  const [c] = readCompactions(log())
  assert.equal(c.checkpointChars, 6270)
  assert.equal(c.checkpointTokensEstimate, 1000)
})

// Nummer 3 — Schreibdauer: compaction/start.time bis compaction/summary.time,
// gepaart über dieselbe compactionId.
test('measures the writing duration from start to summary of the same compactionId', () => {
  const [c] = readCompactions(log())
  assert.equal(c.writeDurationSeconds, 105.27)
})

test('reports no duration when the log has no start time, and zero when it is a non-LLM path', () => {
  const noStart = log().filter((e) => e.type !== 'compaction/start')
  assert.equal(readCompactions(noStart)[0].writeDurationSeconds, null)
  const instant = log().map((e) => (e.type === 'compaction/summary' ? { ...e, time: 1000 } : e))
  assert.equal(readCompactions(instant)[0].writeDurationSeconds, 0)
})

test('a checkpoint message without text gives zero characters and zero tokens', () => {
  const bare = log().map((e) => (e.type === 'user/message' && e.seq === 22 ? { ...e, data: { ...e.data, content: [] } } : e))
  const [c] = readCompactions(bare)
  assert.equal(c.checkpointChars, 0)
  assert.equal(c.checkpointTokensEstimate, 0)
})
