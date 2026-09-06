import { useMemo, useRef, useState } from "react"
import { GitCompare } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import {
  CopyButton,
  RunningIndicator,
  tryParseJson,
  getFileExtension,
  useStickyScrollToBottom,
} from "./shared"
import type { ToolDisplayProps } from "./index"

const COLLAPSE_LINES = 50

function splitLines(text: string): string[] {
  if (!text) return []
  // Strip a single trailing newline so a payload like "a\n" renders as
  // one row, not two — matches what the user typed in old_str/new_str.
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text
  return trimmed.split("\n")
}

export function EditFileTool({ args, result, isRunning }: ToolDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  // `tryParseJson` already returns repaired partial JSON during streaming,
  // so the diff card lights up with the path + accreting new_str bytes as
  // soon as those fields arrive.
  const parsed = tryParseJson(args)

  const path = String(parsed?.path ?? "")
  const oldStr = String(parsed?.old_str ?? "")
  const newStr = String(parsed?.new_str ?? "")
  const replaceAll = parsed?.replace_all === true
  const ext = getFileExtension(path)

  const oldLines = useMemo(() => splitLines(oldStr), [oldStr])
  const newLines = useMemo(() => splitLines(newStr), [newStr])
  const total = oldLines.length + newLines.length
  const isLong = total > COLLAPSE_LINES
  const half = Math.max(1, Math.floor(COLLAPSE_LINES / 2))
  const visibleOld = expanded || !isLong ? oldLines : oldLines.slice(0, half)
  const visibleNew = expanded || !isLong ? newLines : newLines.slice(0, half)

  const hasResult = !!result
  const isStreaming = isRunning && !hasResult
  const isError = hasResult && (result || "").startsWith("Error:")

  const removes = oldLines.length
  const adds = newLines.length

  const preRef = useRef<HTMLPreElement>(null)
  useStickyScrollToBottom(preRef, oldStr.length + newStr.length, isStreaming)

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* File path + badges */}
      {path && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80 wrap-anywhere">
            <GitCompare className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            {path}
          </span>
          {(adds > 0 || removes > 0) && (
            <>
              <span className="rounded bg-[#dafbe1] px-1.5 py-0.5 text-[10px] font-medium text-[#1a7f37] dark:bg-[#2ea04326] dark:text-[#3fb950]">
                +{adds}
              </span>
              <span className="rounded bg-[#ffebe9] px-1.5 py-0.5 text-[10px] font-medium text-[#d1242f] dark:bg-[#f8514926] dark:text-[#f85149]">
                −{removes}
              </span>
            </>
          )}
          {replaceAll && (
            <span
              className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-400"
              title={t("editReplaceAllHint")}
            >
              {t("editReplaceAll")}
            </span>
          )}
          {ext && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground/60">
              {ext}
            </span>
          )}
        </div>
      )}

      {/* Diff preview */}
      {(oldStr || newStr) && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {total} {total !== 1 ? t("linePlural") : t("lineSingular")}
            </span>
            <CopyButton text={`-${oldStr}\n+${newStr}`} />
          </div>
          <pre
            ref={preRef}
            className={cn(
              "rounded-md border bg-muted/20 font-mono text-[11px] leading-relaxed",
              isStreaming
                ? "max-h-64 overflow-y-auto"
                : !expanded && isLong
                  ? "max-h-64 overflow-hidden hover:overflow-auto"
                  : "overflow-hidden hover:overflow-auto",
            )}
          >
            {visibleOld.map((line, i) => (
              <div
                key={`o-${i}`}
                className="whitespace-pre-wrap bg-[#ffebe9] px-2.5 py-0.5 text-[#1f2328] dark:bg-[#f8514926] dark:text-foreground"
              >
                {`-${line || " "}`}
              </div>
            ))}
            {visibleNew.map((line, i) => (
              <div
                key={`n-${i}`}
                className="whitespace-pre-wrap bg-[#e6ffec] px-2.5 py-0.5 text-[#1f2328] dark:bg-[#2ea04326] dark:text-foreground"
              >
                {`+${line || " "}`}
              </div>
            ))}
            {!expanded && isLong && !isStreaming && (
              <div className="px-2.5 py-0.5 text-muted-foreground/50">…</div>
            )}
          </pre>
          {isLong && !isStreaming && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {expanded ? t("showLess") : tf("showAllLines", total)}
            </button>
          )}
        </div>
      )}

      {/* Result / error line */}
      {hasResult && (
        <div
          className={cn(
            "rounded-md px-2.5 py-1.5 text-[11px]",
            isError
              ? "bg-rose-500/10 text-rose-300"
              : "bg-muted/20 text-muted-foreground",
          )}
        >
          {result}
        </div>
      )}

      {isStreaming && !oldStr && !newStr && <RunningIndicator />}
    </div>
  )
}
