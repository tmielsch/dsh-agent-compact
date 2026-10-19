import test from 'node:test'
import assert from 'node:assert/strict'
import { SummaryStash, keptLabel, matchKept, KEEP } from '../lib/summary-stash.js'

// ---- SummaryStash: der Text eines Fehlschlags bleibt erhalten, der
// Wiederversuch nimmt ihn ohne summary wieder auf (gemeldet 2026-10-20:
// "nach jedem Fehlschlag wird der geschriebene Text verworfen"). ----

test('matchKept: same resolved range wins first', () => {
  const entries = [
    { text: 'B', startSeq: 5, endSeq: 9 },
    { text: 'A', startSeq: 1, endSeq: 4 },
  ]
  const hit = matchKept(entries, { startSeq: 1, endSeq: 4, startAnchor: 'x', endAnchor: 'y' })
  assert.equal(hit && hit.text, 'A')
})

test('matchKept: the same endAnchor matches even when the range moved', () => {
  const entries = [{ text: 'A', endAnchor: 'Let us look at the logs' }]
  const hit = matchKept(entries, { startSeq: 10, endSeq: 12, endAnchor: 'Let us look at the logs' })
  assert.equal(hit && hit.text, 'A')
})

test('matchKept: a lengthened anchor matches an entry that never resolved a range', () => {
  const entries = [{ text: 'A', endAnchor: 'Kurz' }]
  const hit = matchKept(entries, { endAnchor: 'Kurz nach dem Aufbau' })
  assert.equal(hit && hit.text, 'A')
  const back = matchKept([{ text: 'A', endAnchor: 'Kurz nach dem Aufbau' }], { endAnchor: 'Kurz' })
  assert.equal(back && back.text, 'A')
})

test('matchKept: an entry with a resolved range never matches by anchors', () => {
  const entries = [{ text: 'A', startSeq: 1, endSeq: 4, endAnchor: 'Kurz' }]
  assert.equal(matchKept(entries, { endAnchor: 'Kurz nach dem Aufbau' }), null)
})

test('matchKept: a different span gets nothing', () => {
  const entries = [{ text: 'A', startSeq: 1, endSeq: 4, startAnchor: 'a', endAnchor: 'b' }]
  assert.equal(matchKept(entries, { startAnchor: 'a', endAnchor: 'c' }), null)
  assert.equal(matchKept(entries, {}), null)
})

test('stash: save/takeMatched round trip consumes the entry once', () => {
  const stash = new SummaryStash()
  stash.save('s1', { text: 'A', startAnchor: 'a', endAnchor: 'b', startSeq: 1, endSeq: 4 })
  const hit = stash.takeMatched('s1', { startSeq: 1, endSeq: 4 })
  assert.equal(hit && hit.text, 'A')
  assert.equal(stash.takeMatched('s1', { startSeq: 1, endSeq: 4 }), null)
})

test('stash: the same attempt saving twice stays one entry (update in place)', () => {
  const stash = new SummaryStash()
  // Der erste save passiert vor der Anker-Auflösung, der zweite danach.
  stash.save('s1', { text: 'A', startAnchor: 'a', endAnchor: 'b' })
  stash.save('s1', { text: 'A', startAnchor: 'a', endAnchor: 'b', startSeq: 7, endSeq: 9 })
  assert.equal(stash.list('s1').length, 1)
  assert.equal(stash.list('s1')[0].startSeq, 7)
})

test('stash: the ring keeps the newest entries, oldest dropped first', () => {
  const stash = new SummaryStash()
  for (let i = 1; i <= KEEP + 2; i++) stash.save('s1', { text: 'T' + i, endAnchor: 'a' + i })
  const list = stash.list('s1')
  assert.equal(list.length, KEEP)
  assert.equal(list[0].text, 'T' + (KEEP + 2))
  assert.equal(list[KEEP - 1].text, 'T' + 3)
})

test('stash: sessions do not share their kept texts', () => {
  const stash = new SummaryStash()
  stash.save('s1', { text: 'A', endAnchor: 'a' })
  assert.equal(stash.takeMatched('s2', { endAnchor: 'a' }), null)
  assert.equal(stash.takeMatched('s1', { endAnchor: 'a' })?.text, 'A')
})

test('stash: clear drops everything of a session', () => {
  const stash = new SummaryStash()
  stash.save('s1', { text: 'A', startSeq: 1, endSeq: 2 })
  stash.clear('s1')
  assert.equal(stash.list('s1').length, 0)
  assert.equal(stash.takeMatched('s1', { startSeq: 1, endSeq: 2 }), null)
})

test('keptLabel: names the range when known, else the anchor', () => {
  assert.equal(keptLabel({ text: 'A', startSeq: 1, endSeq: 4 }), 'range [1,4]')
  assert.equal(keptLabel({ text: 'A', endAnchor: 'Kurz  nach\nAufbau' }), 'endAnchor "Kurz nach Aufbau"')
  const long = 'x'.repeat(80)
  const label = keptLabel({ text: 'A', endAnchor: long })
  assert.ok(label.includes('…') && label.length < 80)
})
