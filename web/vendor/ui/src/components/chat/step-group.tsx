import { useEffect, useMemo, useRef, useState, memo, type ReactNode } from "react"
import { ChevronRight, Loader2, X } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { GroupFoldContext, useFoldAll } from "@agentchat/lib/fold-all"
import { useReveal } from "@agentchat/lib/reveal"
import { toolLabel } from "./tools/shared"
import { Collapsible } from "./collapsible"

/**
 * Collapsible wrapper around a run of consecutive "process" rows — reasoning-
 * only assistant turns and tool calls — that sit between two pieces of real
 * content. Long agentic turns produce dozens of these; each row already
 * collapses itself, but the ladder of one-line headers still dominates the
 * transcript. The group folds the ladder into one summary line once the
 * answer arrives, while keeping every row live and visible while it runs.
 *
 * Grouping itself (which rows form a group) is decided by
 * `buildTranscriptBlocks`; this component owns the fold/unfold lifecycle.
 */

/** Visible process steps below this count render bare (no group header):
 *  one wrapper line around one or two tool rows would ADD noise. */
export const MIN_STEP_GROUP = 3

/** Tools whose collapsed card IS the interaction (a button the user must
 *  click) — they never fold into a group, so they stay reachable. Mirrors
 *  STICKY_TOOLS in tool-call-block.tsx. */
export const UNGROUPABLE_TOOLS = new Set(["open_terminal", "set_chat_style", "open_file", "install_app"])

/** The shape `buildTranscriptBlocks` needs from a transcript message. */
export interface StepLike {
  id: number
  role: string
  content: string
  reasoning?: string
  toolName?: string
  toolSuccess?: boolean
  /** Lets a group recognise the member a reveal command targets. */
  toolCallId?: string
}

/** Is this row a process step (eligible for grouping)? Includes the empty
 *  assistant placeholder appended after each tool result — it becomes the
 *  next reasoning row (or the answer) as the stream continues. */
export function isProcessStep(m: StepLike): boolean {
  if (m.role === "tool") return !UNGROUPABLE_TOOLS.has(m.toolName ?? "")
  return m.role === "assistant" && !m.content
}

/**
 * One rendered unit inside a group. `part: "reasoning"` is the reasoning half
 * of an assistant message that ALSO carries content: the answer's own
 * thinking folds into the group above it, and the content renders below as a
 * row with `hideReasoning`. Same message object, two places.
 */
export interface GroupMember<M> {
  msg: M
  index: number
  part: "step" | "reasoning"
}

export type TranscriptBlock<M> =
  | { kind: "row"; msg: M; index: number; hideReasoning: boolean }
  | { kind: "group"; members: GroupMember<M>[]; key: string }

/** Steps that show something: tool rows and reasoning rows with text. Empty
 *  assistant placeholders ride along in a run but don't count toward the
 *  grouping threshold or the header tally. */
function isVisibleStep<M extends StepLike>(m: GroupMember<M>): boolean {
  if (m.part === "reasoning") return true
  return m.msg.role === "tool" || !!m.msg.reasoning
}

/**
 * Partition the transcript into plain rows and step groups. A run of process
 * rows becomes a group when it holds at least `MIN_STEP_GROUP` visible steps.
 * A trailing run (the turn in progress) is grouped too, so the header can
 * show progress while it runs.
 *
 * `key` stays stable while a group grows (first member's id), so React keeps
 * the group's expanded/collapsed state across stream updates.
 */
export function buildTranscriptBlocks<M extends StepLike>(messages: M[]): TranscriptBlock<M>[] {
  const blocks: TranscriptBlock<M>[] = []
  let run: GroupMember<M>[] = []

  /** Emit the pending run; returns whether it formed a group. */
  const flush = (): boolean => {
    const pending = run
    run = []
    if (pending.length === 0) return false
    // Threshold counts the turn's own steps only. The answer's split-off
    // reasoning rides along when a group forms, but must not tip a one- or
    // two-tool turn into one: `[reasoning, tool, answer]` should stay bare.
    const ownSteps = pending.filter((m) => m.part === "step" && isVisibleStep(m)).length
    if (ownSteps >= MIN_STEP_GROUP) {
      blocks.push({ kind: "group", members: pending, key: `g${pending[0].msg.id}` })
      return true
    }
    // Too short: rows render bare (MessageRow already hides an empty
    // placeholder unless it is the streaming tail). A split-off reasoning
    // part is dropped: its content row renders the reasoning itself.
    for (const m of pending) {
      if (m.part === "step") blocks.push({ kind: "row", msg: m.msg, index: m.index, hideReasoning: false })
    }
    return false
  }

  messages.forEach((msg, i) => {
    if (isProcessStep(msg)) {
      run.push({ msg, index: i, part: "step" })
      return
    }
    // A content-bearing assistant message closes the run. Its reasoning (if
    // any) is the last step OF that run — the thinking that produced the
    // answer — so it joins the group, and the content renders without it.
    const splitReasoning = msg.role === "assistant" && !!msg.reasoning && run.length > 0
    if (splitReasoning) run.push({ msg, index: i, part: "reasoning" })
    const formed = flush()
    blocks.push({ kind: "row", msg, index: i, hideReasoning: splitReasoning && formed })
  })
  flush()
  return blocks
}

interface StepGroupProps {
  members: GroupMember<StepLike>[]
  /**
   * True while this group's turn is still producing steps (streaming, and
   * this is the transcript's last block). Drives the live header.
   */
  live: boolean
  /**
   * Whether the reader is following the tail of the transcript. Auto-fold on
   * completion only fires when true: folding while the user has scrolled up
   * to read a tool output would yank it away.
   */
  followTail: boolean
  children: ReactNode
}

/** Per-tool counts for the collapsed summary, most frequent first. */
function summarizeTools(members: GroupMember<StepLike>[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (m.msg.role !== "tool") continue
    const name = m.msg.toolName || "tool"
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

const MAX_TOOL_CHIPS = 4

export const StepGroup = memo(function StepGroup({ members, live, followTail, children }: StepGroupProps) {
  // Live groups start open so the running rows stay visible; a group mounted
  // from history (already finished) starts folded.
  const [expanded, setExpanded] = useState(live)
  const userToggledRef = useRef(false)
  // Was the group live at any point during this mount? Only a live→done
  // transition may auto-fold — a history-mounted group is already folded.
  const wasLiveRef = useRef(live)
  if (live) wasLiveRef.current = true

  useEffect(() => {
    if (live || userToggledRef.current || !wasLiveRef.current) return
    // The answer started (or the turn ended): fold, unless the reader has
    // scrolled up — then leave it as is and let them fold it themselves.
    if (followTail) setExpanded(false)
    // Deliberately not depending on followTail: a later scroll-to-bottom must
    // not retroactively fold a group the reader chose to keep open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  // The fold-all command that produced the current expansion, with the
  // member count at that moment. Rows that mount because "expand all" opened
  // this group apply the same command (see GroupFoldContext); rows a live
  // turn adds LATER get their normal default — the count no longer matches,
  // so the provided seq drops back to 0 in that very render.
  const [fold, setFold] = useState({ seq: 0, len: 0 })
  const groupFoldSeq = fold.len === members.length ? fold.seq : 0

  const handleToggle = () => {
    userToggledRef.current = true
    setFold({ seq: 0, len: 0 })
    setExpanded((e) => !e)
  }

  // Transcript-wide expand/collapse (header menu). Counts as a user choice:
  // the auto-fold on completion must not undo an explicit "expand all".
  useFoldAll((mode, seq) => {
    userToggledRef.current = true
    setFold({ seq, len: members.length })
    setExpanded(mode === "expand")
  })

  // "Show original" from a card that refers to one of our members (the
  // recall_result card): unfold so the member's card can mount and take
  // over (lib/reveal). A user choice as well — auto-fold must not undo it.
  useReveal((cmd) => {
    if (!members.some((m) => m.msg.role === "tool" && m.msg.toolCallId === cmd.callId)) return
    userToggledRef.current = true
    setExpanded(true)
  })

  const stats = useMemo(() => {
    let reasoning = 0
    let tools = 0
    let failed = 0
    for (const m of members) {
      if (m.msg.role === "tool") {
        tools++
        if (m.msg.toolSuccess === false) failed++
      } else if (m.part === "reasoning" || m.msg.reasoning) {
        reasoning++
      }
    }
    return { total: reasoning + tools, reasoning, tools, failed, chips: summarizeTools(members) }
  }, [members])

  // Live header: what is running right now (last member), so the header
  // doubles as a progress line while open — or after an early manual fold.
  const current = members[members.length - 1]
  const currentIsTool = current?.msg.role === "tool"
  const currentLabel = currentIsTool ? toolLabel(current.msg.toolName || "") : t("thinkingLabel")
  // An empty placeholder waiting for the model is the step in progress; the
  // tally above skips it, so count it here for "step N".
  const liveStep = stats.total + (!currentIsTool && current && !current.msg.reasoning ? 1 : 0)

  const visibleChips = stats.chips.slice(0, MAX_TOOL_CHIPS)
  const hiddenChipCount = stats.chips.length - visibleChips.length

  return (
    <div data-acc="step-group" className="mt-1">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 border-l border-l-muted-foreground/30 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform duration-200", expanded && "rotate-90")}
        />
        {live ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
        ) : stats.failed > 0 ? (
          <X className="h-3 w-3 shrink-0 text-destructive" />
        ) : null}
        {/* Keyed on `live`: the progress line ("step 4 · Read File") and the
            settled tally ("7 steps · …") are different labels, so the swap
            re-mounts and fades the new one in rather than snapping. */}
        <span key={live ? "live" : "done"} className="animate-label-in flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 whitespace-nowrap font-medium">
            {live ? tf("stepGroupLive", liveStep, currentLabel) : tf("stepGroupSteps", stats.total)}
          </span>
          {!live && (
            <>
              <span className="shrink-0 text-muted-foreground/30">·</span>
              <span className="shrink-0 whitespace-nowrap text-muted-foreground/60">
                {tf("stepGroupBreakdown", stats.reasoning, stats.tools)}
              </span>
              {stats.failed > 0 && (
                <span className="shrink-0 whitespace-nowrap text-destructive/80">
                  {tf("stepGroupFailed", stats.failed)}
                </span>
              )}
              {visibleChips.length > 0 && (
                <span className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden">
                  {visibleChips.map(({ name, count }) => (
                    <span
                      key={name}
                      className="shrink-0 rounded-sm bg-muted/60 px-1 py-px font-mono text-[10px] text-muted-foreground/70"
                    >
                      {toolLabel(name)}
                      {count > 1 && <span className="text-muted-foreground/40"> ×{count}</span>}
                    </span>
                  ))}
                  {hiddenChipCount > 0 && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/50">+{hiddenChipCount}</span>
                  )}
                </span>
              )}
            </>
          )}
        </span>
      </button>
      {/* Rows render at the transcript's left edge, exactly as they do when
          no group forms: the header is a fold control above them, not a
          parent they nest under (each row already carries its own rule). */}
      <Collapsible open={expanded}>
        <GroupFoldContext.Provider value={groupFoldSeq}>{children}</GroupFoldContext.Provider>
      </Collapsible>
    </div>
  )
})
