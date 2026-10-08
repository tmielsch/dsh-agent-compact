// Shared-trunk memory: a content-addressed store of trunk checkpoints and a
// registry of the fork points a parent session has handed out.
//
// The memo is what makes sibling compactions byte-identical: the first sibling
// that compacts a trunk generates the checkpoint text once, every later (or
// concurrent) sibling with the same trunk key gets exactly those bytes back.
// Concurrent requests for the same key share one in-flight generation; a failed
// generation is not remembered, so the next attempt tries again. Entries are
// written to disk (when a directory is configured) so they survive a restart.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One stored trunk checkpoint. */
export interface TrunkMemoEntry {
  version: 1
  key: string
  /** The checkpoint's text blocks, exactly as every sibling lands them. */
  blocks: string[]
  createdAt: number
  origin: { sessionId: string | null; provider: string | null; model: string | null }
}

/** What a generator returns for a key that is not stored yet. */
export interface TrunkMemoSeed {
  blocks: string[]
  sessionId?: string | null
  provider?: string | null
  model?: string | null
}

const KEY_RE = /^[0-9a-f]{64}$/

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error('shared-trunk memo: invalid key ' + JSON.stringify(key))
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = path + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
}

function validEntry(value: unknown, key: string): TrunkMemoEntry | null {
  const v = value as Partial<TrunkMemoEntry> | null
  if (!v || v.version !== 1 || v.key !== key || !Array.isArray(v.blocks)) return null
  if (!v.blocks.every((b) => typeof b === 'string')) return null
  if (!v.blocks.some((b) => b.trim().length > 0)) return null
  return v as TrunkMemoEntry
}

export class SharedTrunkMemo {
  private readonly entries = new Map<string, TrunkMemoEntry>()
  private readonly inflight = new Map<string, Promise<TrunkMemoEntry>>()

  /** @param dir - directory for persisted entries; null keeps them in memory only. */
  constructor(readonly dir: string | null, private readonly log?: (msg: string) => void) {}

  private entryPath(key: string): string | null {
    return this.dir ? join(this.dir, 'trunk', key + '.json') : null
  }

  /** The stored entry for a key, from memory or disk, or null. */
  async get(key: string): Promise<TrunkMemoEntry | null> {
    assertKey(key)
    const hit = this.entries.get(key)
    if (hit) return hit
    const path = this.entryPath(key)
    if (!path) return null
    try {
      const entry = validEntry(JSON.parse(await readFile(path, 'utf8')), key)
      if (entry) this.entries.set(key, entry)
      return entry
    } catch (e) {
      return null
    }
  }

  /**
   * The entry for a key; when none exists, run `create` once — concurrent
   * callers for the same key await that same run — then store its result.
   * @returns the entry and whether this call produced it.
   */
  async getOrCreate(key: string, create: () => Promise<TrunkMemoSeed>): Promise<{ entry: TrunkMemoEntry; created: boolean }> {
    assertKey(key)
    const existing = await this.get(key)
    if (existing) return { entry: existing, created: false }
    const running = this.inflight.get(key)
    if (running) return { entry: await running, created: false }
    const run = (async () => {
      const seed = await create()
      const blocks = Array.isArray(seed.blocks) ? seed.blocks.filter((b) => typeof b === 'string') : []
      if (!blocks.some((b) => b.trim().length > 0)) throw new Error('shared-trunk memo: the generated checkpoint has no text')
      const entry: TrunkMemoEntry = {
        version: 1,
        key,
        blocks,
        createdAt: Date.now(),
        origin: { sessionId: seed.sessionId ?? null, provider: seed.provider ?? null, model: seed.model ?? null },
      }
      this.entries.set(key, entry)
      const path = this.entryPath(key)
      if (path && this.dir) {
        try {
          await mkdir(join(this.dir, 'trunk'), { recursive: true, mode: 0o700 })
          await writeJsonAtomic(path, entry)
        } catch (e) {
          // The in-memory entry still serves this process; only restart survival is lost.
          this.log?.('shared-trunk memo: could not persist ' + key + ': ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      return entry
    })()
    this.inflight.set(key, run)
    try {
      return { entry: await run, created: true }
    } finally {
      this.inflight.delete(key)
    }
  }
}

/**
 * Which fork points each parent session has handed out. A parent (for example
 * a Team Lead) learns its children's cut from their session headers; with it
 * the parent can compact the same canonical trunk and stay aligned with them.
 */
export class ForkRegistry {
  private readonly cuts = new Map<string, Set<number>>()
  private readonly loaded = new Set<string>()
  private readonly seenChildren = new Set<string>()

  constructor(readonly dir: string | null, private readonly log?: (msg: string) => void) {}

  private path(parentId: string): string | null {
    if (!this.dir || !/^[A-Za-z0-9._-]+$/.test(parentId)) return null
    return join(this.dir, 'forks', parentId + '.json')
  }

  private async load(parentId: string): Promise<Set<number>> {
    let set = this.cuts.get(parentId)
    if (!set) {
      set = new Set<number>()
      this.cuts.set(parentId, set)
    }
    if (this.loaded.has(parentId)) return set
    this.loaded.add(parentId)
    const path = this.path(parentId)
    if (!path) return set
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as { cuts?: unknown }
      if (Array.isArray(data.cuts)) for (const c of data.cuts) if (Number.isSafeInteger(c) && (c as number) > 0) set.add(c as number)
    } catch (e) {
      /* no file yet */
    }
    return set
  }

  /** Record that `childId` was forked from `parentId` after `cut` events. Idempotent per child. */
  async record(parentId: string, childId: string, cut: number): Promise<void> {
    if (!(cut > 0) || this.seenChildren.has(childId)) return
    this.seenChildren.add(childId)
    const set = await this.load(parentId)
    if (set.has(cut)) return
    set.add(cut)
    const path = this.path(parentId)
    if (!path || !this.dir) return
    try {
      await mkdir(join(this.dir, 'forks'), { recursive: true, mode: 0o700 })
      await writeJsonAtomic(path, { version: 1, parent: parentId, cuts: [...set].sort((a, b) => a - b) })
    } catch (e) {
      this.log?.('shared-trunk registry: could not persist forks of ' + parentId + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Whether a child id was already recorded in this process (cheap pre-check for hot event paths). */
  seen(childId: string): boolean {
    return this.seenChildren.has(childId)
  }

  /** The fork points handed out by a parent, ascending. */
  async cutsOf(parentId: string): Promise<number[]> {
    return [...(await this.load(parentId))].sort((a, b) => a - b)
  }

  /** Synchronous view of what is already loaded for a parent (no disk read). */
  loadedCutsOf(parentId: string): number[] {
    return [...(this.cuts.get(parentId) ?? [])].sort((a, b) => a - b)
  }
}
