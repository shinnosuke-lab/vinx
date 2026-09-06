import { Archive, CircleCheck, CornerLeftUp, History, SearchX } from "lucide-react"
import { t, tf } from "@agentchat/lib/i18n"
import { useChatRuntime } from "@agentchat/lib/chat-runtime"
import { GenericTool } from "./generic-tool"
import { CopyButton, RunningIndicator, toolLabel, tryParseJson } from "./shared"
import type { ToolDisplayProps } from "./index"

/**
 * `recall_result` — the agent re-reading a tool result that had been elided
 * from its working context (the `[compacted: … recall_result(call_id=…)]`
 * placeholder). The raw output is that earlier result again, prefixed with a
 * one-line header naming its tool and call id.
 *
 * For a human reader the payload is a re-print of something the transcript
 * already shows, so the card leads with provenance — WHICH tool's result came
 * back, how big, from where (session record or the pre-compaction archive) —
 * and a "show original" jump to the call it duplicates. The content itself
 * renders through the original tool's own card (a recalled `run_shell` looks
 * like a shell card, a recalled `search_files` like a search card) when the
 * original call is still in the transcript to lend its arguments; otherwise
 * as plain output.
 */

/** Header the kernel prefixes to a successful recall (agent_loop.rs). */
const RECALLED_HEAD = /^\[recalled (archived )?(\S+) result call_id="([^"]*)"\]\n?/
/** The "already in context" short-circuit: nothing was re-sent. */
const VISIBLE_HEAD = /^Result call_id="([^"]*)" is already present/
/** Loop-level marker on the miss / missing-argument errors. */
const NO_RETRY = "[NO_RETRY]"

type Recall =
  | { kind: "recalled"; tool: string; callId: string; archived: boolean; content: string }
  | { kind: "visible"; callId: string }
  | { kind: "miss"; message: string }

function parseRecall(result: string): Recall {
  const head = result.match(RECALLED_HEAD)
  if (head) {
    return {
      kind: "recalled",
      archived: !!head[1],
      tool: head[2],
      callId: head[3],
      content: result.slice(head[0].length),
    }
  }
  const visible = result.match(VISIBLE_HEAD)
  if (visible) return { kind: "visible", callId: visible[1] }
  const message = result.startsWith(NO_RETRY) ? result.slice(NO_RETRY.length).trim() : result
  return { kind: "miss", message }
}

/** The tool whose result a `recall_result` output brought back, for the
 *  card header while collapsed. Undefined for a miss / short-circuit. */
export function recalledToolName(result?: string): string | undefined {
  return result?.match(RECALLED_HEAD)?.[2]
}

/** Interactive cards (the button IS the result) are not re-printed from a
 *  recall; mirrors STICKY_TOOLS in tool-call-block.tsx. */
const NO_REPRINT = new Set(["open_terminal", "set_chat_style"])

function countLines(text: string): number {
  if (!text) return 0
  const n = text.split("\n").length
  return text.endsWith("\n") ? n - 1 : n
}

/** Mono call id with a copy affordance — the id is what a reader would paste
 *  into a search of the transcript or a bug report. */
function CallId({ id }: { id: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <span className="truncate font-mono text-muted-foreground/60">{id}</span>
      <CopyButton text={id} />
    </span>
  )
}

/** "Show original call" when the transcript still holds the call. */
function ShowOriginal({ callId }: { callId: string }) {
  const runtime = useChatRuntime()
  if (!runtime?.revealToolCall || !runtime.findToolCall?.(callId)) return null
  const reveal = runtime.revealToolCall
  return (
    <button
      type="button"
      onClick={() => reveal(callId)}
      className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <CornerLeftUp className="h-3 w-3" />
      {t("recallShowOriginal")}
    </button>
  )
}

export function RecallResultTool({ args, result, isRunning, renderers }: ToolDisplayProps) {
  const runtime = useChatRuntime()
  if (isRunning && !result) return <RunningIndicator />
  if (!result) return null

  const recall = parseRecall(result)

  if (recall.kind === "visible") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[11px] text-muted-foreground">
        <CircleCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span>{t("recallAlreadyVisible")}</span>
        <CallId id={recall.callId} />
        <ShowOriginal callId={recall.callId} />
      </div>
    )
  }

  if (recall.kind === "miss") {
    // The id the agent asked for, so the miss is legible without opening
    // the input JSON.
    const requested = tryParseJson(args)?.call_id
    return (
      <div className="space-y-1 py-1 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <SearchX className="h-3.5 w-3.5 shrink-0 text-destructive/70" />
          <span>{t("recallNotFound")}</span>
          {typeof requested === "string" && requested && <CallId id={requested} />}
        </div>
        <p className="whitespace-pre-wrap pl-[22px] text-muted-foreground/70">{recall.message}</p>
      </div>
    )
  }

  const { tool, callId, archived, content } = recall
  // The original call, when this transcript still has it: its arguments
  // let the tool's own card render the content faithfully (the command
  // line, the file path, the search pattern all live in the arguments).
  const original = runtime?.findToolCall?.(callId)
  const Render =
    original && renderers?.[tool] && !NO_REPRINT.has(tool) ? renderers[tool] : GenericTool
  // The title embeds the tool label as an emphasised span; the placeholder
  // sits mid-sentence in some locales, so split the template around it.
  const [titleBefore, titleAfter = ""] = t("recallTitle").split("{0}")

  return (
    <div className="space-y-1.5 py-1">
      <div className="space-y-1 text-[11px]" title={t("recallHint")}>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          <span className="min-w-0 truncate">
            {titleBefore}
            <span className="font-medium text-foreground/80">{toolLabel(tool)}</span>
            {titleAfter}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[10px] text-muted-foreground/60">
          <CallId id={callId} />
          <span className="text-muted-foreground/30">·</span>
          <span className="shrink-0 tabular-nums">
            {tf("recallSize", content.length.toLocaleString(), countLines(content).toLocaleString())}
          </span>
          {archived && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <Archive className="h-3 w-3" />
                {t("recallFromArchive")}
              </span>
            </>
          )}
          {original ? (
            <>
              <span className="text-muted-foreground/30">·</span>
              <ShowOriginal callId={callId} />
            </>
          ) : (
            runtime?.findToolCall &&
            !archived && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="shrink-0 italic">{t("recallOriginalGone")}</span>
              </>
            )
          )}
        </div>
      </div>

      {/* The re-print, framed dashed so it reads as a quotation of an earlier
          card rather than a fresh run. */}
      <div className="rounded-md border border-dashed border-border/70 px-2 py-1">
        <Render
          name={tool}
          args={original?.args}
          result={content}
          isRunning={false}
          status="done"
          callId={callId}
          renderers={renderers}
        />
      </div>
    </div>
  )
}
