import { useState } from "react"
import { FileText, FileCode, FileJson, File, ScrollText } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryParseJson, getFileExtension } from "./shared"
import type { ToolDisplayProps } from "./index"

const CODE_EXTENSIONS = new Set([
  "js", "ts", "jsx", "tsx", "py", "rs", "go", "c", "cpp", "h", "java",
  "rb", "php", "swift", "kt", "scala", "lua", "sh", "bash", "zsh",
  "css", "scss", "less", "html", "vue", "svelte",
])
const CONFIG_EXTENSIONS = new Set([
  "json", "yaml", "yml", "toml", "ini", "xml", "conf", "cfg", "env",
  "properties", "plist",
])
const LOG_EXTENSIONS = new Set(["log", "out", "err"])

const COLLAPSE_LINES = 40

function FileIcon({ ext }: { ext: string }) {
  const cls = "h-3.5 w-3.5 shrink-0"
  if (ext === "json") return <FileJson className={cn(cls, "text-yellow-500")} />
  if (CODE_EXTENSIONS.has(ext)) return <FileCode className={cn(cls, "text-blue-400")} />
  if (CONFIG_EXTENSIONS.has(ext)) return <FileText className={cn(cls, "text-orange-400")} />
  if (LOG_EXTENSIONS.has(ext)) return <ScrollText className={cn(cls, "text-zinc-400")} />
  return <File className={cn(cls, "text-muted-foreground")} />
}

export function FileReadTool({ args, result, isRunning }: ToolDisplayProps) {
  const [outputExpanded, setOutputExpanded] = useState(false)
  const parsed = tryParseJson(args)

  const path = String(parsed?.path ?? "")
  const startLine = parsed?.start_line as number | undefined
  const endLine = parsed?.end_line as number | undefined
  const ext = getFileExtension(path)

  const hasResult = !!result
  const lines = hasResult ? result.split("\n") : []
  const isLarge = lines.length > COLLAPSE_LINES
  const displayLines = outputExpanded || !isLarge ? lines : lines.slice(0, COLLAPSE_LINES)
  const lineNumStart = startLine ?? 1
  const lineNumWidth = String(lineNumStart + displayLines.length - 1).length

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* File path badge */}
      {path && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80 wrap-anywhere">
            <FileIcon ext={ext} />
            {path}
          </span>
          {(startLine != null || endLine != null) && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t("lines")} {startLine ?? "1"}–{endLine ?? t("eof")}
            </span>
          )}
          {ext && (
            <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground/60">
              {ext}
            </span>
          )}
        </div>
      )}

      {/* File content with line numbers */}
      {hasResult && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {lines.length} {lines.length !== 1 ? t("linePlural") : t("lineSingular")}
            </span>
            <CopyButton text={result} />
          </div>
          <div
            className={cn(
              "overflow-hidden rounded-md border bg-muted/20 hover:overflow-auto",
              !outputExpanded && isLarge && "max-h-96",
            )}
          >
            <table className="w-full border-collapse">
              <tbody>
                {displayLines.map((line, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    <td className="select-none border-r border-border/30 px-2 py-0 text-right align-top font-mono text-[10px] leading-relaxed text-muted-foreground/40"
                      style={{ width: `${lineNumWidth + 2}ch` }}
                    >
                      {lineNumStart + i}
                    </td>
                    <td className="px-2.5 py-0 align-top">
                      <pre className="font-mono text-[11px] leading-relaxed text-foreground/80">
                        {line || " "}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isLarge && (
            <button
              onClick={() => setOutputExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {outputExpanded ? t("showLess") : tf("showAllLines", lines.length)}
            </button>
          )}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}
