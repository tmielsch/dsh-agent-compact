// Harte Compaction-Grenze: die reine Rechnung.
//
// Warum die Prozentzahl im Chat allein nicht reicht (gemessen am 2026-10-31):
// die Anzeige teilt den Prompt durch das Kontextfenster. Eine Anfrage muss aber
// PROMPT + ANTWORT-RESERVE in das Fenster legen, sonst lehnt der Anbieter sie ab.
// Bei `deepseek-flash` reserviert jede Anfrage 256.000 Token; ein Fenster von
// 1.000.000 trägt also nur rund 744.000 Token Prompt. Wer bei 86 % (860.000)
// anfängt, verlangt 116 % und bekommt einen API-Fehler.
//
// Diese Datei enthält deshalb nur Rechnung, keine Dienste und kein Cordis: damit
// die Entscheidung ohne laufenden Harness prüfbar bleibt (test/budget.test.mjs).

/** Vorgaben der Grenze. Alle Werte sind Token bzw. Anteile (0..1). */
export interface BudgetPolicy {
  /** Anteil des nutzbaren Promp-Budgets, ab dem verdichtet wird (Vorgabe 0,9). */
  boundaryRatio: number
  /** Anteil, ab dem das Modell den Befehl zu verdichten bekommt (Vorgabe 0,75). */
  nudgeRatio: number
  /** Zusätzlicher Sicherheitsabstand zum Fenster (Vorgabe 4096 Token). */
  safetyTokens: number
}

export interface BudgetReading {
  /** Prompt-Seite der nächsten Anfrage in Token. */
  promptTokens: number
  /** Kontextfenster des gerouteten Modells in Token. */
  windowTokens: number
  /** Antwort-Reserve, die die nächste Anfrage für sich verlangt. */
  reserveTokens: number
}

export type BudgetVerdict = {
  /** keine Verdichtung nötig */
  kind: 'ok' | 'nudge' | 'compact'
  /** Anteil des Fensters, den der Prompt belegt (das, was der Chat anzeigt) */
  windowPercent: number
  /** Anteil des Promp-Budgets, den der Prompt belegt (1 minus Reserve) */
  budgetPercent: number
  /** Prompt-Budget: Fenster minus Sicherheit minus Antwort-Reserve */
  budgetTokens: number
  /** Ab diesem Prompt wird verdichtet */
  thresholdTokens: number
}

/**
 * Beurteilen, ob die nächste Anfrage verdichten muss.
 *
 * Das Budget einer Anfrage ist `Fenster − Sicherheit − Reserve`; der Guard misst
 * den Prompt gegen DIESES Budget, nicht gegen das nackte Fenster. Die Folge ist
 * gewollt und wird im Log doppelt ausgewiesen: mit einer Reserve von 256.000 liegt
 * die Grenze bei rund 67 % der Fensteranzeige, weil genau dort die Anfrage ihre
 * 90 % verbraucht hat. Wird die Reserve im Profil kleiner gesetzt (z. B. 65536),
 * wandert dieselbe Grenze auf rund 93 % der Anzeige — ohne eine Zeile Code.
 *
 * Ist das Fenster unbekannt (0 oder negativ), gibt es kein Urteil: der Guard rät
 * nicht und tut nichts.
 *
 * @param reading - gemessener Prompt, Fenster und Reserve der nächsten Anfrage.
 * @param policy - Grenzen (Anteile und Sicherheitsabstand).
 * @returns das Urteil samt der beiden Prozentzahlen für das Log.
 */
export function judgeBudget(reading: BudgetReading, policy: BudgetPolicy): BudgetVerdict | null {
  const windowTokens = Math.floor(reading.windowTokens)
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return null
  const promptTokens = Math.max(0, Math.floor(reading.promptTokens))
  const reserveTokens = Math.max(0, Math.floor(reading.reserveTokens))
  const safetyTokens = Math.max(0, Math.floor(policy.safetyTokens))
  const boundary = clampRatio(policy.boundaryRatio)
  const nudge = Math.min(clampRatio(policy.nudgeRatio), boundary)

  const usable = Math.max(0, windowTokens - safetyTokens)
  const budgetTokens = Math.max(0, usable - reserveTokens)
  const windowPercent = Math.round((promptTokens / windowTokens) * 1000) / 10
  const budgetPercent = budgetTokens > 0 ? Math.round((promptTokens / budgetTokens) * 1000) / 10 : 100
  const thresholdTokens = Math.floor(budgetTokens * boundary)

  const verdict = (kind: BudgetVerdict['kind']): BudgetVerdict => ({
    kind,
    windowPercent,
    budgetPercent,
    budgetTokens,
    thresholdTokens,
  })

  // Kein Promp-Budget (Reserve frisst das Fenster): jede Anfrage scheitert, egal
  // wie klein der Prompt ist. Verdichten kann das nicht heilen, aber es ist die
  // einzige Handlung, die überhaupt etwas ändert.
  if (budgetTokens <= 0) return verdict('compact')
  if (promptTokens >= thresholdTokens) return verdict('compact')
  if (promptTokens >= Math.floor(budgetTokens * nudge)) return verdict('nudge')
  return verdict('ok')
}

/** Wahr, wenn die nächste Anfrage so nicht mehr durchgeht (Prompt + Reserve > Fenster). */
export function wouldOverflow(reading: BudgetReading, safetyTokens: number): boolean {
  const windowTokens = Math.floor(reading.windowTokens)
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return false
  const usable = windowTokens - Math.max(0, Math.floor(safetyTokens))
  return Math.max(0, Math.floor(reading.promptTokens)) + Math.max(0, Math.floor(reading.reserveTokens)) > usable
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.9
  return Math.min(1, value)
}

/** Lesbarer Satz für das Host-Log und die Meldung an das Modell. */
export function budgetSentence(reading: BudgetReading, verdict: BudgetVerdict): string {
  return (
    'prompt ' + Math.max(0, Math.floor(reading.promptTokens)) + ' / budget ' + verdict.budgetTokens +
    ' tokens (' + verdict.budgetPercent + '% of the request budget, ' + verdict.windowPercent +
    '% of the ' + Math.floor(reading.windowTokens) + '-token window; answer reserve ' +
    Math.max(0, Math.floor(reading.reserveTokens)) + '); boundary at ' + verdict.thresholdTokens + ' tokens'
  )
}

/**
 * Der Befehl an das Modell, wenn die Grenze greift.
 *
 * Der Mensch, 2026-10-31, wörtlich: *„dass einfach bei 90 % der Agent injected
 * bekommt, dass es ein absoluter Befehl ist, drop all compact now, otherwise
 * complete catastrophic failure"*. Ab der Grenze steht deshalb ein Befehl da, kein
 * Hinweis; ab `nudgeRatio` ein dringender Hinweis. Die Zahlen stehen dabei, weil
 * ein Befehl ohne Messwert nur Größe ist.
 *
 * @param reading - gemessener Prompt, Fenster und Reserve.
 * @param verdict - das Urteil derselben Messung.
 * @returns der Text, oder '' wenn nichts zu sagen ist.
 */
export function boundaryCommandText(reading: BudgetReading, verdict: BudgetVerdict): string {
  if (verdict.kind === 'ok') return ''
  const numbers =
    'You are at ' + verdict.budgetPercent + '% of the request budget (' +
    Math.max(0, Math.floor(reading.promptTokens)) + ' of ' + verdict.budgetTokens +
    ' tokens usable; the answer reserve of ' + Math.max(0, Math.floor(reading.reserveTokens)) +
    ' tokens is already subtracted). That is ' + verdict.windowPercent + '% of the ' +
    Math.floor(reading.windowTokens) + '-token window.'
  if (verdict.kind === 'compact') {
    return (
      'ABSOLUTE COMMAND — compact NOW, it is not optional. ' + numbers + ' The harness compacts for you at this ' +
      'point and that checkpoint is not yours: your measured work can be lost. Call `context_compact` in your ' +
      'next tool call with a checkpoint you write, then continue. A request that runs into the boundary without ' +
      'a compaction is rejected by the provider and the turn dies (complete failure).'
    )
  }
  return (
    'Boundary approaching, act now rather than later. ' + numbers + ' At ' + verdict.thresholdTokens +
    ' tokens the harness compacts for you and your own checkpoint is gone. Call `context_compact` with a ' +
    'checkpoint you write, at the end of this turn.'
  )
}

