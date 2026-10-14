// @tmielsch/rolling-compaction: 锚点 → 边界解析的纯函数核心。
// 从 src/index.ts 抽出：这里的一切都只是 `(nodes, args)` 的纯函数，不依赖
// ctx、不发起任何 I/O，因此可以直接单测（见 test/boundary.test.mjs），不需要
// 启一个真的 Cordis 会话或 mock 服务。
//
// 锚点在「当前」surface 上按归一化文本匹配定位 seq，每次调用重新解析；
// 匹配到的边缘会被吸附到平衡的 tool-call/result 边界上。

import { normText } from './normalize.js'
import { nodeFlatText } from './surface-text.js'
import { anchorForm, anchorItems, callNames, isSelfResult, messageTiers, modelViewText, resultTiers, type AnchorItem } from './anchor.js'
import type { SurfaceNode } from './optimizer.js'

interface SurfaceNodeErrorData {
  error?: { code?: unknown } | null
}

/**
 * 恰好携带这一个 tool-call 的 assistant/message 节点（用于判断该调用所属的
 * 消息节点能否被 shadow，而不破坏同一条消息里的其他兄弟 tool-call）。
 */
export function soleToolCall(n: SurfaceNode, callId: string): boolean {
  if (n.type !== 'assistant/message') return false
  const content = (n.data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return false
  const calls = content.filter((b) => {
    const block = b as { type?: unknown; id?: unknown }
    return block !== null && typeof block === 'object' && block.type === 'tool-call'
  })
  return calls.length === 1 && (calls[0] as { id?: unknown }).id === callId
}

// skipReasoning：让锚点匹配文本与模型所见对齐（跳过 reasoning 与图片块）；
// 传入 false 时保留完整原文，reasoning 与图片标记都保留。
export function nodeText(n: SurfaceNode, skipReasoning?: boolean): string {
  const skip = skipReasoning ?? false
  return nodeFlatText(n, { skipReasoning: skip, dropImages: skip })
}

// Fork: 归档文本（spanText / 共享 trunk 的原文）跳过 reasoning，但保留图片标记。
// Zwei Gründe: Die Denkspur hilft beim Wiedereinstieg nicht — sie erklärt nur, wie
// jemand auf einen Gedanken kam —, und sie ist die Textklasse, auf die der
// Anfragefilter von Anthropic reagiert. Ein Archiv ist eine wörtliche Sammlung von
// Modellausgaben; je weniger Denkspur darin steht, desto harmloser die Anfrage.
// Siehe README, Abschnitt „Denkspuren bleiben draußen“.
export function nodeArchiveText(n: SurfaceNode): string {
  return nodeFlatText(n, { skipReasoning: true, dropImages: false })
}

export function nodeErrorTag(n: SurfaceNode): string {
  const d = (n.data as SurfaceNodeErrorData | undefined) ?? null
  if (d && d.error && d.error.code) return ' error=' + String(d.error.code)
  return ''
}

export function preview(text: unknown, max: number): string {
  const t = String(text || '')
  return t.length <= max ? t : t.slice(0, max) + '…'
}

// 一个节点能否作为锚点匹配目标：只看 user/message、assistant/message；
// tool/result 节点不参与匹配，进行中轮次的 tool-call 节点也被排除。
// prefixHits（真正匹配）与 nearestHint（失败提示）共用同一条资格线，
// 保证提示里推荐的候选永远是下一次真的可能命中的节点。
function isEligibleAnchorNode(nodes: SurfaceNode[], i: number): boolean {
  const node = nodes[i]
  if (node.type !== 'user/message' && node.type !== 'assistant/message') return false
  if (i === nodes.length - 1 && /\[tool-call/.test(nodeText(node, true))) return false
  return true
}

// 唯一前缀匹配：锚点必须是恰好一个消息节点的归一化前缀，避免静默替换错节点。
// Fork: matched in tiers against what the model saw (see src/anchor.ts); the first
// tier is the rule above, so anchors that matched before resolve unchanged. Tool
// results are tried last, and never those of context_compact / context_recall,
// whose results echo the anchor.
export function prefixHits(nodes: SurfaceNode[], anchor: string): number[] {
  const f = anchorForm(anchor)
  if (!f.n) return []
  const cache = new Map<number, AnchorItem[]>()
  const items = (i: number): AnchorItem[] => {
    let it = cache.get(i)
    if (!it) cache.set(i, (it = anchorItems(nodes[i])))
    return it
  }
  const messages = nodes.map((_, i) => i).filter((i) => isEligibleAnchorNode(nodes, i))
  for (const tier of messageTiers(f)) {
    const hits = messages.filter((i) => tier(items(i)))
    if (hits.length) return hits
  }
  const names = callNames(nodes)
  const results = nodes.map((_, i) => i).filter((i) => nodes[i].type === 'tool/result' && !isSelfResult(nodes[i], names))
  for (const tier of resultTiers(f)) {
    const hits = results.filter((i) => tier(items(i)))
    if (hits.length) return hits
  }
  return []
}

// AMBIGUOUS 候选的预览：checkpoint 消息共享 dsh-compaction-basic 注入的固定
// 前缀（preamble + `<compacted-summary>` 标签）时，直接截前 80 字会让预览
// 完全一样。先跳过候选共享的最长公共前缀再截，让预览从真正分叉处开始。
function hitPreview(nodes: SurfaceNode[], hits: number[]): string {
  const texts = hits.map((i) => modelViewText(nodes[i]))
  // Fork: elide only whole words, so a quoted preview (`(sha256:…`) stays copyable.
  const raw = hits.length > 1 ? commonPrefixLen(texts) : 0
  const shared = raw > 0 ? texts[0].slice(0, raw).search(/\s\S*$/) + 1 : 0
  return hits.map((i, k) => nodeSummaryLine(nodes, i, shared, texts[k])).join('\n')
}

function commonPrefixLen(texts: string[]): number {
  if (texts.length < 2) return 0
  let len = texts[0].length
  for (let k = 1; k < texts.length && len > 0; k++) {
    const b = texts[k]
    let i = 0
    const max = Math.min(len, b.length)
    while (i < max && texts[0][i] === b[i]) i++
    len = i
  }
  return len
}

// 匹配失败提示复用的单行摘要：`pos <下标> | seq <序号> | <类型>: <前 80 字预览>`。
// skip>0 时表示与其它候选共享的前缀已被跳过，预览从分叉点开始（并标注跳过量）。
function nodeSummaryLine(nodes: SurfaceNode[], i: number, skip?: number, text?: string): string {
  const full = text ?? modelViewText(nodes[i])
  const shown = skip ? full.slice(skip) : full
  const tag = skip ? ' (shared ' + skip + '-char prefix elided)' : ''
  return 'pos ' + i + ' | seq ' + nodes[i].seq + ' | ' + nodes[i].type + tag + ': ' + preview(shown, 80)
}

// 把归一化文本切成用于重叠度打分的 token：ASCII/数字按 3+ 字符的连续片段
// 切词（沿用原先"忽略过短词"的思路），CJK（中日韩）没有空格分词，逐字切开，
// 否则一整句连续中文会被当成一个词，重叠度算法对中文锚点基本失效。
const TOKEN_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7a3]|[A-Za-z0-9]{3,}/g
function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? []
}

// 按与锚点的词重叠度给节点排序，用于在匹配失败时提示该传什么内容。
// 廉价、确定、足以作为提示。
function anchorOverlap(nodeRaw: string, anchorNorm: string): number {
  const words = tokenize(anchorNorm)
  if (!words.length) return 0
  const n = normText(nodeRaw)
  let hit = 0
  for (const w of words) {
    if (n.includes(w)) hit++
  }
  return hit / words.length
}

// Fork: Der Harness hängt an jeden Zug eigene Hinweise („Current runtime context“,
// die Verdichtungs-Erinnerung, den Checkpoint-Text). Sie sind formal Nachrichten,
// als Anker aber wertlos — und sie waren im Fehlerfall die einzigen „closest nodes“,
// die angezeigt wurden, obwohl das Modell sie nie als Anker wählen wollte.
const HARNESS_NOTICE_RE = /^(<system-reminder>|Current runtime context\.|`context_compact` (reminder|done|result)|This is an automatically generated checkpoint|A skill is a reusable set|`context_compact` done)/

function isHarnessNotice(n: SurfaceNode): boolean {
  return HARNESS_NOTICE_RE.test(modelViewText(n).trimStart())
}

function nearestHint(nodes: SurfaceNode[], anchorNorm: string): string {
  const scored = nodes
    .map((_, i) => i)
    .filter((i) => isEligibleAnchorNode(nodes, i) && !isHarnessNotice(nodes[i]))
    .map((i) => ({ i: i, score: anchorOverlap(nodeText(nodes[i], true), anchorNorm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((s) => s.score > 0)
  if (!scored.length) return ''
  return scored.map((s) => nodeSummaryLine(nodes, s.i)).join('\n')
}

// Fork: Das Ende des Verlaufs ist der Anker, den ein Modell fast immer meint —
// „verdichte bis hierher“. Die letzten Nachrichten wörtlich zu zeigen ist deshalb
// hilfreicher als jede Ähnlichkeitssuche, und der Text ist direkt kopierbar.
function tailHint(nodes: SurfaceNode[], count = 6): string {
  const idx = nodes
    .map((_, i) => i)
    .filter((i) => isEligibleAnchorNode(nodes, i) && !isHarnessNotice(nodes[i]))
    .slice(-count)
  return idx.map((i) => nodeSummaryLine(nodes, i, 0, modelViewText(nodes[i]).replace(/\s+/g, ' '))).join('\n')
}

// 将单个锚点解析为唯一节点下标，解析失败时抛出带有可操作提示的错误。
export function resolveUniqueHit(nodes: SurfaceNode[], anchor: string, side: string): number {
  const hits = prefixHits(nodes, anchor)
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) {
    const hint = nearestHint(nodes, normText(anchor))
    const tail = tailHint(nodes)
    throw new Error(
      side + ' not found on the surface: ' + preview(anchor, 120) +
        '\nOnly what was actually exchanged is on the surface. Text that stood only in your own reasoning/thinking is NOT on the surface and can never be an anchor — pick the opening words of a visible message instead (its text, a tool call with its arguments, or a team message’s body).' +
        (hint ? '\nclosest nodes (by wording):\n' + hint : '') +
        (tail ? '\nlast messages on the surface (copy the opening words of one):\n' + tail : ''),
    )
  }
  throw new Error(side + ' is AMBIGUOUS: ' + hits.length + ' nodes start with it. Lengthen the anchor to pick one (for an attached image, quote its full handle with the sha256 id); when the candidates read the same, anchor a neighbouring message instead:\n' + hitPreview(nodes, hits))
}

export function snapStartBalanced(nodes: SurfaceNode[], si: number): number {
  // tool/result 不能在没有其 assistant 消息的情况下作为区间开头：
  // 向前回退到最近的、发起这些调用的 assistant/message。
  while (si > 0 && nodes[si].type === 'tool/result') {
    let j = si - 1
    while (j > 0 && nodes[j].type !== 'assistant/message') j--
    if (nodes[j].type !== 'assistant/message') break
    si = j
  }
  return si
}

export function snapEndBalanced(nodes: SurfaceNode[], ei: number): number {
  // 只要后面还有 tool result，assistant/message 的边缘就保持开放；
  // 连续的 tool/result 节点属于同一对调用，因此要一直推进穿过它们，
  // 直到整对完全闭合。
  while (ei < nodes.length - 1 && nodes[ei + 1].type === 'tool/result') {
    ei++
  }
  return ei
}

/**
 * How many `system/message` nodes sit at the head of the surface.
 *
 * Surface node 0 holds the system prompt, and the harness protects it: a
 * replacement covering node 0 is rejected unless it is itself a
 * `system/message` over exactly that node (`assertSystemHeadRewrite` in
 * dsh-session). A span must therefore never *start* on the head — the stock
 * engine skips it the same way.
 */
export function systemHeadCount(nodes: SurfaceNode[]): number {
  let i = 0
  while (i < nodes.length && nodes[i].type === 'system/message') i++
  return i
}

export interface BoundaryResolveResult {
  si: number
  ei: number
  startSeq: number
  endSeq: number
  method: string
  detail: { startPos: number; endPos: number }
}

export function resolveBoundaries(nodes: SurfaceNode[], args: { startAnchor?: unknown; endAnchor?: unknown }): BoundaryResolveResult {
  if (!nodes.length) throw new Error('surface is empty; nothing to compact')
  const startAnchor = typeof args.startAnchor === 'string' && args.startAnchor.trim() ? args.startAnchor : ''
  const endAnchor = typeof args.endAnchor === 'string' && args.endAnchor.trim() ? args.endAnchor : ''
  // 结束侧是「必需」的，用来界定区间；起点默认取第一个节点。
  if (!endAnchor) {
    throw new Error('cannot resolve the end boundary: provide endAnchor — verbatim text that is a UNIQUE PREFIX of the LAST node of the span to compress (that node itself is compressed; use its predecessor to keep it)')
  }
  const method: string[] = []
  // Fork: node 0 holds the system prompt, and the harness protects it. A span
  // that starts on it is rejected by the loader *after* the summary has been
  // written, which leaves a compaction row behind that the session log can no
  // longer be read with. The head is therefore never part of a span: without a
  // startAnchor the span begins after it (the stock engine skips it the same
  // way). An explicit anchor cannot land there anyway — system nodes are not
  // anchor targets — so this is the one path that had to be closed.
  const head = systemHeadCount(nodes)
  if (head >= nodes.length) {
    throw new Error('this surface holds nothing but system messages; there is no exchange to compress yet')
  }
  let si: number
  if (startAnchor) {
    si = resolveUniqueHit(nodes, startAnchor, 'startAnchor')
    method.push('start=anchor')
  } else {
    si = head
    method.push(head > 0 ? 'start=after-system' : 'start=first')
  }
  let ei = resolveUniqueHit(nodes, endAnchor, 'endAnchor')
  method.push('end=anchor')
  if (si > ei) {
    throw new Error('resolved start sits after resolved end on the surface (start pos ' + si + ', end pos ' + ei + ')')
  }
  const snappedStart = snapStartBalanced(nodes, si)
  const snappedEnd = snapEndBalanced(nodes, ei)
  if (snappedStart !== si) method.push('start-snapped')
  if (snappedEnd !== ei) method.push('end-snapped')
  si = snappedStart
  ei = snappedEnd
  if (si > ei) throw new Error('after balancing, start sits after end on the surface (start pos ' + si + ', end pos ' + ei + ')')
  return {
    si,
    ei,
    startSeq: nodes[si].seq,
    endSeq: nodes[ei].seq,
    method: method.join(' + '),
    detail: { startPos: si, endPos: ei },
  }
}

export function spanText(nodes: SurfaceNode[], si: number, ei: number, archive = true): string {
  const parts: string[] = []
  for (let i = si; i <= ei; i++) {
    const n = nodes[i]
    const body = archive ? nodeArchiveText(n) : nodeText(n)
    parts.push('--- seq ' + n.seq + ' | pos ' + i + ' | ' + n.type + nodeErrorTag(n) + ' ---\n' + body)
  }
  return parts.join('\n\n')
}
