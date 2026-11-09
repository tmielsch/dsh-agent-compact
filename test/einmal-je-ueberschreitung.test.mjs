import test from 'node:test'
import assert from 'node:assert/strict'
import { installCompactionGuard } from '../lib/compaction-guard.js'

// Entscheidung des Menschen 2026-11-06 („gut so"): der Wächter verdichtet nur EINMAL je
// Überschreitung der Grenze. Gemessener Anlass: Sitzung a856b862, zwei Verdichtungen
// hintereinander (02:04 und 02:09), die zweite aufgrund eines veralteten Hinweises.
const POLICY = { boundaryRatio: 0.9, nudgeRatio: 0.75, safetyTokens: 4096 }
// Fenster 1.000.000, Reserve 65.536 -> Budget 930.368 -> Grenze bei 837.331 Token
const WINDOW = 1_000_000
const RESERVE = 65_536
const OVER = 850_000
const UNDER = 400_000
const CUT = { startSeq: 10, endSeq: 20, turns: 3, grossTokens: 90000 }

function harness() {
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
  const state = { prompt: OVER, cuts: 0, notes: [] }
  const agent = { status: 'idle', session: { id: 'session-einmal' } }
  installCompactionGuard(
    ctx,
    { policy: POLICY, compactMidTurn: true, overflowRecovery: true },
    {
      reading: () => ({ promptTokens: state.prompt, windowTokens: WINDOW, reserveTokens: RESERVE }),
      planCut: () => CUT,
      async compactCut() {
        state.cuts++
        return { freedTokens: 1 }
      },
      async compactEmergency() {
        return null
      },
      note(level, message) {
        state.notes.push(level + ': ' + message)
      },
    },
  )
  const fire = async (name, payload) => {
    let result
    for (const handler of listeners.get(name) ?? []) result = await handler(payload, () => Promise.resolve('next'))
    return result
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  return { agent, state, fire, tick }
}

test('Zug-Ende: eine Überschreitung, zwei Zug-Enden -> genau eine Verdichtung', async () => {
  const h = harness()
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  assert.equal(h.state.cuts, 1)
  // der Schnitt hat die Belegung NICHT unter die Grenze gebracht (Prompt bleibt OVER)
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  assert.equal(h.state.cuts, 1, 'für dieselbe Überschreitung kein zweiter Schnitt')
  // Seit 2026-11-09 („2 Ja“): für dieselbe Überschreitung gibt es keinen zweiten turn-basierten
  // Schnitt, aber die harte Stufe (Rettung des Kerns) wird versucht; das Log sagt es.
  assert.equal(h.state.notes.some((n) => n.includes('hard stage')), true)
})

test('nach einer Messung unter der Grenze geht die Sperre wieder auf', async () => {
  const h = harness()
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  assert.equal(h.state.cuts, 1)
  h.state.prompt = UNDER
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  h.state.prompt = OVER
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  assert.equal(h.state.cuts, 2, 'eine NEUE Überschreitung darf wieder verdichten')
})

test('mitten im Zug zählt zur selben Überschreitung wie das Zug-Ende', async () => {
  const h = harness()
  await h.fire('agent/pre-step', { agent: h.agent, step: 2, signal: new AbortController().signal })
  assert.equal(h.state.cuts, 1)
  await h.fire('agent/pre-step', { agent: h.agent, step: 3, signal: new AbortController().signal })
  assert.equal(h.state.cuts, 1, 'zweiter Schritt über der Grenze: nicht noch einmal')
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.tick()
  assert.equal(h.state.cuts, 1, 'und auch das Zug-Ende danach nicht')
})

test('die Verhinderung einer Ablehnung ist von der Sperre ausgenommen', async () => {
  const h = harness()
  await h.fire('agent/pre-step', { agent: h.agent, step: 2, signal: new AbortController().signal })
  assert.equal(h.state.cuts, 1)
  // jetzt würde die nächste Anfrage abgelehnt: 950.000 + 65.536 > 1.000.000 - 4.096
  h.state.prompt = 950_000
  await h.fire('agent/pre-step', { agent: h.agent, step: 3, signal: new AbortController().signal })
  assert.equal(h.state.cuts, 2, 'Überlauf geht vor der Sperre')
})
