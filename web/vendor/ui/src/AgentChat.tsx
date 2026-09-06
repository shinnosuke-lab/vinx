import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useImperativeHandle,
  forwardRef,
  memo,
} from "react"
import { Archive, ChevronDown, ChevronLeft, Copy, Check, ExternalLink, FileText, Pencil, RotateCcw, X, XCircle, PanelLeftOpen, Plus, Upload } from "lucide-react"
import { ChatBusyError, createChatClient } from "./client"
import type { CatalogModel, ModelCaps } from "./client"
import { VINX_LOGO } from "./assets/vinx-logo"
import { defaultToolRenderers } from "./components/chat/tools"
import { setLabels, t, tf } from "./lib/i18n"
import { printElementToPdf, printSoloElementToPdf } from "./lib/export"
import { applyLlmStyle, runLlmScript, currentLlmCss, currentLlmJs } from "./lib/llm-style"
import { ChatRuntimeContext } from "./lib/chat-runtime"
import { FoldAllContext, type FoldCommand } from "./lib/fold-all"
import { clearAttention, installAlerts, signalAttention } from "./lib/alerts"
import { RevealContext, type RevealCommand } from "./lib/reveal"
import { dropPendingNotes, placeStatusNote } from "./lib/status-notes"
import { themeToCssVars } from "./lib/theme"
import {
  NEW_CHAT_DRAFT_ID,
  clearDraft,
  readDraft,
  sweepDrafts,
  writeDraft,
  type ComposerDraft,
} from "./lib/composer-draft"
import { cn, copyToClipboard, useMediaQuery, MOBILE_QUERY } from "./lib/utils"
import { Markdown } from "./components/chat/markdown"
import { ReasoningBlock } from "./components/chat/reasoning-block"
import { ToolCallBlock } from "./components/chat/tool-call-block"
import { StepGroup, buildTranscriptBlocks } from "./components/chat/step-group"
import { MessageOutline, type OutlineEntry } from "./components/chat/message-outline"
import { ConfirmBar } from "./components/chat/confirm-bar"
import { AskUserBar } from "./components/chat/ask-user-bar"
import { Lightbox } from "./components/chat/lightbox"
import { FilePreview } from "./components/chat/file-preview"
import { MessageActions } from "./components/chat/message-actions"
import { ChatInput } from "./components/chat/chat-input"
import { ChatWelcome } from "./components/chat/chat-welcome"
import { QueuedItems, type QueuedItem } from "./components/chat/queued-items"
import { SessionsPanel } from "./components/chat/sessions-panel"
import { ExportMenu } from "./components/chat/export-menu"
import { SessionReleases } from "./components/chat/session-releases"
import { SessionCategoryButton } from "./components/chat/session-category"
import { Spinner } from "./components/shared/spinner"
import { Button } from "./components/ui/button"
import { toast } from "./components/ui/toast"
import { isImageUploadId } from "./lib/attachments"
import type {
  AgentChatHandle,
  AgentChatProps,
  ArchiveGeneration,
  AskAnswer,
  AskQuestion,
  AttachmentView,
  ChatEvent,
  MessageView,
  SessionSummary,
  SkillAction,
  SkillInfo,
  ToolRenderer,
} from "./types"

let nextMsgId = 0

/** Max cadence for applying buffered stream deltas to React state (see
 *  pendingDeltasRef): ~20 renders/s regardless of provider chunk rate. */
const DELTA_FLUSH_MS = 50

/** Smallest text release per smoothing tick (~120 chars/s at DELTA_FLUSH_MS).
 *  Providers that emit small frequent chunks drain their buffer immediately,
 *  so smoothing is invisible for them. */
const SMOOTH_MIN_CHARS = 6

// ── Interval-aware typewriter pacing ──
// Some providers (measured: kimi k3, direct AND via proxies) emit output as
// large bursts seconds apart: ~1s of flowing chunks, 2-3s of silence, then a
// multi-KB block in one network flush. A fixed drain rate either pops the
// block at once or lags behind, so the release rate adapts to the measured
// burst interval: the backlog is spread evenly until the NEXT burst is
// expected, making block-pause-block render as one continuous scroll.
//
// The interval estimate is an EMA over gaps between delta arrivals, counting
// only gaps ≥ SMOOTH_GAP_MIN_MS: frames inside one burst arrive ~0ms apart
// and must not drag the estimate down. The EMA is clamped to
// SMOOTH_GAP_MAX_MS so a long thinking pause (measured 21-37s to first
// token) cannot push display lag beyond ~4s; the full flush on `done`
// bounds it at stream end regardless.

/** Gaps shorter than this are frames within one burst, not a burst boundary. */
const SMOOTH_GAP_MIN_MS = 250

/** Upper clamp for the burst-interval estimate (= worst-case display lag). */
const SMOOTH_GAP_MAX_MS = 4000

/** EMA weight of the newest observed burst gap. */
const SMOOTH_EMA_ALPHA = 0.3

/** Starting interval estimate before any burst gap has been observed. */
const SMOOTH_EMA_INITIAL_MS = 800

/** Split a delta buffer into the portion to render this tick and the rest:
 *  `want` chars with the SMOOTH_MIN_CHARS floor, never cutting a surrogate
 *  pair in half (emoji etc. stay intact). */
function takeSmoothPrefix(buf: string, want: number): [string, string] {
  if (!buf) return ["", ""]
  let take = Math.max(SMOOTH_MIN_CHARS, want)
  if (take >= buf.length) return [buf, ""]
  const last = buf.charCodeAt(take - 1)
  if (last >= 0xd800 && last <= 0xdbff) take++
  return [buf.slice(0, take), buf.slice(take)]
}

/** Backoff before redialling a dropped follow stream. Short because the
 *  reconnect is cheap and self-repairing (it replays a full snapshot). */
const FOLLOW_RETRY_MS = 1000

/** Human-readable label for one `task` call (from its tool_start arguments):
 *  the schema's `description` ("3-8 word summary, shown to the user"), with
 *  the prompt's first line as fallback for older transcripts. Null when the
 *  args are absent or unparsable (falls back to the task id). */
function taskLabel(rawArgs: string | undefined): string | null {
  if (!rawArgs) return null
  try {
    const parsed = JSON.parse(rawArgs) as { description?: unknown; prompt?: unknown }
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : ""
    if (description) return description
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : ""
    if (!prompt) return null
    const nl = prompt.indexOf("\n")
    return nl === -1 ? prompt : prompt.slice(0, nl)
  } catch {
    return null
  }
}

/** Compact elapsed readout: "42s" under a minute, "3:07" beyond. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

interface Message {
  id: number
  role: "user" | "assistant" | "tool" | "status" | "error"
  content: string
  toolCallId?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  /** Loop verdict from the `tool_result` frame; undefined for persisted history. */
  toolSuccess?: boolean
  reasoning?: string
  /** Image attachments on user messages (rendered as thumbnails). */
  attachments?: { id: string; name?: string }[]
  /** A `[Conversation Summary]` context-compaction message. Rendered as a
   *  compact boundary marker (the full pre-compaction history lives in the
   *  archive), not as a regular user bubble. Keeps role "user" so the rewind
   *  ordinal stays aligned with the server's user-message indices. */
  summaryMarker?: boolean
  /** `status` rows: work in flight ("Compacting context..."), shown with a
   *  spinner and replaced by the next status note (see lib/status-notes). */
  pending?: boolean
}

/** An attachment staged in the composer: uploaded eagerly on paste/pick, sent
 *  as an upload reference with the next message. */
interface PendingUpload {
  key: number
  name: string
  /** `image` renders a thumbnail chip; `file` a name+size chip. */
  kind: "image" | "file"
  size: number
  /** Preview URL: a `blob:` object URL for a file picked in this page, or the
   *  server's `GET /api/chat/upload/{id}` for a chip restored from a draft. */
  previewUrl?: string
  /** Upload id once the eager upload finished; chips without it block send. */
  id?: string
  /** Text-file line count from the upload response (echoed with the send). */
  lines?: number | null
}

/** Release a chip's preview. Only object URLs hold memory; a restored chip's
 *  server URL is a plain string. */
function revokePreview(url: string | undefined) {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url)
}

let nextUploadKey = 0

/** Debounce for persisting the composer text to the draft store. Attachment
 *  and skill-chip changes flush immediately (they are rarer and matter more). */
const DRAFT_SAVE_MS = 300

/** Identity of a draft's non-text parts (which draft, which uploads, which
 *  skill). A change here is "structural" and persists at once; a change in
 *  the text alone is debounced. */
function draftSignature(
  id: string,
  uploads: PendingUpload[],
  skill: string | null | undefined,
): string {
  return `${id}\n${uploads.map((p) => p.id ?? "").join(",")}\n${skill ?? ""}`
}

/** Rebuild composer chips from a stored draft: every entry already has its
 *  upload id, so the chips are sendable at once; previews point at the
 *  server copy (the original `File` did not survive the page). */
function uploadsFromDraft(
  draft: ComposerDraft | null,
  uploadUrl: (id: string, name?: string) => string,
): PendingUpload[] {
  if (!draft) return []
  return draft.attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).map((a) => ({
    key: nextUploadKey++,
    name: a.name,
    kind: a.kind,
    size: a.size,
    previewUrl: a.kind === "image" ? uploadUrl(a.id) : uploadUrl(a.id, a.name),
    id: a.id,
    lines: a.lines,
  }))
}

/** Max attachments per message, images + files combined. */
const MAX_ATTACHMENTS_PER_MESSAGE = 5

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const FILE_MAX_BYTES = 20 * 1024 * 1024

/** Compressible image types (the upload endpoint's image set). Anything else
 *  — including other `image/*` like SVG — uploads as a plain file. */
const IMAGE_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

/** Attachment references off a `queue` frame item. The server sends the
 *  full `Attachment` records; anything malformed (or a bare count from an
 *  older server) reads as "no previewable attachments" rather than a crash. */
function queuedAttachments(raw: unknown): AttachmentView[] {
  if (!Array.isArray(raw)) return []
  const out: AttachmentView[] = []
  for (const a of raw) {
    if (!a || typeof a !== "object") continue
    const r = a as Record<string, unknown>
    if (typeof r.id !== "string" || !r.id) continue
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name ? r.name : null,
      mime: typeof r.mime === "string" && r.mime ? r.mime : null,
      size: typeof r.size === "number" ? r.size : null,
      lines: typeof r.lines === "number" ? r.lines : null,
    })
  }
  return out
}

/** localStorage namespace for the per-session model override. */
const MODEL_KEY_PREFIX = "agent.model."

function readModelOverride(sid: string): string {
  try {
    return localStorage.getItem(`${MODEL_KEY_PREFIX}${sid}`) ?? ""
  } catch {
    /* private mode / quota: the override simply stays unread */
  }
  return ""
}

function writeModelOverride(sid: string, model: string) {
  try {
    if (model) localStorage.setItem(`${MODEL_KEY_PREFIX}${sid}`, model)
    else localStorage.removeItem(`${MODEL_KEY_PREFIX}${sid}`)
  } catch {
    /* private mode / quota: selection stays in memory */
  }
}

/** Per-session reasoning-effort override, mirroring the model override. */
const EFFORT_KEY_PREFIX = "agent.effort."

function readEffortOverride(sid: string): string {
  try {
    return localStorage.getItem(`${EFFORT_KEY_PREFIX}${sid}`) ?? ""
  } catch {
    return ""
  }
}

function writeEffortOverride(sid: string, effort: string) {
  try {
    if (effort) localStorage.setItem(`${EFFORT_KEY_PREFIX}${sid}`, effort)
    else localStorage.removeItem(`${EFFORT_KEY_PREFIX}${sid}`)
  } catch {
    /* private mode / quota: selection stays in memory */
  }
}

/** Per-session model tuning: catalog parameter values (`thinking`,
 *  `context`, `effort`…) plus the max-mode flag, one JSON record per session
 *  so a re-opened session keeps the picks made in it. */
const TUNING_KEY_PREFIX = "agent.tuning."

interface TuningOverride {
  parameters: Record<string, string>
  maxMode: boolean
}

function readTuningOverride(sid: string): TuningOverride {
  try {
    const raw = localStorage.getItem(`${TUNING_KEY_PREFIX}${sid}`)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TuningOverride>
      const parameters: Record<string, string> = {}
      if (parsed.parameters && typeof parsed.parameters === "object") {
        for (const [k, v] of Object.entries(parsed.parameters)) {
          if (typeof v === "string" && v) parameters[k] = v
        }
      }
      return { parameters, maxMode: parsed.maxMode === true }
    }
  } catch {
    /* private mode / corrupt record: fall through to defaults */
  }
  return { parameters: {}, maxMode: false }
}

function writeTuningOverride(sid: string, tuning: TuningOverride) {
  const parameters: Record<string, string> = {}
  for (const [k, v] of Object.entries(tuning.parameters)) if (v.trim()) parameters[k] = v
  const empty = Object.keys(parameters).length === 0 && !tuning.maxMode
  try {
    if (empty) localStorage.removeItem(`${TUNING_KEY_PREFIX}${sid}`)
    else localStorage.setItem(`${TUNING_KEY_PREFIX}${sid}`, JSON.stringify({ parameters, maxMode: tuning.maxMode }))
  } catch {
    /* private mode / quota: selection stays in memory */
  }
}

/** Downscale + re-encode an image for upload (max edge 1600px, JPEG q0.8).
 *  Falls back to the original blob when decoding fails (e.g. GIFs keep
 *  animation by skipping re-encode). */
async function compressImage(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file
  try {
    const bitmap = await createImageBitmap(file)
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 512 * 1024) return file
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext("2d")
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    )
    return blob ?? file
  } catch {
    return file
  }
}

/** Persisted transcript (`history` frame / `GET /api/sessions/{id}`) → UI
 *  messages. Used by both the stream path (wholesale replace on `history`)
 *  and the REST load of an idle session — one conversion, one behavior. */
function convertHistory(msgs: MessageView[]): Message[] {
  const loaded: Message[] = []
  for (const m of msgs) {
    if (m.role === "user") {
      loaded.push({
        id: nextMsgId++,
        role: "user",
        content: m.content || "",
        summaryMarker: (m.content || "").startsWith("[Conversation Summary]") || undefined,
        attachments: m.attachments?.length
          ? m.attachments.map((a) => ({ id: a.id, name: a.name || undefined }))
          : undefined,
      })
    } else if (m.role === "assistant") {
      const visibleCalls = m.tool_calls?.filter((tc) => tc.function.name !== "read_skill")
      if (m.content || m.reasoning_content || !m.tool_calls?.length) {
        loaded.push({
          id: nextMsgId++,
          role: "assistant",
          content: m.content || "",
          reasoning: m.reasoning_content || undefined,
        })
      }
      if (visibleCalls) {
        for (const tc of visibleCalls) {
          loaded.push({
            id: nextMsgId++,
            role: "tool",
            content: "",
            toolCallId: tc.id,
            toolName: tc.function.name,
            toolArgs: tc.function.arguments,
          })
        }
      }
    } else if (m.role === "tool") {
      const callId = m.tool_call_id || undefined
      const pending = callId
        ? loaded.find(
            (x) => x.role === "tool" && x.toolCallId === callId && x.toolResult === undefined,
          )
        : [...loaded].reverse().find((x) => x.role === "tool" && x.toolResult === undefined)
      if (pending) pending.toolResult = m.content || ""
    }
  }
  return loaded
}

interface PendingConfirm {
  id: string
  name: string
  arguments: string
}

interface PendingAskUser {
  id: string
  questions: AskQuestion[]
  /** Unattended (full-auto) sessions: seconds until the backend auto-picks
   *  each question's recommended default. Drives the bar's countdown. */
  timeoutSecs?: number | null
}

export const AgentChat = forwardRef<AgentChatHandle, AgentChatProps>(function AgentChat(
  props,
  ref,
) {
  const {
    basePath = "",
    toolRenderers,
    theme,
    labels,
    enableHistory = true,
    enableExport = true,
    modelName: modelNameProp,
    onSessionChange,
    onTitleChange,
    onBack,
    hideSidebar = false,
    sessionHref,
  } = props

  const client = useMemo(() => createChatClient(basePath), [basePath])
  const renderers = useMemo<Record<string, ToolRenderer>>(
    () => ({ ...defaultToolRenderers, ...(toolRenderers ?? {}) }),
    [toolRenderers],
  )
  useMemo(() => setLabels(labels), [labels])

  const [messages, setMessages] = useState<Message[]>([])
  // Read-during-render mirror for stable runtime callbacks (findToolCall):
  // a callback closing over `messages` would churn the runtime context value
  // — and every card consuming it — on each streamed token.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Composer draft (lib/composer-draft): text, staged attachments and the
  // pending `/skill` chip survive a reload. The fresh chat's draft seeds the
  // initial state; a session's draft is swapped in by `switchDraft` when it
  // is opened. `draftIdRef` names the draft the composer currently holds.
  const [initialDraft] = useState(() => readDraft(NEW_CHAT_DRAFT_ID))
  const draftIdRef = useRef(NEW_CHAT_DRAFT_ID)
  const [input, setInput] = useState(initialDraft?.text ?? "")
  const inputRef = useRef(input)
  inputRef.current = input
  // Composer skill state: pending is the next-turn intent; activating bridges
  // send → authoritative SSE; active is the server-owned session context.
  const [pendingSkill, setPendingSkill] = useState<SkillInfo | null>(null)
  const pendingSkillRef = useRef<SkillInfo | null>(null)
  pendingSkillRef.current = pendingSkill
  /** Skill name from a restored draft that could not be resolved yet (the
   *  skill list had not loaded); resolved when it arrives, and kept in the
   *  persisted draft meanwhile so a second reload does not lose it. */
  const pendingSkillRestoreRef = useRef<string | null>(initialDraft?.skill ?? null)
  const [activatingSkill, setActivatingSkill] = useState<SkillInfo | null>(null)
  const [resettingSkill, setResettingSkill] = useState(false)
  const [streaming, setStreaming] = useState(false)
  /** A stored session is being fetched/attached: show a centered spinner
   *  instead of the (misleading) welcome composer or the previous
   *  session's stale transcript. */
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  /** The session's `origin` label from the SSE `session` frame. `"task"`
   *  marks a sub-agent transcript, which is served read-only (the backend
   *  rejects posts into it too). */
  const [sessionOrigin, setSessionOrigin] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [pendingAskUser, setPendingAskUser] = useState<PendingAskUser | null>(null)
  /** Live progress per `task` sub-agent (keyed by the parent task tool_call
   *  id), fed by `subagent` frames; an entry clears when the task's own
   *  tool_result lands. `startedAt` (first frame seen) anchors the elapsed
   *  readouts. Rendered as a strip above the composer and shared with the
   *  `task` tool card via the chat runtime context. */
  const [subagentNotes, setSubagentNotes] = useState<
    Record<
      string,
      { note: string; startedAt: number; sessionId?: string; label?: string }
    >
  >({})
  /** Tasks whose per-task cancel was requested; the row shows "cancelling…"
   *  until the task's tool_result lands and clears it. */
  const [cancellingTasks, setCancellingTasks] = useState<Set<string>>(new Set())
  /** Messages parked in the server-side session queue (`queue` frames);
   *  they auto-start when the running turn ends. Ids address one item for
   *  remove/edit; `attachments` is the count riding the parked message. */
  const [queuedItems, setQueuedItems] = useState<QueuedItem[]>([])
  const queuedItemsRef = useRef<QueuedItem[]>([])
  queuedItemsRef.current = queuedItems
  // Session-scoped full-auto (backend-owned and persisted with the session;
  // synced from SSE `session` frames and session detail so a reload / second
  // tab / restart converges with the backend).
  const [autoConfirm, setAutoConfirm] = useState(false)
  /** Config default for NEW sessions (`config.default_full_auto` from meta):
   *  seeds the badge on a fresh chat before the server session exists; once a
   *  session is live, its own frames own the state. */
  const defaultFullAutoRef = useRef(false)
  /** The toggle was flipped on a fresh chat (no server session yet): the
   *  choice rides along on the first send (`full_auto`) so the session is
   *  created in that mode — even its first tool call honours it. `null` =
   *  untouched, follow the configured default. */
  const preSessionAutoRef = useRef<boolean | null>(null)
  const [modelName, setModelName] = useState(modelNameProp ?? "")
  // Upstream-advertised models (empty = switcher stays a read-only badge) and
  // the per-session override the user picked. `selectedModel` empty = follow
  // the configured default (`modelName`).
  const [availableModels, setAvailableModels] = useState<string[]>([])
  // Per-model capability records from /api/models (`caps`): effort levels,
  // thinking mode, etc. Always contains the configured default model.
  const [modelCaps, setModelCaps] = useState<Record<string, ModelCaps>>({})
  const [selectedModel, setSelectedModel] = useState("")
  const selectedModelRef = useRef("")
  selectedModelRef.current = selectedModel
  // Per-session reasoning-effort override ("" = the model's default). Reset
  // whenever the model changes — each model has its own level set/default.
  const [selectedEffort, setSelectedEffort] = useState("")
  const selectedEffortRef = useRef("")
  selectedEffortRef.current = selectedEffort
  // Structured model catalog from /api/models (`catalog`, optional; absent on vinx today):
  // base models + parameter definitions + variants. Empty = flat models.
  const [modelCatalog, setModelCatalog] = useState<CatalogModel[]>([])
  // Per-session catalog parameter values by definition id ("" / absent = the
  // model's default) and the max-mode flag. Reset on model switch — each
  // model has its own parameter space.
  const [selectedParameters, setSelectedParameters] = useState<Record<string, string>>({})
  const selectedParametersRef = useRef<Record<string, string>>({})
  selectedParametersRef.current = selectedParameters
  const [maxMode, setMaxMode] = useState(false)
  const maxModeRef = useRef(false)
  maxModeRef.current = maxMode
  /** Persist the in-memory (pre-session) tuning picks under a fresh session
   *  id, so the sessionId effect re-reads them instead of resetting. */
  const carryTuningTo = (sid: string) => {
    const parameters = selectedParametersRef.current
    const max = maxModeRef.current
    if (Object.values(parameters).some((v) => v.trim()) || max) {
      writeTuningOverride(sid, { parameters, maxMode: max })
    }
  }
  // Transcript-wide expand/collapse of process blocks (header menu). A
  // command object is issued per click; every mounted block applies it once.
  // Cleared on session switch so a stale command cannot reach the next
  // transcript's blocks.
  const [foldCommand, setFoldCommand] = useState<FoldCommand | null>(null)
  const foldSeqRef = useRef(0)
  const foldAll = useCallback((mode: FoldCommand["mode"]) => {
    setFoldCommand({ mode, seq: ++foldSeqRef.current })
  }, [])
  // Targeted reveal of one earlier tool call (lib/reveal): issued by the
  // recall_result card's "show original". Retracted after the fold
  // transitions have had time to run, so a card that remounts later does
  // not replay it (a reveal IS applied on mount — the target usually mounts
  // because its group just unfolded for it).
  const [revealCommand, setRevealCommand] = useState<RevealCommand | null>(null)
  const revealSeqRef = useRef(0)
  const revealTimerRef = useRef<number | undefined>(undefined)
  const revealToolCall = useCallback((callId: string) => {
    setRevealCommand({ callId, seq: ++revealSeqRef.current })
    window.clearTimeout(revealTimerRef.current)
    revealTimerRef.current = window.setTimeout(() => setRevealCommand(null), 1500)
  }, [])
  useEffect(() => () => window.clearTimeout(revealTimerRef.current), [])
  /** The transcript's own record of an earlier tool call, for cards that
   *  refer to one (recall_result). Reads the render-time mirror: the row is
   *  older than the card asking, so it is settled by then. */
  const findToolCall = useCallback((callId: string) => {
    const row = messagesRef.current.find((m) => m.role === "tool" && m.toolCallId === callId)
    return row ? { name: row.toolName ?? "", args: row.toolArgs } : undefined
  }, [])
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>(() =>
    uploadsFromDraft(initialDraft, client.uploadUrl),
  )
  const pendingUploadsRef = useRef<PendingUpload[]>([])
  pendingUploadsRef.current = pendingUploads
  /** Full-screen image preview (composer chips + transcript thumbnails). */
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null)
  /** Non-image attachment opened from the queue strip (text head / download). */
  const [filePreview, setFilePreview] = useState<AttachmentView | null>(null)
  /** A queue-row chip was clicked: images go to the lightbox, files to the
   *  file preview modal. */
  const handlePreviewAttachment = useCallback(
    (a: AttachmentView) => {
      if (isImageUploadId(a.id)) setLightbox({ src: client.uploadUrl(a.id), alt: a.name || a.id })
      else setFilePreview(a)
    },
    [client],
  )
  const [chatTitle, setChatTitle] = useState("")
  // Mirror every header-title change (load / auto-title / rename / new chat)
  // to the host in one place, so no `setChatTitle` call site can forget it.
  // Ref-routed: a new callback identity must not re-fire the current title.
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange
  useEffect(() => {
    onTitleChangeRef.current?.(chatTitle)
  }, [chatTitle])
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  // The open session's category (header tag pill). Seeded from the session
  // detail on resume, kept in step with the sidebar list (which the sessions
  // page also mutates), and updated optimistically by the header picker.
  const [sessionCategory, setSessionCategory] = useState<string | null>(null)
  const knownCategories = useMemo(() => {
    const seen = new Set<string>()
    for (const s of sessions) if (s.category) seen.add(s.category)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [sessions])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  // Name of the skill steering the conversation (driven by live `skill` events;
  // null = none). Powers the composer pill + one-click /reset.
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  // Welcome-screen branding + suggestion chips, all opt-in via `/api/chat/meta`
  // (config `meta` / meta.json): hosts customize without touching the library.
  const [welcomeMeta, setWelcomeMeta] = useState<{
    logo?: string
    tagline?: string
    suggestions?: string[]
  }>({})
  // Narrow viewport (phone): the history panel renders as an overlay drawer
  // instead of a flex sibling that would squeeze the chat column — and starts
  // closed there, so first paint isn't a drawer over the welcome composer.
  const isNarrow = useMediaQuery(MOBILE_QUERY)
  const [historyOpen, setHistoryOpen] = useState(() => !isNarrow)
  const [historyAvailable, setHistoryAvailable] = useState(enableHistory)

  // Archived pre-compaction history ("generations"): a context compaction
  // replaces the working transcript with a summary, but the full original is
  // archived server-side. The transcript offers a collapsed "compacted
  // history" expander at its top; contents are lazy-loaded on first open.
  const [archiveGens, setArchiveGens] = useState<ArchiveGeneration[]>([])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveMessages, setArchiveMessages] = useState<Message[] | null>(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const archiveFetchRef = useRef(false)
  const archiveGenCountRef = useRef(0)
  const archiveEndRef = useRef<HTMLDivElement>(null)

  // Auto-fold on viewport transitions: crossing into narrow collapses the
  // panel (otherwise it lingers as a drawer overlay covering the chat);
  // returning to wide restores the wide default (open).
  const prevNarrowRef = useRef(isNarrow)
  useEffect(() => {
    if (prevNarrowRef.current === isNarrow) return
    prevNarrowRef.current = isNarrow
    setHistoryOpen(!isNarrow)
  }, [isNarrow])

  // Drawer dismissal parity with the backdrop click: Escape closes it too.
  useEffect(() => {
    if (!isNarrow || !historyOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isNarrow, historyOpen])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const toolArgsRef = useRef<Record<string, string>>({})
  const hiddenToolIdsRef = useRef<Set<string>>(new Set())
  const skillActionRef = useRef<
    | { op: "activate"; skill: SkillInfo }
    | { op: "reset" }
    | null
  >(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId

  // ── Composer draft persistence ──
  // Everything the composer holds is written under `draftIdRef.current`:
  // text changes debounced, attachment / skill-chip changes at once (a chip
  // still uploading has no id and is skipped — it cannot be restored). The
  // three send paths clear text + chips, which the same effect turns into a
  // removal, so a sent message never leaves a draft behind and a failed send
  // that hands the text back re-creates it. Hiding the tab flushes the
  // pending write: `beforeunload` is unreliable on mobile, `pagehide` /
  // `visibilitychange` fire before the page is frozen or killed.
  const draftTimerRef = useRef<number | null>(null)
  const draftSigRef = useRef<string | null>(null)
  const persistDraftNow = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    const attachments = pendingUploadsRef.current
      .filter((p): p is PendingUpload & { id: string } => !!p.id)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, size: p.size, lines: p.lines }))
    writeDraft(draftIdRef.current, {
      text: inputRef.current,
      attachments,
      skill: pendingSkillRef.current?.name ?? pendingSkillRestoreRef.current ?? undefined,
      updatedAt: Date.now(),
    })
  }, [])
  useEffect(() => {
    const sig = draftSignature(draftIdRef.current, pendingUploads, pendingSkill?.name)
    const structural = sig !== draftSigRef.current
    draftSigRef.current = sig
    if (structural) {
      persistDraftNow()
      return
    }
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null
      persistDraftNow()
    }, DRAFT_SAVE_MS)
  }, [input, pendingUploads, pendingSkill, persistDraftNow])
  // Background-tab attention signals (title badge + chime): document-level
  // listeners live for the component's lifetime.
  useEffect(() => installAlerts(), [])

  useEffect(() => {
    const flush = () => {
      if (draftTimerRef.current !== null) persistDraftNow()
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibility)
      // Unmount: persist whatever is still pending (host navigated away).
      flush()
    }
  }, [persistDraftNow])
  // One sweep per page load: forget drafts nobody came back to in a week.
  useEffect(() => {
    sweepDrafts()
  }, [])

  const skillsRef = useRef<SkillInfo[]>([])
  skillsRef.current = skills
  /** The skill list has answered once (even empty / 404): restored skill
   *  names can be resolved or dropped from here on. */
  const skillsLoadedRef = useRef(false)

  /** Turn a restored draft's skill NAME into the chip, once the skill list is
   *  known. Until then the name stays in `pendingSkillRestoreRef` (and so in
   *  the persisted draft, so a second reload keeps it); an unknown or
   *  disabled skill is dropped quietly and the draft rewritten without it. */
  const resolveRestoredSkill = useCallback(() => {
    const name = pendingSkillRestoreRef.current
    if (!name || !skillsLoadedRef.current) return
    pendingSkillRestoreRef.current = null
    const skill = skillsRef.current.find(
      (s) => s.name === name && s.user_invocable && s.enabled !== false,
    )
    if (skill) {
      // Ref first: a flush before the re-render must still see the skill.
      pendingSkillRef.current = skill
      setPendingSkill(skill)
    } else {
      persistDraftNow()
    }
  }, [persistDraftNow])

  /** Point the composer at another draft: flush the current one under its
   *  own id, then load `id`'s stored text / chips / skill chip. Chips from
   *  files picked in THIS page hold object URLs and are released. Called by
   *  new-chat and session-open, never by the send paths — a session minted
   *  by a send inherits the fresh chat's composer, see `adoptDraftId`. */
  const switchDraft = useCallback(
    (id: string) => {
      if (draftIdRef.current === id) return
      if (draftTimerRef.current !== null) persistDraftNow()
      pendingUploadsRef.current.forEach((p) => revokePreview(p.previewUrl))
      const draft = readDraft(id)
      const text = draft?.text ?? ""
      const uploads = uploadsFromDraft(draft, client.uploadUrl)
      draftIdRef.current = id
      // Mirror into the refs now: a flush racing the re-render must never
      // write the previous composer under the new id.
      inputRef.current = text
      pendingUploadsRef.current = uploads
      pendingSkillRef.current = null
      pendingSkillRestoreRef.current = draft?.skill ?? null
      setInput(text)
      setPendingUploads(uploads)
      setPendingSkill(null)
      resolveRestoredSkill()
      // The persistence effect then sees a new signature (the id changed)
      // and rewrites what was just read — a harmless touch.
    },
    [client, persistDraftNow, resolveRestoredSkill],
  )

  /** A send on the fresh chat named a session: the composer (emptied by the
   *  send) now belongs to that session. The `new` record is dropped rather
   *  than flushed — a debounced write still pending would otherwise land
   *  under the wrong id — and anything typed since the send moves along. */
  const adoptDraftId = useCallback(
    (sid: string) => {
      if (draftIdRef.current !== NEW_CHAT_DRAFT_ID) return
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current)
        draftTimerRef.current = null
      }
      clearDraft(NEW_CHAT_DRAFT_ID)
      draftIdRef.current = sid
      persistDraftNow()
    },
    [persistDraftNow],
  )

  /** A restored image chip whose upload is gone (runtime cache cleared, other
   *  agent): drop the chip and say so, rather than send a dangling reference
   *  the server would silently strip. Only server-backed previews count — a
   *  `blob:` preview that fails to decode says nothing about the upload. */
  const handleUploadPreviewError = useCallback((key: number) => {
    const gone = pendingUploadsRef.current.find((p) => p.key === key)
    if (!gone?.id || !gone.previewUrl || gone.previewUrl.startsWith("blob:")) return
    toast.warning(tf("draftAttachmentGone", gone.name))
    setPendingUploads((prev) => prev.filter((p) => p.key !== key))
  }, [])

  // Archive expander lifecycle. Reset on session switch; (re)fetch the
  // generation list whenever the session goes idle — a compaction that just
  // happened during the finished turn becomes visible right away.
  useEffect(() => {
    setArchiveGens([])
    setArchiveOpen(false)
    setArchiveMessages(null)
    archiveGenCountRef.current = 0
  }, [sessionId])
  useEffect(() => {
    if (!sessionId || streaming) return
    let stale = false
    client.listSessionArchive(sessionId).then((gens) => {
      if (stale || sessionIdRef.current !== sessionId) return
      // A new generation appeared (compaction during the turn): drop the
      // loaded copy so the next expand refetches the complete set.
      if (gens.length !== archiveGenCountRef.current) setArchiveMessages(null)
      archiveGenCountRef.current = gens.length
      setArchiveGens(gens)
    })
    return () => {
      stale = true
    }
  }, [client, sessionId, streaming])
  // Lazy-load all generations on first expand (and again after invalidation).
  useEffect(() => {
    if (!archiveOpen || archiveMessages !== null || archiveFetchRef.current) return
    const sid = sessionIdRef.current
    if (!sid) return
    archiveFetchRef.current = true
    setArchiveLoading(true)
    ;(async () => {
      const loaded: Message[] = []
      try {
        const gens = await client.listSessionArchive(sid)
        for (const g of gens) {
          loaded.push(...convertHistory(await client.getSessionArchive(sid, g.generation)))
        }
      } catch {
        /* partial/empty result renders what we have; a reopen retries */
      }
      archiveFetchRef.current = false
      setArchiveLoading(false)
      if (sessionIdRef.current === sid) setArchiveMessages(loaded)
    })()
  }, [archiveOpen, archiveMessages, client])
  /** From the stream's `session` frame: whether a turn is live. Decides if
   *  the following `history` frame appends a streaming placeholder. */
  const streamRunningRef = useRef(false)
  /** Session-load generation: bumped by every resumeSession/newChat so a
   *  slow, superseded getSession response cannot clobber the view the user
   *  has since navigated to (rapid session switching on slow loads). */
  const loadGenRef = useRef(0)

  // ── Streaming delta throttle + typewriter smoothing ──
  // Applying every SSE frame directly means one full markdown re-parse of the
  // growing message per provider chunk (cost grows with message length). Text
  // deltas are buffered here and drained by a DELTA_FLUSH_MS tick that
  // releases at most a slice of the backlog per step (takeSmoothPrefix), so
  // providers that batch tokens into large infrequent chunks render as a
  // steady typewriter instead of block-pause-block. Structural events flush
  // the whole buffer synchronously first so ordering is preserved. `toolArgs`
  // holds the ids of tool calls whose accumulated args (in toolArgsRef) need
  // syncing into state.
  const pendingDeltasRef = useRef<{ content: string; reasoning: string; toolArgs: Set<string> }>({
    content: "",
    reasoning: "",
    toolArgs: new Set(),
  })
  const flushTimerRef = useRef<number | null>(null)
  /** Burst-interval estimate for typewriter pacing (see SMOOTH_GAP_MIN_MS).
   *  `lastArrivalMs = 0` means "no arrival yet this turn"; the learned EMA
   *  survives across turns since it characterizes the provider. */
  const smoothPaceRef = useRef({ lastArrivalMs: 0, emaMs: SMOOTH_EMA_INITIAL_MS })
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Empty = new chat: composer is centered in the content area instead of
  // pinned to the bottom. Declared early so effects can depend on it. A
  // session being loaded is NOT "empty" — it gets a spinner, not the welcome.
  const isEmpty = messages.length === 0 && !streaming && !sessionLoading

  // Capabilities + branding from /api/chat/meta.
  useEffect(() => {
    let alive = true
    client
      .getMeta()
      .then((m) => {
        if (!alive || !m) return
        if (!modelNameProp && typeof m.model === "string") setModelName(m.model)
        if (m.history === false) setHistoryAvailable(false)
        else if (enableHistory) setHistoryAvailable(true)
        setWelcomeMeta({
          logo: typeof m.logo === "string" && m.logo ? m.logo : undefined,
          tagline: typeof m.tagline === "string" && m.tagline ? m.tagline : undefined,
          suggestions: Array.isArray(m.suggestions)
            ? (m.suggestions as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 4)
            : undefined,
        })
        // New sessions start at the configured full-auto default. Seed the
        // badge for the fresh-chat view only — a live session's state
        // arrives on its own `session` frames.
        const defaultFullAuto = m.config?.default_full_auto === true
        defaultFullAutoRef.current = defaultFullAuto
        if (defaultFullAuto && !sessionIdRef.current && preSessionAutoRef.current === null) {
          setAutoConfirm(true)
        }
      })
      .catch(() => {
        if (alive) toast.error(t("loadFailed"))
      })
    return () => {
      alive = false
    }
  }, [client, enableHistory, modelNameProp])

  // Upstream model list for the chat-input switcher (best-effort; empty on
  // unsupported endpoints keeps the badge read-only).
  useEffect(() => {
    let alive = true
    client
      .getModels()
      .then((m) => {
        if (!alive) return
        setAvailableModels(m.models)
        setModelCaps(m.caps)
        setModelCatalog(m.catalog)
      })
      .catch(() => {
        /* switcher simply stays read-only */
      })
    return () => {
      alive = false
    }
  }, [client])

  // Session-scoped model choice (localStorage). Re-read on session switch; a
  // pre-session pick made on the empty composer is persisted in the `session`
  // frame handler before this runs, so it survives the transition.
  useEffect(() => {
    if (!sessionId) {
      setSelectedModel("")
      setSelectedEffort("")
      setSelectedParameters({})
      setMaxMode(false)
      return
    }
    setSelectedModel(readModelOverride(sessionId))
    setSelectedEffort(readEffortOverride(sessionId))
    const tuning = readTuningOverride(sessionId)
    setSelectedParameters(tuning.parameters)
    setMaxMode(tuning.maxMode)
  }, [sessionId])

  const handleSelectModel = useCallback(
    (model: string) => {
      // Treat "pick the default" as clearing the override so the session tracks
      // the configured default even if it later changes.
      const next = model === modelName ? "" : model
      setSelectedModel(next)
      // A model switch resets the effort override: each model has its own
      // level set and default, so a carried-over pick would be misleading
      // (and possibly invalid).
      setSelectedEffort("")
      // Same for catalog parameter values and max mode — they are defined per
      // base model (a `context: 1m` pick is meaningless on a 200k model).
      setSelectedParameters({})
      setMaxMode(false)
      const sid = sessionIdRef.current
      if (!sid) return
      writeModelOverride(sid, next)
      writeEffortOverride(sid, "")
      writeTuningOverride(sid, { parameters: {}, maxMode: false })
    },
    [modelName],
  )

  const handleSelectEffort = useCallback((effort: string) => {
    setSelectedEffort(effort)
    const sid = sessionIdRef.current
    if (sid) writeEffortOverride(sid, effort)
  }, [])

  // Parameter / max-mode picks persist per session (like model and effort).
  // Before the first message they live in memory and are carried onto the
  // new session id by the `session` frame / send-ack handlers.
  const handleSelectParameter = useCallback((id: string, value: string) => {
    const next = { ...selectedParametersRef.current, [id]: value }
    setSelectedParameters(next)
    const sid = sessionIdRef.current
    if (sid) writeTuningOverride(sid, { parameters: next, maxMode: maxModeRef.current })
  }, [])

  const handleToggleMaxMode = useCallback((on: boolean) => {
    setMaxMode(on)
    const sid = sessionIdRef.current
    if (sid) writeTuningOverride(sid, { parameters: selectedParametersRef.current, maxMode: on })
  }, [])

  // Capability record of the model the next turn will use (override or the
  // configured default) — drives the effort badge next to the model switcher.
  const currentCaps: ModelCaps | undefined = modelCaps[selectedModel || modelName]

  // Catalog record of that same model (structured catalog only): resolves the flat
  // name against base names, legacy slugs and aliases, because the configured
  // `modelName` may still be a legacy variant slug like `gpt-6.1-high`.
  const currentCatalogModel: CatalogModel | undefined = useMemo(() => {
    const name = (selectedModel || modelName).trim()
    if (!name || !modelCatalog.length) return undefined
    return (
      modelCatalog.find((m) => m.name === name) ??
      modelCatalog.find((m) => m.serverModelName === name) ??
      modelCatalog.find((m) => m.legacySlugs.includes(name)) ??
      modelCatalog.find((m) => m.variants.some((v) => v.legacySlug === name)) ??
      modelCatalog.find((m) => m.idAliases.includes(name))
    )
  }, [modelCatalog, selectedModel, modelName])

  // The parameter values / max-mode flag that actually ride a send: only when
  // the CURRENT model defines them (mirrors the effort guard below). Refs so
  // send callbacks never see stale closure values.
  const parametersForSend: [string, string][] = useMemo(() => {
    const defs = currentCatalogModel?.parameters ?? []
    if (!defs.length) return []
    const out: [string, string][] = []
    for (const def of defs) {
      const v = selectedParameters[def.id]?.trim()
      if (v) out.push([def.id, v])
    }
    return out
  }, [currentCatalogModel, selectedParameters])
  const parametersForSendRef = useRef<[string, string][]>([])
  parametersForSendRef.current = parametersForSend
  const maxModeForSend = currentCatalogModel?.supportsMaxMode ? maxMode : false
  const maxModeForSendRef = useRef(false)
  maxModeForSendRef.current = maxModeForSend

  // The effort that actually rides a send: only when the CURRENT model
  // advertises levels. A stale per-session override (picked on a previous
  // model whose badge has since disappeared) must not be blind-sent — with
  // the badge hidden there would be no way to clear it from the UI. Ref
  // mirror so the send callbacks never see a stale closure value.
  const effortForSend = currentCaps?.effortLevels.length ? selectedEffort : ""
  const effortForSendRef = useRef("")
  effortForSendRef.current = effortForSend

  const refreshSessions = useCallback(() => {
    if (!historyAvailable) return
    client
      .listSessions()
      .then((list) => setSessions(Array.isArray(list) ? list : []))
      .catch(() => toast.error(t("loadFailed")))
  }, [client, historyAvailable])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // Discover skills for the `/` command palette, re-fetching when the window
  // regains focus so palette icons/entries stay in sync with edits made on the
  // skills page. Deliberately silent on failure: the endpoint 404s when the
  // agent has no skill registry.
  useEffect(() => {
    let alive = true
    const refresh = () => {
      client
        .listSkills()
        .then((r) => {
          if (!alive) return
          // Ref before state: the `finally` below resolves against the ref.
          skillsRef.current = r.skills
          setSkills(r.skills)
        })
        .catch(() => {})
        .finally(() => {
          // Either way the registry has spoken (a 404 = no skills at all):
          // a restored draft's skill chip can now be resolved or dropped.
          if (!alive || skillsLoadedRef.current) return
          skillsLoadedRef.current = true
          resolveRestoredSkill()
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      alive = false
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [client, resolveRestoredSkill])

  // ── Sticky autoscroll ──
  // One intent bit, `followRef`, says whether the reader is following the
  // tail. It is the ONLY input to autoscroll; geometry (scrollTop vs
  // scrollHeight) never decides on its own. The bit is set by the reader's
  // actions (send, jump-to-bottom, scrolling to the bottom) and cleared by
  // exactly one thing: the reader scrolling up. Every content change that
  // lands while it is set re-pins the container — the optimistic bubbles, the
  // `history` rebuild of the whole transcript, each token flush, AND the
  // silent height changes that go through no React state at all (a step
  // group auto-folding after the turn, a mermaid block swapping its code view
  // for the SVG, images decoding).
  //
  // Why not derive "at bottom" from the previous scrollHeight (the earlier
  // design): those silent height changes left that number stale, so the send
  // after a folded turn read as "reader scrolled up", and a `history` rebuild
  // landing mid-glide (localhost: ~20ms) stranded the smooth scroll on a
  // target computed for the OLD layout — the new bubble ended up below the
  // fold with the button suppressed. `showJumpToBottom` surfaces the floating
  // button when the reader has scrolled away, so new output is never silently
  // missed.
  const STICK_THRESHOLD = 80
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const followRef = useRef(true)
  // Set for the span of a smooth scroll WE started: the scroll events it
  // fires along the way must not read as the reader scrolling up (mid-glide
  // the container IS >80px from the bottom for a few frames). Cleared on
  // arrival, on `scrollend`, by a timeout past any plausible glide duration
  // (a glide the browser skips — reduced motion, hidden tab — never fires
  // either event), by content landing (see `pinToBottom`), or the moment the
  // reader touches the wheel / screen.
  const glidingRef = useRef(false)
  const glideTimerRef = useRef<number | null>(null)
  const endGlide = useCallback(() => {
    glidingRef.current = false
    if (glideTimerRef.current !== null) {
      window.clearTimeout(glideTimerRef.current)
      glideTimerRef.current = null
    }
  }, [])
  const isAtBottom = (c: HTMLElement) =>
    c.scrollTop + c.clientHeight >= c.scrollHeight - STICK_THRESHOLD
  // A programmatic pin fires a scroll event too (async, next frame). It moves
  // toward the bottom, so it cannot mean "the reader left" — but it can land
  // between two pins of a fast stream while a taller layout has already made
  // the container "not at bottom" again. This flag spans pin → its event.
  // Counted, not boolean: several pins can land in one frame (layout effect
  // + resize observer) and each schedules its own release.
  const pinningRef = useRef(0)
  const pinToBottom = useCallback((c: HTMLElement) => {
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 1) return
    // Content landing mid-glide cuts the glide: re-issuing a smooth scroll
    // per token would restart its easing every time and never arrive.
    if (glidingRef.current) endGlide()
    pinningRef.current++
    c.scrollTop = c.scrollHeight
    // The event (if any — none when the content grew below the fold without
    // moving the thumb) lands before the next frame; release after it.
    requestAnimationFrame(() => {
      pinningRef.current = Math.max(0, pinningRef.current - 1)
    })
  }, [endGlide])
  // Scroll events tell us two things: where the reader is (button) and, when
  // the scroll is theirs, whether they left the tail (intent). Ours (an
  // autoscroll pin or a glide in flight) only ever move toward the bottom,
  // so they may confirm the intent, never revoke it. A reader scroll that
  // leaves the tail is recognised by direction: scrollTop went DOWN in value
  // (content moved away from the bottom); a pin or content growth never does.
  const lastScrollTopRef = useRef(0)
  const handleContainerScroll = useCallback(() => {
    const c = messagesContainerRef.current
    if (!c) return
    const atBottom = isAtBottom(c)
    const movedUp = c.scrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = c.scrollTop
    if (glidingRef.current) {
      if (atBottom) endGlide()
      return
    }
    if (atBottom) followRef.current = true
    else if (movedUp && pinningRef.current === 0) followRef.current = false
    setShowJumpToBottom(!atBottom)
  }, [endGlide])
  // Input that can only come from the reader. It ends any glide right away
  // (the reader wins), and an upward wheel drops the follow bit BEFORE the
  // scroll it causes — so a token flush landing in between cannot pin the
  // reader back down. If the wheel was too small to leave the tail, the
  // scroll event that follows raises the bit again. A wheel-up that cannot
  // scroll anything (already at the top, or no overflow yet) is ignored: it
  // fires no scroll event to correct the bit, and a transcript that has yet
  // to overflow must still follow once it does. Passive: the browser's own
  // scrolling must not wait on us.
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (glidingRef.current) endGlide()
      const c = messagesContainerRef.current
      if (e.deltaY < 0 && c && c.scrollTop > 0) followRef.current = false
    },
    [endGlide],
  )
  const handleTouchStart = useCallback(() => {
    if (glidingRef.current) endGlide()
  }, [endGlide])
  // The one smooth scroll in the transcript, for the reader's own actions
  // (jump button, send). Sets the intent first: content that lands during
  // the glide goes through `pinToBottom`, which ends the glide with an
  // instant pin to the new bottom instead of stranding it on the old one.
  const glideToBottom = useCallback(() => {
    followRef.current = true
    setShowJumpToBottom(false)
    const c = messagesContainerRef.current
    if (!c) return
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 1) return
    glidingRef.current = true
    if (glideTimerRef.current !== null) window.clearTimeout(glideTimerRef.current)
    glideTimerRef.current = window.setTimeout(endGlide, 1200)
    c.scrollTo({ top: c.scrollHeight, behavior: "smooth" })
  }, [endGlide])
  // The transcript's content column, observed for height changes that do not
  // go through `messages` (folds, mermaid, images). Only the column is
  // observed: the scroll container itself grows/shrinks with the window,
  // which is not content.
  const contentResizeObserverRef = useRef<ResizeObserver | null>(null)
  // Callback ref: attach the listeners the moment the messages container
  // mounts, detach when it unmounts. Driven by the node's lifecycle, NOT by a
  // guessed render condition — the container is absent during the session-load
  // spinner and the empty-state welcome, so a useEffect([isEmpty]) misses the
  // loading->loaded remount and never attaches (the bug that hid the
  // jump-to-bottom button on a resumed/refreshed session).
  const setMessagesContainer = useCallback(
    (node: HTMLDivElement | null) => {
      const prev = messagesContainerRef.current
      if (prev) {
        prev.removeEventListener("scroll", handleContainerScroll)
        prev.removeEventListener("scrollend", endGlide)
        prev.removeEventListener("wheel", handleWheel)
        prev.removeEventListener("touchstart", handleTouchStart)
      }
      contentResizeObserverRef.current?.disconnect()
      contentResizeObserverRef.current = null
      messagesContainerRef.current = node
      if (!node) return
      node.addEventListener("scroll", handleContainerScroll, { passive: true })
      node.addEventListener("scrollend", endGlide, { passive: true })
      node.addEventListener("wheel", handleWheel, { passive: true })
      node.addEventListener("touchstart", handleTouchStart, { passive: true })
      // A fresh container (new session / loading → loaded) starts at the tail.
      followRef.current = true
      lastScrollTopRef.current = 0
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          if (followRef.current) pinToBottom(node)
        })
        // Observe every direct child (the transcript column, the archive
        // expander, the print title): each is a block whose height is content.
        for (const child of Array.from(node.children)) ro.observe(child)
        contentResizeObserverRef.current = ro
      }
    },
    [handleContainerScroll, endGlide, handleWheel, handleTouchStart, pinToBottom],
  )
  // Keep the observer's child set current: the archive expander and the
  // print title mount/unmount after the container does.
  useEffect(() => {
    const ro = contentResizeObserverRef.current
    const c = messagesContainerRef.current
    if (!ro || !c) return
    ro.disconnect()
    for (const child of Array.from(c.children)) ro.observe(child)
  }, [archiveOpen, chatTitle, messages.length === 0])
  // Every transcript update pins while following. Instant on purpose: a
  // smooth scroll here would race the next token's flush and stutter.
  // Smoothness is reserved for the reader's own actions (jumpToBottom,
  // sending), where there is one target and no race. Before paint, so the
  // `history` rebuild (every row unmounted and remounted with a different
  // layout) never shows a frame at the wrong offset.
  useLayoutEffect(() => {
    const c = messagesContainerRef.current
    if (!c) return
    if (followRef.current) pinToBottom(c)
  }, [messages, pinToBottom])
  const jumpToBottom = glideToBottom

  // Outline rail entries: real user messages (not compaction markers), by
  // id. Recomputed only when a user message is added/removed — streaming
  // mutates the last assistant row, so the memo keeps its identity then and
  // the rail's scroll listener is not re-attached per token.
  const outlineSignature = useMemo(
    () => messages.filter((m) => m.role === "user" && !m.summaryMarker).map((m) => m.id).join(","),
    [messages],
  )
  const outlineEntries = useMemo<OutlineEntry[]>(
    () =>
      messages
        .filter((m) => m.role === "user" && !m.summaryMarker)
        .map((m) => ({ id: m.id, content: m.content, attachments: m.attachments?.length })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outlineSignature],
  )

  // Append the given deltas to the last assistant message / dirty tool rows
  // as one state update. Shared by the full flush (structural events) and the
  // smoothing tick (partial release).
  const applyDeltas = useCallback((content: string, reasoning: string, argIds: string[]) => {
    if (!content && !reasoning && argIds.length === 0) return
    setMessages((prev) => {
      let updated = prev
      if (content || reasoning) {
        updated = [...updated]
        for (let j = updated.length - 1; j >= 0; j--) {
          if (updated[j].role === "assistant") {
            updated[j] = {
              ...updated[j],
              content: updated[j].content + content,
              reasoning: reasoning
                ? (updated[j].reasoning || "") + reasoning
                : updated[j].reasoning,
            }
            break
          }
        }
      }
      if (argIds.length > 0) {
        updated = updated.map((m) =>
          m.role === "tool" && m.toolCallId && argIds.includes(m.toolCallId)
            ? { ...m, toolArgs: toolArgsRef.current[m.toolCallId] }
            : m,
        )
      }
      return updated
    })
  }, [])

  // Apply ALL buffered deltas as one state update (and cancel the timer).
  // Structural events (tool rows, done, error, …) call this first so they
  // never render ahead of the text that precedes them.
  const flushDeltas = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const pending = pendingDeltasRef.current
    if (!pending.content && !pending.reasoning && pending.toolArgs.size === 0) return
    const { content, reasoning } = pending
    const argIds = [...pending.toolArgs]
    pendingDeltasRef.current = { content: "", reasoning: "", toolArgs: new Set() }
    applyDeltas(content, reasoning, argIds)
  }, [applyDeltas])

  /** Self-reference so scheduleFlush and the tick it arms can refer to each
   *  other without a circular useCallback dependency. */
  const smoothTickRef = useRef<() => void>(() => {})

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        smoothTickRef.current()
      }, DELTA_FLUSH_MS)
    }
  }, [])

  /** Feed the burst-interval EMA on every text-delta arrival. Sub-250ms gaps
   *  are frames within one burst and are ignored (they would drag the
   *  estimate to ~0 and defeat the pacing). */
  const notePaceArrival = useCallback(() => {
    const pace = smoothPaceRef.current
    const now = performance.now()
    if (pace.lastArrivalMs > 0) {
      const gap = now - pace.lastArrivalMs
      if (gap >= SMOOTH_GAP_MIN_MS) {
        const clamped = Math.min(gap, SMOOTH_GAP_MAX_MS)
        pace.emaMs = pace.emaMs * (1 - SMOOTH_EMA_ALPHA) + clamped * SMOOTH_EMA_ALPHA
      }
    }
    pace.lastArrivalMs = now
  }, [])

  // One smoothing step: release a slice of the text backlog sized so the
  // whole backlog drains evenly by the time the next provider burst is
  // expected (interval-aware typewriter), and re-arm the timer while any
  // remains — a burst keeps scrolling through the silence that follows it.
  const smoothTick = useCallback(() => {
    const pending = pendingDeltasRef.current
    const estTicks = Math.max(1, smoothPaceRef.current.emaMs / DELTA_FLUSH_MS)
    const [content, contentRest] = takeSmoothPrefix(
      pending.content,
      Math.ceil(pending.content.length / estTicks),
    )
    const [reasoning, reasoningRest] = takeSmoothPrefix(
      pending.reasoning,
      Math.ceil(pending.reasoning.length / estTicks),
    )
    const argIds = [...pending.toolArgs]
    pending.content = contentRest
    pending.reasoning = reasoningRest
    pending.toolArgs = new Set()
    applyDeltas(content, reasoning, argIds)
    if (contentRest || reasoningRest) scheduleFlush()
  }, [applyDeltas, scheduleFlush])
  smoothTickRef.current = smoothTick

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current)
    }
  }, [])

  const rollbackSkillAction = useCallback(() => {
    const action = skillActionRef.current
    if (action?.op === "activate") setPendingSkill(action.skill)
    setActivatingSkill(null)
    setResettingSkill(false)
    skillActionRef.current = null
  }, [])

  const reportSendError = useCallback(
    (message: string) => {
      const failedAction = skillActionRef.current
      rollbackSkillAction()
      setMessages((prev) => {
        // A turn that died mid-compaction leaves its pending note behind;
        // the error row below is the account of what happened.
        const next = dropPendingNotes([...prev])
        const last = next[next.length - 1]
        if (
          last?.role === "assistant" &&
          !last.content &&
          !last.reasoning
        ) {
          next.pop()
        }
        if (failedAction?.op === "activate" && next[next.length - 1]?.role === "user") {
          next.pop()
        }
        return [...next, { id: nextMsgId++, role: "error", content: message }]
      })
      setStreaming(false)
      setSessionLoading(false)
    },
    [rollbackSkillAction],
  )

  /** Self-reference so the long-lived follow stream always dispatches through
   *  the CURRENT handler without being torn down on every re-render. */
  const handleEventRef = useRef<(ev: ChatEvent) => void>(() => {})
  const handleEvent = useCallback(
    (ev: ChatEvent) => {
      // Text deltas only accumulate; everything else is structural and must
      // see fully-applied text first (e.g. content before a tool row, args
      // complete before tool_result appends the next assistant message).
      switch (ev.event) {
        case "content": {
          notePaceArrival()
          pendingDeltasRef.current.content += ev.data.text ?? ""
          scheduleFlush()
          return
        }
        case "reasoning": {
          notePaceArrival()
          pendingDeltasRef.current.reasoning += ev.data.text ?? ""
          scheduleFlush()
          return
        }
        case "tool_args": {
          const callId = ev.data.id
          if (callId && hiddenToolIdsRef.current.has(callId)) return
          if (callId) {
            toolArgsRef.current[callId] = (toolArgsRef.current[callId] || "") + (ev.data.delta ?? "")
            pendingDeltasRef.current.toolArgs.add(callId)
            scheduleFlush()
          }
          return
        }
        default:
          flushDeltas()
      }

      switch (ev.event) {
        case "session": {
          const sid = ev.data.session_id
          // Carry a pre-session model/effort pick (made on the empty composer)
          // onto the freshly minted session id before the sessionId effect
          // re-reads it.
          if (selectedModelRef.current) {
            writeModelOverride(sid, selectedModelRef.current)
          }
          if (selectedEffortRef.current) {
            writeEffortOverride(sid, selectedEffortRef.current)
          }
          carryTuningTo(sid)
          adoptDraftId(sid)
          setSessionId(sid)
          sessionIdRef.current = sid
          streamRunningRef.current = ev.data.running === true
          if (Object.prototype.hasOwnProperty.call(ev.data, "running")) {
            // The server owns "is a turn running" — every snapshot the follow
            // stream sends re-asserts it, which is what makes a turn started
            // in another tab (or auto-started from the queue) light up here.
            setStreaming(streamRunningRef.current)
          }
          if (Object.prototype.hasOwnProperty.call(ev.data, "active_skill")) {
            const n = ev.data.active_skill
            setActiveSkill(typeof n === "string" && n ? n : null)
          }
          if (Object.prototype.hasOwnProperty.call(ev.data, "auto_confirm")) {
            setAutoConfirm(ev.data.auto_confirm === true)
          }
          if (Object.prototype.hasOwnProperty.call(ev.data, "origin")) {
            setSessionOrigin(
              typeof ev.data.origin === "string" ? ev.data.origin : null,
            )
          }
          onSessionChange?.(sid)
          break
        }
        case "history": {
          // Authoritative transcript replacement (committed + staged): the
          // one rule serving first send, mid-turn re-attach and the fast-turn
          // race alike. A live turn gets a fresh streaming placeholder for
          // the replayed/live deltas that follow.
          toolArgsRef.current = {}
          hiddenToolIdsRef.current.clear()
          const loaded = convertHistory((ev.data.messages ?? []) as MessageView[])
          if (streamRunningRef.current) {
            loaded.push({ id: nextMsgId++, role: "assistant", content: "", reasoning: "" })
          }
          setMessages(loaded)
          // Queue state is stream-scoped: `history` starts a fresh sequence
          // and a `queue` frame follows right after when items are parked.
          setQueuedItems([])
          // The transcript is on screen — the attach path's loading is over.
          setSessionLoading(false)
          break
        }
        case "tool_start": {
          const initialArgs = ev.data.arguments || ""
          if (ev.data.name === "read_skill") {
            hiddenToolIdsRef.current.add(ev.data.id)
            break
          }
          toolArgsRef.current[ev.data.id] = initialArgs
          setMessages((prev) => [
            ...prev,
            {
              id: nextMsgId++,
              role: "tool",
              content: "",
              toolCallId: ev.data.id,
              toolName: ev.data.name,
              toolArgs: initialArgs,
            },
          ])
          break
        }
        case "tool_result": {
          const result = ev.data.result
          const callId = ev.data.id
          // A request resolved elsewhere (another tab answered a replayed
          // confirm/ask): its `tool_result` is the resolution signal — clear
          // the now-stale bar instead of leaving dead UI.
          if (callId) {
            setPendingConfirm((prev) => (prev && prev.id === callId ? null : prev))
            setPendingAskUser((prev) => (prev && prev.id === callId ? null : prev))
            // A finished `task` call's progress line is now redundant.
            setSubagentNotes((prev) => {
              if (!(callId in prev)) return prev
              const next = { ...prev }
              delete next[callId]
              return next
            })
            setCancellingTasks((prev) => {
              if (!prev.has(callId)) return prev
              const next = new Set(prev)
              next.delete(callId)
              return next
            })
          }
          if (callId && hiddenToolIdsRef.current.delete(callId)) break
          // Absent on older kernels (pre-protocol field): treat as success.
          const success = ev.data.success !== false
          setMessages((prev) => {
            let matched = false
            const updated = prev.map((m) => {
              if (
                !matched &&
                m.role === "tool" &&
                !m.toolResult &&
                (callId ? m.toolCallId === callId : true)
              ) {
                matched = true
                return { ...m, toolResult: result, toolSuccess: success }
              }
              return m
            })
            return [...updated, { id: nextMsgId++, role: "assistant", content: "", reasoning: "" }]
          })
          break
        }
        case "status": {
          // Known codes render localized; the wire `text` is the fallback
          // for codes this build does not know.
          const text =
            ev.data.code === "tail_trimmed" ? t("streamTrimmed") : (ev.data.text ?? "")
          // A pending note ("Compacting context...") is replaced by the next
          // one — its outcome — and a note never stacks under the streaming
          // placeholder (which must stay last): both rules in placeStatusNote.
          const note: Message = {
            id: nextMsgId++,
            role: "status",
            content: text,
            pending: ev.data.pending === true,
          }
          setMessages((prev) => placeStatusNote(prev, note))
          break
        }
        case "confirm": {
          setPendingConfirm({ id: ev.data.id, name: ev.data.name, arguments: ev.data.arguments })
          signalAttention("attention")
          break
        }
        case "ask_user": {
          setPendingAskUser({
            id: ev.data.id,
            questions: ev.data.questions,
            timeoutSecs: ev.data.timeout_secs ?? null,
          })
          signalAttention("attention")
          break
        }
        case "queue": {
          const items = Array.isArray(ev.data.items) ? ev.data.items : []
          setQueuedItems(
            items.map(
              (i: { id?: number; message?: string; attachments?: unknown }) => ({
                id: i.id ?? 0,
                message: i.message ?? "",
                attachments: queuedAttachments(i.attachments),
              }),
            ),
          )
          break
        }
        case "user_injected": {
          // A steered message the loop just accepted: place the user bubble
          // and a fresh assistant placeholder for the reply that follows.
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId++, role: "user", content: ev.data.text ?? "" },
            { id: nextMsgId++, role: "assistant", content: "", reasoning: "" },
          ])
          break
        }
        case "subagent": {
          // Envelope from a `task` sub-agent: { task_id, session_id, label,
          // event, data }. Only a few inner events matter for the progress
          // strip; the rest are deliberately not spliced into the transcript
          // (the parent `task` tool row is the transcript entry, its result
          // carries the report). `session_id` is kept so the task card can
          // deep-link to the live sub-session view while it runs; `label`
          // titles the row even when this tab never saw the parent
          // tool_start (re-attach after a trimmed replay).
          const taskId = ev.data.task_id as string | undefined
          if (!taskId) break
          const childSessionId =
            typeof ev.data.session_id === "string" ? ev.data.session_id : undefined
          const label =
            typeof ev.data.label === "string" && ev.data.label
              ? (ev.data.label as string)
              : undefined
          const inner = ev.data.event as string | undefined
          let note: string | null = null
          if (inner === "tool_start") {
            note = t("subagentRunning").replace("{name}", ev.data.data?.name ?? "")
          } else if (inner === "done") {
            note = t("subagentDone")
          } else if (inner === "error") {
            note = t("subagentError")
          }
          // Any frame from a new task starts its elapsed clock; note-bearing
          // frames also refresh the activity line.
          setSubagentNotes((prev) => {
            const existing = prev[taskId]
            if (
              existing &&
              note === null &&
              existing.sessionId === childSessionId &&
              (existing.label !== undefined || label === undefined)
            )
              return prev
            return {
              ...prev,
              [taskId]: {
                note: note ?? existing?.note ?? "",
                startedAt: existing?.startedAt ?? Date.now(),
                sessionId: childSessionId ?? existing?.sessionId,
                label: existing?.label ?? label,
              },
            }
          })
          break
        }
        case "skill": {
          const n = ev.data.name
          setActiveSkill(typeof n === "string" && n ? n : null)
          setActivatingSkill(null)
          setResettingSkill(false)
          skillActionRef.current = null
          break
        }
        case "title": {
          setChatTitle(ev.data.title ?? "")
          refreshSessions()
          onSessionChange?.(sessionIdRef.current)
          break
        }
        case "style": {
          // `set_chat_style` easter egg: definitive CSS + the only place the
          // effect script runs (streaming previews are CSS-only). Idempotent
          // per-channel: css and js are compared INDEPENDENTLY against what is
          // already live (raw payload, not the sanitized DOM text). Skipping a
          // css that equals the last streamed preview must NOT also skip the
          // js — the script never ran during streaming — so a "save"/verbatim
          // re-send lands as a no-op (no teardown, no effect-layer flicker)
          // while a genuinely new theme still applies fully.
          // `assets_changed` overrides the css skip: the look's images only
          // reached disk when the tool ran, so the preview painted its
          // url(/theme/assets/…) against 404s and the browser will not retry on
          // its own. Re-injecting the same css is what fetches them.
          const nextCss = ev.data.css ?? ""
          const nextJs = ev.data.js ?? ""
          if (ev.data.assets_changed || nextCss !== currentLlmCss()) applyLlmStyle(nextCss)
          if (nextJs !== currentLlmJs()) runLlmScript(nextJs)
          break
        }
        case "error": {
          setSubagentNotes({})
          setCancellingTasks(new Set())
          reportSendError(ev.data.message ?? "error")
          signalAttention("error")
          // A queued follow-up (the server drains the queue even after a
          // failed turn) arrives as the next snapshot on this same stream.
          break
        }
        case "done": {
          setSubagentNotes({})
          setCancellingTasks(new Set())
          if (skillActionRef.current) rollbackSkillAction()
          // Drop a trailing empty placeholder (a turn whose last frame was a
          // tool_result, or an attach landing right before the end, leaves
          // one behind) — mirrors the error path's cleanup. Same for a
          // pending status note the turn never resolved (cancelled
          // mid-compaction): the wait is over, nothing to report.
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            const trimmed =
              last?.role === "assistant" && !last.content && !last.reasoning
                ? prev.slice(0, -1)
                : prev
            return dropPendingNotes(trimmed)
          })
          // The next queued message auto-starts server-side and arrives as a
          // fresh snapshot on this same stream, which flips `streaming` back
          // on — no timer, no guessing when to re-attach.
          setStreaming(false)
          // Only a turn that actually hands control back is worth a chime: with
          // messages still queued the server starts the next one by itself.
          if (queuedItemsRef.current.length === 0) {
            signalAttention("done")
          }
          refreshSessions()
          break
        }
        default:
          break
      }
    },
    [onSessionChange, refreshSessions, flushDeltas, scheduleFlush, notePaceArrival, reportSendError, rollbackSkillAction, adoptDraftId],
  )
  handleEventRef.current = handleEvent

  // ── The session's live feed ──
  // Exactly one `follow` stream per open session, owned by this effect and
  // torn down only when the session changes or the component unmounts. It
  // outlives individual turns, so a queued follow-up, a turn started in
  // another tab and a rewind all arrive as fresh snapshots here — the client
  // never has to decide when to re-attach, and two tabs on one session watch
  // the same thing at the same time.
  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    let retry: number | null = null
    const connect = () => {
      client
        .attachStream(sessionId, handleEventRef.current, controller.signal, true)
        .catch(() => {
          // Never leave the spinner up on a connection this attempt failed to
          // make; a later retry still repaints the transcript.
          if (!controller.signal.aborted) setSessionLoading(false)
        })
        .then(() => {
          // A follow stream never ends server-side, so getting here means the
          // connection dropped (network blip, proxy timeout, daemon restart).
          // The reconnect's `history` snapshot repairs whatever was missed.
          if (controller.signal.aborted) return
          retry = window.setTimeout(connect, FOLLOW_RETRY_MS)
        })
    }
    connect()
    return () => {
      if (retry !== null) window.clearTimeout(retry)
      controller.abort()
    }
  }, [sessionId, client])

  /** Stage attachments (any file type): eager upload (LAN-fast) with an
   *  optimistic chip; chips missing an upload id block send until resolved.
   *  Images are downscaled client-side; non-image models still accept images
   *  (they degrade to a placeholder on the wire). */
  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingUploadsRef.current.length
      if (files.length > room) {
        toast.info(tf("attachLimit", MAX_ATTACHMENTS_PER_MESSAGE))
      }
      for (const file of files.slice(0, Math.max(0, room))) {
        const isImage = IMAGE_UPLOAD_TYPES.includes(file.type)
        // Pre-check before burning the upload roundtrip; images get the real
        // check after compression (a 6MB camera JPEG usually fits post-resize).
        if (!isImage && file.size > FILE_MAX_BYTES) {
          toast.error(tf("fileTooLarge", file.name, 20))
          continue
        }
        const key = nextUploadKey++
        // Images: thumbnail + lightbox. Files: click opens a browser-native
        // preview tab (txt/pdf render in place).
        const previewUrl = URL.createObjectURL(file)
        setPendingUploads((prev) => [
          ...prev,
          {
            key,
            name: file.name,
            kind: isImage ? "image" : "file",
            size: file.size,
            previewUrl,
          },
        ])
        const dropChip = () => {
          revokePreview(previewUrl)
          setPendingUploads((prev) => prev.filter((p) => p.key !== key))
        }
        void (async () => {
          try {
            const blob = isImage ? await compressImage(file) : file
            if (isImage && blob.size > IMAGE_MAX_BYTES) {
              toast.error(tf("fileTooLarge", file.name, 10))
              dropChip()
              return
            }
            const up = await client.uploadFile(blob, file.name)
            setPendingUploads((prev) =>
              prev.map((p) =>
                p.key === key
                  ? { ...p, id: up.id, size: up.size, lines: up.lines }
                  : p,
              ),
            )
          } catch {
            toast.error(t("uploadFailed"))
            dropChip()
          }
        })()
      }
    },
    [client],
  )

  const removeUpload = useCallback((key: number) => {
    setPendingUploads((prev) => {
      const gone = prev.find((p) => p.key === key)
      revokePreview(gone?.previewUrl)
      return prev.filter((p) => p.key !== key)
    })
  }, [])

  // ── Drag-and-drop upload ──
  // Files dragged anywhere over the AgentChat window (sidebar included, so a
  // stray drop there can't navigate the browser away) arm a drop overlay;
  // dropping stages them through the exact paste/picker path (`addFiles`).
  // Gated on `streaming` for consistency with the disabled attach button and
  // textarea. dragenter/dragleave fire per child element while moving across
  // the tree, so a depth counter tracks the true window-level enter/leave;
  // the drop (and a clamped decrement) reset it, so a cancelled drag can't
  // strand it.
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return
      e.preventDefault()
      if (streaming) return
      dragDepthRef.current += 1
      setDragActive(true)
    },
    [streaming],
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return
      // Always swallow file drags: without a preventDefault'd dragover the
      // drop never fires, and an unhandled drop navigates the browser to the
      // file — losing the chat page. `dropEffect` mirrors acceptability.
      e.preventDefault()
      e.dataTransfer.dropEffect = streaming ? "none" : "copy"
    },
    [streaming],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return
      e.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)
      if (streaming) return
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length > 0) addFiles(files)
    },
    [streaming, addFiles],
  )

  const resetDeltaBuffers = useCallback(() => {
    toolArgsRef.current = {}
    hiddenToolIdsRef.current.clear()
    pendingDeltasRef.current = { content: "", reasoning: "", toolArgs: new Set() }
    // Keep the learned burst-interval EMA (it characterizes the provider) but
    // forget the last arrival so the idle gap between turns is not counted.
    smoothPaceRef.current.lastArrivalMs = 0
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  const sendMessage = useCallback(
    (raw: string, skillAction?: SkillAction, displayContent?: string) => {
      // Attachments count as a message ("paste and hit enter"); chips still
      // uploading block the send button, so ids are resolved here.
      const uploads = pendingUploadsRef.current
      const attachments = uploads
        .filter((p) => !!p.id)
        .map((p) => ({ id: p.id as string, name: p.name, lines: p.lines ?? undefined }))
      if ((!raw.trim() && !skillAction && attachments.length === 0) || streaming) return
      clearAttention()
      const shown = displayContent ?? raw
      setInput("")
      if (attachments.length > 0) {
        uploads.forEach((p) => revokePreview(p.previewUrl))
        setPendingUploads([])
      }
      if (skillAction?.op !== "reset") {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMsgId++,
            role: "user",
            content: shown,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          { id: nextMsgId++, role: "assistant", content: "", reasoning: "" },
        ])
      }
      setStreaming(true)
      // The reader's own action: follow the tail from here on. Set the intent
      // NOW, synchronously — the optimistic rows above commit (and pin) in
      // this same batch, and the `history` rebuild that follows the ack must
      // find it set too. The glide itself waits a frame so the new bubble is
      // laid out and the scroll has a real target.
      followRef.current = true
      requestAnimationFrame(glideToBottom)
      resetDeltaBuffers()

      // Pure trigger: the turn's frames arrive on the session's follow stream,
      // which is already open (or opens as soon as the ack names the session).
      client
        .sendMessage(
          raw,
          sessionIdRef.current,
          skillAction,
          attachments,
          selectedModelRef.current || undefined,
          effortForSendRef.current || undefined,
          parametersForSendRef.current.length ? parametersForSendRef.current : undefined,
          maxModeForSendRef.current || undefined,
          // Fresh-chat extras (ignored for an existing session): an explicit
          // full-auto toggle, applied server-side before the turn starts so
          // even the first tool call honours it.
          { fullAuto: preSessionAutoRef.current ?? undefined },
        )
        .then((ack) => {
          if (!ack.session_id) return
          if (!sessionIdRef.current) {
            // First message of a new chat: naming the session starts the
            // follow stream, which replays this turn from the feed tail.
            // The pre-session full-auto choice went with the request; the
            // session's own frames own the badge from here.
            preSessionAutoRef.current = null
            if (selectedModelRef.current) writeModelOverride(ack.session_id, selectedModelRef.current)
            if (selectedEffortRef.current) writeEffortOverride(ack.session_id, selectedEffortRef.current)
            carryTuningTo(ack.session_id)
            adoptDraftId(ack.session_id)
            sessionIdRef.current = ack.session_id
            setSessionId(ack.session_id)
            onSessionChange?.(ack.session_id)
          }
          if (!ack.running) {
            // Reset-only: nothing streams, so settle the local state here.
            setActiveSkill(ack.active_skill ?? null)
            rollbackSkillAction()
            setStreaming(false)
          }
        })
        .catch((e) => {
          if (e instanceof ChatBusyError) {
            // Another tab claimed the session first. Its turn is already on
            // screen via the follow stream, so this send simply did not
            // happen: undo the optimistic bubbles and give the text back.
            toast.info(t("turnInFlight"))
            rollbackSkillAction()
            setStreaming(false)
            setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last?.role === "assistant" && !last.content && !last.reasoning) next.pop()
              if (next[next.length - 1]?.role === "user") next.pop()
              return next
            })
            setInput(shown)
            return
          }
          reportSendError(e instanceof Error ? e.message : String(e))
        })
    },
    [
      streaming,
      client,
      resetDeltaBuffers,
      reportSendError,
      rollbackSkillAction,
      onSessionChange,
      glideToBottom,
      adoptDraftId,
    ],
  )

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (streaming) {
      // Busy: park the message in the session queue (plain messages only —
      // skill actions still wait for the turn to end).
      const uploads = pendingUploadsRef.current
      const attachments = uploads
        .filter((p) => !!p.id)
        .map((p) => ({ id: p.id as string, name: p.name, lines: p.lines ?? undefined }))
      if ((!text && attachments.length === 0) || pendingSkill || !sessionIdRef.current) return
      setInput("")
      // The chips ride the queued message, so clear them now — leaving them
      // staged would attach the same files again to whatever is typed next.
      if (attachments.length > 0) {
        uploads.forEach((p) => revokePreview(p.previewUrl))
        setPendingUploads([])
      }
      client
        .queueMessage(
          text,
          sessionIdRef.current,
          attachments,
          selectedModelRef.current || undefined,
          effortForSendRef.current || undefined,
          parametersForSendRef.current.length ? parametersForSendRef.current : undefined,
          maxModeForSendRef.current || undefined,
        )
        // A message that raced the turn's end started a fresh turn instead;
        // either way the follow stream reports it.
        .catch((e) => {
          toast.error(e instanceof Error ? e.message : String(e))
          setInput(text)
        })
      return
    }
    if (pendingSkill) {
      const skill = pendingSkill
      skillActionRef.current = { op: "activate", skill }
      setActivatingSkill(skill)
      setPendingSkill(null)
      sendMessage(
        text,
        { op: "activate", name: skill.name },
        text || `/${skill.name}`,
      )
      return
    }
    if (!text && pendingUploadsRef.current.length === 0) return
    sendMessage(text)
  }, [input, pendingSkill, sendMessage, streaming, client])

  /** "Edit & resend": rewind the server-side conversation to BEFORE the
   *  `userIndex`-th user message, truncate the local transcript to match,
   *  and put the original text in the composer for editing. */
  const handleRewindMessage = useCallback(
    async (userIndex: number, content: string) => {
      if (streaming || !sessionIdRef.current) return
      try {
        const skill = await client.rewind(sessionIdRef.current, userIndex)
        setActiveSkill(skill)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        return
      }
      setMessages((prev) => {
        let ordinal = -1
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].role === "user" && ++ordinal === userIndex) {
            return prev.slice(0, i)
          }
        }
        return prev
      })
      setInput(content)
      refreshSessions()
    },
    [streaming, client, refreshSessions],
  )

  /** "Send now": wind the RUNNING turn down (the stop machinery, but the
   *  queue survives) and park the message at the queue front — the backend
   *  starts it the moment the turn ends. A turn that ended in the meantime
   *  simply starts it as a fresh turn (same endpoint, no 409 race); either
   *  way the follow stream reports what happened. */
  const handleSendNow = useCallback(() => {
    const text = input.trim()
    if (!streaming || !sessionIdRef.current) return
    const uploads = pendingUploadsRef.current
    const attachments = uploads
      .filter((p) => !!p.id)
      .map((p) => ({ id: p.id as string, name: p.name, lines: p.lines ?? undefined }))
    if ((!text && attachments.length === 0) || pendingSkill) return
    setInput("")
    // The chips ride the interrupting message, so clear them now — leaving
    // them staged would attach the same files again to the next message.
    if (attachments.length > 0) {
      uploads.forEach((p) => revokePreview(p.previewUrl))
      setPendingUploads([])
    }
    client
      .interruptMessage(
        text,
        sessionIdRef.current,
        attachments,
        selectedModelRef.current || undefined,
        effortForSendRef.current || undefined,
        parametersForSendRef.current.length ? parametersForSendRef.current : undefined,
        maxModeForSendRef.current || undefined,
      )
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : String(e))
        setInput(text)
      })
  }, [input, streaming, client, pendingSkill])

  /** Drop one parked message. No optimistic mutation — the backend's next
   *  `queue` snapshot converges the strip (a miss means the item already
   *  started or was removed elsewhere, which reads the same on screen). */
  const handleRemoveQueued = useCallback(
    (id: number) => {
      if (!sessionIdRef.current) return
      void client.removeQueued(sessionIdRef.current, id)
    },
    [client],
  )

  /** Replace one parked message's text (attachments ride along unchanged). */
  const handleEditQueued = useCallback(
    (id: number, message: string) => {
      if (!sessionIdRef.current) return
      void client.editQueued(sessionIdRef.current, id, message)
    },
    [client],
  )

  /** "Send now" for one parked message: the backend moves it to the queue
   *  front and winds the running turn down (queue kept), so the pump starts
   *  it the moment the turn ends — the composer's ⚡ semantics, for a message
   *  that is already queued (its attachments and model selection ride along).
   *  No optimistic mutation: the `queue` snapshot converges the strip, and the
   *  turn's normal wind-down drives the transcript. */
  const handleSendNowQueued = useCallback(
    (id: number) => {
      if (!sessionIdRef.current) return
      void client.sendQueuedNow(sessionIdRef.current, id)
    },
    [client],
  )

  /** Drop EVERY parked message (the panel's "clear all"): one remove per
   *  item — same converge-on-snapshot semantics as a single remove, no
   *  optimistic mutation. */
  const handleClearQueued = useCallback(() => {
    const sid = sessionIdRef.current
    if (!sid) return
    for (const q of queuedItems) void client.removeQueued(sid, q.id)
  }, [client, queuedItems])

  /** Cancel ONE running sub-agent. Optimistically marks the row as
   *  "cancelling…"; the task's tool_result is the convergence signal (it
   *  clears the row for every viewer). */
  const handleCancelTask = useCallback(
    (taskId: string) => {
      if (!sessionIdRef.current) return
      setCancellingTasks((prev) => new Set(prev).add(taskId))
      void client.cancelTask(sessionIdRef.current, taskId)
    },
    [client],
  )

  // 1s re-render tick while sub-agent rows are on screen, so their elapsed
  // readouts advance (startedAt is fixed; elapsed derives from Date.now()).
  const hasSubagentRows = streaming && Object.keys(subagentNotes).length > 0
  const [, setSubagentTick] = useState(0)
  useEffect(() => {
    if (!hasSubagentRows) return
    const id = setInterval(() => setSubagentTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hasSubagentRows])

  const handleResetSkill = useCallback(() => {
    if (!activeSkill || streaming) return
    skillActionRef.current = { op: "reset" }
    setResettingSkill(true)
    sendMessage("", { op: "reset" })
  }, [activeSkill, sendMessage, streaming])

  const handlePendingSkillChange = useCallback(
    (skill: SkillInfo | null) => {
      setPendingSkill(skill?.name === activeSkill ? null : skill)
    },
    [activeSkill],
  )

  const handleConfirm = (
    confirmed: boolean,
    amendedArgs?: unknown,
    allowPattern?: string,
    allowDir?: string,
    auto?: boolean,
  ) => {
    const sid = sessionIdRef.current
    if (sid && pendingConfirm) {
      if (confirmed && auto) {
        // Badge follows the server: light it only after the confirm actually
        // reached a pending request (a raced cancel would otherwise leave the
        // badge ON while the backend keeps confirming).
        void client
          .confirm(sid, confirmed, amendedArgs, allowPattern, allowDir, auto, pendingConfirm.id)
          .then((ok) => {
            if (ok) setAutoConfirm(true)
          })
      } else {
        void client.confirm(
          sid,
          confirmed,
          amendedArgs,
          allowPattern,
          allowDir,
          auto,
          pendingConfirm.id,
        )
      }
      setPendingConfirm(null)
    }
  }

  // Composer toggle: switch session full-auto on or off (shared flag — applies
  // to the in-flight turn's next tool call too; persisted with the session).
  const handleAutoConfirmChange = useCallback(
    (enabled: boolean) => {
      const sid = sessionIdRef.current
      if (sid) {
        void client.setAutoConfirm(sid, enabled).catch(() => {
          toast.error(t("operationFailed"))
          setAutoConfirm(!enabled)
        })
      } else {
        // Fresh chat (no server session yet): remember the choice so the
        // first send creates the session in that mode — it would otherwise
        // start at the configured default.
        preSessionAutoRef.current = enabled
      }
      setAutoConfirm(enabled)
    },
    [client],
  )

  const handleAskUserSubmit = (answers: AskAnswer[]) => {
    const sid = sessionIdRef.current
    if (sid && pendingAskUser) {
      void client.answer(sid, answers, false, pendingAskUser.id)
      setPendingAskUser(null)
    }
  }

  const handleAskUserCancel = () => {
    const sid = sessionIdRef.current
    if (sid && pendingAskUser) {
      void client.answer(sid, [], true, pendingAskUser.id)
      setPendingAskUser(null)
    }
  }

  const handleAskUserActivity = () => {
    const sid = sessionIdRef.current
    if (sid && pendingAskUser) void client.askActivity(sid, pendingAskUser.id)
  }

  const handleStop = useCallback(() => {
    const sid = sessionIdRef.current
    if (sid) void client.cancel(sid)
    // The follow stream stays up: stopping ends the TURN, not the watching.
    // Cancel also clears the server-side queue (it publishes the emptied
    // queue), mirrored here so the strip goes away immediately.
    setStreaming(false)
    setQueuedItems([])
    setActivatingSkill(null)
    setResettingSkill(false)
    skillActionRef.current = null
  }, [client])

  const handleNewChat = useCallback(() => {
    // Invalidate any in-flight session load so its late response cannot
    // resurrect the old session over the fresh chat.
    loadGenRef.current++
    setMessages([])
    // Clearing the session id tears down its follow stream (effect cleanup).
    setSessionId(null)
    sessionIdRef.current = null
    setSessionOrigin(null)
    setPendingConfirm(null)
    setPendingAskUser(null)
    setQueuedItems([])
    // A fresh chat starts at the configured full-auto default (a session
    // created from it inherits the same server-side).
    preSessionAutoRef.current = null
    setAutoConfirm(defaultFullAutoRef.current)
    setStreaming(false)
    setSessionLoading(false)
    setChatTitle("")
    setSessionCategory(null)
    setActiveSkill(null)
    setPendingSkill(null)
    setActivatingSkill(null)
    setResettingSkill(false)
    skillActionRef.current = null
    setFoldCommand(null)
    resetDeltaBuffers()
    // Last: flushes the left session's composer under its id and loads the
    // fresh chat's draft (text, chips, skill chip) over the resets above.
    switchDraft(NEW_CHAT_DRAFT_ID)
    onSessionChange?.(null)
  }, [onSessionChange, resetDeltaBuffers, switchDraft])

  const resumeSession = useCallback(
    (id: string) => {
      // Re-opening the session already on screen is a no-op: its follow stream
      // is live and the transcript current. Clearing below would raise the
      // spinner while `setSessionId` bails on the unchanged value, so the
      // stream never reconnects and no `history` snapshot ever lowers it again.
      if (sessionIdRef.current === id) return
      setStreaming(false)
      setQueuedItems([])
      // Leaving the fresh chat: its pre-session full-auto choice no longer
      // applies; the opened session's frames own the badge from here.
      preSessionAutoRef.current = null
      setPendingConfirm(null)
      setPendingAskUser(null)
      setPendingSkill(null)
      setActivatingSkill(null)
      setResettingSkill(false)
      skillActionRef.current = null
      // Clear the previous transcript immediately and show the loading
      // spinner: neither the stale transcript nor the welcome composer may
      // bridge the fetch gap (slow loads invited typing into the void).
      setMessages([])
      setSessionLoading(true)
      // Drop any buffered stream deltas so a pending flush can't splice text
      // from the previous stream into the freshly loaded transcript.
      resetDeltaBuffers()
      // Switch the followed session FIRST: that tears down the old stream and
      // opens this one, whose `session` + `history` snapshot is the
      // authoritative transcript (committed history plus a live turn's staged
      // tail, with any pending confirm/ask replayed from the tail). Loading
      // the stored copy here as well would only race that snapshot.
      setSessionId(id)
      sessionIdRef.current = id
      setSessionOrigin(null)
      // The composer follows the session: park the previous draft, load this
      // session's (after the skill resets above, which it may re-populate).
      switchDraft(id)
      onSessionChange?.(id)
      const gen = ++loadGenRef.current
      setFoldCommand(null)
      // Reset the header pill; the list-sync effect below seeds it from the
      // sidebar row (usually present) and the detail is authoritative — it
      // also covers sessions the active list does not carry (archived).
      setSessionCategory(null)
      client
        .getSession(id)
        .then((detail) => {
          // A newer load/new-chat superseded this response: discard it.
          if (gen !== loadGenRef.current) return
          setChatTitle(detail.meta?.title || "")
          setSessionCategory(detail.meta?.category ?? null)
        })
        .catch(() => {
          if (gen !== loadGenRef.current) return
          setChatTitle("")
        })
    },
    [client, onSessionChange, resetDeltaBuffers, switchDraft],
  )

  // The sessions page (and the sidebar) may re-file the open session while
  // this component stays mounted: follow the list whenever it carries the
  // current id, so the header pill never lags a change made elsewhere.
  useEffect(() => {
    if (!sessionId) return
    const row = sessions.find((s) => s.id === sessionId)
    if (row) setSessionCategory(row.category ?? null)
  }, [sessions, sessionId])

  /** Header picker: optimistic update, PATCH, roll back + toast on failure. */
  const handleSetCategory = useCallback(
    (category: string | null) => {
      const sid = sessionIdRef.current
      if (!sid) return
      const previous = sessionCategory
      setSessionCategory(category)
      void client
        .updateSession(sid, { category })
        .then(refreshSessions)
        .catch(() => {
          if (sessionIdRef.current === sid) setSessionCategory(previous)
          toast.error(t("operationFailed"))
        })
    },
    [client, refreshSessions, sessionCategory],
  )

  const handleRename = useCallback(
    (id: string, title: string) => {
      void client
        .updateSession(id, { title })
        .then(refreshSessions)
        .catch(() => toast.error(t("operationFailed")))
      if (id === sessionIdRef.current) setChatTitle(title)
    },
    [client, refreshSessions],
  )

  const handleDelete = useCallback(
    (id: string) => {
      void client.deleteSession(id).then(() => {
        refreshSessions()
        // The open session's composer moves to the fresh chat first (so its
        // draft is not flushed back under the deleted id), then the record
        // goes with the session.
        if (id === sessionIdRef.current) handleNewChat()
        clearDraft(id)
      })
    },
    [client, refreshSessions, handleNewChat],
  )

  useImperativeHandle(
    ref,
    () => ({ newChat: handleNewChat, openSession: resumeSession, refreshSessions }),
    [handleNewChat, resumeSession, refreshSessions],
  )

  const handleExport = useCallback(() => {
    const body = messages
      .map((m) => {
        if (m.role === "user") return `**You:** ${m.content}`
        if (m.role === "assistant") return m.content
        if (m.role === "tool")
          return `> tool \`${m.toolName}\`\n>\n> args: \`${m.toolArgs ?? ""}\`\n>\n> result:\n>\n\`\`\`\n${m.toolResult ?? ""}\n\`\`\``
        if (m.role === "error") return `> error: ${m.content}`
        return `_${m.content}_`
      })
      .filter(Boolean)
      .join("\n\n---\n\n")
    const md = chatTitle ? `# ${chatTitle}\n\n${body}` : body
    const blob = new Blob([md], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${chatTitle || "conversation"}-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [messages, chatTitle])

  // PDF: defer to the browser print dialog (Save as PDF). A print-only
  // stylesheet in theme.css isolates the messages region; `printElementToPdf`
  // sizes a single page to the content and injects a one-shot `@page`.
  const handlePdf = useCallback(() => {
    const el = messagesContainerRef.current
    if (el) printElementToPdf(el, { title: chatTitle, neutralizeInnerColumn: true })
  }, [chatTitle])

  // Per-message PDF: isolate a single assistant answer body. The shared solo
  // helper marks the transcript container + target for theme.css's solo print
  // rules and sizes the page to just this message. No title, no reasoning.
  const handleMessagePdf = useCallback((bodyEl: HTMLElement | null, title: string) => {
    if (bodyEl) printSoloElementToPdf(bodyEl, title)
  }, [])

  // Click-to-rename in the chat header (single click → inline input).
  useEffect(() => {
    if (titleEditing) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [titleEditing])

  const canEditTitle = !!sessionId && !streaming

  const startTitleEdit = useCallback(() => {
    if (!sessionIdRef.current || streaming) return
    setTitleDraft(chatTitle || "")
    setTitleEditing(true)
  }, [chatTitle, streaming])

  const cancelTitleEdit = useCallback(() => {
    setTitleEditing(false)
    setTitleDraft("")
  }, [])

  const commitTitleEdit = useCallback(() => {
    const sid = sessionIdRef.current
    const trimmed = titleDraft.trim()
    if (!sid || !trimmed || trimmed === (chatTitle || "")) {
      cancelTitleEdit()
      return
    }
    void client
      .updateSession(sid, { title: trimmed })
      .then(refreshSessions)
      .catch(() => toast.error(t("operationFailed")))
    setChatTitle(trimmed)
    setTitleEditing(false)
    setTitleDraft("")
  }, [client, titleDraft, chatTitle, refreshSessions, cancelTitleEdit])

  const styleVars = themeToCssVars(theme)
  // Sub-agent transcripts are read-only: no composer, no rewind. The id
  // prefix answers before the stream's `session` frame lands (deep-link
  // open); the frame's `origin` field is the authoritative signal after it.
  const isTaskSession =
    sessionOrigin === "task" || (sessionId?.startsWith("task-") ?? false)
  // Live sub-agent state joined with cancel flags for the `task` tool cards
  // (keyed by tool_call id, same key the cards receive as `callId`).
  const runtimeSubagents = useMemo(() => {
    const out: Record<
      string,
      {
        note: string
        startedAt: number
        cancelling: boolean
        sessionId?: string
        label?: string
      }
    > = {}
    for (const [taskId, live] of Object.entries(subagentNotes)) {
      out[taskId] = { ...live, cancelling: cancellingTasks.has(taskId) }
    }
    return out
  }, [subagentNotes, cancellingTasks])
  const runtimeValue = useMemo(
    () => ({
      client,
      sessionId,
      subagents: runtimeSubagents,
      cancelTask: handleCancelTask,
      sessionHref,
      findToolCall,
      revealToolCall,
    }),
    [client, sessionId, runtimeSubagents, handleCancelTask, sessionHref, findToolCall, revealToolCall],
  )

  return (
    <ChatRuntimeContext.Provider value={runtimeValue}>
    <FoldAllContext.Provider value={foldCommand}>
    <RevealContext.Provider value={revealCommand}>
    <div
      className={`acc-root relative flex h-full w-full overflow-hidden bg-background text-foreground${
        theme?.scheme === "dark" ? " dark" : ""
      }`}
      style={styleVars}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {historyAvailable &&
        !hideSidebar &&
        (historyOpen ? (
          isNarrow ? (
            <>
              {/* Backdrop: tap-outside dismisses the drawer. */}
              <div
                className="fixed inset-0 z-40 animate-fade-in bg-black/40"
                aria-hidden
                onClick={() => setHistoryOpen(false)}
              />
              <div className="fixed inset-y-0 left-0 z-50 flex animate-slide-in-left shadow-2xl">
                <SessionsPanel
                  sessions={sessions}
                  activeId={sessionId}
                  sessionHref={sessionHref}
                  onResume={(id) => {
                    resumeSession(id)
                    setHistoryOpen(false)
                  }}
                  onNew={() => {
                    handleNewChat()
                    setHistoryOpen(false)
                  }}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onClose={() => setHistoryOpen(false)}
                />
              </div>
            </>
          ) : (
            <SessionsPanel
              sessions={sessions}
              activeId={sessionId}
              sessionHref={sessionHref}
              onResume={(id) => {
                resumeSession(id)
              }}
              onNew={handleNewChat}
              onRename={handleRename}
              onDelete={handleDelete}
              onClose={() => setHistoryOpen(false)}
            />
          )
        ) : (
          <CollapsedRail onExpand={() => setHistoryOpen(true)} onNew={handleNewChat} />
        ))}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-chat-page>
        {sessionLoading && messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="h-5 w-5 text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          isNarrow ? (
            // Mobile empty state: brand block centered in the free space, the
            // composer docked at the BOTTOM (thumb reach + no position jump
            // once the first reply arrives), suggestion chips just above it.
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
                <ChatWelcome
                  logo={welcomeMeta.logo ?? VINX_LOGO}
                  tagline={welcomeMeta.tagline}
                />
              </div>
              {(welcomeMeta.suggestions?.length ?? 0) > 0 && (
                <div className="flex flex-wrap justify-center gap-2 px-4 pb-2">
                  {welcomeMeta.suggestions!.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setInput(s)}
                      className="rounded-full border border-border bg-card px-3.5 py-2 text-[13px] text-foreground/85 shadow-sm transition-colors hover:bg-muted active:bg-muted"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={handleStop}
                streaming={streaming}
                hasMessages={false}
                modelName={selectedModel || modelName}
                models={availableModels}
                defaultModel={modelName}
                onSelectModel={handleSelectModel}
                effortLevels={currentCaps?.effortLevels ?? []}
                selectedEffort={selectedEffort}
                defaultEffort={currentCaps?.defaultEffort}
                onSelectEffort={handleSelectEffort}
                parameterDefinitions={currentCatalogModel?.parameters ?? []}
                selectedParameters={selectedParameters}
                onSelectParameter={handleSelectParameter}
                supportsMaxMode={currentCatalogModel?.supportsMaxMode ?? false}
                maxMode={maxModeForSend}
                onToggleMaxMode={handleToggleMaxMode}
                skills={skills}
                skillIconUrl={client.skillIconUrl}
                pendingSkill={pendingSkill}
                activatingSkill={activatingSkill}
                activeSkillName={activeSkill}
                resettingSkill={resettingSkill}
                onPendingSkillChange={handlePendingSkillChange}
                onResetSkill={handleResetSkill}
                autoConfirm={autoConfirm}
                onAutoConfirmChange={handleAutoConfirmChange}
                attachments={pendingUploads}
                onAddFiles={addFiles}
                onRemoveUpload={removeUpload}
                onPreviewError={handleUploadPreviewError}
                onPreview={(src, alt) => setLightbox({ src, alt })}
              />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center gap-8 px-4 pt-[25vh]">
              <ChatWelcome />
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={handleStop}
                streaming={streaming}
                hasMessages={false}
                centered
                modelName={selectedModel || modelName}
                models={availableModels}
                defaultModel={modelName}
                onSelectModel={handleSelectModel}
                effortLevels={currentCaps?.effortLevels ?? []}
                selectedEffort={selectedEffort}
                defaultEffort={currentCaps?.defaultEffort}
                onSelectEffort={handleSelectEffort}
                parameterDefinitions={currentCatalogModel?.parameters ?? []}
                selectedParameters={selectedParameters}
                onSelectParameter={handleSelectParameter}
                supportsMaxMode={currentCatalogModel?.supportsMaxMode ?? false}
                maxMode={maxModeForSend}
                onToggleMaxMode={handleToggleMaxMode}
                skills={skills}
                skillIconUrl={client.skillIconUrl}
                pendingSkill={pendingSkill}
                activatingSkill={activatingSkill}
                activeSkillName={activeSkill}
                resettingSkill={resettingSkill}
                onPendingSkillChange={handlePendingSkillChange}
                onResetSkill={handleResetSkill}
                autoConfirm={autoConfirm}
                onAutoConfirmChange={handleAutoConfirmChange}
                attachments={pendingUploads}
                onAddFiles={addFiles}
                onRemoveUpload={removeUpload}
                onPreviewError={handleUploadPreviewError}
                onPreview={(src, alt) => setLightbox({ src, alt })}
              />
            </div>
          )
        ) : (
          <>
            {/* Header: same height as the host page header */}
            <div className="relative flex h-14 shrink-0 items-center border-b border-border px-4 print:hidden">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label={t("backToSessions")}
                  title={t("backToSessions")}
                  className="-ml-1.5 mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-5"
                >
                  <ChevronLeft />
                </button>
              )}
              {titleEditing ? (
                <div className="absolute inset-x-4 flex justify-center">
                  <div className="relative inline-block max-w-[60%]">
                    <span aria-hidden className="invisible block whitespace-pre px-1 text-sm font-medium">
                      {titleDraft || " "}
                    </span>
                    <input
                      ref={titleInputRef}
                      type="text"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={commitTitleEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          commitTitleEdit()
                        } else if (e.key === "Escape") {
                          e.preventDefault()
                          cancelTitleEdit()
                        }
                      }}
                      className="absolute inset-0 w-full border-b border-primary/50 bg-transparent px-1 text-center text-sm font-medium text-foreground outline-none"
                      aria-label={t("rename")}
                    />
                  </div>
                </div>
              ) : (
                <span
                  onClick={startTitleEdit}
                  title={canEditTitle ? t("rename") : undefined}
                  className={`absolute left-1/2 max-w-[60%] -translate-x-1/2 truncate text-sm font-medium text-foreground ${
                    canEditTitle ? "cursor-pointer" : "pointer-events-none"
                  }`}
                >
                  {chatTitle || t("newChat")}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {/* Mobile-only "new chat" in the header (the drawer keeps the
                    desktop entry): the top-right + is the ingrained mobile
                    habit for starting a fresh conversation. */}
                <button
                  type="button"
                  onClick={handleNewChat}
                  aria-label={t("newChat")}
                  title={t("newChat")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                  <Plus className="h-4.5 w-4.5" strokeWidth={1.8} />
                </button>
                {/* File the conversation without leaving it: category pill +
                    the same picker the sessions page uses. Needs a persisted
                    session to PATCH — a fresh chat gets it after its first
                    message. */}
                {sessionId && historyAvailable && (
                  <SessionCategoryButton
                    category={sessionCategory}
                    knownCategories={knownCategories}
                    onChange={handleSetCategory}
                  />
                )}
                <SessionReleases client={client} sessionId={sessionId} refreshKey={streaming} basePath={basePath} />
                {enableExport && messages.length > 0 && (
                  <ExportMenu
                    onMarkdown={handleExport}
                    onPdf={handlePdf}
                    onExpandAll={() => foldAll("expand")}
                    onCollapseAll={() => foldAll("collapse")}
                  />
                )}
              </div>
            </div>

            {/* `@container` so the outline rail can query THIS pane's width
                (the sessions panel opening/closing changes it, the viewport
                does not). */}
            <div className="relative min-h-0 flex-1 @container">
              <div
                className="h-full overflow-y-auto"
                ref={setMessagesContainer}
                data-chat-messages
              >
                {/* Print-only title: theme.css's print rules show only
                    [data-chat-messages], hiding the header — so the exported
                    PDF gets its title from this block instead. */}
                {/* Spacing/border live on the inner <h1>: theme.css's print
                    rules zero out margins on `[data-chat-messages] > div`. */}
                {chatTitle && (
                  <div data-print-title className="hidden print:block">
                    <h1 className="mb-4 border-b border-border pb-2 text-2xl font-semibold text-foreground">
                      {chatTitle}
                    </h1>
                  </div>
                )}
                {archiveGens.length > 0 && (
                  <div className="mx-auto max-w-3xl px-4 pt-4 print:hidden">
                    <button
                      type="button"
                      onClick={() => setArchiveOpen((v) => !v)}
                      title={t("archivedHistoryHint")}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Archive className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                      {tf("archivedHistory", archiveGens.length)}
                      {archiveLoading ? (
                        <Spinner className="h-3 w-3" />
                      ) : (
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${archiveOpen ? "rotate-180" : ""}`}
                        />
                      )}
                    </button>
                    {archiveOpen && archiveMessages && (
                      <div className="opacity-85">
                        <MessageList
                          messages={archiveMessages}
                          streaming={false}
                          renderers={renderers}
                          onEditMessage={setInput}
                          onMessagePdf={handleMessagePdf}
                          messagesEndRef={archiveEndRef}
                          uploadUrl={client.uploadUrl}
                          onPreview={(src, alt) => setLightbox({ src, alt })}
                        />
                      </div>
                    )}
                  </div>
                )}
                <MessageList
                  messages={messages}
                  streaming={streaming}
                  renderers={renderers}
                  onEditMessage={setInput}
                  onRewindMessage={isTaskSession ? undefined : handleRewindMessage}
                  onMessagePdf={handleMessagePdf}
                  messagesEndRef={messagesEndRef}
                  uploadUrl={client.uploadUrl}
                  onPreview={(src, alt) => setLightbox({ src, alt })}
                  followTail={!showJumpToBottom}
                />
              </div>
              {/* Right-hand rail: one tick per user message (hover = preview,
                  click = scroll). Indexes the live transcript only — archived
                  generations are collapsed by default and their rows move
                  when that expander toggles. */}
              <MessageOutline entries={outlineEntries} containerRef={messagesContainerRef} />
              {/* Always mounted; `data-state` drives a fade+lift in AND out
                  (theme.css .acc-jump). While a stream is running and the
                  reader has scrolled up, a pulsing dot says "new output below". */}
              <button
                type="button"
                onClick={jumpToBottom}
                aria-label={t("jumpToBottom")}
                title={t("jumpToBottom")}
                aria-hidden={!showJumpToBottom}
                tabIndex={showJumpToBottom ? 0 : -1}
                data-state={showJumpToBottom ? "shown" : "hidden"}
                className="acc-jump absolute bottom-3 left-1/2 z-10 inline-flex items-center justify-center gap-1 rounded-full border border-border bg-card py-1.5 pl-1.5 pr-1.5 text-muted-foreground shadow-md hover:text-foreground"
              >
                {streaming && (
                  <span className="acc-live-dot ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                )}
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>

            {streaming && Object.keys(subagentNotes).length > 0 && (
              /* Same card chrome as QueuedItems below: bordered rounded panel
                 with a header row — the two strips dock together above the
                 composer and should read as one family. */
              <div className="mx-auto w-full max-w-3xl px-4 pb-1.5 print:hidden">
                <div className="animate-rise-in overflow-hidden rounded-lg border border-border bg-muted/20">
                  <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    <Spinner className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {tf("subagentHeader", Object.keys(subagentNotes).length)}
                    </span>
                  </div>
                  <div className="space-y-px p-1">
                    {Object.entries(subagentNotes).map(([taskId, live]) => {
                      // This tab's tool_start args first, the envelope's label as
                      // fallback (covers re-attach after a trimmed replay), the
                      // raw id as last resort.
                      const label = taskLabel(toolArgsRef.current[taskId]) ?? live.label
                      const cancelling = cancellingTasks.has(taskId)
                      return (
                        <div
                          key={taskId}
                          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
                        >
                          <span
                            className="min-w-0 flex-1 truncate text-foreground/75"
                            title={label ?? undefined}
                          >
                            {label ?? taskId.slice(0, 8)}
                            <span className="text-muted-foreground/60">
                              {" · "}
                              {cancelling ? t("subagentCancelling") : live.note}
                            </span>
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                            {formatElapsed(Date.now() - live.startedAt)}
                          </span>
                          {/* Always-visible actions (no hover reveal): this
                              strip is the ONE place a running sub-agent can
                              be opened or cancelled, so the affordance must
                              be discoverable at a glance. */}
                          <div className="flex shrink-0 items-center gap-0.5">
                            {live.sessionId && sessionHref && (
                              <a
                                href={sessionHref(live.sessionId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={t("taskViewTranscript")}
                                aria-label={t("taskViewTranscript")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={cancelling}
                              onClick={() => handleCancelTask(taskId)}
                              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive disabled:opacity-40 [&_svg]:size-3"
                              title={t("subagentCancel")}
                              aria-label={t("subagentCancel")}
                            >
                              <X />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {queuedItems.length > 0 && (
              <QueuedItems
                items={queuedItems}
                onRemove={handleRemoveQueued}
                onEdit={handleEditQueued}
                onSendNow={handleSendNowQueued}
                onClear={handleClearQueued}
                uploadUrl={client.uploadUrl}
                onPreviewAttachment={handlePreviewAttachment}
              />
            )}

            {pendingAskUser ? (
              <AskUserBar
                questions={pendingAskUser.questions}
                timeoutSecs={pendingAskUser.timeoutSecs}
                onActivity={handleAskUserActivity}
                onSubmit={handleAskUserSubmit}
                onCancel={handleAskUserCancel}
              />
            ) : pendingConfirm ? (
              <ConfirmBar
                toolName={pendingConfirm.name}
                toolArgs={pendingConfirm.arguments}
                onConfirm={(amendedArgs) => handleConfirm(true, amendedArgs)}
                onConfirmAndAllow={(pattern) => handleConfirm(true, undefined, pattern)}
                onConfirmAndAllowDir={(dir) => handleConfirm(true, undefined, undefined, dir)}
                onConfirmAll={() => handleConfirm(true, undefined, undefined, undefined, true)}
                onCancel={() => handleConfirm(false)}
              />
            ) : null}

            {isTaskSession ? (
              // Sub-agent transcript: a read-only note replaces the composer
              // (the backend rejects posts into task sessions as well).
              <div className="mx-auto w-full max-w-3xl px-4 pb-4 print:hidden">
                <div className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {t("taskSessionReadonly")}
                </div>
              </div>
            ) : (
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={handleSend}
                onStop={handleStop}
                streaming={streaming}
                hasMessages={!isEmpty}
                modelName={selectedModel || modelName}
                models={availableModels}
                defaultModel={modelName}
                onSelectModel={handleSelectModel}
                effortLevels={currentCaps?.effortLevels ?? []}
                selectedEffort={selectedEffort}
                defaultEffort={currentCaps?.defaultEffort}
                onSelectEffort={handleSelectEffort}
                parameterDefinitions={currentCatalogModel?.parameters ?? []}
                selectedParameters={selectedParameters}
                onSelectParameter={handleSelectParameter}
                supportsMaxMode={currentCatalogModel?.supportsMaxMode ?? false}
                maxMode={maxModeForSend}
                onToggleMaxMode={handleToggleMaxMode}
                skills={skills}
                skillIconUrl={client.skillIconUrl}
                pendingSkill={pendingSkill}
                activatingSkill={activatingSkill}
                activeSkillName={activeSkill}
                resettingSkill={resettingSkill}
                onPendingSkillChange={handlePendingSkillChange}
                onResetSkill={handleResetSkill}
                autoConfirm={autoConfirm}
                onAutoConfirmChange={handleAutoConfirmChange}
                attachments={pendingUploads}
                onAddFiles={addFiles}
                onRemoveUpload={removeUpload}
                onPreviewError={handleUploadPreviewError}
                onPreview={(src, alt) => setLightbox({ src, alt })}
                queueEnabled
                onSendNow={handleSendNow}
              />
            )}
          </>
        )}
      </div>
      {lightbox ? (
        <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
      {filePreview ? (
        <FilePreview
          file={filePreview}
          src={client.uploadUrl(filePreview.id)}
          downloadHref={client.uploadUrl(filePreview.id, filePreview.name ?? undefined)}
          onClose={() => setFilePreview(null)}
        />
      ) : null}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/70">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary/60 bg-background px-8 py-6 text-primary shadow-lg">
            <Upload className="h-6 w-6" strokeWidth={1.8} />
            <span className="text-sm font-medium">{t("dropFilesHint")}</span>
          </div>
        </div>
      )}
    </div>
    </RevealContext.Provider>
    </FoldAllContext.Provider>
    </ChatRuntimeContext.Provider>
  )
})

/** Thin left rail shown when history is collapsed: expand + new chat. */
function CollapsedRail({ onExpand, onNew }: { onExpand: () => void; onNew: () => void }) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center border-b border-transparent">
        <Button
          variant="ghost"
          size="icon"
          onClick={onExpand}
          className="h-8 w-8 [&_svg]:size-4 text-muted-foreground hover:text-foreground"
          title={t("history")}
        >
          <PanelLeftOpen />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onNew}
        className="h-8 w-8 [&_svg]:size-4 text-muted-foreground hover:text-foreground"
        title={t("newChat")}
      >
        <Plus />
      </Button>
    </div>
  )
}

interface MessageListProps {
  messages: Message[]
  streaming: boolean
  renderers: Record<string, ToolRenderer>
  onEditMessage: (content: string) => void
  /** "Edit & resend": rewind the conversation to BEFORE the `userIndex`-th
   *  user message and put its text back in the composer. */
  onRewindMessage?: (userIndex: number, content: string) => void
  /** Export a single assistant answer body to PDF. */
  onMessagePdf: (bodyEl: HTMLElement | null, title: string) => void
  messagesEndRef: React.RefObject<HTMLDivElement>
  /** URL resolver for attachments (`/api/chat/upload/{id}[?name=]`). */
  uploadUrl: (id: string, name?: string) => string
  /** Open the image lightbox (transcript thumbnails). */
  onPreview: (src: string, alt?: string) => void
  /** Reader is at the transcript tail (gates step-group auto-fold). */
  followTail?: boolean
}

const MessageList = memo(function MessageList({
  messages,
  streaming,
  renderers,
  onEditMessage,
  onRewindMessage,
  onMessagePdf,
  messagesEndRef,
  uploadUrl,
  onPreview,
  followTail = true,
}: MessageListProps) {
  // Runs of ≥3 reasoning/tool rows fold into one StepGroup; everything else
  // renders as before. Recomputed per messages change only — cheap (one
  // linear pass) next to the per-row markdown work it wraps.
  const blocks = useMemo(() => buildTranscriptBlocks(messages), [messages])
  // Entrance animation gate. Rows that appear one at a time (a turn in
  // progress) rise in; rows that arrive as a batch (a `history` frame
  // replacing the transcript, this list mounting over a resumed session)
  // render settled — forty rows lifting together is noise, not feedback.
  // Ids are monotonic (`nextMsgId`), so "above the highest id rendered
  // before this change" is "new". A replacement re-issues EVERY id: when no
  // previous id survives and more than a few rows are new, it was a batch.
  // (A brand-new chat's first send is 2 all-new rows — it animates.) The row
  // snapshots its verdict at mount (see MessageRow), so the flip to "seen"
  // on the next update cannot cut a running animation short. Read during
  // render, committed after — a repeated render of the same `messages`
  // reaches the same verdict.
  const seenMaxIdRef = useRef(-1)
  const prevMax = seenMaxIdRef.current
  let fresh = 0
  let maxId = prevMax
  let survivors = 0
  for (const m of messages) {
    if (m.id > prevMax) fresh++
    else survivors++
    if (m.id > maxId) maxId = m.id
  }
  const batch = survivors === 0 && fresh > 3
  const animateAboveId = batch ? Number.POSITIVE_INFINITY : prevMax
  useLayoutEffect(() => {
    seenMaxIdRef.current = maxId
  }, [maxId])
  // Per-row user-message ordinal — the anchor `POST /api/chat/rewind` counts
  // by (user bubbles map 1:1 to the server's user-role messages).
  const userOrdinals = useMemo(() => {
    const out = new Map<number, number>()
    let ordinal = -1
    for (const m of messages) if (m.role === "user") out.set(m.id, ++ordinal)
    return out
  }, [messages])
  const lastIndex = messages.length - 1
  const renderRow = (msg: Message, i: number, hideReasoning = false) => (
    <MessageRow
      key={msg.id}
      msg={msg}
      isFirst={i === 0}
      isLast={streaming && i === lastIndex}
      streaming={streaming}
      renderers={renderers}
      onEditMessage={onEditMessage}
      onRewindMessage={onRewindMessage}
      userIndex={msg.role === "user" ? (userOrdinals.get(msg.id) ?? -1) : -1}
      onMessagePdf={onMessagePdf}
      uploadUrl={uploadUrl}
      onPreview={onPreview}
      hideReasoning={hideReasoning}
      enter={msg.id > animateAboveId}
      afterPendingNote={i > 0 && messages[i - 1].role === "status" && messages[i - 1].pending === true}
    />
  )
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-4">
      {blocks.map((block) => {
        if (block.kind === "row") return renderRow(block.msg, block.index, block.hideReasoning)
        // A group is live while the stream is still feeding it: its last
        // member is the transcript's last message (nothing has followed yet).
        const tail = block.members[block.members.length - 1]
        const live = streaming && tail.index === lastIndex && tail.part === "step"
        return (
          <StepGroup key={block.key} members={block.members} live={live} followTail={followTail}>
            {block.members.map((m) =>
              m.part === "step" ? (
                renderRow(m.msg, m.index)
              ) : (
                // The answer's own reasoning, split off from its content row
                // (which renders below the group with hideReasoning).
                <div
                  key={`r${m.msg.id}`}
                  data-acc="msg-assistant"
                  className={cn("mt-1", m.msg.id > animateAboveId && "animate-rise-in")}
                >
                  <ReasoningBlock content={m.msg.reasoning!} isStreaming={streaming && m.index === lastIndex} />
                </div>
              ),
            )}
          </StepGroup>
        )
      })}
      <div ref={messagesEndRef} />
    </div>
  )
})

/**
 * One transcript row, memoized so streaming (which only mutates the last
 * message object) skips re-rendering every earlier row — the difference
 * between O(1) and O(n) markdown re-renders per token in long conversations.
 */
const MessageRow = memo(function MessageRow({
  msg,
  isFirst,
  isLast,
  streaming,
  renderers,
  onEditMessage,
  onRewindMessage,
  userIndex,
  onMessagePdf,
  uploadUrl,
  onPreview,
  hideReasoning = false,
  enter = false,
  afterPendingNote = false,
}: {
  msg: Message
  isFirst: boolean
  isLast: boolean
  streaming: boolean
  renderers: Record<string, ToolRenderer>
  onEditMessage: (content: string) => void
  onRewindMessage?: (userIndex: number, content: string) => void
  /** 0-based ordinal among user messages (`-1` for non-user rows). */
  userIndex: number
  onMessagePdf: (bodyEl: HTMLElement | null, title: string) => void
  uploadUrl: (id: string, name?: string) => string
  onPreview: (src: string, alt?: string) => void
  /** The reasoning of this assistant row is rendered elsewhere (inside the
   *  step group above it) — show only the content. */
  hideReasoning?: boolean
  /** Play the entrance animation. Read once at mount: the list's verdict
   *  flips to "seen" on the next update, and a class removed mid-animation
   *  would snap the row to its final state. */
  enter?: boolean
  /** The row directly above is a pending status note ("Compacting
   *  context..."): an empty placeholder here stays silent instead of adding
   *  a second spinner. */
  afterPendingNote?: boolean
}) {
  const enterRef = useRef(enter)
  const rise = enterRef.current ? "animate-rise-in" : undefined
  // Ref to the rendered answer body, printed as-is by the per-message PDF
  // export (so code highlighting, tables, etc. carry over faithfully).
  const bodyRef = useRef<HTMLDivElement>(null)
  // Boundary-marker summaries start collapsed; the toggle reveals the text.
  const [showSummary, setShowSummary] = useState(false)
  if (msg.role === "tool") {
    return (
      <div data-acc="tool-block" className={cn("mt-1", rise)}>
        <ToolCallBlock
          name={msg.toolName || ""}
          args={msg.toolArgs}
          result={msg.toolResult}
          success={msg.toolSuccess}
          isRunning={streaming && !msg.toolResult}
          renderers={renderers}
          callId={msg.toolCallId}
        />
      </div>
    )
  }

  if (msg.role === "status") {
    // A pending note is the turn's activity line while it lasts (the
    // placeholder below it yields its own spinner — see `afterPendingNote`).
    return (
      <div
        className={cn(
          "mt-2 flex items-center justify-center gap-2 py-1 text-center text-xs text-muted-foreground",
          rise,
        )}
      >
        {msg.pending && streaming && <Spinner size="sm" />}
        {msg.content}
      </div>
    )
  }

  if (msg.role === "error") {
    return (
      <div className={cn("mt-2 flex justify-center", rise)}>
        <div className="flex items-start gap-2 rounded-sm border border-border bg-card px-3 py-2 max-w-[80%]">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" strokeWidth={2} />
          <div className="min-w-0 flex-1 text-xs leading-4 text-foreground wrap-anywhere">{msg.content}</div>
        </div>
      </div>
    )
  }

  // Context-compaction boundary: render `[Conversation Summary]` messages as
  // a compact divider (the full pre-compaction history is in the archive
  // expander above), with the summary text itself one click away. Keeping the
  // marker visible explains WHY the transcript restarts here — e.g. after a
  // model switch slashed the context budget and compaction fired.
  if (msg.role === "user" && msg.summaryMarker) {
    const summaryText = msg.content.replace(/^\[Conversation Summary\]\s*/, "")
    return (
      <div className="mt-6 flex flex-col items-center gap-1 print:hidden">
        <button
          type="button"
          onClick={() => setShowSummary((v) => !v)}
          title={showSummary ? t("summaryHide") : t("summaryShow")}
          className="inline-flex max-w-[90%] items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Archive className="h-3 w-3 shrink-0" strokeWidth={1.8} />
          <span className="truncate">{t("contextCompacted")}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 transition-transform ${showSummary ? "rotate-180" : ""}`}
          />
        </button>
        {showSummary && (
          <div className="mt-1 w-full max-w-[90%] whitespace-pre-wrap rounded-sm border border-border bg-card px-3 py-2 text-xs leading-5 text-muted-foreground">
            {summaryText}
          </div>
        )}
      </div>
    )
  }

  if (msg.role === "user") {
    return (
      <div
        data-msg-id={msg.id}
        className={cn("group mt-6 flex scroll-mt-4 flex-col items-end gap-1", rise)}
      >
        {msg.attachments?.length ? (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {msg.attachments.map((a) =>
              isImageUploadId(a.id) ? (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPreview(uploadUrl(a.id), a.name || a.id)}
                  title={a.name || a.id}
                  className="block cursor-zoom-in overflow-hidden rounded-sm border border-border"
                >
                  <img
                    src={uploadUrl(a.id)}
                    alt={a.name || a.id}
                    loading="lazy"
                    className="h-20 w-20 object-cover"
                  />
                </button>
              ) : (
                // Server sends Content-Disposition: attachment — click = download.
                <a
                  key={a.id}
                  href={uploadUrl(a.id, a.name)}
                  title={`${t("downloadFile")} — ${a.name || a.id}`}
                  className="inline-flex max-w-56 items-center gap-1.5 rounded-sm border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground/85 transition-colors hover:bg-muted"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{a.name || a.id}</span>
                </a>
              ),
            )}
          </div>
        ) : null}
        {msg.content ? (
          <div data-acc="msg-user" className="max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-sm bg-muted px-4 py-2.5 text-sm">
            {msg.content}
          </div>
        ) : null}
        <UserMessageActions
          content={msg.content}
          onEdit={onEditMessage}
          onRewind={
            onRewindMessage && !streaming && userIndex >= 0
              ? () => onRewindMessage(userIndex, msg.content)
              : undefined
          }
        />
      </div>
    )
  }

  // assistant
  // A pending status note right above this placeholder is already the
  // activity line (with its own spinner): a second "Thinking…" would be
  // noise, so the placeholder renders nothing until the note resolves.
  const showThinking = !msg.content && isLast && !msg.reasoning && !afterPendingNote
  if (!msg.content && !msg.reasoning && !showThinking) return null

  const hasContent = !!msg.content
  // Reasoning may be rendered inside the step group above (hideReasoning):
  // then this row is content-only and spaces like an answer without one.
  const hasReasoning = !!msg.reasoning && !hideReasoning
  const spacing = hasReasoning ? "mt-1" : hasContent || isLast ? "mt-5" : "mt-1"

  return (
    <div data-acc="msg-assistant" className={`group ${isFirst ? "" : spacing}`}>
      {hasReasoning && (
        <ReasoningBlock content={msg.reasoning!} isStreaming={isLast} className={rise} />
      )}
      {hasContent ? (
        // The body mounts when the first content token lands, replacing the
        // "Thinking…" line (or following the reasoning row): fade it in so
        // the swap reads as a continuation rather than a cut. Fade only — a
        // lift here would push the streaming text around under the eye. Same
        // gate as the row: history bodies render settled.
        <div
          ref={bodyRef}
          data-acc="msg-assistant-body"
          className={cn(rise && "animate-fade-in", hasReasoning && "mt-4")}
        >
          <Markdown content={msg.content} isStreaming={isLast} />
        </div>
      ) : showThinking ? (
        <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", rise)}>
          <Spinner size="sm" />
          {t("thinking")}
        </div>
      ) : null}
      {hasContent && (
        <MessageActions content={msg.content} bodyRef={bodyRef} onExportPdf={onMessagePdf} />
      )}
    </div>
  )
})

function UserMessageActions({
  content,
  onEdit,
  onRewind,
}: {
  content: string
  onEdit: (content: string) => void
  /** "Edit & resend": rewind to before this message (absent while streaming). */
  onRewind?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await copyToClipboard(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      {onRewind && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onRewind}
          className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
          title={t("rewindEdit")}
        >
          <RotateCcw />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onEdit(content)}
        className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
        title={t("edit")}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
        title={copied ? t("copied") : t("copy")}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  )
}
