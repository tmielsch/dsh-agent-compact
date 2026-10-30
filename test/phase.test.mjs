import test from 'node:test'
import assert from 'node:assert/strict'
import {
  phaseComplete,
  phaseCounts,
  nudgeMode,
  limitNudgeText,
  zwischenfazitText,
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

test('nudgeMode: die harte Obergrenze ist das einzige Auslöser-Signal', () => {
  assert.equal(nudgeMode(300000, 300000), 'limit')
  assert.equal(nudgeMode(350000, 300000), 'limit')
  assert.equal(nudgeMode(299999, 300000), null)
  assert.equal(nudgeMode(900000, 0), null)
})

test('nudgeMode hat keinen Wachstums-Parameter mehr: der Phasenhinweis ist entfernt', () => {
  // Anordnung des Menschen 2026-10-30: „der phasenhinweis muss raus“.
  // Die Signatur nimmt genau zwei Argumente; ein drittes wird ignoriert.
  assert.equal(nudgeMode.length, 2)
  assert.equal(nudgeMode(120000, 300000, 200000, 50000, done), null)
})

test('limitNudgeText: nennt die Belegung in k Token und verlangt dieselbe Zugform', () => {
  const t = limitNudgeText(310000)
  assert.match(t, /310k tokens/)
  assert.match(t, /LAST action of this turn/)
  assert.match(t, /never a reply to a message of the human/)
  assert.match(t, /BACK end of the surface/)
})

test('limitNudgeText verlangt Lossless, nicht eine Größenobergrenze', () => {
  const t = limitNudgeText(310000)
  assert.match(t, /Lossless is mandatory/)
  assert.match(t, /small details included/)
  assert.match(t, /no size cap/)
  assert.doesNotMatch(t, /one fifth/)
  assert.doesNotMatch(t, /clearly smaller/)
})

test('limitNudgeText trägt den Zwischenfazit-Block als Bedingung (3)', () => {
  const t = limitNudgeText(310000)
  assert.match(t, /\(3\)/)
  assert.match(t, /# 📌 ZWISCHENFAZIT/)
  assert.match(t, /scrollable marker/)
})

test('zwischenfazitText: H1-Überschrift mit Pin, Wort ZWISCHENFAZIT, kein Code-Block, Handgriffe', () => {
  const t = zwischenfazitText()
  assert.match(t, /# 📌 ZWISCHENFAZIT/)
  assert.match(t, /H1/)
  assert.match(t, /never a code block/i)
  assert.match(t, /search/i)
  assert.match(t, /handgrips/i)
  assert.match(t, /Lossless is mandatory/)
  assert.match(t, /context_recall/)
})

test('kein Phasenhinweis mehr: phaseNudgeText existiert im gebauten phase.js nicht', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../lib/phase.js', import.meta.url), 'utf8')
  assert.equal(code.includes('phaseNudgeText'), false, 'noch vorhanden: phaseNudgeText')
  assert.equal(code.includes('2 of 2 items done'), false)
  assert.equal(code.includes('one fifth or less'), false)
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
    'one fifth or less',
    'clearly smaller than the span it replaces',
    'checkpoint must be smaller than the compressed span',
    'must be smaller than the compressed content',
    'volumeNudgeTokens',
    'volumeBaseline',
    'todosOf',
  ]) {
    assert.equal(code.includes(w), false, 'noch vorhanden: ' + w)
  }
  assert.equal(code.includes('only at the end of a finished phase'), true)
  assert.equal(code.includes('Lossless is mandatory'), true)
  assert.equal(code.includes('contextHardLimitTokens'), true)
})

test('gebautes lib/phase.js trägt die Zwischenfazit-Regel', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(new URL('../lib/phase.js', import.meta.url), 'utf8')
  assert.equal(code.includes('ZWISCHENFAZIT'), true)
  assert.equal(code.toLowerCase().includes('never a code block'), true)
})
