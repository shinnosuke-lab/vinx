import { useState } from "react"
import { Globe, ExternalLink } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

const COLLAPSE_LINES = 30

/** Split the tool output into its `Key: value` header block and the body. The
 *  Rust side always emits `URL:` / `Status:` (+ optional `Title:` /
 *  `Content-Type:` / `Bytes:`) followed by a blank line, then the text. */
function splitResult(result: string): { meta: Record<string, string>; body: string } {
  const idx = result.indexOf("\n\n")
  const head = idx >= 0 ? result.slice(0, idx) : result
  const body = idx >= 0 ? result.slice(idx + 2) : ""
  const meta: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1].toLowerCase()] = m[2]
  }
  // Not the header shape (e.g. an error string): treat everything as body.
  if (!meta.url && !meta.status) return { meta: {}, body: result }
  return { meta, body }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function WebFetchTool({ args, result, isRunning }: ToolDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const parsed = tryParseJson(args)
  const requestedUrl = String(parsed?.url ?? "")

  const hasResult = !!result
  const { meta, body } = hasResult ? splitResult(result) : { meta: {}, body: "" }
  const finalUrl = meta.url || requestedUrl
  const status = meta.status
  const ok = status ? /^2\d\d/.test(status) : undefined
  const title = meta.title
  const contentType = meta["content-type"]?.split(";")[0]
  const bytes = meta.bytes ? Number(meta.bytes) : undefined

  const lines = body ? body.split("\n") : []
  const isLarge = lines.length > COLLAPSE_LINES
  const shown = expanded || !isLarge ? lines : lines.slice(0, COLLAPSE_LINES)

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* URL badge + metadata chips */}
      {finalUrl && (
        <div className="flex flex-wrap items-center gap-1.5">
          <a
            href={finalUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={finalUrl}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80 hover:bg-muted/70 hover:text-foreground"
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-sky-500" />
            <span className="truncate">{hostOf(finalUrl)}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
          </a>
          {status && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400",
              )}
            >
              {status}
            </span>
          )}
          {contentType && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
              {contentType}
            </span>
          )}
          {bytes != null && Number.isFinite(bytes) && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground/60">
              {bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes >= 10240 ? 0 : 1)} KB` : `${bytes} B`}
            </span>
          )}
        </div>
      )}
      {title && (
        <div className="truncate text-[11px] text-muted-foreground" title={title}>
          {title}
        </div>
      )}

      {/* Extracted text */}
      {hasResult && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {lines.length} {lines.length !== 1 ? t("linePlural") : t("lineSingular")}
            </span>
            <CopyButton text={body || result} />
          </div>
          <div
            className={cn(
              "overflow-hidden rounded-md border bg-muted/20 hover:overflow-auto",
              !expanded && isLarge && "max-h-96",
            )}
          >
            <pre className="whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
              {shown.join("\n") || " "}
            </pre>
          </div>
          {isLarge && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {expanded ? t("showLess") : tf("showAllLines", lines.length)}
            </button>
          )}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}
