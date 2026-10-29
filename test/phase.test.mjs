import test from 'node:test'
import assert from 'node:assert/strict'
import {
  phaseComplete,
  phaseCounts,
  nudgeMode,
  phaseNudgeText,
  limitNudgeText,
} from '../lib/phase.js'

const done = [
  { content: 'Spec lesen', status: 'completed' },
  { content: 'Texte umbauen', status: 'completed' },
]
const open = [
  { content: 'Spec lesen', status: 'completed' },
  { content: 'Texte umbauen', status: 'in_progress' },
  { content: 'Tests', status: 'pending' },
]

test('phaseComplete: nur eine vollständig abgearbeitete, nicht leere Liste ist ein Phasenende', () => {
  assert.equal(phaseComplete(done), true)
  assert.equal(phaseComplete(open), false)
  assert.equal(phaseComplete([]), false)
  assert.equal(phaseComplete(null), false)
  assert.equal(phaseComplete(undefined), false)
  assert.equal(phaseComplete('completed'), false)
})

test('phaseCounts: zählt Punkte und abgeschlossene Punkte', () => {
  assert.deepEqual(phaseCounts(open), { total: 3, completed: 1 })
  assert.deepEqual(phaseCounts(done), { total: 2, completed: 2 })
  assert.deepEqual(phaseCounts(null), { total: 0, completed: 0 })
})

test('nudgeMode: ohne Liste kein Hinweis, auch bei großem Wachstum (das war der Fehler von heute)', () => {
  assert.equal(nudgeMode(120000, 50000, 200000, 300000, null), null)
  assert.equal(nudgeMode(120000, 50000, 200000, 300000, open), null)
})

test('nudgeMode: Phasenende plus genug Wachstum ergibt den Phasen-Hinweis', () => {
  assert.equal(nudgeMode(50000, 50000, 200000, 300000, done), 'phase')
  assert.equal(nudgeMode(80000, 50000, 200000, 300000, done), 'phase')
})

test('nudgeMode: Phasenende, aber zu wenig Wachstum seit dem letzten Checkpoint, ergibt keinen Hinweis', () => {
  assert.equal(nudgeMode(49999, 50000, 200000, 300000, done), null)
  assert.equal(nudgeMode(0, 50000, 200000, 300000, done), null)
})

test('nudgeMode: die harte Obergrenze greift auch ohne Liste und ohne Wachstumsschwelle', () => {
  assert.equal(nudgeMode(1000, 50000, 300000, 300000, null), 'limit')
  assert.equal(nudgeMode(1000, 50000, 350000, 300000, open), 'limit')
  assert.equal(nudgeMode(1000, 50000, 299999, 300000, null), null)
})

test('nudgeMode: Schwelle 0 schaltet die Phasenregel ab, Obergrenze 0 schaltet die Obergrenze ab', () => {
  assert.equal(nudgeMode(500000, 0, 200000, 300000, done), null)
  assert.equal(nudgeMode(500000, 50000, 900000, 0, null), null)
  assert.equal(nudgeMode(500000, 50000, 900000, 0, done), 'phase')
})

test('phaseNudgeText: nennt Zahlen der Liste, das Ende des eigenen Zugs und die Fünftel-Regel', () => {
  const t = phaseNudgeText(61000, done)
  assert.match(t, /2 of 2 items done/)
  assert.match(t, /61k tokens/)
  assert.match(t, /LAST action of this turn/)
  assert.match(t, /never a reply to a message of the human/)
  assert.match(t, /one fifth or less/)
  assert.match(t, /WHOLE finished phase/)
})

test('Hinweistexte widersprechen sich nicht: kein Wort von kleinen Spans oder sofortigem Verdichten', () => {
  for (const t of [phaseNudgeText(61000, done), limitNudgeText(310000)]) {
    assert.doesNotMatch(t, /smaller spans/i)
    assert.doesNotMatch(t, /as soon as/i)
    assert.doesNotMatch(t, /routine memory hygiene/i)
    assert.doesNotMatch(t, /not a last resort/i)
  }
})

test('limitNudgeText: nennt die Belegung in k Token und verlangt dieselbe Zugform', () => {
  const t = limitNudgeText(310000)
  assert.match(t, /310k tokens/)
  assert.match(t, /LAST action of this turn/)
  assert.match(t, /clearly smaller/)
})

test('gebautes lib/index.js trägt keine der widersprüchlichen Verdichtungs-Formulierungen mehr', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const w of [
    'routine memory hygiene',
    'not a last resort',
    'as soon as they are read',
    'smaller spans',
    'Evaluate whenever a span',
    'compact each finished step',
    'Prefer a rare, big compaction',
  ]) {
    assert.equal(code.includes(w), false, 'noch vorhanden: ' + w)
  }
  assert.equal(code.includes('only at the end of a finished phase'), true)
})
