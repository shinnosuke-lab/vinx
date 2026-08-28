import { useEffect, useRef, useState } from "react"
import { Check, Paintbrush, RotateCcw, Save } from "lucide-react"
import { t, tf } from "@agentchat/lib/i18n"
import { applyLlmStyle, clearLlmStyle } from "@agentchat/lib/llm-style"
import { useChatRuntime } from "@agentchat/lib/chat-runtime"
import { toast } from "@agentchat/components/ui/toast"
import { promptDialog } from "@agentchat/components/ui/confirm-dialog"
import {
  CopyButton,
  RunningIndicator,
  tryParseJson,
  useStickyScrollToBottom,
} from "./shared"
import type { ToolDisplayProps } from "./index"

const TAIL_LINES = 25
/** Max cadence for painting partial CSS onto the page while args stream. */
const LIVE_APPLY_MS = 200

/**
 * Renderer for the `set_chat_style` easter egg.
 *
 * While the arguments stream it does two things: shows the accreting tail of
 * whichever field is being written (like `file-write-tool`, following css into
 * js so the pane never looks stuck) and live-applies the partial stylesheet,
 * throttled, so the user watches the theme paint itself — browsers ignore the
 * trailing incomplete rule, and the definitive `style` SSE event corrects
 * everything at the end. Streaming js is shown but NEVER run; the script
 * executes exactly once, from the final event (see `AgentChat`).
 */
export function StyleTool({ args, result, isRunning }: ToolDisplayProps) {
  const [cssVisible, setCssVisible] = useState(false)
  const [jsVisible, setJsVisible] = useState(false)
  const [restored, setRestored] = useState(false)
  const [saved, setSaved] = useState(false)
  const runtime = useChatRuntime()

  const parsed = tryParseJson(args)
  const css = String(parsed?.css ?? "")
  const js = String(parsed?.js ?? "")
  const isReset = !css.trim() && !js.trim()
  const isStreaming = isRunning && !result

  // Which field the model is currently writing: follow whichever last grew, so
  // the pane keeps moving when the model finishes css and starts js (and still
  // works if a model emits them in the opposite order).
  const prevRef = useRef({ css: "", js: "" })
  const activeRef = useRef<"css" | "js">("css")
  if (js !== prevRef.current.js) activeRef.current = "js"
  else if (css !== prevRef.current.css) activeRef.current = "css"
  prevRef.current = { css, js }

  const streamLabel = activeRef.current === "js" ? "JS" : "CSS"
  const streamCode = activeRef.current === "js" ? js : css

  // Set during render so a pending throttle timer can tell that the final
  // `style` event already applied the definitive CSS (timers can fire between
  // the state flush and passive effects — a stale partial apply would stick).
  const doneRef = useRef(false)
  doneRef.current = !isStreaming

  const cssRef = useRef("")
  cssRef.current = css
  const lastAppliedRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isStreaming) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }
    if (!css) return
    const since = Date.now() - lastAppliedRef.current
    if (since >= LIVE_APPLY_MS) {
      lastAppliedRef.current = Date.now()
      applyLlmStyle(css)
    } else if (timerRef.current == null) {
      // Trailing edge: guarantees the last partial chunk lands even when
      // deltas stop arriving mid-throttle-window.
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (doneRef.current) return
        lastAppliedRef.current = Date.now()
        applyLlmStyle(cssRef.current)
      }, LIVE_APPLY_MS - since)
    }
  }, [css, isStreaming])

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const preRef = useRef<HTMLPreElement>(null)
  useStickyScrollToBottom(preRef, streamCode.length, isStreaming)

  if (isStreaming) {
    const lines = streamCode.split("\n")
    return (
      <div className="mt-1 space-y-1.5 pb-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RunningIndicator />
          <span>{t("styleApplying")}</span>
          {streamCode && (
            <span className="text-[10px] text-muted-foreground/50">
              {streamLabel} · {streamCode.length.toLocaleString()} {t("chars")}
            </span>
          )}
        </div>
        {streamCode && (
          <pre
            ref={preRef}
            className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80"
          >
            {lines.slice(-TAIL_LINES).join("\n")}
          </pre>
        )}
      </div>
    )
  }

  const handleRestore = () => {
    clearLlmStyle()
    setRestored(true)
  }

  // "Save this theme" persists THIS card's css/js (not the global current-page
  // look) with no model round-trip — so clicking an older card saves the theme
  // that card represents, and there is never an empty save. Prompts for a name
  // so saves ACCUMULATE in the releases inventory (a new name = a new saved
  // theme; the same name overwrites). Offered on any applied-style card as long
  // as the runtime context exists (absent in the terminal panel → self-hides).
  const canSave = !isReset && !!runtime
  const handleSave = async () => {
    if (!runtime) return
    // Prefer the model-authored name from this call's args; fall back to a
    // unique timestamp slug only when the model didn't provide one.
    const modelName = typeof parsed?.name === "string" ? parsed.name.trim() : ""
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, "0")
    const suggested =
      modelName ||
      `theme-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const input = await promptDialog(t("themeSavePrompt"), suggested)
    if (input == null) return // cancelled
    const name = input.trim() || suggested
    try {
      await runtime.client.saveTheme(name, css, js, runtime.sessionId)
      setSaved(true)
      toast.success(tf("themeSavedAs", name))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const codeSection = (label: string, code: string) => (
    <div className="group/block">
      <div className="flex items-center justify-between pb-0.5">
        <span className="text-[10px] text-muted-foreground/50">
          {label} · {code.length.toLocaleString()} {t("chars")}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
        {code}
      </pre>
    </div>
  )

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px] text-foreground/80">
          {isReset ? (
            <RotateCcw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          ) : (
            <Paintbrush className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={1.8} />
          )}
          {isReset ? t("styleResetDone") : t("styleApplied")}
        </span>
        {!isReset && (
          <>
            {css.trim() && (
              <button
                onClick={() => setCssVisible((v) => !v)}
                className="text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              >
                {cssVisible ? t("styleHideCss") : t("styleShowCss")}
              </button>
            )}
            {js.trim() && (
              <button
                onClick={() => setJsVisible((v) => !v)}
                className="text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              >
                {jsVisible ? t("styleHideJs") : t("styleShowJs")}
              </button>
            )}
            {canSave && (
              <button
                onClick={handleSave}
                disabled={saved}
                className="inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:cursor-default disabled:opacity-60"
              >
                {saved ? (
                  <Check className="h-3 w-3 text-success" />
                ) : (
                  <Save className="h-3 w-3" strokeWidth={1.8} />
                )}
                {saved ? t("styleSaved") : t("styleSave")}
              </button>
            )}
            <button
              onClick={handleRestore}
              disabled={restored}
              className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-60"
            >
              {restored ? (
                <Check className="h-3 w-3 text-success" />
              ) : (
                <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
              )}
              {t("styleRestoreDefault")}
            </button>
          </>
        )}
      </div>

      {cssVisible && css.trim() && codeSection("CSS", css)}
      {jsVisible && js.trim() && codeSection("JS", js)}
    </div>
  )
}
