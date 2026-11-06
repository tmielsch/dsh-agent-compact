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
 * Hinweis. Zwischen `nudgeRatio` und der Grenze sagt das Plugin nichts mehr
 * (Entscheidung des Menschen 2026-11-06, „gut so").
 *
 * Gemessener Fehler (Sitzung a856b862, 2026-11-05/06): der Text stand mit der
 * aktuellen Prozentzahl, der Ankerliste und der Schnitt-Tabelle darin. Weil sich die
 * Zahl bei jedem Schritt ändert, speicherte DSH jedes Mal einen neuen Block von rund
 * 12.000 Zeichen — 21 Stück in einer Sitzung. Ein Block aus der laufenden Runde kann
 * von einer Verdichtung nicht ersetzt werden und blieb mit „81 %" stehen, obwohl die
 * Belegung nach der Verdichtung bei 68 % lag; das Modell glaubte ihm und verdichtete
 * ein zweites Mal. Der Text ist deshalb FEST (ohne Zahl, ohne Liste): unveränderter
 * Text wird nicht noch einmal gespeichert, und er sagt selbst, wann er erledigt ist.
 *
 * @returns der feste Befehlstext, byte-gleich bei jedem Aufruf.
 */
export function boundaryCommandText(): string {
  return (
    'ABSOLUTE COMMAND — the context has reached the hard boundary of this session. Compact NOW: call ' +
    '`context_compact_plan` once, then `context_compact` with the largest allowed `turns=N` and a ' +
    'checkpoint you write, as the LAST action of this turn after you have answered the human. ' +
    'If you do not, the harness compacts at the end of this turn instead, and that checkpoint is not ' +
    'yours. This block is spent as soon as a compaction has happened after it: if the conversation ' +
    'above shows a compaction newer than this block, ignore it and do NOT compact again for it. ' +
    'It names no numbers on purpose, because a number in it would be stale one step later.'
  )
}

