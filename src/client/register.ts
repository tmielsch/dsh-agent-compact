// Compact Chat: registration against DSH's slot ledger (no React here).
//
// Two things are registered:
//  1. a Chat node kind `compact-block` (supported API: slot `conversation.chat.node`, keyed);
//  2. a second conversation view `compact-chat` that renders DSH's OWN Chat component
//     (taken from the registered `chat` view entry) over a filtered snapshot.
//
// (2) leans on internals of DSH 0.2.0-rc.2 (an entry's `component`, `inject`, `store`,
// `locale`, `children` fields). It fails soft: if the `chat` entry is missing or
// anything throws, no tab is added and the normal Chat is never touched.

import { CompactBlockView, CompactChatRoot } from './CompactChat.js'
import { BLOCK_KIND } from './compact-core.js'

const TAB_ID = 'compact-chat'
const CHAT_ID = 'chat'

interface SlotsLike {
  entries(name: string): readonly any[]
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(name: string, factory: () => () => void): unknown
  subscribe(name: string, fn: () => void): () => void
}

/**
 * Add the Compact Chat tab and its block row.
 * @param slots - the Cordis `slots` service of the plugin context.
 * @param readCompactions - `ctxSurface.compactions` remote call.
 * @returns disposer; safe to call more than once.
 */
export function registerCompactChat(slots: SlotsLike, readCompactions: (request: { sessionId: string }) => Promise<unknown>, warn: (message: string) => void = () => {}): () => void {
  let disposed = false
  let registering = false
  let disposeTab: (() => void) | null = null
  let mine: any = null

  // 1. the block row (deferred by the slot machinery until `conversation.chat.node` exists)
  slots.inject('conversation.chat.node', () => slots.register({ name: 'conversation.chat.node', key: BLOCK_KIND }, CompactBlockView))

  // 2. the tab, once the Chat entry exists
  const tryRegister = (): void => {
    if (disposed || disposeTab !== null || registering) return
    const chat = slots.entries('conversation.view').find((e) => e.options && e.options.id === CHAT_ID)
    if (!chat || typeof chat.component !== 'function' && typeof chat.component !== 'object') return
    registering = true
    try {
      const inject = (sessionId: string, actions: unknown) => ({
        ...(typeof chat.inject === 'function' ? chat.inject(sessionId, actions) : {}),
        ChatView: chat.component,
        readCompactions,
      })
      disposeTab = slots.register({
        name: 'conversation.view',
        id: TAB_ID,
        order: 10,
        label: () => 'Compact Chat',
        // An empty (but defined) children table makes DSH hand us `renderSlot`; the
        // slots it may render are borrowed from the Chat entry just below.
        children: {},
        ...(chat.store !== undefined ? { store: chat.store } : {}),
        ...(chat.locale !== undefined ? { locale: chat.locale } : {}),
        inject,
      }, CompactChatRoot)
      mine = slots.entries('conversation.view').find((e) => e.options && e.options.id === TAB_ID)
      if (mine && chat.children) mine.children = chat.children
    } catch (error) {
      warn('[rolling-compaction] Compact Chat tab not registered: ' + (error instanceof Error ? error.message : String(error)))
      disposeTab = null
      mine = null
    } finally {
      registering = false
    }
  }
  tryRegister()
  const unsubscribe = slots.subscribe('conversation.view', tryRegister)

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    // The borrowed children must not be released with our entry: that would unregister
    // the Chat's own slots. Put the empty table back first.
    if (mine) mine.children = {}
    if (disposeTab) disposeTab()
    disposeTab = null
  }
}
