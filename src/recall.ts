// @mimichunterz/agent-compact: recall of compacted spans (no runtime dependencies on DSH packages).
//
// Every compaction keeps the raw span in an archive and ends its checkpoint
// with a reference to it, so the agent can read the original back on demand
// with `context_recall`. The result arrives at the end of the conversation:
// nothing before it changes, so the inference engine's prompt cache survives.
//
// Two archive kinds:
//  - span archives: the session's spill directory, written by the spill store
//    (`<spillRoot>/session-<hash>/<name>.txt`), id `session-<hash>/<name>`;
//  - shared-trunk archives: content-addressed next to the trunk memo
//    (`<storeDir>/trunk/<key>.raw.txt`), id `trunk:<key>`, written once and
//    referenced by the same bytes in every sibling's checkpoint.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/** Marker every recall reference starts with; the id follows in quotes. */
export const FOOTER_PREFIX = '[Full original of this checkpoint: context_recall archive="'

const SPAN_ID = /^session-[0-9a-f]{12}\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const TRUNK_ID = /^trunk:([0-9a-f]{64})$/
// Tolerates JSON-escaped quotes, so serialized events can be scanned as they are.
const FOOTER_RE = /\[Full original of this checkpoint: context_recall archive=\\?"([^"\\\s]+)\\?"\]/g
const HEADER_RE = /^--- seq (\d+) \| pos (\d+) \| (.+?) ---$/gm

/** The reference line appended to a checkpoint. */
export function footerText(id: string): string {
  return FOOTER_PREFIX + id + '"]'
}

/** Append the reference to a checkpoint text (idempotent). */
export function withFooter(text: string, id: string): string {
  const footer = footerText(id)
  if (text.includes(footer)) return text
  return text.replace(/\s+$/, '') + '\n\n' + footer
}

/** Whether an id has the shape of a span or trunk archive id. */
export function isArchiveId(id: string): boolean {
  return SPAN_ID.test(id) || TRUNK_ID.test(id)
}

/**
 * Archive ids referenced in a text, in order of first appearance. Only well-formed ids
 * count: a checkpoint that quotes the footer with a placeholder (`archive="<id>"`) is prose.
 */
export function referencedIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(FOOTER_RE)) {
    if (isArchiveId(m[1]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

export function trunkArchiveId(key: string): string {
  return 'trunk:' + key
}

/** The id of a spill-store file, or null when it does not live under the spill root. */
export function spanArchiveId(spillRoot: string | null, locator: unknown): string | null {
  if (!spillRoot || typeof locator !== 'string' || !isAbsolute(locator)) return null
  const rel = relative(spillRoot, locator)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const id = rel.split(sep).join('/').replace(/\.txt$/, '')
  return SPAN_ID.test(id) ? id : null
}

export interface ArchiveRoots {
  spillRoot: string | null
  storeDir: string | null
}

export function trunkArchivePath(storeDir: string, key: string): string {
  return join(storeDir, 'trunk', key + '.raw.txt')
}

/** The file behind an archive id; throws for an id this plugin never hands out. */
export function archivePath(id: string, roots: ArchiveRoots): string {
  const t = TRUNK_ID.exec(id)
  if (t) {
    if (!roots.storeDir) throw new Error('shared-trunk archives are kept in memory only in this runtime (no sharedStoreDir)')
    return trunkArchivePath(roots.storeDir, t[1])
  }
  if (SPAN_ID.test(id)) {
    if (!roots.spillRoot) throw new Error('the spill store has no local directory in this runtime')
    return join(roots.spillRoot, ...id.split('/')) + '.txt'
  }
  throw new Error('unknown archive id "' + id + '": pass the id from a checkpoint\'s context_recall reference')
}

/** Shared-trunk archives: one file per trunk key, first writer wins (the content is the same for every sibling). */
export class TrunkArchive {
  private readonly memory = new Map<string, string>()

  constructor(readonly dir: string | null) {}

  async ensure(key: string, render: () => Promise<string>): Promise<string> {
    if (!this.dir) {
      if (!this.memory.has(key)) this.memory.set(key, await render())
      return trunkArchiveId(key)
    }
    const path = trunkArchivePath(this.dir, key)
    try {
      await stat(path)
      return trunkArchiveId(key)
    } catch {
      /* not written yet */
    }
    const content = await render()
    await mkdir(join(this.dir, 'trunk'), { recursive: true, mode: 0o700 })
    const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp'
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
    return trunkArchiveId(key)
  }

  async read(id: string, roots: ArchiveRoots): Promise<{ text: string; path: string | null }> {
    const t = TRUNK_ID.exec(id)
    if (t && !this.dir) {
      const text = this.memory.get(t[1])
      if (text === undefined) throw new Error('archive "' + id + '" is gone (kept in memory only, lost on restart)')
      return { text, path: null }
    }
    const path = archivePath(id, roots)
    return { text: await readFile(path, 'utf8'), path }
  }
}

/** One archived message: its header line and text. */
export interface ArchiveBlock {
  seq: number
  kind: string
  text: string
}

/** Split an archive into its messages (the format of spanText). */
export function splitBlocks(archive: string): ArchiveBlock[] {
  const heads = [...archive.matchAll(HEADER_RE)]
  if (!heads.length) return archive.trim() ? [{ seq: -1, kind: 'text', text: archive }] : []
  return heads.map((h, i) => {
    const start = h.index ?? 0
    const end = i + 1 < heads.length ? heads[i + 1].index ?? archive.length : archive.length
    return { seq: Number(h[1]), kind: h[3], text: archive.slice(start, end).replace(/\s+$/, '') }
  })
}

export interface RecallOptions {
  query?: string
  offset?: number
  maxChars?: number
}

export const DEFAULT_MAX_CHARS = 20000
export const MAX_CHARS = 60000

/**
 * Render a bounded page of an archive: messages in order, or only those that
 * contain every word of `query` (case-insensitive). The first line says what
 * was returned and the offset that continues it.
 */
export function renderRecall(id: string, archive: string, path: string | null, opts: RecallOptions = {}): string {
  const all = splitBlocks(archive)
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const list = words.length ? all.filter((b) => { const t = b.text.toLowerCase(); return words.every((w) => t.includes(w)) }) : all
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const budget = Math.min(MAX_CHARS, Math.max(1000, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)))
  const parts: string[] = []
  let used = 0
  let i = offset
  for (; i < list.length; i++) {
    const b = list[i]
    const room = budget - used
    if (b.text.length <= room) {
      parts.push(b.text)
      used += b.text.length + 2
      continue
    }
    if (parts.length === 0) {
      // A single message larger than the page: show its start and say where the rest is.
      parts.push(b.text.slice(0, room) + '\n[... ' + (b.text.length - room) + ' more characters of this message' + (path ? '; read ' + path + ' with offset/limit for the rest' : '') + ']')
      i++
    }
    break
  }
  const what = words.length ? list.length + ' of ' + all.length + ' messages match "' + opts.query + '"' : all.length + ' messages'
  const shown = parts.length ? 'showing ' + (words.length ? 'matches' : 'messages') + ' ' + offset + '-' + (i - 1) : 'nothing at offset ' + offset
  const more = i < list.length ? 'more: offset ' + i : 'end of archive'
  return 'archive ' + id + ': ' + what + '; ' + shown + '; ' + more + (path ? '; file ' + path : '') + '\n\n' + parts.join('\n\n')
}
