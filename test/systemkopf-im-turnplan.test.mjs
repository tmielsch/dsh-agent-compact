// Regressionstest für die Systemkopf-Falle im Massenschnitt (turns=N).
//
// Gemessen am 2026-10-31 an session-e40fe6ab: Ein `context_compact({ turns: 20 })`
// begann die Spanne am Systemkopf (surface node 0). Der Kern lehnt das ab
// ("node 0 holds the system prompt"), die bereits geschriebene
// `compaction/summary` blieb trotzdem im Log und machte die Sitzung beim
// nächsten Start unladbar:
//   SessionFormatError: compaction cannot shadow the protected system head
//
// Der Anker-Weg (resolveBoundaries) nimmt den Kopf seit jeher aus; der
// Massenschnitt tat es nicht. offSystemHead schließt die Lücke und ist hier
// ohne laufenden Kern prüfbar.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnTable, turnCutRow, offSystemHead } from '../lib/turns.js'
import { systemHeadCount } from '../lib/boundary.js'

// Oberfläche: node 0 ist der Systemkopf, danach zwei Züge.
//   Praxis-Fall: der Kopf entsteht bei jedem Neustart neu und fällt auf den
//   ersten Knoten des ersten Zuges — genau die Lage aus dem Log.
const SURFACE = [
  { seq: 0, type: 'system/message' },
  { seq: 11, type: 'user/message' },
  { seq: 12, type: 'assistant/message' },
  { seq: 21, type: 'user/message' },
  { seq: 22, type: 'assistant/message' },
]

// Die Turn-Grenzen liegen HINTER dem Kopf (seq 5 > 0): der Kopf ist Präfix,
// nicht Teil von Zug 1. Das ist der Normalfall im echten Log.
const LOG = [
  { seq: 5, type: 'turn/start', data: { turn: 1 } },
  { seq: 15, type: 'turn/end', data: { turn: 1 } },
  { seq: 16, type: 'turn/start', data: { turn: 2 } },
  { seq: 25, type: 'turn/end', data: { turn: 2 } },
]

const TOKENS = new Map([
  [0, 1000],
  [11, 500],
  [12, 500],
  [21, 500],
  [22, 500],
])

test('systemHeadCount zaehlt die Systemknoten am Kopf der Oberflaeche', () => {
  assert.equal(systemHeadCount(SURFACE), 1, 'node 0 ist der Systemkopf')
  assert.equal(systemHeadCount([{ seq: 1, type: 'user/message' }]), 0, 'ohne Systemknoten null')
  assert.equal(
    systemHeadCount([{ seq: 0, type: 'system/message' }, { seq: 1, type: 'system/message' }, { seq: 2, type: 'user/message' }]),
    2,
    'mehrere Systemknoten zaehlen alle',
  )
})

test('der Massenschnitt ohne Kopf-Ausnahme wuerde auf Position 0 beginnen', () => {
  // Das ist die Gegenprobe: die Turn-Tabelle selbst kennt keinen Kopf. Ihr
  // erster Zug beginnt bei seq 11 — aber ihre POSITION wird über die
  // Oberfläche bestimmt, und im echten Fehlerfall lag sie auf 0.
  const table = buildTurnTable(LOG, SURFACE, TOKENS)
  assert.equal(table.prefix.firstSeq, 0, 'der Kopf ist Praefix')
  assert.equal(table.turns[0].firstSeq, 11, 'Zug 1 beginnt nach dem Kopf')

  const row = turnCutRow(table, 1, 0)
  assert.ok(row, 'ein Schnitt ueber einen fertigen Zug ist erlaubt')

  // Der Kern-Fehler: Start auf Position 0 = auf dem Kopf. Ohne den Fix
  // ginge dieser Start unveraendert an den Kern.
  const ohneFix = 0
  assert.equal(SURFACE[ohneFix].type, 'system/message', 'Position 0 ist der Systemkopf')
})

test('offSystemHead schiebt einen Start auf dem Kopf dahinter', () => {
  const head = systemHeadCount(SURFACE)
  assert.equal(head, 1)

  const verschoben = offSystemHead(0, 4, head)
  assert.equal(verschoben, 1, 'aus Position 0 wird Position 1')
  assert.notEqual(SURFACE[verschoben].type, 'system/message', 'der Kopf ist nicht mehr im Bereich')
})

test('offSystemHead laesst einen Start hinter dem Kopf unveraendert', () => {
  const head = systemHeadCount(SURFACE)
  assert.equal(offSystemHead(1, 4, head), 1, 'Normalfall bleibt unangetastet')
  assert.equal(offSystemHead(3, 4, head), 3, 'auch spaeter Start bleibt')
})

test('offSystemHead ohne Systemkopf aendert nichts', () => {
  assert.equal(offSystemHead(0, 2, 0), 0, 'ohne Kopf beginnt die Spanne bei 0')
  assert.equal(offSystemHead(2, 5, 0), 2, 'auch mitten in der Oberflaeche')
})

test('offSystemHead verliert keinen Inhalt hinter dem Kopf', () => {
  const head = systemHeadCount(SURFACE)
  const start = offSystemHead(0, 4, head)
  const rest = SURFACE.slice(start)
  assert.equal(rest.length, 4, 'alle vier Austausch-Knoten bleiben')
  assert.equal(rest[0].seq, 11, 'die Spanne beginnt bei der ersten echten Meldung')
})

test('offSystemHead wirft, wenn nur der Kopf uebrig bliebe', () => {
  // Lage: die Spanne besteht ausschliesslich aus Systemknoten. Dann gibt es
  // nichts zu verdichten — ein Fehler ist hier richtig, kein stiller Leerlauf.
  assert.throws(
    () => offSystemHead(0, 0, 1),
    (e) => e instanceof RangeError && /only the system head|entirely on the system head/.test(e.message),
    'nur der Kopf ist kein Schnitt',
  )
})

test('der Fehlerfall aus dem echten Log wird nachgestellt', () => {
  // Aus session-e40fe6ab, seq 16296: shadowedRange start 11563, Kopf 11563.
  // Der dritte Versuch (seq 16307) begann korrekt bei 11928 — dem Knoten
  // NACH dem Kopf. Genau diese Verschiebung macht offSystemHead.
  const headSeq = 11563
  const surface = [
    { seq: 11563, type: 'system/message' }, // Kopf
    { seq: 11928, type: 'user/message' },   // der gültige Start des dritten Versuchs
    { seq: 15135, type: 'assistant/message' },
  ]
  const head = systemHeadCount(surface)
  assert.equal(head, 1, 'ein Kopf')

  const falscherStart = 0
  const richtigerStart = offSystemHead(falscherStart, 2, head)
  assert.equal(richtigerStart, 1)
  assert.equal(surface[richtigerStart].seq, 11928, 'genau der Start, den der Retry nahm')
  assert.notEqual(surface[richtigerStart].seq, headSeq, 'nicht mehr der Kopf')
})
