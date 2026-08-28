import { useState } from "react"
import { Folder, File, FolderOpen } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

interface DirEntry {
  type: "dir" | "file"
  name: string
  size?: string
  mtime?: string
}

function parseEntries(output: string): { header: string; entries: DirEntry[]; footer: string } {
  const lines = output.split("\n")
  let header = ""
  let footer = ""
  const entries: DirEntry[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("[Directory:") || trimmed.startsWith("[directory:")) {
      header = trimmed
      continue
    }

    if (trimmed.startsWith("...") && trimmed.includes("more entries")) {
      footer = trimmed
      continue
    }

    if (trimmed.startsWith("[DIR]")) {
      const name = trimmed.slice(5).trim().replace(/\/$/, "")
      entries.push({ type: "dir", name })
    } else if (trimmed.startsWith("[FILE]")) {
      const rest = trimmed.slice(6).trim()
      const parenMatch = rest.match(/^(.+?)\s+\((.+?),\s*(.+?)\)\s*$/)
      if (parenMatch) {
        entries.push({
          type: "file",
          name: parenMatch[1].trim(),
          size: parenMatch[2].trim(),
          mtime: parenMatch[3].trim(),
        })
      } else {
        entries.push({ type: "file", name: rest })
      }
    } else {
      entries.push({ type: "file", name: trimmed })
    }
  }

  return { header, entries, footer }
}

const COLLAPSE_COUNT = 40

export function DirListTool({ args, result, isRunning }: ToolDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const parsed = tryParseJson(args)

  const path = String(parsed?.path ?? "/")
  const recursive = parsed?.recursive as boolean | undefined
  const pattern = parsed?.pattern as string | undefined

  const hasResult = !!result
  const { header, entries, footer } = hasResult ? parseEntries(result) : { header: "", entries: [], footer: "" }
  const isLarge = entries.length > COLLAPSE_COUNT
  const visible = expanded || !isLarge ? entries : entries.slice(0, COLLAPSE_COUNT)

  const dirs = entries.filter((e) => e.type === "dir")
  const files = entries.filter((e) => e.type === "file")

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* Path breadcrumb */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          {path}
        </span>
        {recursive && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t("recursive")}
          </span>
        )}
        {pattern && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {pattern}
          </span>
        )}
        {hasResult && (
          <span className="text-[10px] text-muted-foreground/50">
            {tf("dirFileSummary", dirs.length, files.length)}
          </span>
        )}
      </div>

      {/* File listing */}
      {hasResult && entries.length > 0 && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            {header && (
              <span className="text-[10px] text-muted-foreground/40">{header}</span>
            )}
            <CopyButton text={result} />
          </div>
          <div
            className={cn(
              "overflow-hidden rounded-md border bg-muted/20",
              !expanded && isLarge && "max-h-96",
            )}
          >
            <div className="divide-y divide-border/20">
              {visible.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2.5 py-1 text-[11px] hover:bg-muted/30"
                >
                  {entry.type === "dir" ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  ) : (
                    <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  )}
                  <span className={cn(
                    "min-w-0 flex-1 truncate font-mono",
                    entry.type === "dir" ? "font-medium text-foreground/90" : "text-foreground/70",
                  )}>
                    {entry.name}{entry.type === "dir" ? "/" : ""}
                  </span>
                  {entry.size && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/50">
                      {entry.size}
                    </span>
                  )}
                  {entry.mtime && (
                    <span className="hidden shrink-0 text-[10px] text-muted-foreground/40 sm:inline">
                      {entry.mtime}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          {footer && (
            <div className="mt-0.5 text-[10px] text-muted-foreground/40">{footer}</div>
          )}
          {isLarge && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {expanded ? t("showLess") : tf("showAllEntries", entries.length)}
            </button>
          )}
        </div>
      )}

      {hasResult && entries.length === 0 && (
        <div className="rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {result}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}
