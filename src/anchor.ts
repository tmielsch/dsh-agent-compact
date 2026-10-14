// @tmielsch/rolling-compaction (fork): anchor matching against what the model saw.
//
// The model quotes an anchor from its own view of the transcript, which differs from
// the plain node text the matcher used to compare:
//   - an attached image or file reaches the model as a handle line before it
//     (dsh-llm `requestImageHandleText`: `Image "grafik.png" (sha256:…); request preview …`),
//     while the node text drops media entirely;
//   - a message may consist of several blocks (a team-message header, then the body;
//     text, then a tool call) and the model quotes the block it remembers;
//   - tool calls are quoted with the marker the error hints print (`[tool-call Bash] …`),
//     in another case and with other JSON spacing;
//   - a tool call is remembered by its argument (the message of a send_message call);
//   - sometimes the opening of a tool result is quoted.
//
// Matching runs in tiers and returns the first tier with hits, so an anchor that
// matched before (tier 1 is exactly the previous rule) still resolves to the same
// node and never becomes ambiguous through the new readings. Uniqueness is still
// required by the caller: a wrong node is never picked silently.

import { normText } from './normalize.js'
import { blockText, nodeContent } from './surface-text.js'
import type { SurfaceNode } from './optimizer.js'

/** Tools whose calls and results echo anchors: never anchor targets through their arguments or results. */
const SELF_TOOLS = new Set(['context_compact', 'context_recall'])
/** A string argument shorter than this is too generic to identify a call. */
const MIN_ARG_CHARS = 12

/** Normalized text without the `[tool-call …]` / `[tool-result]` markers the hints print. */
export function strippedText(s: string): string {
  return normText(
    s
      .replace(/\[tool-call\s+[^\]]*\]\s*/gi, '')
      .replace(/\[tool-result(?:\s+error)?\]\s*/gi, ''),
  )
}

const loose = (s: string): string => s.replace(/\s+/g, '')
const exact = (s: string): string => s

// The handle texts dsh-llm puts in front of an attachment (see dsh-llm types/content.js),
// matched on normalized text. Group 1 is the attachment id or its 8-hex prefix.
const Q = '"(?:[^"\\\\]|\\\\.)*"'
const ID = '(sha256:[0-9a-f]{8,64})'
const HANDLES: RegExp[] = [
  new RegExp(
    '^Image (?:' + Q + ' \\()?' + ID + '\\)?'
      + '(?:; request preview \\d+x\\d+px\\.)?'
      + '(?: It may be resized or re-encoded; source dimensions, format, and byte size may differ\\.)?'
      + '(?: Normalized copy \\(read-only; may be resized or re-encoded\\): ' + Q + ' \\(\\d+x\\d+px, [^)]*\\)\\.'
      + ' Source dimensions, format, and byte size may differ\\. Copy to a writable path ending in \\.\\w+ before editing\\.)? ?',
  ),
  new RegExp('^\\[image omitted because this model accepts text only; attachment ' + ID + '\\] ?'),
  new RegExp('^\\[image omitted to fit request image limits; (?:' + Q + ' \\()?' + ID + '\\)?\\.[^\\]]*\\] ?'),
  new RegExp('^\\[File ' + Q + ' \\(\\d+ bytes, ' + ID + '\\)[^\\]]*\\] ?'),
  /^\[image\] ?()/,
]

/** Leading attachment handles of a normalized anchor: their ids ('' = any) and the text after them. */
export function stripHandles(anchorNorm: string): { ids: string[]; rest: string } {
  const ids: string[] = []
  let rest = anchorNorm
  for (let guard = 0; guard < 32; guard++) {
    let hit = false
    for (const re of HANDLES) {
      const m = re.exec(rest)
      if (m && m[0].length) {
        ids.push(m[1] ?? '')
        rest = rest.slice(m[0].length)
        hit = true
        break
      }
    }
    if (!hit) break
  }
  return { ids, rest: rest.trim() }
}

/** One content block as the matcher sees it. */
export interface AnchorItem {
  kind: 'text' | 'media' | 'call'
  /** Plain text (media: empty; call: `[tool-call name] args`). */
  text: string
  /** media: the attachment id. */
  id?: string
  /** media: the handle label the model saw, `Image "name" (sha256:…)`. */
  label?: string
  /** call: the tool name. */
  name?: string
  /** call: top-level string argument values long enough to identify it. */
  values?: string[]
}

interface RawBlock {
  type?: unknown
  name?: unknown
  arguments?: unknown
  attachment?: { attachmentId?: unknown; name?: unknown; bytes?: unknown } | null
}

function stringArgs(args: unknown): string[] {
  let v: unknown = args
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  return Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === 'string' && x.trim().length >= MIN_ARG_CHARS)
}

function mediaItem(b: RawBlock): AnchorItem {
  const att = b.attachment ?? {}
  const id = typeof att.attachmentId === 'string' ? att.attachmentId : ''
  const name = typeof att.name === 'string' ? att.name : undefined
  let label = '[image]'
  if (b.type === 'image' && id) label = 'Image ' + (name === undefined ? id : JSON.stringify(name) + ' (' + id + ')')
  if (b.type === 'file') label = '[File ' + JSON.stringify(name ?? '') + ' (' + String(att.bytes ?? 0) + ' bytes, sha256:' + id.slice(7, 15) + ')'
  return { kind: 'media', text: '', id, label }
}

/** The content blocks of a node, in order, as anchor items (reasoning skipped). */
export function anchorItems(n: SurfaceNode): AnchorItem[] {
  const blocks = nodeContent(n)
  if (!Array.isArray(blocks)) return []
  const out: AnchorItem[] = []
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as RawBlock
    if (b.type === 'reasoning') continue
    if (b.type === 'image' || b.type === 'file') {
      out.push(mediaItem(b))
      continue
    }
    const text = blockText(b, 0, { skipReasoning: true, dropImages: true }, Infinity).text
    if (b.type === 'tool-call') {
      const name = String(b.name ?? '')
      out.push({ kind: 'call', text, name, values: SELF_TOOLS.has(name) ? [] : stringArgs(b.arguments) })
      continue
    }
    if (text) out.push({ kind: 'text', text })
  }
  return out
}

/** Text of the items from index k on; media as their handle labels or dropped. */
function textFrom(items: AnchorItem[], k: number, labels: boolean, cap: number): string {
  let out = ''
  for (let i = k; i < items.length && out.length < cap; i++) {
    const it = items[i]
    const t = it.kind === 'media' ? (labels ? it.label ?? '' : '') : it.text
    if (t) out += t + '\n'
  }
  return out.slice(0, cap)
}

/**
 * A node's text as the model saw it, attachments as their handle labels: what error
 * hints show, so a quoted preview is itself an anchor that resolves.
 */
export function modelViewText(n: SurfaceNode): string {
  return textFrom(anchorItems(n), 0, true, Infinity).replace(/\n+$/, '')
}

/** The `[tool-call name]` marker the hints print, at the very start of an anchor. */
const MARKER_AT_START = /^\[tool-call\s+([^\]]*)\]/i

/** Case- and punctuation-insensitive form of a tool name (`mcp__houdini__execute-python` → `mcphoudiniexecutepython`). */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Every reading of one tool name: the whole name and each `__`-separated segment.
 *
 * A model that quotes a namespaced call routinely drops the namespace:
 * `mcp__houdini__execute_python` is remembered and written as `execute_python`.
 * The segments are the readings that still identify the same call.
 *
 * The name alone is NOT enough to identify a call: `[tool-call Bash] …` names
 * one of hundreds of Bash calls, and matching on the name by itself turned a
 * precise anchor into "every node of this tool". It is therefore only ever
 * compared together with the argument text that follows the marker (see
 * `markerArgument`).
 */
export function toolNameSegments(name: string): string[] {
  const out = new Set<string>()
  const whole = nameKey(name)
  if (whole) out.add(whole)
  for (const part of name.split('__')) {
    const key = nameKey(part)
    if (key) out.add(key)
  }
  return [...out]
}

/** An anchor in every reading the tiers compare. */
export interface AnchorForm {
  /** normalized anchor */
  n: string
  /** normalized anchor without tool-call / tool-result markers */
  s: string
  /** leading attachment handles' ids */
  ids: string[]
  /** text after the handles, normalized and marker-stripped */
  restN: string
  restS: string
  /** how much node text a prefix comparison needs (whitespace collapses, so with margin) */
  cap: number
  /** the tool name a leading `[tool-call …]` marker quotes, in comparison form ('' = no marker) */
  markerName: string
  /** what follows that marker in the anchor, marker- and whitespace-normalized ('' = name only) */
  markerArgument: string
}

export function anchorForm(anchor: string): AnchorForm {
  const n = normText(anchor)
  const { ids, rest } = stripHandles(n)
  const marker = MARKER_AT_START.exec(n.trimStart())
  return {
    n,
    s: strippedText(anchor),
    ids,
    restN: normText(rest),
    restS: strippedText(rest),
    cap: anchor.length * 4 + 4000,
    markerName: marker ? nameKey(marker[1]) : '',
    markerArgument: marker ? normText(n.trimStart().slice(marker[0].length)) : '',
  }
}

const startsWith = (text: string, prefix: string): boolean => prefix.length > 0 && text.startsWith(prefix)

/**
 * Whether the anchor opens the node at item k. `previous` restricts to the rule used
 * before this extension (plain text, anchor taken as it is); `L` is exact or loose
 * (whitespace-free) comparison.
 */
function matchAt(items: AnchorItem[], k: number, f: AnchorForm, L: (s: string) => string, previous: boolean): boolean {
  const plain = textFrom(items, k, false, f.cap)
  const pn = L(normText(plain))
  const ps = L(strippedText(plain))
  const an = L(f.n)
  if (startsWith(pn, an) || startsWith(ps, an)) return true
  if (previous) return false
  // Markers the model copied from a hint, in any case.
  if (startsWith(ps, L(f.s))) return true
  const it = items[k]
  // The anchor quotes (the start of) an attachment handle line.
  if (it?.kind === 'media' && startsWith(L(normText(textFrom(items, k, true, f.cap))), an)) return true
  // Whole handle lines, then the text after the attachments.
  if (f.ids.length) {
    let j = k
    let ok = true
    for (const id of f.ids) {
      const m = items[j]
      if (!m || m.kind !== 'media' || (id && !(m.id ?? '').startsWith(id))) {
        ok = false
        break
      }
      j++
    }
    if (ok) {
      if (!f.restN) return true
      const rest = textFrom(items, j, false, f.cap)
      if (startsWith(L(normText(rest)), L(f.restN)) || startsWith(L(strippedText(rest)), L(f.restS))) return true
    }
  }
  // The opening of a string argument of a tool call.
  if (it?.kind === 'call') {
    for (const v of it.values ?? []) if (startsWith(L(normText(v)), an)) return true
  }
  // The anchor quotes the call with `[tool-call …]`, but with a shortened tool
  // name: the model drops the namespace (`execute_python` for
  // `mcp__houdini__execute_python`), or writes it without the prefix at all.
  //
  // The name alone identifies nothing — it must be carried by the argument text
  // the anchor also quotes, otherwise `[tool-call Bash] {"command":"cd …"}`
  // would match every Bash call in the session. When the anchor stops at the
  // marker (nothing but the name), the exact-marker rule above has already had
  // its chance and this reading is skipped rather than turned into a flood.
  if (f.markerName && f.markerArgument && it?.kind === 'call') {
    const named = toolNameSegments(it.name ?? '').includes(f.markerName)
    if (named) {
      const argText = normText(textFrom(items, k, false, f.cap).replace(MARKER_AT_START, ''))
      if (startsWith(argText, f.markerArgument)) return true
    }
  }
  return false
}

/**
 * Tiers, first with hits wins:
 *  1. the previous rule: the node's plain opening;
 *  2. the model's view of the opening: attachment handles, copied markers, a call's argument;
 *  3. the opening of a later block of the message;
 *  4. tiers 1-3 ignoring whitespace (JSON spacing of quoted tool calls).
 */
export function messageTiers(f: AnchorForm): Array<(items: AnchorItem[]) => boolean> {
  return [
    (it) => matchAt(it, 0, f, exact, true),
    (it) => matchAt(it, 0, f, exact, false),
    (it) => it.some((_, k) => k > 0 && matchAt(it, k, f, exact, false)),
    (it) => it.length > 0 && it.some((_, k) => matchAt(it, k, f, loose, false)),
  ]
}

/** Tool results, only when no message matches: exact, then ignoring whitespace. */
export function resultTiers(f: AnchorForm): Array<(items: AnchorItem[]) => boolean> {
  return [
    (it) => matchAt(it, 0, f, exact, false),
    (it) => matchAt(it, 0, f, loose, false),
  ]
}

/** Call id → tool name, over every tool call on the surface. */
export function callNames(nodes: SurfaceNode[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) {
    if (n.type !== 'assistant/message') continue
    const content = (n.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const blk = b as { type?: unknown; id?: unknown; name?: unknown }
      if (blk && blk.type === 'tool-call' && typeof blk.id === 'string') out.set(blk.id, String(blk.name ?? ''))
    }
  }
  return out
}

/** The call id a tool/result node answers, when recorded. */
export function resultCallId(n: SurfaceNode): string | null {
  const m = (n.data as { message?: { toolCallId?: unknown; source?: { callId?: unknown } } } | undefined)?.message
  const id = m?.toolCallId ?? m?.source?.callId
  return typeof id === 'string' ? id : null
}

/** Whether a tool result belongs to a call that echoes anchors (context_compact / context_recall). */
export function isSelfResult(n: SurfaceNode, names: Map<string, string>): boolean {
  const id = resultCallId(n)
  return id !== null && SELF_TOOLS.has(names.get(id) ?? '')
}
