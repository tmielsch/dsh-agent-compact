import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boundaryCommandText } from '../lib/budget.js'

// Gemessener Fehler (Sitzung a856b862, 2026-11-05/06): der Befehls-Text trug die aktuelle
// Prozentzahl, die Ankerliste und die Schnitt-Tabelle. Er änderte sich bei jedem Schritt,
// DSH speicherte jede Fassung als eigenen Block (21 Stück à ~12.000 Zeichen), und ein Block
// aus der laufenden Runde — von einer Verdichtung nicht ersetzbar — behauptete danach noch
// „81 %", obwohl die Belegung bei 68 % lag. Das Modell glaubte ihm und verdichtete ein
// zweites Mal.

test('der Befehlstext ist bei jedem Aufruf byte-gleich', () => {
  assert.equal(boundaryCommandText(), boundaryCommandText())
})

test('der Befehlstext enthält keine Ziffer: eine Zahl darin wäre einen Schritt später veraltet', () => {
  assert.equal(/\d/.test(boundaryCommandText()), false)
})

test('der Befehlstext ist kurz: keine Ankerliste, keine Schnitt-Tabelle', () => {
  const text = boundaryCommandText()
  assert.ok(text.length < 1200, 'zu lang: ' + text.length)
  assert.equal(text.includes('Anchor markers'), false)
  // die Anleitung `turns=N` ist gewollt; eine Tabellenzeile mit Messwert nicht
  assert.equal(/turns=\d/.test(text), false)
  assert.equal(text.includes('frees ~'), false)
})

test('der Befehlstext sagt, wann er erledigt ist, und verbietet die zweite Verdichtung', () => {
  const text = boundaryCommandText()
  assert.equal(text.includes('ABSOLUTE COMMAND'), true)
  assert.equal(text.includes('ignore it and do NOT compact again'), true)
  assert.equal(text.includes('context_compact_plan'), true)
})

test('index.js gibt den Text nur an der Grenze aus, nie zwischen Mahnung und Grenze', () => {
  const code = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(code.includes("if (verdict.kind !== 'compact')"), true)
  assert.equal(code.includes('Boundary approaching'), false)
  // der alte Text mit eingebetteter Zahl ist weg
  assert.equal(code.includes('limitNudgeText(reading.promptTokens)'), false)
  assert.equal(code.includes('boundaryCommandText(reading, verdict)'), false)
})
