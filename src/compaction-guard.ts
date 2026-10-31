// Harte Compaction-Grenze: die Verdrahtung am Harness.
//
// Der Kern (dsh-compaction-basic) verdichtet in `agent/pre-step`, also auch vor dem
// ersten Schritt eines Zuges — und genau dort hat er am 30.10.2026 eine Antwort des
// Menschen durch eine Verdichtung ersetzt. Deshalb steht im Profil `auto: false`.
// Damit ist aber auch die Rettung nach `CONTEXT_WINDOW_EXCEEDED` aus, und eine
// Sitzung stirbt bei einem Provider-Fehler.
//
// Dieses Modul setzt die Grenze deshalb selbst, in drei Lagen:
//
//   1. Zug-Ende (Agent wird untätig): liegt die Belegung über der Grenze, wird
//      sofort verdichtet. Da wartet kein Mensch, das ist der Normalfall.
//   2. Mitten im Zug, ab dem zweiten Schritt: die Grenze wird ebenfalls gehalten.
//      NICHT vor dem ersten Schritt eines Zuges — dort bleibt die Anordnung vom
//      30.10. in Kraft (keine Verdichtung als Antwort auf eine Nachricht).
//   3. Notfall: die nächste Anfrage würde abgelehnt (Prompt + Antwort-Reserve >
//      Fenster) oder der Anbieter hat sie schon abgelehnt. Dann wird verdichtet,
//      egal was ist, und die Anfrage wird einmal wiederholt.

import type { Context } from '@deepseek-ai/cordis'
import { budgetSentence, judgeBudget, wouldOverflow, type BudgetPolicy, type BudgetReading } from './budget.js'

/** Der Agent, so weit der Guard ihn sieht. */
export interface GuardAgent {
  status?: unknown
  session?: { id?: unknown }
}

/** Ein geplanter Schnitt: ganze, abgeschlossene Züge in einem Checkpoint. */
export interface GuardCut {
  startSeq: number
  endSeq: number
  turns: number
  grossTokens: number
}

/** Ergebnis einer Verdichtung, wie das Plugin es braucht. */
export interface GuardCompaction {
  freedTokens?: number
}

/** Was der Guard von der Aussenwelt braucht (in index.ts aus dem Plugin heraus geliefert). */
export interface GuardCallbacks {
  /** Prompt-Belegung, Fenster und Antwort-Reserve der nächsten Anfrage; null wenn unbekannt. */
  reading(agent: GuardAgent): BudgetReading | null
  /** Der turn-basierte Schnitt, der das Arbeitsfenster (keepTurns) respektiert. */
  planCut(agent: GuardAgent): GuardCut | null
  /** Eine Verdichtung des geplanten Schnitts. */
  compactCut(agent: GuardAgent, cut: GuardCut, signal?: AbortSignal): Promise<GuardCompaction | null>
  /** Rettung des Kerns, wenn kein turn-basierter Schnitt möglich ist. */
  compactEmergency(agent: GuardAgent, signal?: AbortSignal): Promise<GuardCompaction | null>
  /** Zeile ins Host-Log. */
  note(level: 'info' | 'warn', message: string): void
}

export interface GuardOptions {
  policy: BudgetPolicy
  /** Grenze mitten im Zug halten (ab dem zweiten Schritt eines Zuges). */
  compactMidTurn: boolean
  /** Nach `CONTEXT_WINDOW_EXCEEDED` einmal verdichten und wiederholen. */
  overflowRecovery: boolean
}

/** Grenze im Harness anmelden; gibt den Abmelder zurück. */
export function installCompactionGuard(ctx: Context, options: GuardOptions, callbacks: GuardCallbacks): () => void {
  const { policy } = options
  // Eine Verdichtung je Sitzung zur Zeit: der Kern lehnt eine zweite ab, und zwei
  // gleichzeitige Ersetzungen der Oberfläche wären ein Rennen.
  const inFlight = new Set<string>()
  // Ein Wiederholungsversuch je Zug, damit eine Ablehnung nicht in einer Schleife endet.
  const retried = new Map<string, number>()

  const sessionKey = (agent: GuardAgent): string => {
    const id = agent.session?.id
    return typeof id === 'string' && id ? id : 'unknown-session'
  }

  async function forceCompact(agent: GuardAgent, why: string, signal?: AbortSignal): Promise<boolean> {
    const key = sessionKey(agent)
    if (inFlight.has(key)) {
      callbacks.note('info', 'compaction guard: a compaction is already running for this session; skipped (' + why + ')')
      return false
    }
    inFlight.add(key)
    try {
      const cut = callbacks.planCut(agent)
      if (cut) {
        const done = await callbacks.compactCut(agent, cut, signal)
        if (done) {
          callbacks.note(
            'info',
            'compaction guard (' + why + '): compacted ' + cut.turns + ' finished turn(s), range ' + cut.startSeq + '..' + cut.endSeq +
              ', freed ' + (typeof done.freedTokens === 'number' ? done.freedTokens : '?') + ' tokens',
          )
          return true
        }
      }
      const emergency = await callbacks.compactEmergency(agent, signal)
      if (emergency) {
        callbacks.note(
          'info',
          'compaction guard (' + why + '): no turn-based cut was allowed, the engine compacted the oldest safe range, freed ' +
            (typeof emergency.freedTokens === 'number' ? emergency.freedTokens : '?') + ' tokens',
        )
        return true
      }
      callbacks.note('warn', 'compaction guard (' + why + '): no compactable range was found')
      return false
    } catch (error) {
      callbacks.note('warn', 'compaction guard (' + why + ') failed: ' + (error instanceof Error ? error.message : String(error)))
      return false
    } finally {
      inFlight.delete(key)
    }
  }

  function verdictFor(agent: GuardAgent) {
    const reading = callbacks.reading(agent)
    if (!reading) return null
    const verdict = judgeBudget(reading, policy)
    return verdict ? { reading, verdict } : null
  }

  const disposers: (() => void)[] = []

  // Die Ereignis-Signaturen sind im Cordis-Kontext typscharf; dieser Guard
  // behandelt sie strukturell, damit das Plugin auch dann lädt, wenn ein
  // Kern-Update die Nutzlast erweitert. Er liest nur Felder, die er kennt.
  type LooseOn = (name: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void
  type LooseOnSync = (name: string, handler: (payload: unknown) => void) => () => void
  const onWaterfall = ctx.on as unknown as LooseOn
  const onEvent = ctx.on as unknown as LooseOnSync

  // Lage 3a: die nächste Anfrage würde abgelehnt — vor dem Schritt verdichten.
  disposers.push(onWaterfall('agent/pre-step', async (payload, next) => {
    try {
      const { agent, signal, step } = (payload ?? {}) as { agent?: GuardAgent; signal?: AbortSignal; step?: number }
      if (agent) {
        const judged = verdictFor(agent)
        if (judged) {
          const overflow = wouldOverflow(judged.reading, policy.safetyTokens)
          const firstStepOfTurn = typeof step === 'number' && step <= 1
          const overBoundary = judged.verdict.kind === 'compact'
          if (overflow || (overBoundary && options.compactMidTurn && !firstStepOfTurn)) {
            callbacks.note(
              'info',
              'compaction guard: ' + budgetSentence(judged.reading, judged.verdict) +
                (overflow ? ' — the next request would be rejected, compacting before it' : ' — over the boundary mid-turn'),
            )
            await forceCompact(agent, overflow ? 'overflow prevention' : 'turn boundary', signal)
          }
        }
      }
    } catch (error) {
      callbacks.note('warn', 'compaction guard pre-step failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return next()
  }))

  // Lage 1: der Zug ist vorbei (Agent untätig) und die Grenze ist überschritten.
  disposers.push(onEvent('agent/status', (payload) => {
    try {
      const { agent, status } = (payload ?? {}) as { agent?: GuardAgent; status?: unknown }
      if (!agent || status !== 'idle') return
      retried.delete(sessionKey(agent))
      const judged = verdictFor(agent)
      if (!judged || judged.verdict.kind !== 'compact') return
      callbacks.note('info', 'compaction guard at turn end: ' + budgetSentence(judged.reading, judged.verdict))
      // Nicht auf die Verdichtung warten: der Zug ist zu Ende, und ein hängender
      // Ereignis-Hörer würde den nächsten Zug blockieren.
      void forceCompact(agent, 'turn end')
    } catch (error) {
      callbacks.note('warn', 'compaction guard idle check failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }))

  // Lage 3b: der Anbieter hat abgelehnt — einmal verdichten und wiederholen.
  disposers.push(onWaterfall('agent/request-error', async (payload, next) => {
    try {
      const { agent, failure, turn, signal } = (payload ?? {}) as {
        agent?: GuardAgent
        failure?: { code?: unknown }
        turn?: number
        signal?: AbortSignal
      }
      if (!options.overflowRecovery || !agent) return next()
      if (failure?.code !== 'CONTEXT_WINDOW_EXCEEDED') return next()
      const key = sessionKey(agent)
      const already = retried.get(key)
      if (already !== undefined && already === turn) return next()
      retried.set(key, typeof turn === 'number' ? turn : -1)
      callbacks.note('warn', 'compaction guard: the provider rejected the request for context overflow; compacting once and retrying the request')
      const done = await forceCompact(agent, 'context overflow recovery', signal)
      return done ? { kind: 'retry' } : next()
    } catch (error) {
      callbacks.note('warn', 'compaction guard overflow recovery failed: ' + (error instanceof Error ? error.message : String(error)))
      return next()
    }
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
