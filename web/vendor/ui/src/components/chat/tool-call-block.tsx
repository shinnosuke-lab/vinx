import { useState, useEffect, useRef, memo } from "react"
import { ChevronRight, Check, Loader2, Minus, X } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { useFoldAll } from "@agentchat/lib/fold-all"
import { useReveal } from "@agentchat/lib/reveal"
import { toolLabel, tryParseJson } from "./tools/shared"
import { fallbackRenderer } from "./tools"
import { recalledToolName } from "./tools/recall-result-tool"
import { askUserSummary } from "./tools/ask-user-tool"
import { Collapsible } from "./collapsible"
import type { ToolRenderer } from "@agentchat/types"

// One-line header hint: surfaces the path / pattern as soon as it streams in.
function getHeaderSummary(name: string, args?: string, result?: string): string | null {
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
  if (name === "web_fetch") return parsed.url ? String(parsed.url) : null
  if (name === "task") {
    // The schema's `description` is the purpose-built display summary;
    // prompt first line only covers older transcripts without one.
    if (typeof parsed.description === "string" && parsed.description.trim())
      return parsed.description.trim()
    if (typeof parsed.prompt !== "string" || !parsed.prompt) return null
    const line = parsed.prompt.split("\n", 1)[0]
    return line.length > 60 ? line.slice(0, 60) + "…" : line
  }
  if (name === "ask_user") return askUserSummary(args, result)
  if (name === "recall_result") {
    // Collapsed, the card should still say WHICH tool's result came back;
    // that is only known from the result's header line, not the arguments.
    const id = typeof parsed.call_id === "string" ? parsed.call_id : null
    const tool = recalledToolName(result)
    if (tool && id) return `${toolLabel(tool)} · ${id}`
    return id
  }
  // Generic: first short scalar arg.
  for (const [, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v && v.length <= 60) return v
  }
  return null
}

// Tools whose card stays expanded after completion — their result IS the UI
// (e.g. `open_terminal` renders the button the user must click;
// `set_chat_style` renders the "save this theme" / "restore" buttons;
// `open_file` and `install_app` — vinx's workspace tools — render an Open
// button).
const STICKY_TOOLS = new Set(["open_terminal", "set_chat_style", "open_file", "install_app"])

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

  // Transcript-wide expand/collapse (header menu). Sticky cards stay open on
  // "collapse all": their body is the interaction, not process detail.
  useFoldAll((mode) => {
    userToggledRef.current = true
    setExpanded(mode === "expand" || STICKY_TOOLS.has(name))
  })

  // "Show original" aimed at this call (lib/reveal): open, flash, and scroll
  // into view once the fold transitions — the group's and our own, both
  // --acc-motion-base — have run; scrolling earlier aims at a moving target.
  const rootRef = useRef<HTMLDivElement>(null)
  const [flashing, setFlashing] = useState(false)
  useReveal((cmd) => {
    if (!callId || cmd.callId !== callId) return
    userToggledRef.current = true
    setExpanded(true)
    setFlashing(true)
    // Unmounted before the timer fires → rootRef is null → no-op.
    window.setTimeout(() => {
      rootRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    }, 260)
  })

  const handleToggle = () => {
    userToggledRef.current = true
    setExpanded((e) => !e)
  }

  const label = toolLabel(name)
  const summary = getHeaderSummary(name, args, result)
  const Render = renderers[name] ?? fallbackRenderer

  // The verdict icon pops in the moment the spinner gives way — but only
  // then: a card mounted from history with its result already present must
  // render settled. Tracks whether this mount ever showed the spinner.
  const running = isRunning && !hasResult
  const sawRunningRef = useRef(running)
  if (running) sawRunningRef.current = true
  const verdictPop = !running && sawRunningRef.current

  return (
    <div
      ref={rootRef}
      className={cn(
        "border-l border-l-muted-foreground/30 px-3",
        flashing && "acc-reveal-flash",
      )}
      onAnimationEnd={(e) => {
        if (e.animationName === "acc-reveal-flash") setFlashing(false)
      }}
    >
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
        {running ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
        ) : success === false ? (
          <X className={cn("h-3 w-3 shrink-0 text-destructive", verdictPop && "animate-pop-in")} />
        ) : hasResult || success === true ? (
          <Check className={cn("h-3 w-3 shrink-0 text-success", verdictPop && "animate-pop-in")} />
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

      <Collapsible open={expanded}>
        <div className="pb-1">
          <Render
            name={name}
            args={args}
            result={result}
            isRunning={isRunning}
            status={running ? "running" : "done"}
            callId={callId}
            renderers={renderers}
          />
        </div>
      </Collapsible>
    </div>
  )
})
