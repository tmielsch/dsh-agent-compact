// @tmielsch/rolling-compaction: pure reader of compaction records from a raw session log.
//
// The Compact Chat tab needs, for every compaction of a session, exactly this:
// which events were replaced, which message replaced them, what the checkpoint
// says. All of it is in the raw log (`compaction/summary` + the checkpoint
// `user/message`); nothing is guessed from text. This file holds NO DSH imports
// so it can be tested offline against a real log (see test/compactions.test.mjs).

/** One compaction as the log records it. */
export interface CompactionRecord {
  readonly compactionId: string
  /** seq of the checkpoint `user/message` that replaced the span (the position in the model's history). */
  readonly checkpointSeq: number
  /** First and last seq of the replaced range (`surfaceOp.startSeq/endSeq`, else `shadowedRange`). */
  readonly startSeq: number
  readonly endSeq: number
  /** Exact seqs of the replaced events (`compaction/summary.shadowedSeqs`). */
  readonly shadowedSeqs: readonly number[]
  /** Tokens the replacement freed, as DSH counted them (0 when the log has no count). */
  readonly shadowedTokenCount: number
  /** Checkpoint text shown to the model (text blocks of `compaction/summary.summary`, empty when absent). */
  readonly summaryText: string
  /** Characters of the checkpoint `user/message` itself (text blocks of its `content`) — what the model reads. */
  readonly checkpointChars: number
  /** Checkpoint size in tokens, estimated from `checkpointChars` with `ZEICHEN_PRO_TOKEN` (6.27, measured). */
  readonly checkpointTokensEstimate: number
  /** Seconds the checkpoint took to write: `compaction/summary.time` minus `compaction/start.time` of the same `compactionId`. Null when the log has no start time. */
  readonly writeDurationSeconds: number | null
}

interface RawEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

const CHECKPOINT_KIND = 'compact-checkpoint'

/** Zeichen pro Prompt-Token, gemessen (see `ZEICHEN_PRO_TOKEN` in `src/boundary.ts`). */
export const ZEICHEN_PRO_TOKEN = 6.27

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function seqList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((n): n is number => Number.isSafeInteger(n) && (n as number) >= 0)
}

function summaryTextOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const block of value) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out.trim()
}

/** Characters of all text blocks of a message `content` (the checkpoint message as the model reads it). */
function textCharsOf(value: unknown): number {
  if (!Array.isArray(value)) return 0
  let chars = 0
  for (const block of value) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/**
 * Read every compaction of a session out of its raw events, in log order.
 * A compaction is reported only when both halves exist: the `compaction/summary`
 * (what was replaced) and the checkpoint message (where it landed). An unfinished
 * compaction (start without checkpoint) is skipped.
 * @param events - raw session events (ascending seq), e.g. `sessionQuery.readSession(id).events`.
 * @returns compaction records ordered by checkpoint position.
 */
export function readCompactions(events: readonly unknown[]): CompactionRecord[] {
  const summaries = new Map<string, { shadowedSeqs: number[]; range: [number, number] | null; tokens: number; text: string; time: number | null }>()
  const checkpoints = new Map<string, { seq: number; op: [number, number] | null; chars: number }>()
  const startTimes = new Map<string, number>()
  for (const raw of events) {
    if (!isRecord(raw)) continue
    const ev = raw as RawEvent
    if (typeof ev.seq !== 'number') continue
    const data = isRecord(ev.data) ? ev.data : null
    if (data === null) continue
    if (ev.type === 'compaction/start' && typeof data.compactionId === 'string' && typeof ev.time === 'number') {
      startTimes.set(data.compactionId, ev.time)
    } else if (ev.type === 'compaction/summary' && typeof data.compactionId === 'string') {
      const range = isRecord(data.shadowedRange) && typeof data.shadowedRange.start === 'number' && typeof data.shadowedRange.end === 'number'
        ? ([data.shadowedRange.start, data.shadowedRange.end] as [number, number])
        : null
      summaries.set(data.compactionId, {
        shadowedSeqs: seqList(data.shadowedSeqs),
        range,
        tokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
        text: summaryTextOf(data.summary),
        time: typeof ev.time === 'number' ? ev.time : null,
      })
    } else if (ev.type === 'user/message' && isRecord(data.source) && data.source.kind === CHECKPOINT_KIND && typeof data.source.compactionId === 'string') {
      const op = isRecord(ev.surfaceOp) && ev.surfaceOp.op === 'replace' && typeof ev.surfaceOp.startSeq === 'number' && typeof ev.surfaceOp.endSeq === 'number'
        ? ([ev.surfaceOp.startSeq, ev.surfaceOp.endSeq] as [number, number])
        : null
      checkpoints.set(data.source.compactionId, { seq: ev.seq, op, chars: textCharsOf(data.content) })
    }
  }
  const out: CompactionRecord[] = []
  for (const [compactionId, checkpoint] of checkpoints) {
    const summary = summaries.get(compactionId)
    if (!summary) continue
    const range = checkpoint.op ?? summary.range
    if (!range) continue
    const start = startTimes.get(compactionId)
    // Log times are epoch milliseconds; the duration is seconds with two decimals.
    const duration = (start !== undefined && summary.time !== null) ? Math.round((summary.time - start) / 10) / 100 : null
    out.push({
      compactionId,
      checkpointSeq: checkpoint.seq,
      startSeq: range[0],
      endSeq: range[1],
      shadowedSeqs: summary.shadowedSeqs,
      shadowedTokenCount: summary.tokens,
      summaryText: summary.text,
      checkpointChars: checkpoint.chars,
      checkpointTokensEstimate: Math.round(checkpoint.chars / ZEICHEN_PRO_TOKEN),
      writeDurationSeconds: duration,
    })
  }
  out.sort((a, b) => a.checkpointSeq - b.checkpointSeq)
  return out
}
