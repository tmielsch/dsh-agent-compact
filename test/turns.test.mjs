import test from 'node:test'
import assert from 'node:assert/strict'
import {
  turnBoundaries,
  buildTurnTable,
  planRows,
  tailTokensAfter,
  turnCutRow,
  turnTableText,
} from '../lib/turns.js'
import { markerTag } from '../lib/anchor.js'

// ---- synthetic log + surface: shapes match real session events ----
// The log carries `turn/start` / `turn/end` with `{ turn }`; the surface is the
// folded model-visible node list. Sizes are per-node tokens, as the token meter
// reports them.

function start(turn) { return { seq: -1, type: 'turn/start', data: { turn } } }
function end(turn) { return { seq: -1, type: 'turn/end', data: { turn } } }

// One scenario, with explicit seqs:
//   prefix: 0 (system), 5 (opening user message)
//   turn 1: 11,12,13   turn 2: 22,23   turn 3: 32,33   turn 4 (running): 42
const LOG = []
LOG.push({ seq: 10, type: 'turn/start', data: { turn: 1 } })
LOG.push({ seq: 20, type: 'turn/end', data: { turn: 1 } })
LOG.push({ seq: 21, type: 'turn/start', data: { turn: 2 } })
LOG.push({ seq: 30, type: 'turn/end', data: { turn: 2 } })
LOG.push({ seq: 31, type: 'turn/start', data: { turn: 3 } })
LOG.push({ seq: 40, type: 'turn/end', data: { turn: 3 } })
LOG.push({ seq: 41, type: 'turn/start', data: { turn: 4 } })

const SURFACE = [0, 5, 11, 12, 13, 22, 23, 32, 33, 42].map((seq) => ({ seq, type: 'user/message' }))
const SIZES = new Map([
  [0, 200], [5, 100],
  [11, 1000], [12, 2000], [13, 3000],   // turn 1 = 6000
  [22, 4000], [23, 5000],               // turn 2 = 9000
  [32, 1000], [33, 1000],              // turn 3 = 2000
  [42, 700],                          // turn 4 (running)
])

test('turn boundaries pair start with end and keep a running turn open', () => {
  const b = turnBoundaries(LOG)
  assert.equal(b.get(1).startSeq, 10)
  assert.equal(b.get(1).endSeq, 20)
  assert.equal(b.get(4).endSeq, null, 'turn 4 has no turn/end: it is running')
})

test('the turn table groups nodes by turn and keeps the prefix apart', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  assert.equal(t.prefix.firstSeq, 0)
  assert.equal(t.prefix.lastSeq, 5)
  assert.equal(t.prefix.tokens, 300)
  assert.equal(t.turns.length, 4)
  assert.deepEqual(t.turns[0].positions, [2, 3, 4])
  assert.equal(t.turns[0].tokens, 6000)
  assert.equal(t.turns[3].finished, false, 'the running turn is marked unfinished')
  assert.equal(t.totalSurfaceTokens, 200 + 100 + 6000 + 9000 + 2000 + 700)
})

test('planRows lists the largest allowed cut first and names the freed tokens', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const rows = planRows(t, 0)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].k, 3, 'the deepest row covers all three finished turns')
  assert.equal(rows[0].grossTokens, 6000 + 9000 + 2000)
  assert.equal(rows[0].startSeq, 11)
  assert.equal(rows[0].endSeq, 33)
  // price: everything behind position of seq 33 (index 8) is the running turn's node
  assert.equal(rows[0].priceTokens, 700)
  assert.equal(rows[1].k, 2)
  assert.equal(rows[1].grossTokens, 9000 + 2000)
  assert.equal(rows[2].k, 1)
  assert.equal(rows[2].grossTokens, 2000)
})

test('the working-memory window blocks a cut that reaches into the newest turns', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const rows = planRows(t, 2)
  assert.equal(rows.length, 1, 'with 2 turns kept, only turn 1 is compactable')
  assert.equal(rows[0].k, 1)
  assert.equal(rows[0].startSeq, 11)
  assert.equal(rows[0].endSeq, 13)
  // the price grows: everything behind turn 1 (turns 2, 3, 4) is re-read
  assert.equal(rows[0].priceTokens, 9000 + 2000 + 700)
  assert.equal(planRows(t, 3).length, 0, 'keeping all finished turns leaves nothing to compact')
})

test('turnCutRow answers exactly one k', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  // keepTurns=1 blocks turn 3; usable is turns 1 and 2, so k=2 spans both.
  const r = turnCutRow(t, 2, 1)
  assert.equal(r.k, 2)
  assert.equal(r.startSeq, 11)
  assert.equal(r.endSeq, 23)
  assert.equal(turnCutRow(t, 3, 1), null, 'k=3 reaches into the kept turn: not allowed')
})

test('markers in the rows are the anchor markers the tool accepts', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const r = planRows(t, 0)[0]
  assert.equal(r.startMarker, markerTag(11))
  assert.equal(r.endMarker, markerTag(33))
})

test('the table text states the freed tokens and flags a cut below the requested minimum', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const text = turnTableText(t, 0, 100000)
  assert.match(text, /Surface: 18000 tokens/)
  assert.match(text, /frees ~17000 tokens \(7 nodes\)/)
  assert.match(text, /BELOW the requested minimum/)
  const empty = turnTableText(t, 3)
  assert.match(empty, /Nothing is safe to compact yet/)
})

test('tailTokensAfter counts only what sits behind the cut', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  assert.equal(tailTokensAfter(t, 4), 9000 + 2000 + 700)
  assert.equal(tailTokensAfter(t, 9), 0, 'nothing behind the last node')
})
