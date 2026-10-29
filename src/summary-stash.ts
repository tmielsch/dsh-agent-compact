// @tmielsch/rolling-compaction: the kept checkpoint text after a failed compaction.
//
// Problem (gemeldet 2026-10-20): nach jedem Fehlschlag war der vom Modell
// geschriebene Checkpoint-Text weg — der nächste Versuch musste ihn komplett
// neu schreiben, was je nach Modell rund zwei Minuten dauert. Ursache ist die
// Einmal-Ablage in index.ts (`ext[sid]`, `delete` im Fehlerfall) zusammen mit
// der Anforderung, `summary` bei jedem Aufruf neu zu übergeben.
//
// Dieses Modul hält den Text des letzten Fehlschlags vor: ein erneuter
// `context_compact`-Aufruf ohne `summary` übernimmt ihn unverändert. Der Text
// ist reine Laufzeit-Ablage pro Sitzung (höchstens KEEP Einträge, die ältesten
// fallen zuerst); nach Erfolg wird der benutzte Eintrag verworfen. Bewusst kein
// Platten-Speicher: nach einem Neustart liegt der Text noch immer wörtlich in
// der vorherigen Modellnachricht und wird von dort kopiert.

import { normText } from './normalize.js'

/** How many failed attempts' texts are kept per session (oldest dropped first). */
export const KEEP = 4

/** One kept checkpoint text with the anchors/range it was written for. */
export interface KeptSummary {
  text: string
  startAnchor?: string
  endAnchor?: string
  startSeq?: number
  endSeq?: number
}

/** What a new call resolved on the surface (anchors as passed, seqs once known). */
export interface AttemptSpan {
  startAnchor?: string
  endAnchor?: string
  startSeq?: number
  endSeq?: number
}

function sameAnchors(a: KeptSummary, b: AttemptSpan): boolean {
  return (a.startAnchor ?? '') === (b.startAnchor ?? '') && (a.endAnchor ?? '') === (b.endAnchor ?? '')
}

/**
 * The kept entry this attempt may reuse, newest first:
 *  1. the same resolved range (the plain retry of the same compaction);
 *  2. the same endAnchor (the surface moved, or the attempt failed before it
 *     resolved anything and the retry repeats the anchors);
 *  3. an entry that never resolved a range (its attempt failed at the anchors)
 *     whose endAnchor is a prefix of this one or the other way round — the
 *     lengthened-anchor retry after "AMBIGUOUS"/"not found".
 * Anything else is a different compaction and must carry its own summary.
 */
export function matchKept(entries: readonly KeptSummary[], span: AttemptSpan): KeptSummary | null {
  if (span.startSeq !== undefined && span.endSeq !== undefined) {
    for (const e of entries) {
      if (e.startSeq === span.startSeq && e.endSeq === span.endSeq) return e
    }
  }
  const end = typeof span.endAnchor === 'string' && span.endAnchor.trim() ? normText(span.endAnchor) : ''
  if (end) {
    for (const e of entries) {
      if (e.endAnchor !== undefined && normText(e.endAnchor) === end) return e
    }
    for (const e of entries) {
      if (e.startSeq !== undefined || e.endAnchor === undefined) continue
      const kept = normText(e.endAnchor)
      if (kept && (kept.startsWith(end) || end.startsWith(kept))) return e
    }
  }
  return null
}

/**
 * Regel 4 (gemeldet 2026-10-29): der Wiederversuch, den die AMBIGUOUS-Meldung
 * selbst empfiehlt — „anchor a neighbouring message, to keep one of them". Der
 * Fehlschlag schrieb den Text für eine Spanne, deren Ende auf einem der
 * Kandidaten sass; der Wiederversuch endet jetzt auf dessen Vorgänger, also
 * genau einen Knoten kürzer. Das ist dieselbe Verdichtung, und der Text soll
 * unverändert wiederbenutzt werden — die bisherigen drei Regeln erkennen ihn
 * nicht, weil der Anker ein anderer ist.
 *
 * Die Regel braucht die Oberfläche, deshalb als Rückgabe-Funktion: `resolve`
 * nennt die seqs, die ein Anker jetzt trifft (leer, wenn er nichts trifft),
 * `nextSeq` ist der Knoten direkt nach dem Ende dieses Versuchs. Ein Anker,
 * der mehrere Knoten trifft, ist mehrdeutig, und genau das ist der gemeldete
 * Fall: die Fertig-Meldungen desselben Unteragenten sind wortgleich, der
 * gehaltene endAnchor löst also auf zwei Knoten auf, und einer von ihnen ist
 * der Knoten direkt nach dem neuen Ende.
 *
 * Ein Eintrag, der nie eine Spanne aufgelöst hat, gehört zu diesem Versuch,
 * wenn sein endAnchor den Knoten direkt nach dem neuen Ende unter seinen
 * Kandidaten hat und die Startseite dieselbe Anker-Angabe trägt.
 */
export function matchNeighbourKept(
  entries: readonly KeptSummary[],
  span: AttemptSpan,
  nextSeq: number | null,
  resolve: (anchor: string) => number[],
): KeptSummary | null {
  if (nextSeq === null || span.endSeq === undefined) return null
  for (const e of entries) {
    if (e.startSeq !== undefined || e.endAnchor === undefined) continue
    if (!resolve(e.endAnchor).includes(nextSeq)) continue
    if (e.startAnchor !== undefined && span.startAnchor !== undefined && normText(e.startAnchor) !== normText(span.startAnchor)) continue
    return e
  }
  return null
}

/** Per-session ring of the kept checkpoint texts (see KEEP). */
export class SummaryStash {
  private readonly bySession = new Map<string, KeptSummary[]>()

  /**
   * Keep a text for a session. A newer entry with the same text and anchors is
   * replaced in place (the same attempt saving twice — once before the anchors
   * resolve, once with the resolved range — stays one entry).
   */
  save(sid: string, entry: KeptSummary): void {
    const list = this.bySession.get(sid) ?? []
    const first = list[0]
    if (first && first.text === entry.text && sameAnchors(first, entry)) {
      list[0] = { ...first, ...entry }
    } else {
      list.unshift({ ...entry })
      while (list.length > KEEP) list.pop()
    }
    this.bySession.set(sid, list)
  }

  /** The kept entries of a session, newest first. */
  list(sid: string): KeptSummary[] {
    return [...(this.bySession.get(sid) ?? [])]
  }

  /** The kept entry this attempt may reuse (see matchKept), removed from the stash. */
  takeMatched(sid: string, span: AttemptSpan): KeptSummary | null {
    const list = this.bySession.get(sid)
    if (!list || !list.length) return null
    const hit = matchKept(list, span)
    if (!hit) return null
    const i = list.indexOf(hit)
    if (i >= 0) list.splice(i, 1)
    return hit
  }

  /** The kept entry this attempt may reuse by the neighbour rule (see matchNeighbourKept), removed from the stash. */
  takeNeighbourMatched(sid: string, span: AttemptSpan, nextSeq: number | null, resolve: (anchor: string) => number[]): KeptSummary | null {
    const list = this.bySession.get(sid)
    if (!list || !list.length) return null
    const hit = matchNeighbourKept(list, span, nextSeq, resolve)
    if (!hit) return null
    const i = list.indexOf(hit)
    if (i >= 0) list.splice(i, 1)
    return hit
  }

  /** Drop every kept entry of a session (after a successful compaction). */
  clear(sid: string): void {
    this.bySession.delete(sid)
  }
}

/** A one-line description of where a kept entry belongs, for error messages. */
export function keptLabel(e: KeptSummary): string {
  if (e.startSeq !== undefined && e.endSeq !== undefined) return 'range [' + e.startSeq + ',' + e.endSeq + ']'
  const anchor = e.endAnchor ? e.endAnchor.replace(/\s+/g, ' ').trim() : ''
  return 'endAnchor ' + JSON.stringify(anchor.length > 60 ? anchor.slice(0, 60) + '…' : anchor)
}
