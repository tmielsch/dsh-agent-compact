// Anchors quoted from the model's view of the transcript. Every case comes from a
// failed context_compact call in a real session (stalker-dev, 2026-10-08), with the
// node shapes of that session's log.

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBoundaries, prefixHits } from '../lib/boundary.js'
import { stripHandles } from '../lib/anchor.js'

const IMG_A = 'sha256:1c9be60e6d716067cf2869145f6cb4aaa1b1d5507246737286b99455f0575020'
const IMG_B = 'sha256:456754a2e290c9fce18f869b306b5f855858b0547155a16d8aa8379838e14b99'

const user = (seq, ...content) => ({ seq, type: 'user/message', data: { content } })
const text = (t) => ({ type: 'text', text: t })
const image = (id, name = 'grafik.png') => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/webp', width: 1737, height: 801, bytes: 40096, name } })
const assistant = (seq, ...content) => ({ seq, type: 'assistant/message', data: { message: { content } } })
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const result = (seq, callId, t) => ({ seq, type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'tool-result', isError: false, content: [text(t)] }] } } })

function surface() {
  return [
    user(1, text('Ausgangsfrage zum Hausgenerator')),
    user(2, image(IMG_B), text('Hier ist das stück')),
    assistant(3, text('Danke, ich schaue es mir an.')),
    user(4, text('Team message team-message-348c59b9 from wand-experte:'), text("**b' ist NICHT gelöst — mein Fix hat sein Ziel verfehlt und zusätzlich eine Regression erzeugt.**")),
    assistant(5, call('c1', 'send_message', { target: 'wand-experte', message: 'Lead an wand-experte — meine Gegenmessung zu deinem Reststück-Bericht: die Fugen stimmen.' })),
    result(6, 'c1', '{"ok":true}'),
    assistant(7, call('c2', 'mcp__houdini__save_scene', {})),
    result(8, 'c2', '{"success":true,"hip_file":"/Users/tmielsch/Perforce/stalker-dev/houdini/buildings/projects/buildings.hiplc"}'),
    user(9, image(IMG_A), text('Hier bei den 2 gestackten wänden ist das tiling broken')),
    assistant(10, text('Ich prüfe das.'), call('c3', 'bash', { command: "python3 - <<'PY' | gh issue comment 445 -R tmielsch/stalker-topdown" })),
    result(11, 'c3', 'commented'),
    assistant(12, call('c4', 'todo_write', { todos: [{ content: 'Schritt 2a: Prüfwände für Teilkachel', status: 'in_progress' }] })),
    result(13, 'c4', 'Updated todo list'),
    user(14, text('weiter')),
  ]
}

const seqOf = (nodes, anchor) => prefixHits(nodes, anchor).map((i) => nodes[i].seq)

test('image: the handle line the model saw resolves to the message with that attachment', () => {
  const nodes = surface()
  assert.deepEqual(seqOf(nodes, 'Image "grafik.png" (' + IMG_A + ')'), [9])
  const handle = 'Image "grafik.png" (' + IMG_A + '); request preview 1737x801px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.'
  assert.deepEqual(seqOf(nodes, handle), [9], 'whole handle line, no text after it')
  assert.deepEqual(seqOf(nodes, handle + ' Hier bei den 2 gestackten'), [9], 'handle line, then the text')
  assert.deepEqual(seqOf(nodes, '[image omitted because this model accepts text only; attachment sha256:1c9be60e] Hier bei den 2'), [9], 'text-only model placeholder')
  assert.deepEqual(seqOf(nodes, 'Hier bei den 2 gestackten'), [9], 'the text alone still works')
  assert.deepEqual(seqOf(nodes, 'Image "grafik.png" (' + IMG_B + ') Hier bei'), [], 'another attachment id does not match')
  assert.deepEqual(seqOf(nodes, 'Image "grafik.png"').sort(), [2, 9], 'the name alone is ambiguous, never a silent pick')
})

test('image: stripHandles takes the known handle forms and keeps the text after them', () => {
  assert.deepEqual(stripHandles('Image "a.png" (' + IMG_A + '); request preview 10x20px. Hallo'), { ids: [IMG_A], rest: 'Hallo' })
  assert.deepEqual(stripHandles('[image] [File "n.txt" (12 bytes, sha256:1c9be60e): verbatim read-only copy saved at "/x". Read that path] Text'), { ids: ['', 'sha256:1c9be60e'], rest: 'Text' })
  assert.deepEqual(stripHandles('Image ohne Kennung'), { ids: [], rest: 'Image ohne Kennung' })
})

test('team message: the body after the header line resolves to that message', () => {
  assert.deepEqual(seqOf(surface(), "**b' ist NICHT gelöst — mein Fix hat sein Ziel verfehlt"), [4])
})

test('tool call: a marker copied in another case, and JSON with other spacing', () => {
  const nodes = surface()
  assert.deepEqual(seqOf(nodes, "[tool-call Bash] {\"command\":\"python3 - <<'PY' | gh issue comment 445"), [10], 'call after a text block, marker in another case')
  assert.deepEqual(seqOf(nodes, '[tool-call todo_write] {"todos": [{"content": "Schritt 2a: Prüfwände für Teilkachel'), [12], 'JSON spacing')
})

test('tool call: the opening of a string argument (the message of send_message)', () => {
  assert.deepEqual(seqOf(surface(), 'Lead an wand-experte — meine Gegenmessung zu deinem Reststück-Bericht'), [5])
})

test('tool result: accepted when no message matches, and the span snaps to its call', () => {
  const nodes = surface()
  const r = resolveBoundaries(nodes, { startAnchor: 'Ausgangsfrage', endAnchor: '{"success":true,"hip_file":"/Users/tmielsch/Perforce/stalker-dev/houdini/buildings/projects/buildings.hiplc"}' })
  assert.equal(r.startSeq, 1)
  assert.equal(r.endSeq, 8)
  const s = resolveBoundaries(nodes, { startAnchor: '{"success":true,"hip_file"', endAnchor: 'weiter' })
  assert.equal(s.startSeq, 7, 'a result as start snaps back to the assistant message that issued the call')
})

test('regression guard: an anchor that matched one node before still resolves to it alone', () => {
  // Node 2 starts (after its image) with "Hier ist das stück"; a later block of another
  // message starting the same must not make the old, unique match ambiguous.
  const nodes = [...surface(), user(15, text('Team message x from y:'), text('Hier ist das stück, noch einmal'))]
  assert.deepEqual(seqOf(nodes, 'Hier ist das stück'), [2])
})

test('self-loop guard: arguments and results of context_compact / context_recall never match', () => {
  const nodes = [
    user(1, text('please fix the login bug')),
    assistant(2, call('k1', 'context_compact', { startAnchor: 'meine besondere Formulierung hier', endAnchor: 'x' })),
    result(3, 'k1', 'meine besondere Formulierung hier, als Echo'),
    assistant(4, call('k2', 'context_recall', { query: 'meine besondere Formulierung hier' })),
    result(5, 'k2', 'meine besondere Formulierung hier'),
    user(6, text('weiter')),
  ]
  assert.deepEqual(seqOf(nodes, 'meine besondere Formulierung hier'), [])
})

test('hints show the model view: an ambiguous image anchor lists each handle with its id', () => {
  let message = ''
  try {
    resolveBoundaries(surface(), { endAnchor: 'Image "grafik.png"' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  assert.match(message, /seq 2 .*456754a2/)
  assert.match(message, /seq 9 .*1c9be60e/)
})
