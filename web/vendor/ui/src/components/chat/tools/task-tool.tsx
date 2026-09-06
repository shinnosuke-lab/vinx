import { useEffect, useRef, useState, type RefObject } from "react"
import {
  Check,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  Gauge,
  Loader2,
  Printer,
  Sparkles,
  TriangleAlert,
  XCircle,
} from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { formatBudget } from "@agentchat/lib/duration"
import {
  deriveMessageTitle,
  printSoloElementToPdf,
  saveMarkdownFile,
} from "@agentchat/lib/export"
import { useChatRuntime } from "@agentchat/lib/chat-runtime"
import { Markdown } from "../markdown"
import { CopyButton, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

/** Structured report a `task` tool result carries (see `TaskReport` in
 *  agent_task.rs). Absent fields are tolerated: partial/older payloads
 *  degrade to the raw-text fallback. */
interface TaskReport {
  ok: boolean
  result: string
  error?: string
  transcript_session_id?: string
  elapsed_ms?: number
  timed_out?: boolean
  cancelled?: boolean
}

function parseReport(result?: string): TaskReport | null {
  const parsed = tryParseJson(result)
  if (!parsed || typeof parsed.ok !== "boolean") return null
  return {
    ok: parsed.ok,
    result: typeof parsed.result === "string" ? parsed.result : "",
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    transcript_session_id:
      typeof parsed.transcript_session_id === "string"
        ? parsed.transcript_session_id
        : undefined,
    elapsed_ms: typeof parsed.elapsed_ms === "number" ? parsed.elapsed_ms : undefined,
    timed_out: parsed.timed_out === true,
    cancelled: parsed.cancelled === true,
  }
}

function statusOf(report: TaskReport): { label: string; ok: boolean } {
  if (report.timed_out) return { label: t("taskStatusTimeout"), ok: false }
  if (report.cancelled) return { label: t("taskStatusCancelled"), ok: false }
  if (report.ok) return { label: t("taskStatusDone"), ok: true }
  return { label: t("taskStatusFailed"), ok: false }
}

/** Final elapsed: sub-second precision under a minute, m:ss beyond. */
function formatMs(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}

/** Live elapsed: whole seconds (ticks once per second, no jitter). */
function formatLiveMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** Markdown-download + print-to-PDF icon pair for one task block (prompt or
 *  result), visually matching the sibling `CopyButton`. The PDF export prints
 *  the block's rendered element in isolation (solo print rules hide the rest
 *  of the transcript); the MD export saves the raw text. */
function ExportButtons({
  text,
  elRef,
  title,
}: {
  text: string
  elRef: RefObject<HTMLElement | null>
  title: string
}) {
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation()
          saveMarkdownFile(text, title)
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        title={t("saveAsMarkdown")}
      >
        <Download className="h-3 w-3" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (elRef.current) printSoloElementToPdf(elRef.current, title)
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        title={t("saveAsPdf")}
      >
        <Printer className="h-3 w-3" />
      </button>
    </>
  )
}

/** Dedicated renderer for the `task` sub-agent tool. Header status row
 *  (state + elapsed + child settings), live activity while running (fed by
 *  the chat runtime keyed on `callId`; cancelling is the sub-task strip's job
 *  above the composer — the card itself carries no controls), the prompt
 *  collapsed behind a one-line entry, and the result report unpacked
 *  (markdown answer, error banner, deep link to the child transcript). */
export function TaskTool({ args, result, isRunning, callId }: ToolDisplayProps) {
  const [promptExpanded, setPromptExpanded] = useState(false)
  const runtime = useChatRuntime()

  const parsedArgs = tryParseJson(args)
  const prompt = typeof parsedArgs?.prompt === "string" ? parsedArgs.prompt.trim() : ""
  const description =
    typeof parsedArgs?.description === "string" ? parsedArgs.description.trim() : ""
  const skill = typeof parsedArgs?.skill === "string" ? parsedArgs.skill : ""
  const model = typeof parsedArgs?.model === "string" ? parsedArgs.model : ""
  const effort =
    typeof parsedArgs?.reasoning_effort === "string" ? parsedArgs.reasoning_effort : ""
  const timeoutSecs =
    typeof parsedArgs?.timeout_secs === "number" ? parsedArgs.timeout_secs : null

  const report = parseReport(result)
  const status = report ? statusOf(report) : null
  const running = isRunning && !result
  const live = running && callId ? runtime?.subagents?.[callId] : undefined
  const cancelling = live?.cancelling ?? false

  // 1s tick while running so the header's elapsed readout advances (the
  // start time itself never changes, so nothing else re-renders us).
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || live?.startedAt === undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running, live?.startedAt])

  const elapsed =
    report?.elapsed_ms !== undefined
      ? formatMs(report.elapsed_ms)
      : live?.startedAt !== undefined
        ? formatLiveMs(Date.now() - live.startedAt)
        : null
  // Past the wall-clock budget while still running: normal for a short
  // stretch (the child gets a wind-down grace), but worth flagging.
  const overBudget =
    running &&
    timeoutSecs !== null &&
    live?.startedAt !== undefined &&
    Date.now() - live.startedAt > timeoutSecs * 1000

  // Finished: the report names the persisted transcript. Running: the live
  // `subagent` frames carry the child session id, so the link works while the
  // child is still going (the sub-session view follows it in real time).
  const transcriptSessionId = report?.transcript_session_id ?? live?.sessionId
  const transcriptHref =
    transcriptSessionId && runtime?.sessionHref
      ? runtime.sessionHref(transcriptSessionId)
      : null

  // Export targets: the prompt's <pre> and the result's rendered markdown.
  // File names lead with the task's human label so a batch of exports from
  // sibling tasks stays tellable apart.
  const promptRef = useRef<HTMLPreElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const exportTitle = deriveMessageTitle(description || prompt)

  const badge = (icon: React.ReactNode, text: string, key: string, title?: string) => (
    <span
      key={key}
      title={title}
      className="inline-flex items-center gap-1 rounded-[3px] bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
    >
      {icon}
      {text}
    </span>
  )

  return (
    <div className="mt-1 space-y-2.5 pb-1">
      {/* Status row: state + elapsed + child settings. */}
      <div className="flex flex-wrap items-center gap-1">
        {running ? (
          <span className="inline-flex items-center gap-1 rounded-[3px] bg-primary/10 px-1.5 py-px text-[10px] text-primary">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {cancelling ? t("subagentCancelling") : t("taskStatusRunning")}
          </span>
        ) : (
          status && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-[3px] px-1.5 py-px text-[10px]",
                status.ok
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              {status.ok ? (
                <Check className="h-2.5 w-2.5" />
              ) : (
                <XCircle className="h-2.5 w-2.5" />
              )}
              {status.label}
            </span>
          )
        )}
        {elapsed && (
          <span
            key="elapsed"
            title={overBudget ? t("taskOverBudget") : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded-[3px] px-1.5 py-px text-[10px]",
              overBudget ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
            )}
          >
            <Clock className="h-2.5 w-2.5" />
            {elapsed}
          </span>
        )}
        {skill && badge(<Sparkles className="h-2.5 w-2.5" />, skill, "skill")}
        {model && badge(null, model, "model")}
        {effort && badge(<Gauge className="h-2.5 w-2.5" />, effort, "effort")}
        {timeoutSecs !== null &&
          badge(
            null,
            tf("taskTimeoutBadge", formatBudget(timeoutSecs)),
            "timeout",
            // While running, hovering the budget answers the question the
            // elapsed readout next to it raises: how much is left.
            running && live?.startedAt !== undefined && !overBudget
              ? tf(
                  "taskTimeLeft",
                  formatLiveMs(timeoutSecs * 1000 - (Date.now() - live.startedAt)),
                )
              : undefined,
          )}
      </div>

      {/* Live activity: what the child is executing right now. */}
      {running && live?.note && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
          <span className="min-w-0 truncate">{live.note}</span>
        </div>
      )}

      {/* Prompt, collapsed behind a one-line entry by default. */}
      {prompt && (
        <div className="group/block">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPromptExpanded((e) => !e)}
              className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 transition-colors hover:text-muted-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-2.5 w-2.5 transition-transform duration-150",
                  promptExpanded && "rotate-90",
                )}
              />
              {t("taskPromptLabel")}
              <span className="font-normal normal-case tracking-normal text-muted-foreground/40">
                {tf("taskPromptChars", prompt.length.toLocaleString())}
              </span>
            </button>
            {promptExpanded && (
              <div className="flex items-center gap-0.5">
                <CopyButton text={prompt} />
                <ExportButtons
                  text={prompt}
                  elRef={promptRef}
                  title={`${exportTitle} · ${t("taskPromptLabel")}`}
                />
              </div>
            )}
          </div>
          {promptExpanded && (
            <pre
              ref={promptRef}
              className="mt-1 overflow-hidden whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground hover:overflow-auto"
            >
              {prompt}
            </pre>
          )}
        </div>
      )}

      {report?.error && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap">{report.error}</span>
        </div>
      )}

      {report && report.result && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("taskResultLabel")}
            </span>
            <div className="flex items-center gap-0.5">
              <CopyButton text={report.result} />
              <ExportButtons
                text={report.result}
                elRef={resultRef}
                title={`${exportTitle} · ${t("taskResultLabel")}`}
              />
            </div>
          </div>
          <div ref={resultRef} className="rounded-md bg-muted/30 px-3 py-2">
            <Markdown content={report.result} className="text-xs" />
          </div>
        </div>
      )}

      {/* Unstructured result (older kernel / crashed driver): raw fallback. */}
      {!report && result && (
        <pre className="overflow-hidden whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground hover:overflow-auto">
          {result}
        </pre>
      )}

      {/* Full child transcript lives in a hidden session; opens in a new tab
          (hash deep link) so the parent conversation stays put. */}
      {transcriptHref && (
        <a
          href={transcriptHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          {t("taskViewTranscript")}
        </a>
      )}
    </div>
  )
}
