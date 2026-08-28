import { useRef, useState } from "react"
import { Download, FilePenLine, FilePlus2 } from "lucide-react"
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

const COLLAPSE_LINES = 25

export function FileWriteTool({ args, result, isRunning }: ToolDisplayProps) {
  const [contentExpanded, setContentExpanded] = useState(false)
  // `tryParseJson` already falls back to `repairPartialJson` so streaming
  // args (mid-`tool_args_delta`) come back with `path` set and `content`
  // holding the bytes seen so far — no separate partial helper needed.
  const parsed = tryParseJson(args)

  const path = String(parsed?.path ?? "")
  const content = String(parsed?.content ?? "")
  const mode = String(parsed?.mode ?? "overwrite")
  const ext = getFileExtension(path)
  const isAppend = mode === "append"

  const hasResult = !!result
  const isStreaming = isRunning && !hasResult

  // Legacy sessions: older kernels appended a `Download: <url>` line to
  // runtime-cache writes (delivery is now the publish tool's job). Keep the
  // parse so persisted history still renders its download button.
  const downloadMatch = result?.match(/^Download: (\/api\/runtime\/file\/\S+)\s*$/m)
  const downloadUrl = downloadMatch?.[1]
  const resultText = downloadMatch
    ? result!.replace(downloadMatch[0], "").trimEnd()
    : result

  const contentLines = content.split("\n")
  const isLargeContent = contentLines.length > COLLAPSE_LINES
  // While streaming, show the tail (last COLLAPSE_LINES) so the user sees
  // the latest bytes accreting; switch back to head-preview + "show all"
  // toggle once the stream finishes.
  const displayLines =
    contentExpanded || !isLargeContent
      ? contentLines
      : isStreaming
        ? contentLines.slice(-COLLAPSE_LINES)
        : contentLines.slice(0, COLLAPSE_LINES)

  const preRef = useRef<HTMLPreElement>(null)
  useStickyScrollToBottom(preRef, content.length, isStreaming)

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* File path + mode */}
      {path && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
            {isAppend
              ? <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-blue-400" />
              : <FilePenLine className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            }
            {path}
          </span>
          <span className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            isAppend
              ? "bg-blue-500/10 text-blue-400"
              : "bg-amber-500/10 text-amber-400",
          )}>
            {isAppend ? t("append") : t("overwrite")}
          </span>
          {ext && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground/60">
              {ext}
            </span>
          )}
        </div>
      )}

      {/* Content preview */}
      {content && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {contentLines.length} {contentLines.length !== 1 ? t("linePlural") : t("lineSingular")}
              {" · "}
              {content.length.toLocaleString()} {t("chars")}
            </span>
            <CopyButton text={content} />
          </div>
          <pre
            ref={preRef}
            className={cn(
              "whitespace-pre-wrap rounded-md border bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80",
              // While streaming, keep the box scrollable so the sticky
              // autoscroll hook can advance `scrollTop`. Post-stream the
              // collapsed card stays clipped and only reveals on hover so
              // the chat surface stays calm.
              isStreaming
                ? "max-h-64 overflow-y-auto"
                : !contentExpanded && isLargeContent
                  ? "max-h-64 overflow-hidden hover:overflow-auto"
                  : "overflow-hidden hover:overflow-auto",
            )}
          >
            {displayLines.join("\n")}
            {!contentExpanded && isLargeContent && !isStreaming && "\n…"}
          </pre>
          {isLargeContent && !isStreaming && (
            <button
              onClick={() => setContentExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {contentExpanded ? t("showLess") : tf("showAllLines", contentLines.length)}
            </button>
          )}
        </div>
      )}

      {/* Result status */}
      {hasResult && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 break-all">{resultText}</span>
          {downloadUrl && (
            <a
              href={downloadUrl}
              download
              className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary no-underline transition-colors hover:bg-primary/20"
            >
              <Download className="h-3 w-3" />
              {t("download")}
            </a>
          )}
        </div>
      )}

      {isStreaming && !content && <RunningIndicator />}
    </div>
  )
}
