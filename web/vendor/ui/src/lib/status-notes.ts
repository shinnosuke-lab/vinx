/**
 * Transcript placement of `status` frames — the loop's one-line notes about
 * its own work ("Compacting context...", "Context compacted in 15s: …").
 *
 * The wire marks work in flight with `pending: true`; the next `status`
 * frame is that work's outcome (see `AgentEvent::StatusUpdate`). Two rules,
 * shared by every chat surface:
 *
 * 1. The transcript keeps the outcome, not the wait: a note REPLACES a
 *    pending one in place instead of stacking under it.
 * 2. A note that lands during a turn goes in FRONT of the trailing empty
 *    assistant placeholder, so the placeholder stays last — it carries the
 *    thinking spinner and receives the deltas that follow, which must render
 *    below the note, not above it.
 */

/** The shape a transcript row needs to expose for placement. */
export interface StatusNoteLike {
  role: string
  content: string
  reasoning?: string
  /** Set on `status` rows only: work in flight, resolved by the next note. */
  pending?: boolean
}

function isPendingNote(m: StatusNoteLike): boolean {
  return m.role === "status" && m.pending === true
}

function isEmptyPlaceholder(m: StatusNoteLike | undefined): boolean {
  return !!m && m.role === "assistant" && !m.content && !m.reasoning
}

/** Insert (or substitute) a status note into the transcript; returns a new array. */
export function placeStatusNote<M extends StatusNoteLike>(rows: readonly M[], note: M): M[] {
  const next = [...rows]
  for (let i = next.length - 1; i >= 0; i--) {
    if (isPendingNote(next[i])) {
      next[i] = note
      return next
    }
  }
  if (isEmptyPlaceholder(next[next.length - 1])) {
    next.splice(next.length - 1, 0, note)
  } else {
    next.push(note)
  }
  return next
}

/**
 * Drop pending notes a finished turn never resolved (cancelled or crashed
 * mid-compaction): the wait is over and there is nothing to report. Returns
 * the same array when there is nothing to drop, so callers can skip a
 * re-render.
 */
export function dropPendingNotes<M extends StatusNoteLike>(rows: M[]): M[] {
  return rows.some(isPendingNote) ? rows.filter((m) => !isPendingNote(m)) : rows
}
