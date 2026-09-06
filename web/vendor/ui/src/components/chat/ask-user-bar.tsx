import { useEffect, useRef, useState } from "react"
import { HelpCircle, Timer } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import type { AskAnswer, AskQuestion } from "@agentchat/types"

interface AskUserBarProps {
  questions: AskQuestion[]
  /** Unattended (full-auto) sessions: seconds until the backend auto-picks
   *  each question's recommended default. Shows a countdown badge; the bar
   *  itself is dismissed by the ask's `tool_result` frame when time runs out
   *  (the backend, not the UI, owns the timeout). */
  timeoutSecs?: number | null
  /** Called (leading-edge throttled) when the user interacts with the card
   *  while a countdown is armed — the backend resets its auto-pick deadline
   *  so an in-progress answer is never cut short. */
  onActivity?: () => void
  onSubmit: (answers: AskAnswer[]) => void
  onCancel: () => void
}

interface SlotState {
  selectedIds: string[]
  customText: string
}

/**
 * Sentinel option id used to represent the free-text row. It participates in
 * the radio/checkbox group like a regular option, but is stripped from
 * `selected_ids` before the answer leaves the UI — the typed text travels
 * back via `custom_text` instead, keeping the wire protocol unchanged.
 */
const CUSTOM_SENTINEL_ID = "__other__"

/** Option letter badges: A, B, C… (schema caps options at 5 per question). */
const letterOf = (i: number) => String.fromCharCode(65 + i)

function initialSlots(questions: AskQuestion[]): SlotState[] {
  return questions.map((q) => ({
    selectedIds: q.default_id ? [q.default_id] : [],
    customText: "",
  }))
}

/**
 * Bottom-of-chat popover that renders an `ask_user` SSE frame's questions
 * as a single card. One radio/checkbox group per question (multi_select
 * decides which), every option carrying an A/B/C… letter badge.
 *
 * Every question ends with an always-visible free-text row (the
 * `allow_custom` flag is deprecated/ignored — models rarely set it, and
 * users routinely need an answer outside the offered options). Focusing or
 * typing into the inline input selects the row; in single-select picking a
 * regular option deselects it again (the typed text is kept, not cleared).
 *
 * Submit ships every question's answer in one POST — partial submissions
 * are blocked at the UI layer to avoid the LLM having to chase missing
 * answers.
 */
export function AskUserBar({ questions, timeoutSecs, onActivity, onSubmit, onCancel }: AskUserBarProps) {
  const [slots, setSlots] = useState<SlotState[]>(() => initialSlots(questions))
  const [error, setError] = useState<string | null>(null)
  // Countdown display only — the backend owns the timeout and resolves the
  // ask itself; when the seconds hit 0 the bar just waits for its
  // `tool_result` frame to dismiss it. Activity pings push the deadline
  // back to the full window (mirroring the backend), so the interval keeps
  // ticking instead of stopping at 0.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(timeoutSecs ?? null)
  const deadlineRef = useRef<number | null>(null)
  const lastPingRef = useRef(0)
  useEffect(() => {
    if (timeoutSecs == null) return
    deadlineRef.current = Date.now() + timeoutSecs * 1000
    setSecondsLeft(timeoutSecs)
    const timer = window.setInterval(() => {
      const deadline = deadlineRef.current
      if (deadline == null) return
      setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [timeoutSecs])

  /** Leading-edge throttle (2s): ping the backend and reset the local
   *  countdown together, so the badge tracks the real deadline. Only when a
   *  countdown is armed — attended sessions have nothing to reset. */
  const reportActivity = () => {
    if (timeoutSecs == null) return
    const now = Date.now()
    if (now - lastPingRef.current < 2000) return
    lastPingRef.current = now
    deadlineRef.current = now + timeoutSecs * 1000
    setSecondsLeft(timeoutSecs)
    onActivity?.()
  }

  // Every user interaction (option pick, free-text focus/typing) funnels
  // through updateSlot — the single activity hook point.
  const updateSlot = (idx: number, next: SlotState) => {
    setSlots((prev) => prev.map((s, i) => (i === idx ? next : s)))
    if (error) setError(null)
    reportActivity()
  }

  const togglePick = (qIdx: number, q: AskQuestion, optId: string) => {
    const slot = slots[qIdx]
    if (q.multi_select) {
      const next = slot.selectedIds.includes(optId)
        ? slot.selectedIds.filter((id) => id !== optId)
        : [...slot.selectedIds, optId]
      updateSlot(qIdx, { ...slot, selectedIds: next })
    } else {
      updateSlot(qIdx, { ...slot, selectedIds: [optId] })
    }
  }

  /** Select (never toggle off) the free-text row — focusing/typing must not
   *  flip an already-selected row back off. */
  const selectCustom = (qIdx: number, q: AskQuestion, extra?: Partial<SlotState>) => {
    const slot = slots[qIdx]
    const selectedIds = slot.selectedIds.includes(CUSTOM_SENTINEL_ID)
      ? slot.selectedIds
      : q.multi_select
        ? [...slot.selectedIds, CUSTOM_SENTINEL_ID]
        : [CUSTOM_SENTINEL_ID]
    updateSlot(qIdx, { ...slot, ...extra, selectedIds })
  }

  const handleSubmit = () => {
    // Validation: every question needs at least one selected option, and
    // a selected free-text row must carry non-empty text.
    for (let i = 0; i < questions.length; i++) {
      const slot = slots[i]
      if (slot.selectedIds.length === 0) {
        setError(t("askUserPickAtLeastOne"))
        return
      }
      if (
        slot.selectedIds.includes(CUSTOM_SENTINEL_ID) &&
        slot.customText.trim().length === 0
      ) {
        setError(t("askUserCustomRequired"))
        return
      }
    }
    const answers: AskAnswer[] = questions.map((q, i) => {
      const slot = slots[i]
      const picked = slot.selectedIds.includes(CUSTOM_SENTINEL_ID)
      // Strip the sentinel before it leaves the UI — the LLM only sees
      // real option ids in selected_ids, and the typed text in custom_text.
      const selected = slot.selectedIds.filter(
        (id) => id !== CUSTOM_SENTINEL_ID,
      )
      return {
        question_id: q.id,
        selected_ids: selected,
        custom_text: picked ? slot.customText.trim() : null,
      }
    })
    onSubmit(answers)
  }

  /** The letter badge IS the selection control: circular for single-select
   *  (radio-like), rounded-square for multi-select (checkbox-like). Solid
   *  primary fill when selected — it is the only selection indicator. The
   *  native input stays in the row visually hidden for keyboard + a11y. */
  const LetterBadge = ({
    letter,
    checked,
    multi,
  }: {
    letter: string
    checked: boolean
    multi: boolean
  }) => (
    <span
      aria-hidden
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center border font-mono text-[10px] leading-none transition-colors",
        multi ? "rounded-[3px]" : "rounded-full",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      {letter}
    </span>
  )

  return (
    <div className="animate-rise-in bg-background px-4 pb-2 pt-1">
      <div className="mx-auto max-w-3xl">
        {/* Wrap the card in a flex column with a viewport-relative max height
         * so a long list of questions/options scrolls inside the card instead
         * of pushing the chat composer off-screen. Header + footer stay
         * pinned (shrink-0) so the title and Submit button are always visible
         * — otherwise users would have to scroll the bar itself to find
         * Submit, which defeats the whole point of a confirmation popup. */}
        <div className="flex max-h-[27vh] flex-col rounded-sm border border-border bg-card">
          <div className="shrink-0 px-3 pt-2.5">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-xs font-medium text-foreground">
                {t("askUserTitle")}
              </span>
              {questions.length > 1 && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {questions.length} {t("askUserQuestionsSuffix")}
                  </span>
                </>
              )}
              {secondsLeft != null && (
                <span
                  className="ml-auto flex shrink-0 items-center gap-1 rounded-[4px] border border-primary/30 bg-primary/10 px-1.5 py-px font-mono text-[10px] text-primary"
                  title={t("askUserAutoPickHint")}
                >
                  <Timer className="h-3 w-3" />
                  {t("askUserAutoPickIn").replace("{s}", String(secondsLeft))}
                </span>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
            <div className="mt-1.5 space-y-2 pl-5">
              {questions.map((q, qIdx) => {
                const slot = slots[qIdx]
                const namePrefix = `ask-user-${qIdx}`
                const customChecked = slot.selectedIds.includes(CUSTOM_SENTINEL_ID)
                return (
                  <div key={q.id} className="space-y-1">
                    <div className="text-xs font-medium text-foreground">
                      {questions.length > 1 ? (
                        <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                          Q{qIdx + 1}
                        </span>
                      ) : null}
                      {q.question}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {q.options.map((opt, optIdx) => {
                        const checked = slot.selectedIds.includes(opt.id)
                        const isRecommended = q.default_id === opt.id
                        return (
                          <label
                            key={opt.id}
                            className="flex cursor-pointer items-center gap-2 rounded-[4px] border border-transparent px-1.5 py-0.5 text-[11px] hover:border-border/60 hover:bg-muted/40"
                          >
                            <input
                              type={q.multi_select ? "checkbox" : "radio"}
                              name={namePrefix}
                              checked={checked}
                              onChange={() => togglePick(qIdx, q, opt.id)}
                              className="sr-only"
                            />
                            <LetterBadge
                              letter={letterOf(optIdx)}
                              checked={checked}
                              multi={q.multi_select}
                            />
                            <span className="text-foreground">{opt.label}</span>
                            {isRecommended && (
                              <span className="rounded-[4px] border border-primary/30 bg-primary/10 px-1 py-px font-mono text-[10px] uppercase tracking-wide text-primary">
                                {t("askUserHintRecommended")}
                              </span>
                            )}
                            {opt.hint && (
                              <span className="text-[11px] text-muted-foreground">
                                · {opt.hint}
                              </span>
                            )}
                          </label>
                        )
                      })}

                      {/* Always-available free-text row: badge + input, no
                       * label text (the placeholder says it all). The badge
                       * toggles selection; focusing/typing selects too. */}
                      <div className="flex items-center gap-2 rounded-[4px] border border-transparent px-1.5 py-0.5 text-[11px] hover:border-border/60 hover:bg-muted/40">
                        <button
                          type="button"
                          role={q.multi_select ? "checkbox" : "radio"}
                          aria-checked={customChecked}
                          aria-label={t("askUserCustomOption")}
                          onClick={() => togglePick(qIdx, q, CUSTOM_SENTINEL_ID)}
                          className="flex cursor-pointer items-center"
                        >
                          <LetterBadge
                            letter={letterOf(q.options.length)}
                            checked={customChecked}
                            multi={q.multi_select}
                          />
                        </button>
                        <input
                          type="text"
                          value={slot.customText}
                          placeholder={t("askUserCustomPlaceholder")}
                          onFocus={() => selectCustom(qIdx, q)}
                          onChange={(e) =>
                            selectCustom(qIdx, q, { customText: e.target.value })
                          }
                          className="min-w-0 flex-1 rounded-[4px] border border-border bg-background px-2 py-0.5 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="shrink-0 px-3 pb-2.5">
            {error && (
              <div className="pt-1.5 text-[11px] text-destructive">{error}</div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                {t("askUserCancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                className="h-7 px-3 text-xs"
              >
                {t("askUserSubmit")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
