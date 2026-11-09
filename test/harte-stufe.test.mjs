import test from 'node:test'
import assert from 'node:assert/strict'
import { installCompactionGuard } from '../lib/compaction-guard.js'

// Sitzung a856b862 (2026-11-09): 19 Verdichtungen in einer Stunde, 16 davon an der Sperre des
// Systemkopfs gescheitert, weil der Wächter in jedem Schritt von vorn anfing und nach einem
// geworfenen Fehler nie die Rettung des Kerns versuchte. Diese Tests halten die Antwort fest:
// zwei Stufen, ein Versuch je Stufe und Zug, die harte Stufe auch nach gesetzter Sperre.
const POLICY = { boundaryRatio: 0.9, nudgeRatio: 0.75, safetyTokens: 4096 }
const OVER = { promptTokens: 447352, windowTokens: 512000, reserveTokens: 65536 } // 101 % des Budgets
const CUT = { startSeq: 10, endSeq: 20, turns: 3, grossTokens: 90000 }

function harness({ reading = OVER, cutFails = false, emergencyFails = false, shrinks = false } = {}) {
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
  const state = { reading, cut: 0, emergency: 0, notes: [] }
  const agent = { status: 'idle', session: { id: 'session-hard-stage' } }
  installCompactionGuard(
    ctx,
    { policy: POLICY, compactMidTurn: true, overflowRecovery: true },
    {
      reading: () => state.reading,
      planCut: () => CUT,
      async compactCut() {
        state.cut++
        if (cutFails) throw new Error('surface replace: node 0 holds the system prompt')
        if (shrinks) state.reading = { ...OVER, promptTokens: 90000 }
        return { freedTokens: 111 }
      },
      async compactEmergency() {
        state.emergency++
        if (emergencyFails) throw new Error('boom')
        if (shrinks) state.reading = { ...OVER, promptTokens: 90000 }
        return { freedTokens: 222 }
      },
      note(level, message) { state.notes.push(level + ': ' + message) },
    },
  )
  const fire = async (name, payload) => {
    let result
    for (const handler of listeners.get(name) ?? []) result = await handler(payload, () => Promise.resolve('next'))
    return result
  }
  const step = (turn, n) => fire('agent/pre-step', { agent, turn, step: n, signal: new AbortController().signal })
  return { agent, state, fire, step }
}

test('scheitert die erste Stufe mit einem Fehler, greift die harte Stufe im selben Schritt', async () => {
  const h = harness({ cutFails: true })
  await h.step(105, 1)
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 1)
})

test('je Zug und Stufe nur ein Versuch: spätere Schritte desselben Zuges fangen nicht von vorn an', async () => {
  const h = harness({ cutFails: true, emergencyFails: true })
  for (let n = 1; n <= 6; n++) await h.step(105, n)
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 1)
})

test('ein neuer Zug bekommt wieder je einen Versuch', async () => {
  const h = harness({ cutFails: true, emergencyFails: true })
  await h.step(105, 1)
  await h.step(106, 1)
  assert.equal(h.state.cut, 2)
  assert.equal(h.state.emergency, 2)
})

test('gelingt die erste Stufe und die Belegung fällt unter die Grenze, zählen die Versuche von vorn', async () => {
  const h = harness({ shrinks: true })
  await h.step(105, 1)
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 0)
  h.state.reading = OVER
  await h.step(105, 2)
  assert.equal(h.state.cut, 2)
})

test('gelingt die erste Stufe, die Belegung bleibt aber über der Grenze: der nächste Schritt eskaliert zur harten Stufe', async () => {
  const h = harness()
  await h.step(105, 1)
  assert.equal(h.state.cut, 1)
  await h.step(105, 2)
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 1)
})

test('Zug-Ende nach schon verbrauchter Sperre: die harte Stufe greift trotzdem, die erste nicht', async () => {
  const h = harness({ reading: { promptTokens: 400000, windowTokens: 512000, reserveTokens: 65536 } }) // 90,4 %, kein Überlauf
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.state.cut, 1)
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 1)
})

test('mitten im Zug nach verbrauchter Sperre: nur die harte Stufe', async () => {
  const h = harness({ reading: { promptTokens: 400000, windowTokens: 512000, reserveTokens: 65536 } })
  await h.step(7, 2)
  assert.equal(h.state.cut, 1)
  await h.step(8, 2)
  assert.equal(h.state.cut, 1)
  assert.equal(h.state.emergency, 1)
})
