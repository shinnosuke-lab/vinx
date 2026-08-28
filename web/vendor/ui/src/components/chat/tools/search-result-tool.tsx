import { useState, useMemo } from "react"
import { Search, FileText } from "lucide-react"
import { t, tf } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

type RowKind = "match" | "context"

interface Row {
  line: number
  text: string
  kind: RowKind
  /** True when this row immediately follows a `--` separator in the same file
   * (used by the renderer to draw a dashed horizontal divider above it). */
  breakBefore?: boolean
}

interface FileGroup {
  file: string
  rows: Row[]
}

/**
 * Parse a single output line into a structured record.
 *
 * Protocol (matches src/llm/tools/executor.rs):
 *   - `--`                  range separator within the same file
 *   - `path:line:text`      match line
 *   - `path-line-text`      context line
 *   - `...`-prefixed lines  footer notices
 *   - other                 plain (e.g. "No matches found...")
 *
 * The greedy `^(.+)([:\-])(\d+)\2(.*)$` anchors from the right, so it
 * correctly handles Windows drive letters (`C:\foo\bar.rs:42:text`) and
 * paths that contain `-` (`src/foo-bar/baz.rs-41-context`). The previous
 * `indexOf(":")` based parser broke on both.
 */
type Parsed =
  | { kind: "separator" }
  | { kind: "footer"; text: string }
  | { kind: "row"; file: string; line: number; text: string; rowKind: RowKind }
  | { kind: "plain"; text: string }

function parseLine(raw: string, pathOnlyMode: boolean): Parsed | null {
  if (raw === "") return null
  if (raw === "--") return { kind: "separator" }
  // Footer detection: every footer emitted by execute_search_files starts
  // with "... " (three dots + space) — e.g. "... skipped 3 file(s) >10MB".
  // The trailing space discriminates against legitimate match content like
  // `.../foo.rs:1:text` (path-prefixed under a directory literally named
  // "...") or a match line whose body starts with "...todo".
  if (raw.startsWith("... ") || raw.startsWith("No matches")) {
    return { kind: "footer", text: raw }
  }
  // files_with_matches mode emits paths-only — never try to parse them as
  // `path:line:text` rows. Otherwise a path containing `:digit:` (e.g.
  // `report:2024:final.log`) would be misclassified as a match row.
  if (pathOnlyMode) {
    return { kind: "plain", text: raw }
  }
  const m = raw.match(/^(.+)([:\-])(\d+)\2(.*)$/)
  if (!m) return { kind: "plain", text: raw }
  return {
    kind: "row",
    file: m[1],
    line: parseInt(m[3], 10),
    text: m[4],
    rowKind: m[2] === ":" ? "match" : "context",
  }
}

function parseSearchFileResults(
  output: string,
  pathOnlyMode: boolean,
): {
  groups: FileGroup[]
  footers: string[]
  plain: string[]
} {
  const lines = output.split("\n")
  const groupMap = new Map<string, Row[]>()
  const footers: string[] = []
  const plain: string[] = []
  // Track per-file "pending break" so a `--` only annotates the next row.
  let pendingBreakForFile: string | null = null

  for (const raw of lines) {
    const p = parseLine(raw, pathOnlyMode)
    if (!p) continue
    if (p.kind === "footer") {
      footers.push(p.text)
      pendingBreakForFile = null
      continue
    }
    if (p.kind === "plain") {
      plain.push(p.text)
      pendingBreakForFile = null
      continue
    }
    if (p.kind === "separator") {
      // The separator belongs to "the file we were last appending to".
      // Capture it; the next "row" in that same file will inherit it.
      // If the next row is in a different file, we just drop the marker
      // (`--` only makes sense within a single file).
      const lastFile = [...groupMap.keys()].pop() ?? null
      pendingBreakForFile = lastFile
      continue
    }
    // p.kind === "row"
    if (!groupMap.has(p.file)) groupMap.set(p.file, [])
    const row: Row = { line: p.line, text: p.text, kind: p.rowKind }
    if (pendingBreakForFile === p.file) {
      row.breakBefore = true
    }
    pendingBreakForFile = null
    groupMap.get(p.file)!.push(row)
  }

  const groups: FileGroup[] = [...groupMap.entries()].map(([file, rows]) => ({
    file,
    rows,
  }))
  return { groups, footers, plain }
}

function parseDocSearchResults(output: string): { isDocSearch: true; text: string } | null {
  if (output.includes("Found") && output.includes("result(s) for")) {
    return { isDocSearch: true, text: output }
  }
  return null
}

const COLLAPSE_GROUPS = 10

export function SearchResultTool({ name, args, result, isRunning }: ToolDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const parsed = tryParseJson(args)

  const isDocSearch = name === "search_docs"
  const query = String(parsed?.pattern ?? parsed?.query ?? "")
  const searchPath = parsed?.path as string | undefined
  const fileExt = parsed?.file_ext as string | undefined
  const category = parsed?.category as string | undefined
  const outputMode = parsed?.output_mode as string | undefined
  const contextLines = parsed?.context as number | undefined
  const multiline = parsed?.multiline as boolean | undefined

  const hasResult = !!result

  const pathOnlyMode = outputMode === "files_with_matches"
  const { groups, footers, plain, docText } = useMemo(() => {
    if (!hasResult) return { groups: [], footers: [], plain: [], docText: "" }
    if (isDocSearch) {
      const doc = parseDocSearchResults(result)
      return { groups: [], footers: [], plain: [], docText: doc?.text ?? result }
    }
    return { ...parseSearchFileResults(result, pathOnlyMode), docText: "" }
  }, [result, hasResult, isDocSearch, pathOnlyMode])

  // Counts use `:` rows (matches) only — context rows are bonus.
  const matchCount = groups.reduce(
    (sum, g) => sum + g.rows.filter((r) => r.kind === "match").length,
    0,
  )
  // files_with_matches mode emits a single path per file with no `:line:text`
  // payload — so groups end up empty and we render the plain[] fallback.
  const isFilesOnlyMode =
    outputMode === "files_with_matches" || (plain.length > 0 && groups.length === 0)
  const isLarge = groups.length > COLLAPSE_GROUPS
  const visibleGroups = expanded || !isLarge ? groups : groups.slice(0, COLLAPSE_GROUPS)

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {/* Search query + parameter badges */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
          <Search className="h-3.5 w-3.5 shrink-0 text-violet-400" />
          {query || t("empty")}
        </span>
        {searchPath && searchPath !== "." && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tf("inPath", searchPath)}
          </span>
        )}
        {fileExt && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            *.{fileExt}
          </span>
        )}
        {category && (
          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">
            {category}
          </span>
        )}
        {outputMode && outputMode !== "content" && (
          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">
            {outputMode === "files_with_matches"
              ? t("toolSearchOutputModeFiles")
              : t("toolSearchOutputModeCount")}
          </span>
        )}
        {typeof contextLines === "number" && contextLines > 0 && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {tf("toolSearchContext", contextLines)}
          </span>
        )}
        {multiline && (
          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t("toolSearchMultiline")}
          </span>
        )}
        {hasResult && !isDocSearch && matchCount > 0 && (
          <span className="text-[10px] text-muted-foreground/50">
            {matchCount} {matchCount !== 1 ? t("matchPlural") : t("matchSingular")}
            {t("matchIn")}
            {groups.length} {groups.length !== 1 ? t("filePlural") : t("fileSingular")}
          </span>
        )}
        {hasResult && !isDocSearch && isFilesOnlyMode && plain.length > 0 && (
          <span className="text-[10px] text-muted-foreground/50">
            {tf("searchFilesOnly", plain.length)}
          </span>
        )}
      </div>

      {/* search_docs output */}
      {hasResult && isDocSearch && (
        <div className="group/block">
          <div className="flex items-end justify-between pb-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("results")}
            </span>
            <CopyButton text={result} />
          </div>
          <pre className="overflow-hidden whitespace-pre-wrap rounded-md bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80 hover:overflow-auto">
            {docText}
          </pre>
        </div>
      )}

      {/* search_files content/count mode — grouped by file with diff-like rows */}
      {hasResult && !isDocSearch && groups.length > 0 && (
        <div className="group/block">
          <div className="flex items-end justify-between pb-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("results")}
            </span>
            <CopyButton text={result} />
          </div>
          <div className="space-y-1">
            {visibleGroups.map((group) => (
              <div key={group.file} className="overflow-hidden rounded-md border bg-muted/20">
                <div className="flex items-center gap-1.5 border-b border-border/20 bg-muted/30 px-2.5 py-1">
                  <FileText className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                  <span className="min-w-0 truncate font-mono text-[10px] font-medium text-foreground/70">
                    {group.file}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/40">
                    {group.rows.filter((r) => r.kind === "match").length}
                  </span>
                </div>
                <div>
                  {group.rows.map((row, i) => (
                    <div key={i}>
                      {row.breakBefore && (
                        <div className="my-0.5 border-t border-dashed border-border/30" />
                      )}
                      <div
                        className={
                          "flex gap-0 text-[11px] hover:bg-muted/20 " +
                          (row.kind === "match"
                            ? "border-l-2 border-violet-400/60"
                            : "border-l-2 border-transparent")
                        }
                      >
                        <span
                          className={
                            "w-12 shrink-0 select-none border-r border-border/20 px-1.5 py-0.5 text-right font-mono text-[10px] " +
                            (row.kind === "match"
                              ? "text-muted-foreground/60"
                              : "text-muted-foreground/30")
                          }
                        >
                          {row.line}
                        </span>
                        <pre
                          className={
                            "min-w-0 flex-1 overflow-hidden px-2 py-0.5 font-mono " +
                            (row.kind === "match"
                              ? "text-foreground/70"
                              : "text-foreground/40")
                          }
                        >
                          {row.kind === "match"
                            ? highlightMatch(row.text, query)
                            : row.text}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {footers.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {footers.map((line, i) => (
                <div key={i} className="text-[10px] text-muted-foreground/50">
                  {line}
                </div>
              ))}
            </div>
          )}
          {isLarge && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {expanded ? t("showLess") : tf("showAllFiles", groups.length)}
            </button>
          )}
        </div>
      )}

      {/* files_with_matches mode — plain path list */}
      {hasResult && !isDocSearch && groups.length === 0 && plain.length > 0 && (
        <div className="group/block">
          <div className="flex items-end justify-between pb-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("results")}
            </span>
            <CopyButton text={result} />
          </div>
          <div className="space-y-0.5 rounded-md bg-muted/20 px-2.5 py-1.5">
            {plain.map((line, i) => (
              <div key={i} className="flex items-center gap-1.5 font-mono text-[11px] text-foreground/70">
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                <span className="min-w-0 truncate">{line}</span>
              </div>
            ))}
          </div>
          {footers.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {footers.map((line, i) => (
                <div key={i} className="text-[10px] text-muted-foreground/50">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty result fallback */}
      {hasResult && !isDocSearch && groups.length === 0 && plain.length === 0 && (
        <div className="rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {result}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text
  try {
    const re = new RegExp(`(${escapeRegex(query)})`, "gi")
    const parts = text.split(re)
    if (parts.length <= 1) return text
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <span key={i} className="rounded-sm bg-yellow-400/20 font-semibold text-yellow-300">
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )
  } catch {
    return text
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
