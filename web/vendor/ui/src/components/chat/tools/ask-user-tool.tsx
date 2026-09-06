import type { ReactNode } from "react"
import { Check, MessageSquareText, Ban, Timer, HelpCircle, Loader2 } from "lucide-react"
import { t } from "@agentchat/lib/i18n"
import { cn } from "@agentchat/lib/utils"
import { tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

/**
 * `ask_user` transcript card: the question(s) the agent asked and what the
 * user answered. The live interaction happens in the bottom popover
 * (`ask-user-bar`); this card is the permanent record that survives in the
 * transcript once the popover is gone.
 *
 * Arguments: `{ questions: [{ id, question, options: [{ id, label, hint? }],
 * default_id?, multi_select? }] }` — only what the record needs is read; the
 * default/multi-select mechanics belong to the popover.
 * Result (see `event::build_ask_user_payload`): `{ cancelled, auto_picked,
 * note?, answers: [{ question_id, question, selected_ids, selected_labels,
 * custom_text? }] }`. `note` rides along with `auto_picked` and is addressed
 * to the model (what a timed-out default means); the badge says it to the
 * user, so the sentence itself is not rendered.
 */

interface AskOption {
  id: string
  label: string
  hint?: string
}

interface AskQuestion {
  id: string
  question: string
  options: AskOption[]
}

interface AskAnswer {
  questionId?: string
  question: string
  selectedIds: string[]
  selectedLabels: string[]
  customText?: string
}

interface AskResult {
  cancelled: boolean
  autoPicked: boolean
  answers: AskAnswer[]
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function parseQuestions(args?: string): AskQuestion[] {
  const parsed = tryParseJson(args)
  const raw = parsed?.questions
  if (!Array.isArray(raw)) return []
  const out: AskQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== "object") continue
    const rec = q as Record<string, unknown>
    const options: AskOption[] = Array.isArray(rec.options)
      ? rec.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
          .map((o) => ({
            id: String(o.id ?? ""),
            label: String(o.label ?? o.id ?? ""),
            hint: typeof o.hint === "string" && o.hint ? o.hint : undefined,
          }))
      : []
    out.push({
      id: String(rec.id ?? ""),
      question: String(rec.question ?? ""),
      options,
    })
  }
  return out
}

/** Parse the structured result; `null` when it is not the expected payload
 *  (older transcripts, an error string) so the caller can fall back to text. */
export function parseAskUserResult(result?: string): AskResult | null {
  if (!result) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec.answers)) return null
  const answers: AskAnswer[] = rec.answers
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      questionId: typeof a.question_id === "string" ? a.question_id : undefined,
      question: String(a.question ?? ""),
      selectedIds: strList(a.selected_ids),
      selectedLabels: strList(a.selected_labels),
      customText:
        typeof a.custom_text === "string" && a.custom_text.trim()
          ? a.custom_text
          : undefined,
    }))
  return {
    cancelled: rec.cancelled === true,
    autoPicked: rec.auto_picked === true,
    answers,
  }
}

/** What the user picked, as one string: labels then the free text (the TUI
 *  preview joins them the same way). Empty when nothing was chosen. */
function answerDigest(a: AskAnswer): string {
  const labels = a.selectedLabels.length > 0 ? a.selectedLabels : a.selectedIds
  return [...labels, ...(a.customText ? [a.customText.trim()] : [])].join(", ")
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max) + "…" : one
}

/** One-line digest for the collapsed header: `question → answer`, plus a
 *  `+N` when several were asked. The question is clipped short once there is
 *  an answer so the answer is what survives the header's ellipsis. */
export function askUserSummary(args?: string, result?: string): string | null {
  const qs = parseQuestions(args)
  const parsed = parseAskUserResult(result)
  const first = qs[0]?.question ?? parsed?.answers[0]?.question ?? ""
  if (!first.trim()) return null
  const count = Math.max(qs.length, parsed?.answers.length ?? 0)
  let s: string
  if (parsed?.cancelled) {
    s = `${clip(first, 48)} · ${t("askUserCancelled")}`
  } else if (parsed && parsed.answers[0]) {
    const a = answerDigest(parsed.answers[0])
    s = a ? `${clip(first, 48)} → ${clip(a, 40)}` : clip(first, 60)
  } else {
    s = clip(first, 60)
  }
  return count > 1 ? `${s} (+${count - 1})` : s
}

function Badge({
  icon,
  children,
  tone = "muted",
}: {
  icon: ReactNode
  children: ReactNode
  tone?: "muted" | "warn"
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        tone === "warn"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "bg-muted/60 text-muted-foreground",
      )}
    >
      {icon}
      {children}
    </span>
  )
}

function QuestionRow({
  question,
  options,
  answer,
  showOptions,
}: {
  question: string
  options: AskOption[]
  answer?: AskAnswer
  /** Cancelled prompt: list the choices that were offered (nothing picked). */
  showOptions: boolean
}) {
  // Labels come from the payload (already resolved server-side); fall back
  // to the ids when a label is missing so nothing silently disappears.
  const labels =
    answer && answer.selectedLabels.length > 0
      ? answer.selectedLabels
      : (answer?.selectedIds ?? [])
  const unanswered = !!answer && labels.length === 0 && !answer.customText

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1.5 text-[12px] text-foreground/90">
        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 wrap-anywhere">{question}</span>
      </div>

      {showOptions && options.length > 0 && (
        <ul className="ml-5 flex flex-wrap gap-1">
          {options.map((o) => (
            <li
              key={o.id}
              title={o.hint}
              className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}

      {answer && (
        <div className="ml-5 flex flex-wrap items-center gap-1">
          {labels.map((label, i) => (
            <span
              key={`${label}-${i}`}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary wrap-anywhere"
            >
              <Check className="h-3 w-3 shrink-0" />
              {label}
            </span>
          ))}
          {answer.customText && (
            <span className="inline-flex max-w-full items-start gap-1 rounded-md bg-muted/50 px-2 py-0.5 text-[11px] text-foreground/90 wrap-anywhere">
              <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="whitespace-pre-wrap">{answer.customText}</span>
            </span>
          )}
          {unanswered && (
            <span className="text-[11px] italic text-muted-foreground/70">
              {t("askUserNoAnswer")}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function AskUserTool({ args, result, isRunning }: ToolDisplayProps) {
  const questions = parseQuestions(args)
  const parsed = parseAskUserResult(result)

  // Join answers to questions by id (fall back to position for payloads
  // that predate `question_id`).
  const answerFor = (q: AskQuestion, idx: number): AskAnswer | undefined => {
    if (!parsed) return undefined
    return (
      parsed.answers.find((a) => a.questionId && a.questionId === q.id) ??
      parsed.answers[idx]
    )
  }

  const pending = !result
  const cancelled = !!parsed && parsed.cancelled

  return (
    <div className="mt-1 space-y-2 pb-1">
      {parsed && (parsed.cancelled || parsed.autoPicked) && (
        <div className="flex flex-wrap items-center gap-1">
          {parsed.cancelled && (
            <Badge tone="warn" icon={<Ban className="h-3 w-3" />}>
              {t("askUserCancelled")}
            </Badge>
          )}
          {parsed.autoPicked && !parsed.cancelled && (
            <Badge icon={<Timer className="h-3 w-3" />}>{t("askUserAutoPicked")}</Badge>
          )}
        </div>
      )}

      {questions.length > 0 ? (
        <div className="space-y-2">
          {questions.map((q, i) => (
            <QuestionRow
              key={q.id || i}
              question={q.question}
              options={q.options}
              answer={parsed && !cancelled ? answerFor(q, i) : undefined}
              showOptions={cancelled}
            />
          ))}
        </div>
      ) : parsed ? (
        // Arguments missing/unparseable (trimmed history): the payload still
        // carries each question's text, so render from the answers alone.
        <div className="space-y-2">
          {parsed.answers.map((a, i) => (
            <QuestionRow
              key={a.questionId || i}
              question={a.question}
              options={[]}
              answer={cancelled ? undefined : a}
              showOptions={false}
            />
          ))}
        </div>
      ) : null}

      {result && !parsed && (
        <pre className="overflow-x-auto rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground">
          {result}
        </pre>
      )}

      {pending && isRunning && (
        <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground/60">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("askUserWaiting")}
        </div>
      )}
    </div>
  )
}
