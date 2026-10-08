// Recall of compacted spans: references, archive ids and paths, the shared
// trunk archive, and the paged / searched rendering.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TrunkArchive,
  archivePath,
  footerText,
  referencedIds,
  renderRecall,
  spanArchiveId,
  splitBlocks,
  trunkArchiveId,
  trunkRecallId,
  withFooter,
} from '../lib/recall.js'
import { blocksWithFooter } from '../lib/optimizer.js'

const KEY = 'a'.repeat(64)
const archive = (n, size = 20) => Array.from({ length: n }, (_, i) =>
  '--- seq ' + (10 + i) + ' | pos ' + (i + 1) + ' | ' + (i % 2 ? 'assistant/message' : 'user/message') + ' ---\n' + ('message ' + i + ' ').repeat(size).trim()).join('\n\n')

test('footer: appended once, found again in plain and JSON-escaped text', () => {
  const t = withFooter('## Checkpoint\n- done\n\n', 'trunk:' + KEY)
  assert.equal(t, '## Checkpoint\n- done\n\n' + footerText('trunk:' + KEY))
  assert.equal(withFooter(t, 'trunk:' + KEY), t, 'idempotent')
  assert.deepEqual(referencedIds(t + '\n' + t), ['trunk:' + KEY])
  assert.deepEqual(referencedIds(JSON.stringify({ text: t })), ['trunk:' + KEY])
  // A checkpoint that quotes the footer with a placeholder is prose, not a reference.
  const span = 'session-2cf2a25e95ea/cc7ce0e8f447-000003'
  assert.deepEqual(referencedIds(footerText('<id>') + ' ' + footerText('…') + ' ' + footerText(span)), [span])
  // Live test 2026-10-08: the trunk summary quoted a placeholder and an older span
  // reference before its own footer; the tool reported "<id>". The id comes from the key.
  const quoted = ['## Checkpoint\n- format: ' + footerText('<id>') + '\n- older: ' + footerText(span), 'more']
  assert.equal(trunkRecallId(KEY, blocksWithFooter(quoted, 'trunk:' + KEY)), 'trunk:' + KEY)
  assert.equal(trunkRecallId(KEY, quoted), null, 'entry written before recall existed')
  assert.deepEqual(blocksWithFooter(['a', 'b'], 'x'), ['a', 'b\n\n' + footerText('x')])
  assert.deepEqual(blocksWithFooter([], 'x'), [footerText('x')])
  assert.deepEqual(blocksWithFooter(['a'], null), ['a'])
})

test('archive ids: spill files under the root, trunk keys, nothing else', () => {
  const root = '/home/u/.dsh/storages/spill'
  assert.equal(spanArchiveId(root, root + '/session-0123456789ab/268a1cf642e1-000002.txt'), 'session-0123456789ab/268a1cf642e1-000002')
  assert.equal(spanArchiveId(root, '/elsewhere/session-0123456789ab/x.txt'), null)
  assert.equal(spanArchiveId(null, root + '/session-0123456789ab/x.txt'), null)
  assert.equal(trunkArchiveId(KEY), 'trunk:' + KEY)
  const roots = { spillRoot: root, storeDir: '/home/u/.dsh/storages/agent-compact' }
  assert.equal(archivePath('session-0123456789ab/268a1cf642e1-000002', roots), root + '/session-0123456789ab/268a1cf642e1-000002.txt')
  assert.equal(archivePath('trunk:' + KEY, roots), roots.storeDir + '/trunk/' + KEY + '.raw.txt')
  for (const bad of ['../../etc/passwd', 'session-0123456789ab/..', 'session-0123456789ab/../x', 'trunk:abc', '/etc/passwd']) {
    assert.throws(() => archivePath(bad, roots), /unknown archive id/, bad)
  }
})

test('trunk archive: written once on disk, the second sibling does not render again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-recall-'))
  try {
    const store = new TrunkArchive(dir)
    let renders = 0
    const render = async () => { renders++; return archive(3) }
    assert.equal(await store.ensure(KEY, render), 'trunk:' + KEY)
    assert.equal(await store.ensure(KEY, render), 'trunk:' + KEY)
    assert.equal(renders, 1)
    assert.equal(await readFile(join(dir, 'trunk', KEY + '.raw.txt'), 'utf8'), archive(3))
    const got = await new TrunkArchive(dir).read('trunk:' + KEY, { spillRoot: null, storeDir: dir })
    assert.equal(got.text, archive(3))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trunk archive without a store directory lives in memory', async () => {
  const store = new TrunkArchive(null)
  await store.ensure(KEY, async () => 'raw trunk')
  assert.equal((await store.read('trunk:' + KEY, { spillRoot: null, storeDir: null })).text, 'raw trunk')
  await assert.rejects(new TrunkArchive(null).read('trunk:' + KEY, { spillRoot: null, storeDir: null }), /in memory only/)
})

test('render: pages through messages in order and names the next offset', () => {
  const text = archive(10)
  assert.equal(splitBlocks(text).length, 10)
  const first = renderRecall('trunk:' + KEY, text, '/x.txt', { maxChars: 1000 })
  assert.match(first.split('\n')[0], /^archive trunk:a+: 10 messages; showing messages at offset 0(-\d)?; more: offset \d; file \/x\.txt$/)
  const next = Number(/more: offset (\d+)/.exec(first)[1])
  const second = renderRecall('trunk:' + KEY, text, null, { offset: next, maxChars: 60000 })
  assert.match(second.split('\n')[0], new RegExp('showing messages at offset ' + next + '-9; end of archive$'))
  assert.ok(second.includes('--- seq 19 |'))
  assert.ok(!second.includes('--- seq 10 |'))
})

test('render: query returns only messages with every word, case-insensitive', () => {
  const text = archive(6).replace('message 3 message 3', 'message 3 SPECIAL error message 3')
  const out = renderRecall('x', text, null, { query: 'special ERROR' })
  assert.match(out.split('\n')[0], /1 of 6 messages match "special ERROR"; showing matches at offset 0; end of archive/)
  assert.ok(out.includes('--- seq 13 |'))
  assert.equal(renderRecall('x', text, null, { query: 'nowhere' }).split('\n')[0], 'archive x: 0 of 6 messages match "nowhere"; nothing at offset 0; end of archive')
})

test('render: a message larger than the page is cut and says where the rest is', () => {
  const text = archive(2, 2000)
  const out = renderRecall('x', text, '/a.txt', { maxChars: 1000 })
  assert.match(out, /\[\.\.\. \d+ more characters of this message; read \/a\.txt with offset\/limit for the rest\]/)
  assert.match(out.split('\n')[0], /showing messages at offset 0; more: offset 1/)
})

test('render: a long match is shown around the hit, and a later match as an excerpt while room is left', () => {
  const filler = (n) => ('filler ' + n + ' ').repeat(400)          // ~3.6K characters
  const text = [
    '--- seq 1 | pos 1 | user/message ---\nshort note about effort_position here',
    '--- seq 2 | pos 2 | assistant/message ---\n' + filler('a') + ' NEEDLE effort_position NEEDLE ' + filler('b'),
    '--- seq 3 | pos 3 | assistant/message ---\n' + filler('c') + ' effort_position again ' + filler('d'),
  ].join('\n\n')
  const out = renderRecall('x', text, null, { query: 'effort_position', maxChars: 2000 })
  const [status, ...rest] = out.split('\n')
  assert.match(status, /3 of 3 messages match "effort_position"; showing matches at offset 0-1; more: offset 2/)
  const body = rest.join('\n')
  assert.ok(body.includes('short note about effort_position'), 'first match whole')
  assert.ok(body.includes('NEEDLE effort_position NEEDLE'), 'second match shown around the hit')
  assert.ok(body.includes('--- seq 2 | pos 2 | assistant/message ---'), 'header kept')
  assert.match(body, /\[\.\.\. \d+ characters of this message before\]/)
  assert.ok(body.length <= 2000 + 50, 'page stays near maxChars: ' + body.length)
  // The first match on a page that does not fit is cut around its hit as well.
  const only = renderRecall('x', text, null, { query: 'again', maxChars: 1000 })
  assert.ok(only.includes('effort_position again'))
  assert.match(only.split('\n')[0], /showing matches at offset 0; end of archive/)
})
