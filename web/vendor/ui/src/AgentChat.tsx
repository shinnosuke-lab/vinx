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
import { Archive, ChevronDown, ChevronLeft, Copy, Check, FileText, Pencil, RotateCcw, X, XCircle, PanelLeftOpen, Plus, Upload } from "lucide-react"
import { ChatBusyError, createChatClient } from "./client"
import type { ModelCaps } from "./client"
import { VINX_LOGO } from "./assets/vinx-logo"
import { defaultToolRenderers } from "./components/chat/tools"
import { setLabels, t, tf } from "./lib/i18n"
import { applyLlmStyle, runLlmScript, currentLlmCss, currentLlmJs } from "./lib/llm-style"
import { ChatRuntimeContext } from "./lib/chat-runtime"
import { themeToCssVars } from "./lib/theme"
import { copyToClipboard, useMediaQuery, MOBILE_QUERY } from "./lib/utils"
import { Markdown } from "./components/chat/markdown"
import { ReasoningBlock } from "./components/chat/reasoning-block"
import { ToolCallBlock } from "./components/chat/tool-call-block"
import { ConfirmBar } from "./components/chat/confirm-bar"
import { AskUserBar } from "./components/chat/ask-user-bar"
import { Lightbox } from "./components/chat/lightbox"
import { MessageActions } from "./components/chat/message-actions"
import { ChatInput } from "./components/chat/chat-input"
import { ChatWelcome } from "./components/chat/chat-welcome"
import { QueuedItems, type QueuedItem } from "./components/chat/queued-items"
import { SessionsPanel } from "./components/chat/sessions-panel"
import { ExportMenu } from "./components/chat/export-menu"
import { SessionReleases } from "./components/chat/session-releases"
import { Spinner } from "./components/shared/spinner"
import { Button } from "./components/ui/button"
import { toast } from "./components/ui/toast"
import type {
  AgentChatHandle,
  AgentChatProps,
  ArchiveGeneration,
  AskAnswer,
  AskQuestion,
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

/**
 * Save a DOM region to PDF via the browser print dialog. Shared by the header
 * "export PDF" (whole transcript) and the per-message export button.
 *
 * Sizes a single tall `@page` to the content: measures `el` at the printed
 * width (190mm) so wrapping matches the PDF, injects a one-shot `@page`, and
 * reproduces the active chat skin's page background. Cleaned up on `afterprint`.
 *
 * `neutralizeInnerColumn` handles the transcript container, whose inner column
 * (`mx-auto max-w-3xl px-4`) and print-only title (`[data-print-title]`) must
 * be measured the way the print stylesheet renders them. For a single message
 * body element there is no such column, so leave it off.
 */
function printElementToPdf(
  el: HTMLElement,
  opts: { title?: string; neutralizeInnerColumn?: boolean } = {},
) {
  const prevTitle = document.title
  const cleanup = () => {
    document.getElementById("print-single-page")?.remove()
    document.title = prevTitle
  }

  const run = () => {
    // Measure with the SAME box the print stylesheet renders: theme.css's
    // `@media print` widens the transcript by dropping the inner column's
    // `px-4` / `max-w-3xl`. Measuring with the on-screen padding narrows the
    // text, wraps more lines, and over-counts the height — which then sizes
    // the single page too tall and leaves a long blank tail.
    const inner = opts.neutralizeInnerColumn
      ? el.querySelector<HTMLElement>(":scope > div:not([data-print-title])")
      : null
    // Save whole inline styles: the overrides below use `!important`
    // priority, which a property-by-property restore can't clear.
    const elCss = el.style.cssText
    const innerCss = inner?.style.cssText ?? ""
    // The print-only title is `display: none` on screen, so it would be
    // missing from the measured scrollHeight and the printed page would come
    // up short. Show it for the (synchronous, paint-free) measurement, then
    // restore.
    const titleEl = opts.neutralizeInnerColumn
      ? el.querySelector<HTMLElement>("[data-print-title]")
      : null
    const titleCss = titleEl?.style.cssText ?? ""
    titleEl?.style.setProperty("display", "block", "important")
    // Force the SAME geometry the print stylesheet forces (full width, no
    // column max-width/margins) — and with `!important`, so an active
    // `set_chat_style` skin's own `!important` width/padding can't narrow
    // the MEASURED content below the PRINTED width. A narrower measurement
    // wraps more lines and over-counts the height, sizing the single page
    // far too tall and leaving a long blank tail (the reported bug).
    el.style.setProperty("overflow", "visible", "important")
    el.style.setProperty("height", "auto", "important")
    el.style.setProperty("width", "190mm", "important")
    el.style.setProperty("max-width", "190mm", "important")
    if (inner) {
      inner.style.setProperty("max-width", "none", "important")
      inner.style.setProperty("margin-left", "0", "important")
      inner.style.setProperty("margin-right", "0", "important")
      inner.style.setProperty("padding-left", "0", "important")
      inner.style.setProperty("padding-right", "0", "important")
    }
    const contentHeightMm = Math.ceil((el.scrollHeight * 25.4) / 96)
    el.style.cssText = elCss
    if (inner) inner.style.cssText = innerCss
    if (titleEl) titleEl.style.cssText = titleCss
    // The page must clear the content plus the `@page` top+bottom margins;
    // a small safety margin guards against sub-pixel rounding clipping the
    // last line. Nothing more, so the tail stays tight (no long blank).
    // Keep in sync with the `[data-chat-messages]` print `padding` in
    // theme.css: the @page margin is dropped to 0 so a custom-skin page
    // background can bleed to the paper edge, and this inset moves into
    // that padding instead — so the single page is still sized around it.
    const PAGE_MARGIN_MM = 10
    const SAFETY_MM = 4
    const pageHeightMm = contentHeightMm + PAGE_MARGIN_MM * 2 + SAFETY_MM
    // Reproduce the active chat skin's page background (the resolved
    // `--color-background`, read off `.acc-root`) so a themed transcript
    // exports on themed "paper" instead of white — which also keeps a dark
    // skin's light text readable. Decorative background images / JS effects
    // are deliberately NOT reproduced (they only add noise to a document).
    const accRoot = el.closest(".acc-root") ?? document.body
    const pageBg = getComputedStyle(accRoot).backgroundColor
    const style = document.createElement("style")
    style.id = "print-single-page"
    style.textContent = `@media print { @page { size: 210mm ${pageHeightMm}mm !important; margin: 0 !important; } html { background: ${pageBg} !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`
    document.head.appendChild(style)
    // The browser derives the default "Save as PDF" filename from
    // document.title — swap in the session title for the dialog's lifetime.
    if (opts.title) document.title = opts.title
    window.addEventListener("afterprint", cleanup, { once: true })
    requestAnimationFrame(() => window.print())
  }

  // Late-loading webfonts change line metrics (hence wrapping and height);
  // wait for them so the measurement matches what actually prints.
  const fonts = document.fonts
  if (fonts?.ready) {
    fonts.ready.then(run, run)
  } else {
    run()
  }
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
}

/** An attachment staged in the composer: uploaded eagerly on paste/pick, sent
 *  as an upload reference with the next message. */
interface PendingUpload {
  key: number
  name: string
  /** `image` renders a thumbnail chip; `file` a name+size chip. */
  kind: "image" | "file"
  size: number
  /** Object URL for the local preview (images only). */
  previewUrl?: string
  /** Upload id once the eager upload finished; chips without it block send. */
  id?: string
  /** Text-file line count from the upload response (echoed with the send). */
  lines?: number | null
}

let nextUploadKey = 0

/** Max attachments per message, images + files combined. */
const MAX_ATTACHMENTS_PER_MESSAGE = 3

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const FILE_MAX_BYTES = 20 * 1024 * 1024

/** Compressible image types (the upload endpoint's image set). Anything else
 *  — including other `image/*` like SVG — uploads as a plain file. */
const IMAGE_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

/** `<uuid>.<ext>` upload id → is it an image (thumbnail vs file chip)? */
function isImageUploadId(id: string): boolean {
  const ext = id.split(".").pop() ?? ""
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)
}

/** localStorage namespace for the per-session model override. The
 *  `ontrak.model.` prefix is a leftover from the ontrakagent codebase this
 *  UI was ported from; reads fall back to the legacy key once and migrate
 *  its value forward so existing picks survive the rename. */
const MODEL_KEY_PREFIX = "agent.model."
const LEGACY_MODEL_KEY_PREFIX = "ontrak.model."

function readModelOverride(sid: string): string {
  try {
    const current = localStorage.getItem(`${MODEL_KEY_PREFIX}${sid}`)
    if (current !== null) return current
    const legacy = localStorage.getItem(`${LEGACY_MODEL_KEY_PREFIX}${sid}`)
    if (legacy !== null) {
      localStorage.setItem(`${MODEL_KEY_PREFIX}${sid}`, legacy)
      localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}${sid}`)
      return legacy
    }
  } catch {
    /* private mode / quota: the override simply stays unread */
  }
  return ""
}

function writeModelOverride(sid: string, model: string) {
  try {
    if (model) localStorage.setItem(`${MODEL_KEY_PREFIX}${sid}`, model)
    else localStorage.removeItem(`${MODEL_KEY_PREFIX}${sid}`)
    // Drop any legacy twin so the two namespaces can never diverge.
    localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}${sid}`)
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
  const [input, setInput] = useState("")
  // Composer skill state: pending is the next-turn intent; activating bridges
  // send → authoritative SSE; active is the server-owned session context.
  const [pendingSkill, setPendingSkill] = useState<SkillInfo | null>(null)
  const [activatingSkill, setActivatingSkill] = useState<SkillInfo | null>(null)
  const [resettingSkill, setResettingSkill] = useState(false)
  const [streaming, setStreaming] = useState(false)
  /** A stored session is being fetched/attached: show a centered spinner
   *  instead of the (misleading) welcome composer or the previous
   *  session's stale transcript. */
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [pendingAskUser, setPendingAskUser] = useState<PendingAskUser | null>(null)
  /** Live progress per `task` sub-agent (keyed by the parent task tool_call
   *  id), fed by `subagent` frames; an entry clears when the task's own
   *  tool_result lands. `startedAt` (first frame seen) anchors the elapsed
   *  readouts. Rendered as a strip above the composer and shared with the
   *  `task` tool card via the chat runtime context. */
  const [subagentNotes, setSubagentNotes] = useState<
    Record<string, { note: string; startedAt: number }>
  >({})
  /** Tasks whose per-task cancel was requested; the row shows "cancelling…"
   *  until the task's tool_result lands and clears it. */
  const [cancellingTasks, setCancellingTasks] = useState<Set<string>>(new Set())
  /** Messages parked in the server-side session queue (`queue` frames);
   *  they auto-start when the running turn ends. Ids address one item for
   *  remove/edit; `attachments` is the count riding the parked message. */
  const [queuedItems, setQueuedItems] = useState<QueuedItem[]>([])
  // Session-scoped full-auto (backend-owned; synced from SSE `session` frames
  // and session detail so a reload / second tab converges with the backend).
  const [autoConfirm, setAutoConfirm] = useState(false)
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
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const pendingUploadsRef = useRef<PendingUpload[]>([])
  pendingUploadsRef.current = pendingUploads
  /** Full-screen image preview (composer chips + transcript thumbnails). */
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null)
  const [chatTitle, setChatTitle] = useState("")
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
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

  // ── Streaming delta throttle ──
  // Applying every SSE frame directly means one full markdown re-parse of the
  // growing message per provider chunk (cost grows with message length). Text
  // deltas are buffered here and flushed as a single setMessages at most every
  // DELTA_FLUSH_MS; structural events flush synchronously first so ordering is
  // preserved. `toolArgs` holds the ids of tool calls whose accumulated args
  // (in toolArgsRef) need syncing into state.
  const pendingDeltasRef = useRef<{ content: string; reasoning: string; toolArgs: Set<string> }>({
    content: "",
    reasoning: "",
    toolArgs: new Set(),
  })
  const flushTimerRef = useRef<number | null>(null)
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
      return
    }
    setSelectedModel(readModelOverride(sessionId))
    setSelectedEffort(readEffortOverride(sessionId))
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
      const sid = sessionIdRef.current
      if (!sid) return
      writeModelOverride(sid, next)
      writeEffortOverride(sid, "")
    },
    [modelName],
  )

  const handleSelectEffort = useCallback((effort: string) => {
    setSelectedEffort(effort)
    const sid = sessionIdRef.current
    if (sid) writeEffortOverride(sid, effort)
  }, [])

  // Capability record of the model the next turn will use (override or the
  // configured default) — drives the effort badge next to the model switcher.
  const currentCaps: ModelCaps | undefined = modelCaps[selectedModel || modelName]

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
          if (alive) setSkills(r.skills)
        })
        .catch(() => {})
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
  }, [client])

  // Sticky autoscroll. `showJumpToBottom` surfaces a floating button when the
  // user scrolls away during streaming, so new output is never silently missed.
  const STICK_THRESHOLD = 80
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  // Button visibility follows the live scroll position. It must NOT gate
  // autoscroll: the scroll event is async, so a high-frequency streaming flush
  // could autoscroll before the event lands, clobbering the user's scroll-up.
  // Stable identity so the callback ref below can add/remove it cleanly.
  const handleContainerScroll = useCallback(() => {
    const c = messagesContainerRef.current
    if (!c) return
    setShowJumpToBottom(c.scrollTop + c.clientHeight < c.scrollHeight - STICK_THRESHOLD)
  }, [])
  // Callback ref: attach the scroll listener the moment the messages container
  // mounts, detach when it unmounts. Driven by the node's lifecycle, NOT by a
  // guessed render condition — the container is absent during the session-load
  // spinner and the empty-state welcome, so a useEffect([isEmpty]) misses the
  // loading->loaded remount and never attaches (the bug that hid the
  // jump-to-bottom button on a resumed/refreshed session).
  const setMessagesContainer = useCallback(
    (node: HTMLDivElement | null) => {
      const prev = messagesContainerRef.current
      if (prev) prev.removeEventListener("scroll", handleContainerScroll)
      messagesContainerRef.current = node
      if (node) node.addEventListener("scroll", handleContainerScroll, { passive: true })
    },
    [handleContainerScroll],
  )
  // Deterministic stick-to-bottom: decide from the PREVIOUS scrollHeight vs the
  // live scrollTop (which the browser keeps unchanged when content is appended
  // below the viewport). This reads the user's latest scroll synchronously, so
  // there is no race with the async scroll event and no dependence on a stale
  // flag. Runs before paint to avoid a visible jump.
  const prevScrollHeight = useRef(0)
  useLayoutEffect(() => {
    const c = messagesContainerRef.current
    if (!c) return
    const wasAtBottom =
      prevScrollHeight.current - c.scrollTop - c.clientHeight <= STICK_THRESHOLD
    if (wasAtBottom) c.scrollTop = c.scrollHeight
    prevScrollHeight.current = c.scrollHeight
  }, [messages])
  const jumpToBottom = useCallback(() => {
    const c = messagesContainerRef.current
    if (c) c.scrollTop = c.scrollHeight
    setShowJumpToBottom(false)
  }, [])

  // Apply all buffered deltas as one state update (and cancel the timer).
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

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null
        flushDeltas()
      }, DELTA_FLUSH_MS)
    }
  }, [flushDeltas])

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
        const next = [...prev]
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
          pendingDeltasRef.current.content += ev.data.text ?? ""
          scheduleFlush()
          return
        }
        case "reasoning": {
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
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId++, role: "status", content: ev.data.text ?? "" },
          ])
          break
        }
        case "confirm": {
          setPendingConfirm({ id: ev.data.id, name: ev.data.name, arguments: ev.data.arguments })
          break
        }
        case "ask_user": {
          setPendingAskUser({
            id: ev.data.id,
            questions: ev.data.questions,
            timeoutSecs: ev.data.timeout_secs ?? null,
          })
          break
        }
        case "queue": {
          const items = Array.isArray(ev.data.items) ? ev.data.items : []
          setQueuedItems(
            items.map(
              (i: { id?: number; message?: string; attachments?: number }) => ({
                id: i.id ?? 0,
                message: i.message ?? "",
                attachments: i.attachments ?? 0,
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
          // Envelope from a `task` sub-agent: { task_id, event, data }. Only
          // a few inner events matter for the progress strip; the rest are
          // deliberately not spliced into the transcript (the parent `task`
          // tool row is the transcript entry, its result carries the report).
          const taskId = ev.data.task_id as string | undefined
          if (!taskId) break
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
            if (existing && note === null) return prev
            return {
              ...prev,
              [taskId]: {
                note: note ?? existing?.note ?? "",
                startedAt: existing?.startedAt ?? Date.now(),
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
          // one behind) — mirrors the error path's cleanup.
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            return last?.role === "assistant" && !last.content && !last.reasoning
              ? prev.slice(0, -1)
              : prev
          })
          // The next queued message auto-starts server-side and arrives as a
          // fresh snapshot on this same stream, which flips `streaming` back
          // on — no timer, no guessing when to re-attach.
          setStreaming(false)
          refreshSessions()
          break
        }
        default:
          break
      }
    },
    [onSessionChange, refreshSessions, flushDeltas, scheduleFlush, reportSendError, rollbackSkillAction],
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
          if (previewUrl) URL.revokeObjectURL(previewUrl)
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
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
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
      const shown = displayContent ?? raw
      setInput("")
      if (attachments.length > 0) {
        uploads.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
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
      requestAnimationFrame(() => {
        const container = messagesContainerRef.current
        if (container) container.scrollTop = container.scrollHeight
      })
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
        )
        .then((ack) => {
          if (!ack.session_id) return
          if (!sessionIdRef.current) {
            // First message of a new chat: naming the session starts the
            // follow stream, which replays this turn from the feed tail.
            if (selectedModelRef.current) writeModelOverride(ack.session_id, selectedModelRef.current)
            if (selectedEffortRef.current) writeEffortOverride(ack.session_id, selectedEffortRef.current)
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
        uploads.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
        setPendingUploads([])
      }
      client
        .queueMessage(
          text,
          sessionIdRef.current,
          attachments,
          selectedModelRef.current || undefined,
          effortForSendRef.current || undefined,
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
      uploads.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
      setPendingUploads([])
    }
    client
      .interruptMessage(
        text,
        sessionIdRef.current,
        attachments,
        selectedModelRef.current || undefined,
        effortForSendRef.current || undefined,
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

  // Badge click: turn session full-auto off (shared flag — applies to the
  // in-flight turn's next tool call too).
  const handleAutoConfirmOff = useCallback(() => {
    const sid = sessionIdRef.current
    if (sid) void client.setAutoConfirm(sid, false)
    setAutoConfirm(false)
  }, [client])

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
    setPendingConfirm(null)
    setPendingAskUser(null)
    setQueuedItems([])
    setAutoConfirm(false)
    setStreaming(false)
    setSessionLoading(false)
    setChatTitle("")
    setActiveSkill(null)
    setPendingSkill(null)
    setActivatingSkill(null)
    setResettingSkill(false)
    skillActionRef.current = null
    resetDeltaBuffers()
    onSessionChange?.(null)
  }, [onSessionChange, resetDeltaBuffers])

  const resumeSession = useCallback(
    (id: string) => {
      // Re-opening the session already on screen is a no-op: its follow stream
      // is live and the transcript current. Clearing below would raise the
      // spinner while `setSessionId` bails on the unchanged value, so the
      // stream never reconnects and no `history` snapshot ever lowers it again.
      if (sessionIdRef.current === id) return
      setStreaming(false)
      setQueuedItems([])
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
      onSessionChange?.(id)
      const gen = ++loadGenRef.current
      client
        .getSession(id)
        .then((detail) => {
          // A newer load/new-chat superseded this response: discard it.
          if (gen !== loadGenRef.current) return
          setChatTitle(detail.meta?.title || "")
        })
        .catch(() => {
          if (gen !== loadGenRef.current) return
          setChatTitle("")
        })
    },
    [client, onSessionChange, resetDeltaBuffers],
  )

  const handleRename = useCallback(
    (id: string, title: string) => {
      void client.updateSession(id, { title }).then(refreshSessions)
      if (id === sessionIdRef.current) setChatTitle(title)
    },
    [client, refreshSessions],
  )

  const handleDelete = useCallback(
    (id: string) => {
      void client.deleteSession(id).then(() => {
        refreshSessions()
        if (id === sessionIdRef.current) handleNewChat()
      })
    },
    [client, refreshSessions, handleNewChat],
  )

  useImperativeHandle(
    ref,
    () => ({ newChat: handleNewChat, openSession: resumeSession }),
    [handleNewChat, resumeSession],
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

  // Per-message PDF: isolate a single assistant answer body. `print-solo` on
  // the container + `data-print-solo` on the body element drive theme.css's
  // solo print rules (hide every other message and the session title); the
  // shared helper sizes the page to just this message. No title, no reasoning.
  const handleMessagePdf = useCallback((bodyEl: HTMLElement | null, title: string) => {
    const container = messagesContainerRef.current
    if (!container || !bodyEl) return
    container.classList.add("print-solo")
    bodyEl.setAttribute("data-print-solo", "")
    const cleanup = () => {
      container.classList.remove("print-solo")
      bodyEl.removeAttribute("data-print-solo")
    }
    window.addEventListener("afterprint", cleanup, { once: true })
    printElementToPdf(bodyEl, { title })
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
    void client.updateSession(sid, { title: trimmed }).then(refreshSessions)
    setChatTitle(trimmed)
    setTitleEditing(false)
    setTitleDraft("")
  }, [client, titleDraft, chatTitle, refreshSessions, cancelTitleEdit])

  const styleVars = themeToCssVars(theme)
  // Live sub-agent state joined with cancel flags for the `task` tool cards
  // (keyed by tool_call id, same key the cards receive as `callId`).
  const runtimeSubagents = useMemo(() => {
    const out: Record<string, { note: string; startedAt: number; cancelling: boolean }> = {}
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
    }),
    [client, sessionId, runtimeSubagents, handleCancelTask, sessionHref],
  )

  return (
    <ChatRuntimeContext.Provider value={runtimeValue}>
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
                skills={skills}
                skillIconUrl={client.skillIconUrl}
                pendingSkill={pendingSkill}
                activatingSkill={activatingSkill}
                activeSkillName={activeSkill}
                resettingSkill={resettingSkill}
                onPendingSkillChange={handlePendingSkillChange}
                onResetSkill={handleResetSkill}
                autoConfirm={autoConfirm}
                onAutoConfirmOff={handleAutoConfirmOff}
                attachments={pendingUploads}
                onAddFiles={addFiles}
                onRemoveUpload={removeUpload}
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
                skills={skills}
                skillIconUrl={client.skillIconUrl}
                pendingSkill={pendingSkill}
                activatingSkill={activatingSkill}
                activeSkillName={activeSkill}
                resettingSkill={resettingSkill}
                onPendingSkillChange={handlePendingSkillChange}
                onResetSkill={handleResetSkill}
                autoConfirm={autoConfirm}
                onAutoConfirmOff={handleAutoConfirmOff}
                attachments={pendingUploads}
                onAddFiles={addFiles}
                onRemoveUpload={removeUpload}
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
                <SessionReleases client={client} sessionId={sessionId} refreshKey={streaming} basePath={basePath} />
                {enableExport && messages.length > 0 && (
                  <ExportMenu onMarkdown={handleExport} onPdf={handlePdf} />
                )}
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
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
                  onRewindMessage={handleRewindMessage}
                  onMessagePdf={handleMessagePdf}
                  messagesEndRef={messagesEndRef}
                  uploadUrl={client.uploadUrl}
                  onPreview={(src, alt) => setLightbox({ src, alt })}
                />
              </div>
              {showJumpToBottom && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  aria-label={t("jumpToBottom")}
                  title={t("jumpToBottom")}
                  className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 inline-flex items-center justify-center rounded-full border border-border bg-card p-1.5 text-muted-foreground shadow-md transition-colors hover:text-foreground"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </div>

            {streaming && Object.keys(subagentNotes).length > 0 && (
              <div className="mx-auto w-full max-w-3xl space-y-px px-4 pb-1 print:hidden">
                {Object.entries(subagentNotes).map(([taskId, live]) => {
                  const label = taskLabel(toolArgsRef.current[taskId])
                  const cancelling = cancellingTasks.has(taskId)
                  return (
                    <div
                      key={taskId}
                      className="group flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40"
                    >
                      <Spinner className="h-3 w-3 shrink-0" />
                      <span className="shrink-0 rounded-[3px] bg-muted px-1 py-px">
                        {t("subagentTag")}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={label ?? undefined}>
                        {label ?? taskId.slice(0, 8)}
                        <span className="text-muted-foreground/60">
                          {" · "}
                          {cancelling ? t("subagentCancelling") : live.note}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                        {formatElapsed(Date.now() - live.startedAt)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={cancelling}
                        onClick={() => handleCancelTask(taskId)}
                        className="h-5 w-5 shrink-0 rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40 [@media(hover:none)]:opacity-100 [&_svg]:size-3"
                        title={t("subagentCancel")}
                      >
                        <X />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}

            {queuedItems.length > 0 && (
              <QueuedItems
                items={queuedItems}
                onRemove={handleRemoveQueued}
                onEdit={handleEditQueued}
                onClear={handleClearQueued}
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
              skills={skills}
              skillIconUrl={client.skillIconUrl}
              pendingSkill={pendingSkill}
              activatingSkill={activatingSkill}
              activeSkillName={activeSkill}
              resettingSkill={resettingSkill}
              onPendingSkillChange={handlePendingSkillChange}
              onResetSkill={handleResetSkill}
              autoConfirm={autoConfirm}
              onAutoConfirmOff={handleAutoConfirmOff}
              attachments={pendingUploads}
              onAddFiles={addFiles}
              onRemoveUpload={removeUpload}
              onPreview={(src, alt) => setLightbox({ src, alt })}
              queueEnabled
              onSendNow={handleSendNow}
            />
          </>
        )}
      </div>
      {lightbox ? (
        <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
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
}: MessageListProps) {
  // Per-row user-message ordinal — the anchor `POST /api/chat/rewind` counts
  // by (user bubbles map 1:1 to the server's user-role messages).
  let userOrdinal = -1
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-4">
      {messages.map((msg, i) => {
        if (msg.role === "user") userOrdinal++
        return (
          <MessageRow
            key={msg.id}
            msg={msg}
            isFirst={i === 0}
            isLast={streaming && i === messages.length - 1}
            streaming={streaming}
            renderers={renderers}
            onEditMessage={onEditMessage}
            onRewindMessage={onRewindMessage}
            userIndex={msg.role === "user" ? userOrdinal : -1}
            onMessagePdf={onMessagePdf}
            uploadUrl={uploadUrl}
            onPreview={onPreview}
          />
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
}) {
  // Ref to the rendered answer body, printed as-is by the per-message PDF
  // export (so code highlighting, tables, etc. carry over faithfully).
  const bodyRef = useRef<HTMLDivElement>(null)
  // Boundary-marker summaries start collapsed; the toggle reveals the text.
  const [showSummary, setShowSummary] = useState(false)
  if (msg.role === "tool") {
    return (
      <div data-acc="tool-block" className="mt-1">
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
    return (
      <div className="mt-2 py-1 text-center text-xs text-muted-foreground">
        {msg.content}
      </div>
    )
  }

  if (msg.role === "error") {
    return (
      <div className="mt-2 flex justify-center">
        <div className="flex items-start gap-2 rounded-sm border border-border bg-card px-3 py-2 max-w-[80%]">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" strokeWidth={2} />
          <div className="min-w-0 flex-1 text-xs leading-4 text-foreground">{msg.content}</div>
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
      <div className="group mt-6 flex flex-col items-end gap-1">
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
  const showThinking = !msg.content && isLast && !msg.reasoning
  if (!msg.content && !msg.reasoning && !isLast) return null

  const hasContent = !!msg.content
  const hasReasoning = !!msg.reasoning
  const spacing = hasReasoning ? "mt-1" : hasContent || isLast ? "mt-5" : "mt-1"

  return (
    <div data-acc="msg-assistant" className={`group ${isFirst ? "" : spacing}`}>
      {hasReasoning && <ReasoningBlock content={msg.reasoning!} isStreaming={isLast} />}
      {hasContent ? (
        <div ref={bodyRef} data-acc="msg-assistant-body" className={hasReasoning ? "mt-4" : undefined}>
          <Markdown content={msg.content} isStreaming={isLast} />
        </div>
      ) : showThinking ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
