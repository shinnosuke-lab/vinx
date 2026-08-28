import { useState, useEffect, useRef, memo } from "react"
import { ChevronRight, Check, Loader2, Minus, X } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import { tryParseJson } from "./tools/shared"
import { fallbackRenderer } from "./tools"
import type { ToolRenderer } from "@agentchat/types"

/** Title-case a snake_case tool name (`read_file` → `Read File`). */
export function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// One-line header hint: surfaces the path / pattern as soon as it streams in.
function getHeaderSummary(name: string, args?: string): string | null {
  if (!args || args === "{}" || args === "") return null
  const parsed = tryParseJson(args)
  if (!parsed) return null
  if (name === "run_shell") {
    // The command IS the summary — a collapsed card that hides what ran
    // makes the transcript unreadable. First line, kept short.
    const cmd = typeof parsed.command === "string" ? parsed.command : ""
    const first = cmd.split("\n")[0].trim()
    return first ? (first.length > 60 ? first.slice(0, 60) + "…" : first) : null
  }
  if (
    name === "read_file" ||
    name === "write_file" ||
    name === "edit_file" ||
    name === "list_dir" ||
    name === "download_file"
  )
    return parsed.path ? String(parsed.path) : null
  if (name === "list_files") return parsed.path ? String(parsed.path) : null
  if (name === "search_files") return parsed.pattern ? String(parsed.pattern) : null
  if (name === "task") {
    // The schema's `description` is the purpose-built display summary;
    // prompt first line only covers older transcripts without one.
    if (typeof parsed.description === "string" && parsed.description.trim())
      return parsed.description.trim()
    if (typeof parsed.prompt !== "string" || !parsed.prompt) return null
    const line = parsed.prompt.split("\n", 1)[0]
    return line.length > 60 ? line.slice(0, 60) + "…" : line
  }
  // Generic: first short scalar arg.
  for (const [, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v && v.length <= 60) return v
  }
  return null
}

// Tools whose card stays expanded after completion — their result IS the UI
// (e.g. `open_terminal` renders the button the user must click;
// `set_chat_style` renders the "save this theme" / "restore" buttons).
const STICKY_TOOLS = new Set(["open_terminal", "set_chat_style"])

interface ToolCallBlockProps {
  name: string
  args?: string
  result?: string
  /** Loop verdict from the `tool_result` frame; undefined (history) = success. */
  success?: boolean
  isRunning: boolean
  renderers: Record<string, ToolRenderer>
  /** Tool_call id, forwarded to the renderer for per-call live state. */
  callId?: string
}

export const ToolCallBlock = memo(function ToolCallBlock({
  name,
  args,
  result,
  success,
  isRunning,
  renderers,
  callId,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(isRunning || STICKY_TOOLS.has(name))
  const userToggledRef = useRef(false)

  const hasResult = !!result

  useEffect(() => {
    if (userToggledRef.current) return
    setExpanded(isRunning || STICKY_TOOLS.has(name))
  }, [isRunning, name])

  const handleToggle = () => {
    userToggledRef.current = true
    setExpanded((e) => !e)
  }

  // The sub-agent tool reads as a localized "sub-task" chip, not "Task".
  const label = name === "task" ? t("subagentTag") : humanizeToolName(name)
  const summary = getHeaderSummary(name, args)
  const Render = renderers[name] ?? fallbackRenderer

  return (
    <div className="border-l border-l-muted-foreground/30 px-3">
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        {isRunning && !hasResult ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
        ) : success === false ? (
          <X className="h-3 w-3 shrink-0 text-destructive" />
        ) : hasResult || success === true ? (
          <Check className="h-3 w-3 shrink-0 text-success" />
        ) : (
          // No result and not running: cancelled or interrupted. A green
          // check here would claim something ran that never did.
          <Minus className="h-3 w-3 shrink-0 text-muted-foreground/40" />
        )}
        <span className="shrink-0 whitespace-nowrap text-muted-foreground/60">
          {label}
        </span>
        {summary && (
          <>
            <span className="shrink-0 text-muted-foreground/30">·</span>
            <span className="min-w-0 truncate font-mono text-muted-foreground/50">
              {summary}
            </span>
          </>
        )}
      </button>

      {expanded && (
        <div className="pb-1">
          <Render
            name={name}
            args={args}
            result={result}
            isRunning={isRunning}
            status={isRunning && !hasResult ? "running" : "done"}
            callId={callId}
          />
        </div>
      )}
    </div>
  )
})
