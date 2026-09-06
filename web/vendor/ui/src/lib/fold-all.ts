import { createContext, useContext, useEffect, useRef } from "react"

/**
 * Transcript-wide "expand all / collapse all" for the collapsible process
 * blocks (step groups, reasoning rows, tool cards).
 *
 * Each block keeps its own expanded state and its own auto-fold rules; the
 * host issues a command through this context and every mounted block applies
 * it once. The PDF export prints the DOM as displayed, so these commands are
 * also how a reader chooses between a "full process" and an "answers only"
 * export.
 *
 * Blocks that mount AFTER a command normally keep their default — a stale
 * "collapse all" must not fold a step that starts running later, and a stale
 * "expand all" must not blow open the rows of a group the reader unfolds by
 * hand a minute later. The one exception: rows that mount BECAUSE a group
 * applied the command (a collapsed group unfolding on "expand all" mounts its
 * rows) — those are part of the same snapshot and apply it on mount. The
 * group announces that through `GroupFoldContext`.
 */

export type FoldMode = "expand" | "collapse"

export interface FoldCommand {
  mode: FoldMode
  /** Monotonic: a new command is a new object with a higher seq. */
  seq: number
}

export const FoldAllContext = createContext<FoldCommand | null>(null)

/** Provided by a step group to its rows: the seq of the fold command that
 *  produced the group's current expansion — `0` when the reader expanded it
 *  by hand (or it opened on its own default). */
export const GroupFoldContext = createContext(0)

/** Subscribe a block: `apply` runs once for every command issued after mount
 *  (and on mount itself when this mount is the command's own doing). */
export function useFoldAll(apply: (mode: FoldMode, seq: number) => void): void {
  const cmd = useContext(FoldAllContext)
  const groupSeq = useContext(GroupFoldContext)
  // Mounting inside a group that just applied `cmd`: treat it as unseen so
  // the effect below applies it. Otherwise skip whatever is current.
  const seenRef = useRef(cmd && cmd.seq === groupSeq ? 0 : (cmd?.seq ?? 0))
  const applyRef = useRef(apply)
  applyRef.current = apply
  useEffect(() => {
    if (!cmd || cmd.seq === seenRef.current) return
    seenRef.current = cmd.seq
    applyRef.current(cmd.mode, cmd.seq)
  }, [cmd])
}
