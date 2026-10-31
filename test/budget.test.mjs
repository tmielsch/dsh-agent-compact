import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetSentence, judgeBudget, wouldOverflow } from '../lib/budget.js'

// Die Zahlen stammen aus dem laufenden Harness am 2026-10-31:
//   request/header  : deepseek-official / deepseek-flash, maxTokens 256000
//   request/context : contextWindow 1000000
// und aus der Anbieter-Meldung der homepc-Route, die ihr echtes Fenster selbst
// nennt: "prompt (30032 tokens) + max tokens (256000) exceeds the context (262144)".
const POLICY = { boundaryRatio: 0.9, nudgeRatio: 0.75, safetyTokens: 4096 }

test('Reserve 256k im 1M-Fenster: die Grenze liegt bei 665.913 Token Prompt', () => {
  const verdict = judgeBudget({ promptTokens: 665913, windowTokens: 1e6, reserveTokens: 256000 }, POLICY)
  assert.equal(verdict.kind, 'compact')
  assert.equal(verdict.thresholdTokens, 665913) // floor(0.9 * (1000000 - 4096 - 256000))
  assert.equal(verdict.budgetTokens, 739904)
})

test('86 % Füllung sind 116 % des Anfrage-Budgets und werden verdichtet', () => {
  const verdict = judgeBudget({ promptTokens: 860000, windowTokens: 1e6, reserveTokens: 256000 }, POLICY)
  assert.equal(verdict.kind, 'compact')
  assert.equal(verdict.windowPercent, 86)
  assert.equal(verdict.budgetPercent, 116.2)
})

test('zwischen Nudge und Grenze: 81 % des Budgets ergeben den Befehl, keine Zwangs-Verdichtung', () => {
  const verdict = judgeBudget({ promptTokens: 600000, windowTokens: 1e6, reserveTokens: 256000 }, POLICY)
  assert.equal(verdict.kind, 'nudge')
  assert.equal(verdict.budgetPercent, 81.1)
})

test('kleine Belegung bleibt in Ruhe', () => {
  const verdict = judgeBudget({ promptTokens: 100000, windowTokens: 1e6, reserveTokens: 256000 }, POLICY)
  assert.equal(verdict.kind, 'ok')
})

test('gemessener Ausfall der homepc-Route: 30.032 + 256.000 in 262.144', () => {
  const verdict = judgeBudget({ promptTokens: 30032, windowTokens: 262144, reserveTokens: 256000 }, POLICY)
  assert.equal(verdict.kind, 'compact')
  // 262144 - 4096 Sicherheit - 256000 Reserve = 2048 Token Prompt-Budget. Genau
  // deshalb ist diese Route im zweiten Zug gestorben: es gab nie Platz für einen
  // echten Prompt, und keine Prozentzahl konnte das zeigen.
  assert.equal(verdict.budgetTokens, 2048)
})

test('kleinere Reserve verschiebt dieselbe Grenze ins Fenster, ohne Codeänderung', () => {
  const gross = judgeBudget({ promptTokens: 665913, windowTokens: 1e6, reserveTokens: 256000 }, POLICY)
  const small = judgeBudget({ promptTokens: 665913, windowTokens: 1e6, reserveTokens: 65536 }, POLICY)
  assert.equal(gross.kind, 'compact')
  assert.equal(small.kind, 'ok') // 665913 von 930368 ist 71,6 %
  const boundarySmall = judgeBudget({ promptTokens: 837331, windowTokens: 1e6, reserveTokens: 65536 }, POLICY)
  assert.equal(boundarySmall.kind, 'compact')
  assert.equal(boundarySmall.windowPercent, 83.7)
})

test('unbekanntes Fenster ergibt kein Urteil (kein Raten)', () => {
  assert.equal(judgeBudget({ promptTokens: 1000, windowTokens: 0, reserveTokens: 1000 }, POLICY), null)
})

test('wouldOverflow erkennt die Ablehnung, bevor sie passiert', () => {
  assert.equal(wouldOverflow({ promptTokens: 740000, windowTokens: 1e6, reserveTokens: 256000 }, 4096), true)
  assert.equal(wouldOverflow({ promptTokens: 700000, windowTokens: 1e6, reserveTokens: 256000 }, 4096), false)
})

test('der Satz für das Log nennt beide Prozentzahlen und die Grenze', () => {
  const reading = { promptTokens: 860000, windowTokens: 1e6, reserveTokens: 256000 }
  const verdict = judgeBudget(reading, POLICY)
  const sentence = budgetSentence(reading, verdict)
  assert.equal(sentence.includes('116.2% of the request budget'), true)
  assert.equal(sentence.includes('86% of the 1000000-token window'), true)
  assert.equal(sentence.includes('boundary at 665913 tokens'), true)
})
