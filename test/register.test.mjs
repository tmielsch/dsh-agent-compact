import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// register.ts imports the React views; the registration logic itself needs none of them.
const stubViews = {
  name: 'stub-views',
  setup(build) {
    build.onResolve({ filter: /CompactChat\.js$/ }, () => ({ path: 'stub-views', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const CompactChat = function CompactChat(){}; export const CompactBlockView = function CompactBlockView(){}', loader: 'js' }))
  },
}
const built = await esbuild.build({
  entryPoints: [join(root, 'src/client/register.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent', plugins: [stubViews],
})
const { registerCompactChat } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))

// Minimal stand-in for DSH's slot ledger: just the parts register.ts touches.
function fakeSlots() {
  const entries = []
  const subscribers = new Set()
  const pendingInject = []
  const slots = {
    entries: (name) => entries.filter((e) => e.slot === name),
    register(options, component) {
      const entry = { slot: options.name, component, options: { id: options.id, key: options.key, order: options.order, label: options.label }, children: options.children, store: options.store, locale: options.locale, inject: options.inject }
      entries.push(entry)
      for (const fn of subscribers) fn()
      return () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); slots.released.push(entry.children) }
    },
    inject(name, factory) { pendingInject.push([name, factory()]) },
    subscribe(name, fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    released: [],
    entries_: entries,
  }
  return slots
}

const chatChildren = { 'conversation.chat.node': { kind: 'keyed', scope: 'session' }, 'conversation.message.images': { kind: 'single', scope: 'session' } }
function addChat(slots, extra = {}) {
  slots.register({ name: 'conversation.view', id: 'chat', order: 0, label: () => 'Chat', children: chatChildren, store: { s: 1 }, locale: 'chat', inject: (id) => ({ hooks: { x: 1 }, sessionId: id }), ...extra }, function ChatView() {})
}

test('registers the block row and the tab once the Chat entry exists, borrowing its children', () => {
  const slots = fakeSlots()
  addChat(slots)
  const dispose = registerCompactChat(slots, async () => ({}))
  const tab = slots.entries('conversation.view').find((e) => e.options.id === 'compact-chat')
  assert.ok(tab, 'tab registered')
  assert.equal(tab.options.label(), 'Compact Chat')
  assert.equal(tab.children, chatChildren, 'children borrowed from the Chat entry (not re-declared)')
  assert.equal(tab.store, slots.entries('conversation.view')[0].store)
  assert.equal(slots.entries('conversation.chat.node').length, 1)
  assert.equal(slots.entries('conversation.chat.node')[0].options.key, 'compact-block')
  const injected = tab.inject('sess', {})
  assert.equal(injected.sessionId, 'sess')
  assert.equal(typeof injected.ChatView, 'function')
  assert.equal(typeof injected.readCompactions, 'function')
  dispose()
})

test('waits for the Chat entry and registers when it appears', () => {
  const slots = fakeSlots()
  const dispose = registerCompactChat(slots, async () => ({}))
  assert.equal(slots.entries('conversation.view').length, 0)
  addChat(slots)
  assert.ok(slots.entries('conversation.view').find((e) => e.options.id === 'compact-chat'))
  dispose()
})

test('dispose gives the borrowed children back before the entry is released (the Chat keeps its slots)', () => {
  const slots = fakeSlots()
  addChat(slots)
  const dispose = registerCompactChat(slots, async () => ({}))
  dispose()
  assert.equal(slots.entries('conversation.view').some((e) => e.options.id === 'compact-chat'), false)
  assert.deepEqual(slots.released.at(-1), {}, 'released entry no longer carries the Chat children')
  assert.equal(chatChildren['conversation.chat.node'].kind, 'keyed', 'Chat children untouched')
  dispose() // idempotent
})

test('fails soft: a register error adds no tab and reports it', () => {
  const slots = fakeSlots()
  addChat(slots)
  const real = slots.register
  slots.register = (options, component) => {
    if (options.id === 'compact-chat') throw new Error('boom')
    return real(options, component)
  }
  const warnings = []
  const dispose = registerCompactChat(slots, async () => ({}), (m) => warnings.push(m))
  assert.equal(slots.entries('conversation.view').some((e) => e.options.id === 'compact-chat'), false)
  assert.match(warnings[0], /not registered: boom/)
  dispose()
})
