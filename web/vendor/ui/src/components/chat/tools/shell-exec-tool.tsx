import { useState } from "react"
import { Terminal } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { formatBudget } from "@agentchat/lib/duration"
import { CopyButton, RunningIndicator, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

const OUTPUT_COLLAPSE_LINES = 30

// Split the formatter output produced by `format_exec_outcome` in
// src/llm/tools/executor.rs into a header (one of `[timeout]` /
// `[exit_code=N]`), a stdout body, and an optional stderr block.
// Falls back to "all stdout" for legacy / non-marked output.
function splitExecOutput(out: string): {
  header: string | null
  stdout: string
  stderr: string | null
} {
  if (!out) return { header: null, stdout: "", stderr: null }

  let rest = out
  let header: string | null = null
  const firstLine = rest.split("\n", 1)[0] ?? ""
  if (firstLine === "[timeout]" || /^\[exit_code=-?\d+\]$/.test(firstLine)) {
    header = firstLine
    rest = rest.slice(firstLine.length + 1) // +1 for \n
  }

  // [stderr] section is everything after a literal "\n[stderr]\n" — the
  // body before that is stdout (which may itself be empty after the
  // header was stripped).
  const sep = "\n[stderr]\n"
  let stdout = rest
  let stderr: string | null = null
  const sepIdx = rest.indexOf(sep)
  if (sepIdx >= 0) {
    stdout = rest.slice(0, sepIdx)
    stderr = rest.slice(sepIdx + sep.length)
  } else if (rest.startsWith("[stderr]\n")) {
    // No stdout, only stderr (e.g. [exit_code=1]\n[stderr]\n...)
    stdout = ""
    stderr = rest.slice("[stderr]\n".length)
  }

  return { header, stdout, stderr }
}

export function ShellExecTool({ name, args, result, isRunning }: ToolDisplayProps) {
  const [outputExpanded, setOutputExpanded] = useState(false)
  const parsed = tryParseJson(args)

  const command = parsed?.command ?? parsed?.cmd ?? args ?? ""
  const host = parsed?.host as string | undefined
  // Budget in human units ("1 h", not "3600s"); a non-numeric value (a host
  // tool's own convention) is shown as given.
  const timeoutRaw = parsed?.timeout_secs ?? parsed?.timeout
  const timeout =
    timeoutRaw == null
      ? null
      : Number.isFinite(Number(timeoutRaw))
        ? formatBudget(Number(timeoutRaw))
        : String(timeoutRaw)
  const cmdStr = String(command)

  const hasResult = !!result
  const { header, stdout, stderr } = hasResult
    ? splitExecOutput(result)
    : { header: null, stdout: "", stderr: null }
  const lines = stdout ? stdout.split("\n") : []
  const isLarge = lines.length > OUTPUT_COLLAPSE_LINES
  const visibleLines = outputExpanded || !isLarge ? lines : lines.slice(0, OUTPUT_COLLAPSE_LINES)

  const promptPrefix = name === "ssh_exec" ? "#" : "$"
  const headerTone =
    header === "[timeout]"
      ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
      : header
        ? "bg-rose-500/15 text-rose-300 ring-rose-500/30"
        : ""

  return (
    <div className="mt-1 space-y-2.5 pb-1">
      {/* Command display */}
      <div className="overflow-hidden rounded-md bg-zinc-900 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-700/50 px-2.5 py-1">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <Terminal className="h-3 w-3" />
            <span>
              {name === "ssh_exec" ? t("ssh") : name.endsWith("_run") ? t("run") : t("shell")}
            </span>
            {host && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-500">
                {host}
              </span>
            )}
            {timeout !== null && (
              <span className="text-zinc-600">{tf("timeoutLabel", timeout)}</span>
            )}
          </div>
          <CopyButton text={cmdStr} dark />
        </div>
        <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-emerald-400">
          <span className="select-none text-zinc-500">{promptPrefix} </span>
          {cmdStr}
        </pre>
      </div>

      {/* Output */}
      {hasResult && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("output")}
            </span>
            <CopyButton text={result} />
          </div>
          {header && (
            <div
              className={cn(
                "mb-1 inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ring-1",
                headerTone,
              )}
              title={header === "[timeout]" ? t("execTimeoutTip") : t("execNonzeroTip")}
            >
              {header}
            </div>
          )}
          <pre
            className={cn(
              "overflow-hidden whitespace-pre-wrap rounded-md bg-zinc-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300 hover:overflow-auto dark:bg-zinc-950",
              !outputExpanded && isLarge && "max-h-80",
            )}
          >
            {visibleLines.join("\n")}
            {!outputExpanded && isLarge && "\n…"}
          </pre>
          {isLarge && (
            <button
              onClick={() => setOutputExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {outputExpanded ? t("showLess") : tf("showAllLines", lines.length)}
            </button>
          )}
          {stderr && (
            <div className="mt-1.5">
              <div className="flex items-center justify-between pb-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-rose-300/70">
                  stderr
                </span>
                <CopyButton text={stderr} />
              </div>
              <pre className="overflow-hidden whitespace-pre-wrap rounded-md bg-rose-950/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-rose-200 ring-1 ring-rose-500/20 hover:overflow-auto">
                {stderr}
              </pre>
            </div>
          )}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}
