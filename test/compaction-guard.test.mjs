import test from 'node:test'
import assert from 'node:assert/strict'
import { installCompactionGuard } from '../lib/compaction-guard.js'

// Der Guard wird hier ohne Harness geprüft: ein falscher Cordis-Kontext sammelt
// die Zuhörer ein, die Rückrufe zählen die Verdichtungen. Damit sind die drei
// Lagen (Zug-Ende, mitten im Zug, Notfall) offline belegbar.
const POLICY = { boundaryRatio: 0.9, nudgeRatio: 0.75, safetyTokens: 4096 }

function fakeHarness(reading, cut) {
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    logger: { info() {}, warn() {} },
  }
  const counts = { cut: 0, emergency: 0, notes: [] }
  const agent = { status: 'idle', session: { id: 'session-guard-test' } }
  const dispose = installCompactionGuard(
    ctx,
    { policy: POLICY, compactMidTurn: true, overflowRecovery: true },
    {
      reading: () => reading,
      planCut: () => cut,
      async compactCut() {
        counts.cut++
        return { freedTokens: 4321 }
      },
      async compactEmergency() {
        counts.emergency++
        return { freedTokens: 1234 }
      },
      note(level, message) {
        counts.notes.push(level + ': ' + message)
      },
    },
  )
  const fire = async (name, payload) => {
    const list = listeners.get(name) ?? []
    let result
    for (const handler of list) result = await handler(payload, () => Promise.resolve('next'))
    return result
  }
  return { agent, counts, fire, dispose }
}

const CUT = { startSeq: 10, endSeq: 20, turns: 3, grossTokens: 90000 }

test('Zug-Ende über der Grenze verdichtet sofort', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.counts.cut, 1)
  assert.equal(h.counts.notes.some((n) => n.startsWith('info: compaction guard at turn end')), true)
})

test('vor dem ERSTEN Schritt eines Zuges wird NICHT verdichtet (Anordnung 2026-10-30)', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  const result = await h.fire('agent/pre-step', { agent: h.agent, step: 1, signal: new AbortController().signal })
  assert.equal(result, 'next')
  assert.equal(h.counts.cut, 0)
})

test('mitten im Zug (ab Schritt 2) hält der Guard die Grenze', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  await h.fire('agent/pre-step', { agent: h.agent, step: 2, signal: new AbortController().signal })
  assert.equal(h.counts.cut, 1)
})

test('Notfall: die Anfrage würde abgelehnt, also schon vor Schritt 1 verdichten', async () => {
  // 800.000 + 256.000 > 1.000.000 - 4096
  const h = fakeHarness({ promptTokens: 800000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  await h.fire('agent/pre-step', { agent: h.agent, step: 1, signal: new AbortController().signal })
  assert.equal(h.counts.cut, 1)
})

test('unter der Grenze passiert nichts', async () => {
  const h = fakeHarness({ promptTokens: 200000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await h.fire('agent/pre-step', { agent: h.agent, step: 3, signal: new AbortController().signal })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.counts.cut, 0)
  assert.equal(h.counts.emergency, 0)
})

test('nach CONTEXT_WINDOW_EXCEEDED wird genau einmal verdichtet und wiederholt', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  const failure = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too big' }
  const first = await h.fire('agent/request-error', { agent: h.agent, turn: 7, failure, signal: new AbortController().signal })
  assert.deepEqual(first, { kind: 'retry' })
  assert.equal(h.counts.cut, 1)
  const second = await h.fire('agent/request-error', { agent: h.agent, turn: 7, failure, signal: new AbortController().signal })
  assert.equal(second, 'next')
  assert.equal(h.counts.cut, 1)
})

test('ohne turn-basierten Schnitt greift die Rettung des Kerns', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, null)
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.counts.emergency, 1)
})

test('ein abgemeldeter Guard hört nichts mehr', async () => {
  const h = fakeHarness({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, CUT)
  h.dispose()
  await h.fire('agent/status', { agent: h.agent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.counts.cut, 0)
})
