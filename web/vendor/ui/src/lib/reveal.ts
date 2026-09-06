import { createContext, useContext, useEffect, useRef } from "react"

/**
 * Targeted reveal of ONE earlier tool call — "show me the original" from a
 * card that refers to it (the `recall_result` card links to the call whose
 * output it brought back). The host issues a command; the step group holding
 * that call unfolds, the call's own card expands, scrolls into view and
 * flashes.
 *
 * Unlike fold-all (lib/fold-all.ts) a reveal IS consumed on mount: the card
 * usually mounts BECAUSE its group just unfolded for this very command. The
 * host therefore retracts the command shortly after issuing it, so a card
 * that remounts later (the reader refolds and reopens the group) does not
 * replay a stale reveal.
 */
export interface RevealCommand {
  /** The tool_call id to bring into view. */
  callId: string
  /** Monotonic; a new command is a new object with a higher seq. */
  seq: number
}

export const RevealContext = createContext<RevealCommand | null>(null)

/**
 * Subscribe a block: `apply` runs once per command (including one already in
 * flight when the block mounts). The block decides whether the command is
 * for it — a card compares `callId`, a step group checks its members.
 */
export function useReveal(apply: (cmd: RevealCommand) => void): void {
  const cmd = useContext(RevealContext)
  const seenRef = useRef(0)
  const applyRef = useRef(apply)
  applyRef.current = apply
  useEffect(() => {
    if (!cmd || cmd.seq === seenRef.current) return
    seenRef.current = cmd.seq
    applyRef.current(cmd)
  }, [cmd])
}
