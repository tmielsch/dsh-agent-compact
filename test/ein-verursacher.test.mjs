import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnState, mayIssueCommand, sessionKeyOf } from '../lib/turn-state.js'
import { installCompactionGuard } from '../lib/compaction-guard.js'

// Sitzung 0b9ffeb1 (2026-11-10): Prompt 376.871 über der Grenze 376.012 mitten in Zug 18, Schritt 58.
// Der Wächter verdichtete (6 min 31 s), der Befehl an das Modell erschien im selben Schritt und stand
// danach unter dem Checkpoint; das Modell verdichtete noch einmal und wollte ein drittes Mal.
// Entscheidung des Menschen 2026-11-10: „A)“ (Spec 11.6, R11): eine Überschreitung hat einen Verursacher.
const POLICY = { boundaryRatio: 0.85, nudgeRatio: 0.75, safetyTokens: 4096 }
const OVER = { promptTokens: 376871, windowTokens: 512000, reserveTokens: 65536 } // 100,2 % der Grenze, kein Überlauf
const CUT = { startSeq: 10, endSeq: 20, turns: 3, grossTokens: 90000 }
const KEY = 'session-0b9ffeb1'

test('Befehl: im ersten Schritt eines Zuges ja, danach nie mehr in diesem Zug', () => {
  const s = createTurnState()
  assert.equal(mayIssueCommand(s, KEY, false), true)
  s.noteStep(KEY) // der Wächter hat Schritt 1 gesehen
  assert.equal(mayIssueCommand(s, KEY, false), false, 'mitten im Zug nicht')
  s.noteStep(KEY)
  assert.equal(mayIssueCommand(s, KEY, false), false)
})

test('Befehl: bei drohender Ablehnung nie, auch nicht im ersten Schritt', () => {
  const s = createTurnState()
  assert.equal(mayIssueCommand(s, KEY, true), false)
  assert.equal(s.commandIssued(KEY), false, 'ohne Befehl keine Merkung')
})

test('Befehl: nach dem Zug-Ende gilt der nächste Zug wieder als frisch', () => {
  const s = createTurnState()
  assert.equal(mayIssueCommand(s, KEY, false), true)
  s.noteStep(KEY)
  s.endTurn(KEY)
  assert.equal(mayIssueCommand(s, KEY, false), true)
})

test('Befehl: zwei Sitzungen stören einander nicht', () => {
  const s = createTurnState()
  assert.equal(mayIssueCommand(s, 'a', false), true)
  s.noteStep('a')
  assert.equal(mayIssueCommand(s, 'b', false), true, 'Sitzung b steht im ersten Schritt')
})

test('sessionKeyOf liest die Sitzungs-ID und fällt auf einen festen Namen zurück', () => {
  assert.equal(sessionKeyOf({ session: { id: 'x' } }), 'x')
  assert.equal(sessionKeyOf(undefined), 'unknown-session')
  assert.equal(sessionKeyOf({ session: {} }), 'unknown-session')
})

function harness(turnState) {
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  const state = { cut: 0, emergency: 0, reading: OVER }
  const agent = { status: 'idle', session: { id: KEY } }
  installCompactionGuard(
    ctx,
    { policy: POLICY, compactMidTurn: true, overflowRecovery: true, turnState },
    {
      reading: () => state.reading,
      planCut: () => CUT,
      async compactCut() { state.cut++; return { freedTokens: 1 } },
      async compactEmergency() { state.emergency++; return { freedTokens: 2 } },
      note() {},
    },
  )
  const fire = async (name, payload) => {
    let result
    for (const handler of listeners.get(name) ?? []) result = await handler(payload, () => Promise.resolve('next'))
    return result
  }
  const step = (turn, n) => fire('agent/pre-step', { agent, turn, step: n, signal: new AbortController().signal })
  const idle = async () => { await fire('agent/status', { agent, status: 'idle' }); await new Promise((r) => setTimeout(r, 0)) }
  return { state, step, idle }
}

test('der Fall aus 0b9ffeb1: das Modell hat den Befehl, also verdichtet der Wächter mitten im Zug nicht', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  // Schritt 1: der Anbieter (assemble) liefert den Befehl, danach läuft agent/pre-step des Wächters.
  assert.equal(mayIssueCommand(turnState, KEY, false), true)
  await h.step(18, 1)
  assert.equal(h.state.cut, 0, 'Schritt 1: der Wächter verdichtet nie vor dem ersten Schritt')
  // Schritt 2 bis 5, weiter über der Grenze: bisher hätte der Wächter hier verdichtet.
  for (let n = 2; n <= 5; n++) await h.step(18, n)
  assert.equal(h.state.cut, 0, 'der Befehl liegt beim Modell, der Wächter wartet')
})

test('ohne Befehl in diesem Zug verdichtet der Wächter mitten im Zug wie bisher (Schritt 2 ist der erste mögliche)', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  await h.step(18, 1) // der Anbieter hatte hier keinen Befehl geliefert (zum Beispiel unter der Grenze)
  await h.step(18, 2)
  assert.equal(h.state.cut, 1)
})

test('das Zug-Ende verdichtet trotz Befehl, wenn das Modell nicht verdichtet hat (Rückfall)', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  assert.equal(mayIssueCommand(turnState, KEY, false), true)
  await h.step(18, 1)
  await h.step(18, 2)
  await h.idle()
  assert.equal(h.state.cut, 1, 'Lage 1 bleibt der Rückfall')
})

test('nach dem Zug-Ende ist der Befehl-Merker gelöscht: der nächste Zug verdichtet mitten im Zug wieder', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  assert.equal(mayIssueCommand(turnState, KEY, false), true)
  await h.step(18, 1)
  await h.idle()
  assert.equal(turnState.commandIssued(KEY), false)
  // Der Zug-Ende-Schnitt hat die Belegung (im Test) nicht gesenkt; die Sperre aus 9.4 ist gesetzt. Mitten in
  // Zug 19 greift deshalb die harte Stufe — entscheidend ist, dass der Wächter dort überhaupt verdichtet.
  await h.step(19, 1)
  await h.step(19, 2)
  assert.equal(h.state.cut + h.state.emergency, 2, 'ein Schnitt am Zug-Ende, einer mitten in Zug 19')
  assert.equal(h.state.emergency, 1, 'der zweite war die harte Stufe (Sperre gesetzt, Belegung unverändert)')
})

test('die Verhinderung einer Ablehnung gilt auch dann, wenn das Modell den Befehl hat', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  assert.equal(mayIssueCommand(turnState, KEY, false), true)
  await h.step(18, 1)
  h.state.reading = { promptTokens: 480000, windowTokens: 512000, reserveTokens: 65536 } // Prompt + Reserve > Fenster − 4096
  await h.step(18, 2)
  assert.equal(h.state.cut, 1, 'Lage 3 geht vor dem Befehl')
})

test('fiel das Zug-Ende aus, setzt der Wechsel der Zugnummer den Merker zurück', async () => {
  const turnState = createTurnState()
  const h = harness(turnState)
  assert.equal(mayIssueCommand(turnState, KEY, false), true)
  await h.step(18, 1)
  await h.step(18, 2)
  assert.equal(h.state.cut, 0, 'in Zug 18 liegt der Befehl beim Modell')
  // kein agent/status idle (Abbruch): Zug 19 beginnt
  await h.step(19, 1)
  await h.step(19, 2)
  assert.equal(h.state.cut, 1, 'in Zug 19 gilt der alte Merker nicht mehr')
})
