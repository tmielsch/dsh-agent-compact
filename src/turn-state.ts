// Gemeinsamer Zugzustand von Wächter und Befehls-Anbieter (Spec 11.6, R11).
//
// Gemessen in Sitzung 0b9ffeb1 (2026-11-10): `systemPrompt.assemble` läuft VOR dem Waterfall
// `agent/pre-step` (dsh-agent-loop, `preStep`). Der Anbieter `agent-compact:volume-nudge`
// entscheidet über den Befehl also mit der Belegung vor der Verdichtung des Wächters, und der
// Block wird danach an die Oberfläche geschrieben. Ergebnis: der Wächter verdichtete, und das
// Modell verdichtete auf den frischen Befehl hin noch einmal.
//
// Dieser Zustand sagt dem Anbieter, in welchem Schritt des Zuges er gerade fragt, und dem Wächter,
// ob das Modell den Befehl in diesem Zug schon hat. Er enthält nur Zähler, keine Dienste.

/** Schlüssel einer Sitzung; Wächter und Anbieter müssen denselben benutzen. */
export function sessionKeyOf(agent: { session?: { id?: unknown } } | undefined): string {
  const id = agent && agent.session ? agent.session.id : undefined
  return typeof id === 'string' && id ? id : 'unknown-session'
}

/** Der Zugzustand einer Sitzung. */
interface TurnRecord {
  /** Nummer des Zuges, zu dem die Angaben gehören; undefined, solange sie unbekannt ist. */
  turn: number | undefined
  /** Wie viele Schritte dieses Zuges der Wächter schon gesehen hat (`agent/pre-step`). */
  steps: number
  /** Ob der Anbieter in diesem Zug den Befehl an das Modell geliefert hat. */
  commandIssued: boolean
}

/** Gemeinsamer Zugzustand, nach Sitzung getrennt. */
export interface TurnState {
  /** Wahr, solange in dieser Sitzung in diesem Zug noch kein Schritt durch `agent/pre-step` gegangen ist. */
  isFirstStep(sessionKey: string): boolean
  /** Der Wächter hat einen Schritt gesehen (am Ende seines `agent/pre-step`-Hörers aufrufen). */
  noteStep(sessionKey: string): void
  /** Der Anbieter hat in diesem Zug den Befehl geliefert. */
  markCommand(sessionKey: string): void
  /** Wahr, wenn der Befehl in diesem Zug geliefert wurde. */
  commandIssued(sessionKey: string): boolean
  /** Der Zug ist zu Ende (Agent untätig): beide Angaben zurücksetzen. */
  endTurn(sessionKey: string): void
  /**
   * Die Nummer des laufenden Zuges melden. Wechselt sie, fiel das Zug-Ende aus (zum Beispiel nach einem
   * Abbruch): dann wird der Zustand zurückgesetzt, damit ein Merker nicht in den nächsten Zug hineinragt.
   */
  syncTurn(sessionKey: string, turn: number | undefined): void
}

/**
 * Darf der Anbieter jetzt den Befehl an das Modell liefern? (R11, Entscheidung des Menschen 2026-11-10 „A)“)
 *
 * Nur im ersten Schritt eines Zuges und nur, wenn die nächste Anfrage nicht ohnehin abgelehnt würde.
 * Mitten im Zug und bei drohender Ablehnung verdichtet der Wächter selbst. Bei „ja“ merkt sich der
 * Zustand, dass das Modell in diesem Zug den Befehl hat; der Wächter verdichtet dann mitten im Zug nicht.
 *
 * @param state - der gemeinsame Zugzustand.
 * @param sessionKey - Schlüssel der Sitzung (`sessionKeyOf`).
 * @param wouldBeRejected - wahr, wenn Prompt + Antwort-Reserve das Fenster überschreiten (`wouldOverflow`).
 * @returns wahr, wenn der Befehl geliefert werden soll.
 */
export function mayIssueCommand(state: TurnState, sessionKey: string, wouldBeRejected: boolean): boolean {
  if (wouldBeRejected) return false
  if (!state.isFirstStep(sessionKey)) return false
  state.markCommand(sessionKey)
  return true
}

/**
 * Einen leeren gemeinsamen Zugzustand anlegen.
 *
 * @returns der Zustand; er hält nichts außer den zwei Angaben je Sitzung.
 */
export function createTurnState(): TurnState {
  const records = new Map<string, TurnRecord>()
  const of = (key: string): TurnRecord => {
    let record = records.get(key)
    if (!record) {
      record = { turn: undefined, steps: 0, commandIssued: false }
      records.set(key, record)
    }
    return record
  }
  return {
    isFirstStep: (key) => of(key).steps === 0,
    noteStep: (key) => {
      of(key).steps++
    },
    markCommand: (key) => {
      of(key).commandIssued = true
    },
    commandIssued: (key) => of(key).commandIssued,
    endTurn: (key) => {
      records.delete(key)
    },
    syncTurn: (key, turn) => {
      if (typeof turn !== 'number') return
      const record = records.get(key)
      if (record && record.turn !== undefined && record.turn !== turn) records.delete(key)
      of(key).turn = turn
    },
  }
}
