import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnTable, planRows, keepTurnsHint, turnCutRow } from '../lib/turns.js'

// Sitzung 0b9ffeb1 (2026-11-09, Plan um 22:57): turn/start von Zug 1 steht bei seq 6, der
// Systemprompt (~76.000 Token) erst bei seq 9. Er gehörte damit zu Zug 1, der Plan bot ihn als
// freigebbar an ("frees ~67257"), die Engine maß 1857. Die Zahlen unten sind die der Sitzung
// (Token aus Zeichen / 3,6, SCHÄTZUNG): Kopf 75.883, Zug 8 29.876, Zug 9 7.630, Zug 10 166.808,
// laufender Zug 11 352.031; Zug 7 ist 266 Token groß (zwei kleine Nachrichten).
const SURFACE = [
  { seq: 9, type: 'system/message' },
  { seq: 2393, type: 'user/message' }, // alter Checkpoint, gehört zu Zug 10 (im Protokoll)
  { seq: 2208, type: 'user/message' },
  { seq: 2209, type: 'user/message' },
  { seq: 2230, type: 'user/message' },
  { seq: 2244, type: 'assistant/message' },
  { seq: 2252, type: 'user/message' },
  { seq: 2254, type: 'assistant/message' },
  { seq: 2404, type: 'assistant/message' },
  { seq: 2412, type: 'user/message' },
  { seq: 2760, type: 'assistant/message' },
]
const LOG = [
  { seq: 6, type: 'turn/start', data: { turn: 1 } },
  { seq: 616, type: 'turn/end', data: { turn: 1 } },
  { seq: 2205, type: 'turn/start', data: { turn: 7 } },
  { seq: 2223, type: 'turn/end', data: { turn: 7 } },
  { seq: 2227, type: 'turn/start', data: { turn: 8 } },
  { seq: 2246, type: 'turn/end', data: { turn: 8 } },
  { seq: 2249, type: 'turn/start', data: { turn: 9 } },
  { seq: 2256, type: 'turn/end', data: { turn: 9 } },
  { seq: 2259, type: 'turn/start', data: { turn: 10 } },
  { seq: 2406, type: 'turn/end', data: { turn: 10 } },
  { seq: 2409, type: 'turn/start', data: { turn: 11 } },
]
const SIZES = new Map([
  [9, 75883], [2393, 1974], [2208, 19], [2209, 79], [2230, 29000], [2244, 876],
  [2252, 7000], [2254, 630], [2404, 164834], [2412, 50000], [2760, 302031],
])

test('A6: der Systemkopf ist Präfix, auch wenn turn/start vor ihm steht', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  assert.equal(t.prefix.firstSeq, 9)
  assert.equal(t.prefix.nodes, 1)
  assert.equal(t.prefix.tokens, 75883)
  assert.equal(t.turns.some((g) => g.turn === 1), false, 'Zug 1 hat nach dem Herausnehmen des Kopfes keinen Knoten')
  assert.equal(t.totalSurfaceTokens, [...SIZES.values()].reduce((a, b) => a + b, 0), 'die Summe der Oberfläche zählt den Kopf weiter mit')
})

test('A6: bei Arbeitsfenster 3 bietet der Plan keine Zeile über 1.000 Token an', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const rows = planRows(t, 3, 8)
  for (const r of rows) assert.ok(r.grossTokens < 1000, 'Zeile turns=' + r.k + ' zeigt ' + r.grossTokens)
  assert.equal(turnCutRow(t, 2, 3), null, 'turns=2 ist nicht mehr erlaubt')
})

test('keine Plan-Zeile beginnt auf dem Systemkopf', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  for (let keep = 0; keep <= 4; keep++) for (const r of planRows(t, keep, 10)) assert.notEqual(r.startSeq, 9)
})

test('A7: der Plan nennt den Weg über ein kleineres Arbeitsfenster mit Zahl', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  const hint = keepTurnsHint(t, 3, 50000)
  assert.ok(hint, 'ein Hinweis wird gegeben')
  assert.match(hint, /keep_turns=0/, 'erst Arbeitsfenster 0 erreicht 50.000')
  assert.match(hint, /turns=4/, 'Arbeitsfenster 0 bietet alle vier fertigen Züge (7 bis 10) an')
  assert.match(hint, /204\d{3} tokens/, 'rund 204.400 Token, wie in der Nachrechnung der Sitzung')
  assert.match(hint, /decision/, 'er sagt, dass die Wahl beim Modell liegt')
})

test('kein Hinweis, wenn die größte Zeile das Verlangte schon erreicht', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  assert.equal(keepTurnsHint(t, 0, 50000), null)
})

test('kein Hinweis, wenn auch kein kleineres Fenster etwas bringt', () => {
  const t = buildTurnTable(LOG, SURFACE, SIZES)
  assert.equal(keepTurnsHint(t, 3, 10_000_000), null)
})

test('ohne Systemkopf bleibt die Gruppierung unverändert', () => {
  const surface = SURFACE.slice(1)
  const t = buildTurnTable(LOG, surface, SIZES)
  assert.equal(t.prefix, null)
})
