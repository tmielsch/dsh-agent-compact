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

  // Zwei Stufen, je Zug und Stufe höchstens ein Versuch (Entscheidung des Menschen
  // 2026-11-09: „3 ja einen“). Gemessen in Sitzung a856b862: 19 Versuche in einer Stunde,
  // weil jeder Schritt von vorn anfing, nachdem der erste Versuch gescheitert war.
  //   Stufe 1: der turn-basierte Schnitt, der das Arbeitsfenster (keepTurns) respektiert.
  //   Stufe 2: die Rettung des Kerns (`compactIfNeeded`, Trigger `context-overflow`). Sie
  //            kennt kein Arbeitsfenster, ist also hart und verlustbehaftet — die Sitzung
  //            verliert lieber die jüngsten Züge, als dass sie stirbt (Entscheidung des
  //            Menschen 2026-11-09: „2 Ja“).
  interface Attempts { turn: number | undefined; stage1: boolean; stage2: boolean }
  const attempts = new Map<string, Attempts>()

  function attemptsFor(agent: GuardAgent, turn: number | undefined): Attempts {
    const key = sessionKey(agent)
    const known = attempts.get(key)
    if (known && turn !== undefined && known.turn === turn) return known
    const fresh: Attempts = { turn, stage1: false, stage2: false }
    attempts.set(key, fresh)
    return fresh
  }

  async function forceCompact(
    agent: GuardAgent,
    why: string,
    signal?: AbortSignal,
    turn?: number,
    onlyHard = false,
  ): Promise<boolean> {
    const key = sessionKey(agent)
    if (inFlight.has(key)) {
      callbacks.note('info', 'compaction guard: a compaction is already running for this session; skipped (' + why + ')')
      return false
    }
    const tried = attemptsFor(agent, turn)
    inFlight.add(key)
    try {
      if (!onlyHard && !tried.stage1) {
        tried.stage1 = true
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
              settle(agent, tried)
              return true
            }
          } else {
            callbacks.note('info', 'compaction guard (' + why + '): no turn-based cut is allowed here, going to the hard stage')
          }
        } catch (error) {
          callbacks.note('warn', 'compaction guard (' + why + ') stage 1 failed: ' + (error instanceof Error ? error.message : String(error)) + ' — going to the hard stage')
        }
      }
      if (tried.stage2) {
        callbacks.note('warn', 'compaction guard (' + why + '): both stages were already tried in this turn, not again')
        return false
      }
      tried.stage2 = true
      try {
        const emergency = await callbacks.compactEmergency(agent, signal)
        if (emergency) {
          callbacks.note(
            'info',
            'compaction guard (' + why + '): hard stage, the engine compacted the oldest safe range without a working window, freed ' +
              (typeof emergency.freedTokens === 'number' ? emergency.freedTokens : '?') + ' tokens',
          )
          settle(agent, tried)
          return true
        }
        callbacks.note('warn', 'compaction guard (' + why + '): no compactable range was found')
      } catch (error) {
        callbacks.note('warn', 'compaction guard (' + why + ') hard stage failed: ' + (error instanceof Error ? error.message : String(error)))
      }
      return false
    } finally {
      inFlight.delete(key)
    }
  }

  // Nach einer gelungenen Verdichtung, die die Belegung unter die Grenze gebracht hat, ist
  // das Problem gelöst: die Versuche zählen wieder von vorn. Liegt sie noch darüber, bleiben
  // die Stufen verbraucht, und der nächste Schritt eskaliert statt zu wiederholen.
  function settle(agent: GuardAgent, tried: Attempts): void {
    const after = callbacks.reading(agent)
    const verdict = after ? judgeBudget(after, policy) : null
    if (verdict && verdict.kind !== 'compact') {
      tried.stage1 = false
      tried.stage2 = false
    }
  }

  // Einmal je Überschreitung (Entscheidung des Menschen 2026-11-06, „gut so"): hat der
  // Wächter für die Grenze verdichtet, verdichtet er für DIESELBE Überschreitung nicht
  // noch einmal — auch nicht, wenn der Schnitt die Belegung nicht unter die Grenze
  // gebracht hat. Die Sperre geht erst wieder auf, wenn eine Messung unter der Grenze
  // lag. Ausgenommen ist die Verhinderung einer Ablehnung (Lage 3): wenn die nächste
  // Anfrage sonst abgelehnt würde, hat Verdichten Vorrang vor jeder Sperre.
  const spent = new Set<string>()

  function verdictFor(agent: GuardAgent) {
    const reading = callbacks.reading(agent)
    if (!reading) return null
    const verdict = judgeBudget(reading, policy)
    if (verdict && verdict.kind !== 'compact') spent.delete(sessionKey(agent))
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
      const { agent, signal, step, turn } = (payload ?? {}) as { agent?: GuardAgent; signal?: AbortSignal; step?: number; turn?: number }
      if (agent) {
        const judged = verdictFor(agent)
        if (judged) {
          const overflow = wouldOverflow(judged.reading, policy.safetyTokens)
          const firstStepOfTurn = typeof step === 'number' && step <= 1
          const overBoundary = judged.verdict.kind === 'compact'
          const alreadySpent = spent.has(sessionKey(agent))
          const midTurn = overBoundary && options.compactMidTurn && !firstStepOfTurn
          if (overflow || midTurn) {
            callbacks.note(
              'info',
              'compaction guard: ' + budgetSentence(judged.reading, judged.verdict) +
                (overflow ? ' — the next request would be rejected, compacting before it' : ' — over the boundary mid-turn'),
            )
            // Ist für diese Überschreitung schon einmal verdichtet worden und die Belegung liegt
            // trotzdem noch darüber, greift nur die harte Stufe (Entscheidung 2026-11-09).
            const onlyHard = !overflow && alreadySpent
            if (!overflow) spent.add(sessionKey(agent))
            await forceCompact(agent, overflow ? 'overflow prevention' : onlyHard ? 'turn boundary, hard stage' : 'turn boundary', signal, turn, onlyHard)
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
      // Ist für diese Überschreitung schon verdichtet worden und die Belegung liegt noch
      // immer über der Grenze, greift die harte Stufe (Entscheidung 2026-11-09: „2 Ja“).
      const onlyHard = spent.has(sessionKey(agent))
      callbacks.note('info', 'compaction guard at turn end' + (onlyHard ? ' (still over the boundary after an earlier compaction, hard stage)' : '') + ': ' + budgetSentence(judged.reading, judged.verdict))
      spent.add(sessionKey(agent))
      // Nicht auf die Verdichtung warten: der Zug ist zu Ende, und ein hängender
      // Ereignis-Hörer würde den nächsten Zug blockieren.
      void forceCompact(agent, onlyHard ? 'turn end, hard stage' : 'turn end', undefined, undefined, onlyHard)
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
      const done = await forceCompact(agent, 'context overflow recovery', signal, typeof turn === 'number' ? turn : undefined)
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
