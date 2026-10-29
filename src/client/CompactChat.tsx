import * as React from 'react'
import {
  BLOCK_KIND,
  END_KIND,
  compactState,
  computeHiding,
  isBlockKey,
  overlay,
  planEntries,
  planOrder,
  tokensText,
  visibleMembers,
  type BlockNode,
  type CompactionLite,
  type Hiding,
  type NodeLike,
} from './compact-core.js'

// DSH passes many, version dependent props to a conversation view. We name only the few
// we touch and hand everything else straight to DSH's own Chat component (`ChatView`).
type AnyProps = Record<string, any>

const NO_COMPACTIONS: readonly CompactionLite[] = []
const ABSENT = { getSnapshot: () => undefined, subscribe: () => () => {} }

interface Derived { readonly hiding: Hiding; readonly snapshot: any }

/** Filtered Chat snapshot, memoised per (base snapshot, compactions, expand state). */
const derivedCache = new WeakMap<object, { comps: readonly CompactionLite[]; expanded: ReadonlySet<string>; sessionId: string; value: Derived }>()
function derive(snapshot: any, comps: readonly CompactionLite[], expanded: ReadonlySet<string>, sessionId: string): Derived {
  const hit = derivedCache.get(snapshot)
  if (hit && hit.comps === comps && hit.expanded === expanded && hit.sessionId === sessionId) return hit.value
  const hiding = computeHiding(snapshot.order, (key) => snapshot.nodes.get(key) as NodeLike | undefined, comps, expanded, sessionId)
  const order = planOrder(snapshot.order, hiding)
  const blocks = hiding.blocks
  const nodes = overlay(snapshot.nodes, {
    get: (key: string) => (isBlockKey(key) ? blocks.get(key) : snapshot.nodes.get(key)),
    source: (key: string) => (isBlockKey(key) ? { getSnapshot: () => blocks.get(key), subscribe: () => () => {} } : snapshot.nodes.source(key)),
    processSource: (key: string) => (isBlockKey(key) ? ABSENT : snapshot.nodes.processSource(key)),
    turnDataSource: (key: string) => (isBlockKey(key) ? ABSENT : snapshot.nodes.turnDataSource(key)),
    values: () => [...snapshot.nodes.values(), ...blocks.values()],
  })
  const value: Derived = { hiding, snapshot: overlay(snapshot, { order, nodes }) }
  derivedCache.set(snapshot, { comps, expanded, sessionId, value })
  return value
}

const groupCache = new WeakMap<object, { hidden: ReadonlySet<string>; value: any }>()
function filterGroup(group: any, hidden: ReadonlySet<string>): any {
  if (!group || hidden.size === 0) return group
  const hit = groupCache.get(group)
  if (hit && hit.hidden === hidden) return hit.value
  const members = visibleMembers(group.members, hidden)
  const value = members === group.members ? group : { ...group, members }
  groupCache.set(group, { hidden, value })
  return value
}

const entriesCache = new WeakMap<object, { hiding: Hiding; value: any }>()

function useCompactions(props: AnyProps): { compactions: readonly CompactionLite[]; error: string | null } {
  const { sessionId, readCompactions } = props
  const growth = props.useChat((s: any) => s.order.length)
  const [state, setState] = React.useState<{ compactions: readonly CompactionLite[]; error: string | null }>({ compactions: NO_COMPACTIONS, error: null })
  React.useEffect(() => {
    if (!sessionId || typeof readCompactions !== 'function') return
    let cancelled = false
    const timer = setTimeout(() => {
      readCompactions({ sessionId }).then((result: any) => {
        if (cancelled) return
        if (result && result.ok === true) {
          const next: readonly CompactionLite[] = result.value.compactions
          setState((prev) => (sameCompactions(prev.compactions, next) ? (prev.error === null ? prev : { compactions: prev.compactions, error: null }) : { compactions: next, error: null }))
        } else setState({ compactions: NO_COMPACTIONS, error: (result && result.error && result.error.message) || 'read failed' })
      }).catch((err: unknown) => {
        if (!cancelled) setState({ compactions: NO_COMPACTIONS, error: err instanceof Error ? err.message : String(err) })
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [sessionId, readCompactions, growth])
  return state
}

function sameCompactions(a: readonly CompactionLite[], b: readonly CompactionLite[]): boolean {
  return a.length === b.length && a.every((c, i) => c.compactionId === b[i].compactionId && c.checkpointSeq === b[i].checkpointSeq && c.summaryText === b[i].summaryText)
}

// DSH scrolls the whole conversation area as ONE page ([data-conversation-scroll] makes the
// chat's own scroller `overflow: visible`), so a bar at the top of the tab scrolls away when
// the chat is at the bottom (measured: bar present in the DOM, not on screen). `sticky` keeps
// it at the top of that page; the opaque background keeps chat rows from showing through.
const barStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)',
  position: 'sticky', top: 0, zIndex: 9, background: 'var(--dsw-alias-bg-layer-1, #1b1b1d)',
}
const buttonStyle: React.CSSProperties = {
  font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover-solid)', border: 0, borderRadius: 6, padding: '3px 10px',
}

/**
 * The Compact Chat tab: DSH's own Chat component over a filtered Chat snapshot.
 * `ChatView` is the `component` of the registered `chat` view entry (see register.ts);
 * nothing of DSH is copied.
 */
export function CompactChat(props: AnyProps): React.ReactElement {
  const ChatView = props.ChatView as React.ComponentType<AnyProps>
  const sessionId: string = props.sessionId
  const { compactions, error } = useCompactions(props)
  React.useSyncExternalStore(compactState.subscribe, compactState.version)
  const expanded = compactState.expanded(sessionId)
  const active = compactions.length > 0
  const hidingRef = React.useRef<Hiding | null>(null)
  if (!active) hidingRef.current = null

  const useChat = React.useCallback((selector: (s: any) => any, equal?: any) => props.useChat((snapshot: any) => {
    if (!active) return selector(snapshot)
    const d = derive(snapshot, compactions, expanded, sessionId)
    hidingRef.current = d.hiding
    return selector(d.snapshot)
  }, equal), [props.useChat, active, compactions, expanded, sessionId])

  const useConversation = React.useCallback((selector: (s: any) => any, equal?: any) => props.useConversation((snapshot: any) => {
    if (!active) return selector(snapshot)
    const views = snapshot.views
    const chat = views.get('chat')
    const grouped = views.grouped('chat')
    if (!chat || !grouped) return selector(snapshot)
    const d = derive(chat, compactions, expanded, sessionId)
    const hit = entriesCache.get(grouped.entries)
    let entries: any
    if (hit && hit.hiding === d.hiding) entries = hit.value
    else {
      entries = planEntries(grouped.entries, (key) => grouped.groupSource(key)?.getSnapshot?.()?.members, d.hiding)
      entriesCache.set(grouped.entries, { hiding: d.hiding, value: entries })
    }
    return selector(overlay(snapshot, {
      views: overlay(views, { grouped: (target: string) => (target === 'chat' ? overlay(grouped, { entries }) : views.grouped(target)) }),
    }))
  }, equal), [props.useConversation, active, compactions, expanded, sessionId])

  const useChatNode = React.useCallback((key: any, selector: any, equal?: any) => {
    const typed = typeof key === 'string'
    const block = typed && isBlockKey(key)
    const found = props.useChatNode(block ? '' : key, block ? () => undefined : selector, equal)
    if (!block) return found
    const node = hidingRef.current?.blocks.get(key) as BlockNode | undefined
    return typeof selector === 'function' ? selector(node) : node
  }, [props.useChatNode])

  const useChatNodeProcess = React.useCallback((key: any, selector?: any, equal?: any) => {
    const block = typeof key === 'string' && isBlockKey(key)
    return props.useChatNodeProcess(block ? '' : key, selector, equal)
  }, [props.useChatNodeProcess])

  const useChatGroup = React.useCallback((key: any, selector: any, equal?: any) => props.useChatGroup(key, (group: any) => {
    const hidden = hidingRef.current?.hidden
    return selector(hidden ? filterGroup(group, hidden) : group)
  }, equal), [props.useChatGroup, expanded, compactions])

  const allIds = React.useMemo(() => compactions.map((c) => c.compactionId), [compactions])
  const hiddenCount = active ? hidingRef.current?.hidden.size ?? 0 : 0
  const rowsOf = hidingRef.current?.rows
  const loaded = active ? compactions.filter((c) => (rowsOf?.get(c.compactionId) ?? 0) > 0).length : 0
  const rowsReport = compactions.map((c) => `${c.compactionId.slice(0, 8)}:${rowsOf?.get(c.compactionId) ?? 0}/${c.shadowedSeqs.length}`).join(' ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 'auto', minHeight: 0, height: '100%' }}>
      <div style={barStyle} data-compact-chat-bar="" data-compact-rows={rowsReport} title={'loaded rows / replaced items per compaction: ' + rowsReport}>
        <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>Compact Chat</strong>
        <span>
          {!active
            ? (error ? `cannot read compactions: ${error}` : 'no compactions in this session')
            : `${compactions.length} compaction${compactions.length === 1 ? '' : 's'}, ${loaded} with loaded rows, ${hiddenCount} original row${hiddenCount === 1 ? '' : 's'} hidden${loaded < compactions.length ? ` (${compactions.length - loaded} lie in older history that is not loaded: scroll up, Load earlier)` : ''}`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={buttonStyle} disabled={!active} onClick={() => compactState.setAll(sessionId, allIds, true)}>Expand all</button>
        <button type="button" style={buttonStyle} disabled={!active} onClick={() => compactState.setAll(sessionId, allIds, false)}>Collapse all</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 'auto', minHeight: 0, position: 'relative' }}>
        <ChatView {...props} useChat={useChat} useConversation={useConversation} useChatNode={useChatNode} useChatNodeProcess={useChatNodeProcess} useChatGroup={useChatGroup} />
      </div>
    </div>
  )
}

// DSH's Markdown renderer lives in a package the client module loader hands to plugins
// through the factory's `require` (the esbuild bundle keeps this one call external, see
// scripts/build-client.mjs). It is fetched when a row first renders, NOT at load time, so a
// miss can never take the whole plugin (and the old "Model Context" tab) down with it.
declare const require: (id: string) => any
type MarkdownComponent = React.ComponentType<{ text: string; labels?: unknown }>
function loadMarkdownText(): MarkdownComponent | null {
  try {
    const found = require('@deepseek-ai/dsh-client-ui-primitives')?.MarkdownText
    return typeof found === 'function' || typeof found === 'object' ? (found as MarkdownComponent) : null
  } catch (error) {
    console.warn('[rolling-compaction] DSH MarkdownText not available, showing plain text:', error)
    return null
  }
}

const FALLBACK_LABELS = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } },
  footnotes: 'Footnotes',
}

/** Markdown chrome labels: DSH's own words when the row has the chat locale seat `t`, else English. */
function markdownLabels(t: unknown): unknown {
  if (typeof t !== 'function') return FALLBACK_LABELS
  const tr = t as (key: string) => string
  return {
    code: { copyLabel: tr('copy'), copiedLabel: tr('copied'), toolbarLabels: { codeLabel: tr('codeBlock.title'), wrapLabel: tr('codeBlock.wrap'), unwrapLabel: tr('codeBlock.unwrap') } },
    footnotes: tr('markdown.footnotes'),
  }
}

const metaStyle: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: '0 0 4px' }
const linkButtonStyle: React.CSSProperties = {
  font: 'inherit', fontSize: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-interactive-bg-hover-solid)', border: 0, borderRadius: 6, padding: '3px 10px',
}
const barRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', padding: '4px 10px',
  borderLeft: '3px solid var(--dsw-alias-state-warning-primary, #d9a400)', background: 'var(--dsw-alias-bg-layer-1, transparent)',
  fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
}

/**
 * Chat row for one compaction (Chat node kinds `compact-block` and `compact-end`).
 *  - collapsed: the checkpoint rendered like an ordinary chat message (DSH's MarkdownText),
 *    then a button "Expand original context";
 *  - expanded: a thin bar at the start of the originals and another at their end, each
 *    with "Collapse to checkpoint", so the way back is always close.
 * The toggle is display only; the model's context is never touched.
 */
export function CompactBlockView(props: AnyProps): React.ReactElement | null {
  const node = props.node as BlockNode | undefined
  React.useSyncExternalStore(compactState.subscribe, compactState.version)
  // Hooks first, before any early return: the row switches between states on a click.
  const labels = React.useMemo(() => markdownLabels(props.t), [props.t])
  const Markdown = React.useMemo(loadMarkdownText, [])
  if (!node || (node.kind !== BLOCK_KIND && node.kind !== END_KIND)) return null
  const { sessionId, compactionId, summaryText, itemCount, tokens } = node.data
  const open = compactState.expanded(sessionId).has(compactionId)
  const amount = `${itemCount} items (~${tokensText(tokens)} tokens)`
  const collapse = () => compactState.toggle(sessionId, compactionId)

  if (open || node.kind === END_KIND) {
    const end = node.kind === END_KIND
    return (
      <div data-compact-block={compactionId} data-compact-state="expanded" data-compact-bar={end ? 'end' : 'start'} style={barRowStyle}>
        <span style={{ flex: 1 }}>{end ? `End of original context (${amount})` : `Original context: ${amount}`}</span>
        <button type="button" style={linkButtonStyle} onClick={collapse}>Collapse to checkpoint</button>
      </div>
    )
  }

  return (
    <div data-compact-block={compactionId} data-compact-state="collapsed" style={{ margin: '10px 0' }}>
      <div style={metaStyle}>Context compacted: {amount}. This checkpoint is what the model reads instead of the originals.</div>
      {!summaryText
        ? <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>(no checkpoint text in the log)</div>
        : Markdown
          ? <Markdown text={summaryText} labels={labels} />
          : <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{summaryText}</div>}
      <div style={{ marginTop: 6 }}>
        <button type="button" style={linkButtonStyle} onClick={collapse} aria-expanded={false}>Expand original context</button>
      </div>
    </div>
  )
}

// ---- diagnostics: a crash inside the tab must show WHY instead of an empty pane ----

const NEEDED_PROPS = ['ChatView', 'sessionId', 'useChat', 'useConversation', 'useChatNode', 'useChatNodeProcess', 'useChatGroup', 'useSession', 'useStore', 'renderSlot']

class CrashBoundary extends React.Component<{ propNames: string; children?: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    console.error('[rolling-compaction] Compact Chat crashed:', error)
  }
  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div data-compact-chat-crash="" style={{ padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
        <strong style={{ color: 'var(--dsw-alias-state-error-primary, #e5484d)' }}>Compact Chat crashed: {error.message}</strong>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{String(error.stack || '').slice(0, 1800)}</pre>
        <div>props seen: {this.props.propNames}</div>
      </div>
    )
  }
}

/** Registered tab component: the real tab inside a crash boundary that reports the reason. */
export function CompactChatRoot(props: AnyProps): React.ReactElement {
  const names = Object.keys(props).sort()
  const missing = NEEDED_PROPS.filter((n) => props[n] === undefined)
  if (missing.length > 0) {
    return (
      <div data-compact-chat-crash="" style={{ padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
        <strong style={{ color: 'var(--dsw-alias-state-error-primary, #e5484d)' }}>Compact Chat cannot start: missing props {missing.join(', ')}</strong>
        <div>props seen: {names.join(', ')}</div>
      </div>
    )
  }
  return (
    <CrashBoundary propNames={names.join(', ')}>
      <CompactChat {...props} />
    </CrashBoundary>
  )
}
