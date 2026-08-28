import { Box, FileText, Globe, Play, Square, Trash2 } from "lucide-react"
import { tryParseJson, RunningIndicator } from "./shared"
import { isHtmlName, statusDotClass } from "@agentchat/lib/releases"
import type { ToolDisplayProps } from "./index"

/**
 * Tool cards for the app lifecycle family (`run_app` / `stop_app` /
 * `remove_app`) and the releases inventory (`list_releases`).
 *
 * Lifecycle cards: one identity chip (package/name) + the core's receipt or
 * in-band error. Inventory card: the result JSON rendered as a compact list
 * (kind icon, name, status dot, owning session short-id).
 */

function chip(icon: React.ReactNode, label: string) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80">
      {icon}
      {label}
    </span>
  )
}

function resultLine(result: string | undefined) {
  if (!result) return null
  const failed = result.startsWith("Error:")
  return (
    <div
      className={`rounded-md px-2.5 py-1.5 text-[11px] ${
        failed ? "bg-destructive/10 text-destructive" : "bg-muted/20 text-muted-foreground"
      }`}
    >
      <span className="min-w-0 break-all">{result}</span>
    </div>
  )
}

function lifecycleCard(
  icon: React.ReactNode,
  label: string,
  { result, isRunning }: ToolDisplayProps,
) {
  return (
    <div className="mt-1 space-y-1.5 pb-1 pl-1">
      <div className="flex flex-wrap items-center gap-1.5">{chip(icon, label)}</div>
      {resultLine(result)}
      {isRunning && !result && <RunningIndicator />}
    </div>
  )
}

export function RunAppTool(props: ToolDisplayProps) {
  const parsed = tryParseJson(props.args)
  const pkg = String(parsed?.package ?? "")
  const label = pkg.split("/").pop() || pkg || "app"
  return lifecycleCard(<Play className="h-3.5 w-3.5 shrink-0 text-emerald-400" />, label, props)
}

export function StopAppTool(props: ToolDisplayProps) {
  const parsed = tryParseJson(props.args)
  const name = String(parsed?.name ?? "app")
  return lifecycleCard(<Square className="h-3.5 w-3.5 shrink-0 text-amber-400" />, name, props)
}

export function RemoveAppTool(props: ToolDisplayProps) {
  const parsed = tryParseJson(props.args)
  const name = String(parsed?.name ?? "app")
  return lifecycleCard(<Trash2 className="h-3.5 w-3.5 shrink-0 text-red-400" />, name, props)
}

interface ReleaseRow {
  kind?: string
  name?: string
  url?: string
  status?: string
  port?: number
  session_id?: string
}

function statusDot(status?: string) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(status)}`} title={status} />
}

/** `list_releases` card: parse the trailing JSON array out of the tool output
 *  and render a compact inventory; fall back to the raw text otherwise. */
export function ListReleasesTool({ result, isRunning }: ToolDisplayProps) {
  let rows: ReleaseRow[] | null = null
  if (result) {
    const start = result.indexOf("[")
    if (start >= 0) {
      try {
        const parsed = JSON.parse(result.slice(start))
        if (Array.isArray(parsed)) rows = parsed
      } catch {
        rows = null
      }
    }
  }

  return (
    <div className="mt-1 space-y-1.5 pb-1 pl-1">
      {rows && rows.length > 0 && (
        <div className="space-y-0.5 rounded-md bg-muted/20 px-2.5 py-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              {r.kind === "app" ? (
                <>
                  {statusDot(r.status)}
                  <Box className="h-3 w-3 shrink-0 text-sky-400" />
                </>
              ) : isHtmlName(r.name ?? "") ? (
                <Globe className="h-3 w-3 shrink-0 text-emerald-400" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-emerald-400" />
              )}
              <span className="min-w-0 truncate font-mono text-foreground/80">{r.name}</span>
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-primary no-underline hover:underline"
                >
                  {r.url}
                </a>
              ) : r.port ? (
                <span className="shrink-0">:{r.port}</span>
              ) : null}
              {r.session_id && (
                <span className="ml-auto shrink-0 font-mono text-muted-foreground/50">
                  {r.session_id.slice(0, 8)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {result && (!rows || rows.length === 0) && (
        <div className="rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 break-all">{result}</span>
        </div>
      )}
      {isRunning && !result && <RunningIndicator />}
    </div>
  )
}
