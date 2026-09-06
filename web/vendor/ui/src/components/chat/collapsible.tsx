import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@agentchat/lib/utils"

/**
 * Animated fold for the transcript's process blocks (reasoning rows, tool
 * cards, step groups): an open/close height transition that still keeps the
 * children UNMOUNTED while folded.
 *
 * Why not just CSS: a folded transcript from history holds dozens of tool
 * cards; rendering all of them just to hide them would be the O(n) markdown
 * cost the rows' memoization exists to avoid. Why not just `{open && …}`:
 * conditional rendering can only animate in — the content vanishes in one
 * frame on close and the reader loses their place.
 *
 * So this is a four-state machine over a CSS grid-row transition
 * (`.acc-collapsible` in theme.css):
 *
 *   closed ──open──▶ entering ──transitionend──▶ open
 *     ▲                                            │
 *     └────transitionend──── exiting ◀────close────┘
 *
 * Children are mounted in every state except `closed`. `entering` mounts
 * them at 0fr and flips to 1fr on the next frame; `exiting` keeps the last
 * frame rendered while the row shrinks, then unmounts. A toggle mid-flight
 * simply retargets the transition — no queued animations, no stale timers.
 *
 * Mount with `open` already true renders straight into `open` (no entrance):
 * history rows and live rows must appear settled, not animate open.
 */
type Phase = "closed" | "entering" | "open" | "exiting"

interface CollapsibleProps {
  open: boolean
  children: ReactNode
  className?: string
}

export function Collapsible({ open, children, className }: CollapsibleProps) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed")
  const ref = useRef<HTMLDivElement>(null)

  // Drive the machine from the `open` prop. useLayoutEffect so the `closed`
  // → `entering` mount lands in the same frame as the state change and the
  // 0fr start frame is what the browser paints first.
  useLayoutEffect(() => {
    if (open) {
      setPhase((p) => (p === "open" || p === "entering" ? p : "entering"))
    } else {
      setPhase((p) => (p === "closed" || p === "exiting" ? p : "exiting"))
    }
  }, [open])

  // `entering` is committed with data-state="closed" (0fr). Flip to the open
  // measurement one frame later so the transition has a start value. A
  // double rAF is deliberate: the first fires before the mount's style
  // resolution on some engines, and a transition needs a painted start.
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (phase !== "entering") {
      setEntered(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [phase])

  // Reduced motion (or a transition the browser skipped, e.g. a display:none
  // ancestor) never fires transitionend. Fall back to a timer slightly past
  // the CSS duration so the machine cannot stick in a transitional phase.
  useEffect(() => {
    if (phase !== "entering" && phase !== "exiting") return
    const settle = () => setPhase((p) => (p === "entering" ? "open" : p === "exiting" ? "closed" : p))
    const timer = window.setTimeout(settle, 320)
    return () => window.clearTimeout(timer)
  }, [phase])

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    // Only our own row transition — not a child's color/opacity hover.
    if (e.target !== ref.current || e.propertyName !== "grid-template-rows") return
    setPhase((p) => (p === "entering" ? "open" : p === "exiting" ? "closed" : p))
  }

  if (phase === "closed") return null

  const state = phase === "open" ? "open" : phase === "entering" ? (entered ? "opening" : "closed") : "closed"

  return (
    <div
      ref={ref}
      className={cn("acc-collapsible", className)}
      data-state={state}
      aria-hidden={phase === "exiting" || undefined}
      onTransitionEnd={handleTransitionEnd}
    >
      <div>{children}</div>
    </div>
  )
}
