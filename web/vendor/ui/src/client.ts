/**
 * SSE + REST client for the agent-core web layer (protocol 2).
 *
 * `POST /api/chat` only triggers the turn (JSON ack); ALL streaming happens on
 * `GET /api/chat/stream/{session_id}` — the same self-contained sequence
 * (`session → history → live frames → done|error`) serves the sender and any
 * re-attached viewer. `streamChat` chains the two; `attachStream` attaches to
 * an already-running (or just-finished) turn. Event names align with
 * `agent-core::web::sse`:
 * `session | history | content | reasoning | tool_start | tool_args |
 *  tool_result | confirm | ask_user | skill | status | render | title |
 *  error | done`.
 */

import type {
  AppsMarket,
  ArchiveGeneration,
  AskAnswer,
  ChatEvent,
  MarketSkillPreview,
  MessageView,
  SessionSummary,
  SkillAction,
  SkillDiagnostic,
  SkillInfo,
  SkillsMarket,
} from './types'

function parseFrame(frame: string): ChatEvent | null {
  let event = ''
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  // Comment blocks (heartbeats) have no event name — skip them.
  if (!event || dataLines.length === 0) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

export class ChatUnavailableError extends Error {}

/** `POST /api/chat` was rejected because a turn is already running in the
 *  session (HTTP 409 `turn_in_flight`) — attach to watch it instead. */
export class ChatBusyError extends Error {
  constructor(public sessionId: string) {
    super('turn_in_flight')
  }
}

/** JSON ack of `POST /api/chat` (protocol 2). */
export interface ChatAck {
  ok: boolean
  session_id: string
  /** `true` = a turn started (attach to watch); `false` = reset-only applied. */
  running: boolean
  active_skill?: string | null
  auto_confirm?: boolean
  /** `true` = the message was parked in the session queue (`queue: true`
   *  request while a turn was running); it starts when the turn ends. */
  queued?: boolean
  /** 1-based queue position when `queued`. */
  position?: number
  /** `true` = the running turn was told to wind down and this message was
   *  parked at the queue front (`interrupt: true`); it starts the moment
   *  the turn ends. */
  interrupted?: boolean
}

/** `POST /api/chat/upload` response: the reference riding the next message. */
export interface UploadResult {
  id: string
  name: string
  /** `image` enters model context on vision models; `file` is read on demand
   *  via tools (path note on the wire). */
  kind: 'image' | 'file'
  size: number
  /** Line count for text-like files (echoed back with the message so the
   *  wire note can mention it without re-reading the file). */
  lines?: number | null
}

export interface ChatClient {
  streamChat(
    message: string,
    sessionId: string | null,
    onEvent: (ev: ChatEvent) => void,
    signal: AbortSignal,
    skillAction?: SkillAction,
    /** Upload references (`uploadFile` results) riding this message. */
    attachments?: { id: string; name?: string; lines?: number | null }[],
    /** Per-turn model override (from the chat input's model switcher). */
    model?: string,
    /** Per-turn reasoning-effort override (from the effort switcher). */
    reasoningEffort?: string,
  ): Promise<void>
  /** Trigger a turn WITHOUT attaching to its stream — for clients that keep a
   *  `follow` stream open, where the turn's frames arrive there anyway. */
  sendMessage(
    message: string,
    sessionId: string | null,
    skillAction?: SkillAction,
    attachments?: { id: string; name?: string; lines?: number | null }[],
    model?: string,
    reasoningEffort?: string,
  ): Promise<ChatAck>
  /** Upload one file (image or any other type) for chat attachment. */
  uploadFile(blob: Blob, name?: string): Promise<UploadResult>
  /** Absolute URL of an uploaded file (for `<img src>` / download links —
   *  pass `name` so non-image downloads restore the original file name). */
  uploadUrl(id: string, name?: string): string
  /** Attach to a session's stream (protocol 2 single stream exit): replays the
   *  running turn (or converges via `history` + `done` when idle/finished).
   *
   *  `follow` upgrades it to a session-level stream: instead of ending at the
   *  turn's `done`, it stays open and replays a fresh `session` + `history`
   *  snapshot whenever the next turn starts (a queued follow-up, another
   *  tab's message, a rewind). The caller never has to guess when to
   *  re-attach; it just keeps one connection per open session. */
  attachStream(
    sessionId: string,
    onEvent: (ev: ChatEvent) => void,
    signal: AbortSignal,
    follow?: boolean,
  ): Promise<void>
  /** Park a message in the session queue while a turn runs (`queue: true`).
   *  Resolves the ack: `queued: true` = parked (it auto-starts later);
   *  `queued` absent with `running: true` = the turn had already ended and
   *  this message started a fresh turn instead. */
  queueMessage(
    message: string,
    sessionId: string,
    attachments?: { id: string; name?: string; lines?: number | null }[],
    model?: string,
    reasoningEffort?: string,
  ): Promise<ChatAck>
  /** "Send now": wind the RUNNING turn down (same machinery as stop, but the
   *  queue survives) and park this message at the queue front — it starts
   *  the moment the turn ends. Idle sessions behave like a plain send; the
   *  ack tells which happened (`interrupted: true` vs plain `running`). */
  interruptMessage(
    message: string,
    sessionId: string,
    attachments?: { id: string; name?: string; lines?: number | null }[],
    model?: string,
    reasoningEffort?: string,
  ): Promise<ChatAck>
  /** Drop one parked message by the id the `queue` frame carries. Resolves
   *  `false` when it is already gone (started or removed elsewhere) — the
   *  next `queue` snapshot converges the strip either way. */
  removeQueued(sessionId: string, id: number): Promise<boolean>
  /** Replace one parked message's text (attachments ride along unchanged).
   *  Resolves `false` when the item is already gone. */
  editQueued(sessionId: string, id: number, message: string): Promise<boolean>
  /** Cancel ONE running sub-agent by the `task_id` the `subagent` frames
   *  carry. The child winds down and reports partial progress in the parent
   *  `task` tool result; the rest of the turn keeps running. Resolves
   *  `false` when the task is already finished / unknown. */
  cancelTask(sessionId: string, taskId: string): Promise<boolean>
  /** Inject a message into the RUNNING turn (the "send now" path). Resolves
   *  `true` when steered; `false` = no turn in flight (send it normally). */
  steer(sessionId: string, message: string): Promise<boolean>
  /** Truncate the conversation at the `userIndex`-th user message (0-based):
   *  that message and everything after it are discarded, server-side and in
   *  the store. Rejects while a turn is running. Resolves the recomputed
   *  active skill name (or null). */
  rewind(sessionId: string, userIndex: number): Promise<string | null>
  /** Resolves `true` when the confirm was delivered to a pending request
   *  (`false` = nothing pending / answered elsewhere / stale id). */
  confirm(
    sessionId: string,
    confirmed: boolean,
    amendedArgs?: unknown,
    allowPattern?: string,
    allowDir?: string,
    /** Approve AND enable session-scoped full-auto (skip later confirmations). */
    auto?: boolean,
    /** Tool-call id of the confirm being answered (anchoring; see protocol). */
    callId?: string,
  ): Promise<boolean>
  answer(
    sessionId: string,
    answers: AskAnswer[],
    cancelled?: boolean,
    /** Tool-call id of the ask_user being answered (anchoring). */
    callId?: string,
  ): Promise<void>
  /** User interaction on a pending ask_user (selecting / typing): resets the
   *  unattended auto-pick countdown. Fire-and-forget — a 404 just means the
   *  ask already resolved. `callId` is mandatory (server rejects unanchored
   *  pings, which could extend the wrong ask). */
  askActivity(sessionId: string, callId: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** Toggle session-scoped full-auto (ask_user still prompts). */
  setAutoConfirm(sessionId: string, enabled: boolean): Promise<void>
  /** List sessions; `q` enables server-side search (title + message content). */
  listSessions(q?: string): Promise<SessionSummary[]>
  getSession(id: string): Promise<{
    meta: {
      title: string
      created_at: string
      updated_at: string
      active_skill?: string | null
      /** Memory-only session full-auto state (badge sync on load/reload). */
      auto_confirm?: boolean
      /** Whether a turn is currently running (attach to watch it live). */
      running?: boolean
      /** Number of archived pre-compaction snapshots (0 / absent = none).
       *  When > 0 the transcript can be extended backwards via
       *  `listSessionArchive` / `getSessionArchive`. */
      archive_generations?: number
    }
    messages: MessageView[]
  }>
  /** Archived pre-compaction generations (oldest first). Empty when the
   *  session was never compacted or the agent predates archiving. */
  listSessionArchive(id: string): Promise<ArchiveGeneration[]>
  /** Full messages of one archived generation (system prompt excluded). */
  getSessionArchive(id: string, generation: number): Promise<MessageView[]>
  updateSession(id: string, patch: { title?: string; pinned?: boolean }): Promise<void>
  deleteSession(id: string): Promise<void>
  /** Discovered skills + discovery diagnostics for the `/` command palette. */
  listSkills(): Promise<{ skills: SkillInfo[]; diagnostics: SkillDiagnostic[] }>
  /** Registered tools `[{name, description}]` (for allowed-tools tooltips). */
  listTools(): Promise<{ name: string; description: string }[]>
  /** Models advertised by the configured upstream (`data[].id`) plus the
   *  kernel's per-model capability records (`caps` always includes the
   *  configured default model, even when `models` is empty). Both empty when
   *  the endpoint is absent/unreachable — the chat input falls back to a
   *  read-only model badge. */
  getModels(): Promise<{ models: string[]; caps: Record<string, ModelCaps> }>
  /** Install a skill package (zip). Resolves `{ name, diagnostics }`, throws on error. */
  importSkill(file: File | Blob): Promise<{ name: string; diagnostics: string[] }>
  /** Install a skill from a package (zip) URL — the agent downloads it (the
   *  browser can't reach arbitrary hosts). Resolves `{ name, diagnostics }`,
   *  throws on error. */
  installSkillUrl(url: string): Promise<{ name: string; diagnostics: string[] }>
  /** Delete an install-dir skill by name. Throws on error (e.g. read-only). */
  deleteSkill(name: string): Promise<void>
  /** Enable/disable a skill by name (persisted). */
  setSkillEnabled(name: string, enabled: boolean): Promise<void>
  /** Pin/unpin a skill by name (persisted; management-page ordering only). */
  setSkillPinned(name: string, pinned: boolean): Promise<void>
  /** List/delist a skill on this agent's hub index `/repo` (persisted;
   *  orthogonal to enable/disable — share governs distribution only). */
  setSkillShared(name: string, shared: boolean): Promise<void>
  /** Absolute URL of a skill's icon (for `<img src>`). */
  skillIconUrl(name: string): string
  /** SKILL.md body (frontmatter stripped) — what the skill teaches the model. */
  getSkillReadme(name: string): Promise<string>
  /** A skill's CHANGELOG.md (raw markdown). Resolves `null` when the skill
   *  ships none (404) — the UI shows an empty state. */
  getSkillChangelog(name: string): Promise<string | null>
  /** Online skills repository index (agent-proxied), annotated with local
   *  install state. Resolves `null` when no repository is configured (404)
   *  — the UI hides the market tab. Throws on repo fetch failures. */
  getSkillsMarket(): Promise<SkillsMarket | null>
  /** A repository skill's SKILL.md body + CHANGELOG.md, read WITHOUT
   *  installing (agent downloads + extracts on demand). Throws on
   *  fetch/download failure. */
  getMarketSkillPreview(name: string): Promise<MarketSkillPreview>
  /** Install a repository skill by name (the agent downloads + verifies +
   *  installs it). Resolves `{ name, diagnostics }`, throws on error. */
  installMarketSkill(name: string): Promise<{ name: string; diagnostics: string[] }>
  /** Online apps repository index (agent-proxied), annotated with local
   *  install state. Resolves `null` when no repository is configured (404)
   *  — the UI hides the Apps Hub tab. Throws on repo fetch failures. */
  getAppsMarket(): Promise<AppsMarket | null>
  /** Install (or upgrade) a repository app by id: the agent downloads +
   *  verifies + installs it via run_core (systemd). Resolves `{ name,
   *  receipt }`, throws on error. */
  installMarketApp(name: string): Promise<{ name: string; receipt: string }>
  /** Install (or upgrade) an app from a raw tar.gz upload (the local twin of
   *  `installMarketApp`). `upgraded` is true when a managed same-name app was
   *  replaced. Resolves `{ name, upgraded, receipt }`, throws on error. */
  importApp(file: File | Blob): Promise<{ name: string; upgraded: boolean; receipt: string }>
  /** Install (or upgrade) an app from an operator-supplied URL (the agent
   *  downloads it). `upgraded` is true when a managed same-name app was
   *  replaced. Resolves `{ name, upgraded, receipt }`, throws on error. */
  installAppUrl(appUrl: string): Promise<{ name: string; upgraded: boolean; receipt: string }>
  /** Absolute URL of a skill export zip (for `window.open`). */
  skillExportUrl(name: string): string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getMeta(): Promise<any>
  /** Current agent config for the editable settings form (api_key cleared). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getConfig(): Promise<any>
  /** Persist agent config; the agent restarts to apply. Throws on error. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  putConfig(cfg: unknown): Promise<{ ok?: boolean; restarting?: boolean }>
  probe(): Promise<boolean>
  /** Restart the agent without changing config (the process exits + relaunches). */
  restartApp(): Promise<void>
  /** Absolute URL of the diagnostic-bundle download (for `window.open`). */
  logsExportUrl(): string
  /** Shared `run_shell` allow-list: learned commands grown via the button (+ cap). */
  getSafeCommands(): Promise<SafeCommands>
  /** Clear all learned commands; returns the new learned list. */
  clearSafeCommands(): Promise<string[]>
  /** Remove one learned command; returns the new learned list. */
  removeSafeCommand(cmd: string): Promise<string[]>
  /** Shared write/edit directory allow-list: dirs grown via the button (+ cap). */
  getSafePaths(): Promise<SafePaths>
  /** Clear all allow-listed dirs; returns the new list. */
  clearSafePaths(): Promise<string[]>
  /** Remove one allow-listed dir; returns the new list. */
  removeSafePath(dir: string): Promise<string[]>
  /** Releases inventory: published files + installed apps, with provenance. */
  listReleases(params?: { kind?: string; sessionId?: string }): Promise<ReleaseRecord[]>
  /** Remove one release: unpublish a file / uninstall an app. */
  deleteRelease(kind: string, name: string): Promise<void>
  /** Start a managed app's systemd service (`kind=app` cards). */
  startApp(name: string): Promise<void>
  /** Stop a managed app's systemd service (`kind=app` cards). */
  stopApp(name: string): Promise<void>
  /** Saved themes: injectable payloads applied at boot. */
  listThemes(): Promise<ThemeContent[]>
  /** Persist the current chat look as a saved theme (the "save this theme"
   *  button). `sessionId` attributes it to the owning conversation. */
  saveTheme(name: string, css: string, js: string, sessionId?: string | null): Promise<void>
  /** Switch which saved theme is injected at boot (the active pointer). */
  activateTheme(name: string): Promise<void>
  /** Restore the built-in UI without deleting saved themes (writes the
   *  no-theme sentinel so a `default` slot does not re-inject on refresh). */
  deactivateTheme(): Promise<void>
  /** Runtime cache stats (`<workspace>/runtime/{drafts,downloads}`). */
  getRuntimeStat(category?: string): Promise<RuntimeCacheStat>
  /** Clear runtime cache categories (empty = all); returns reclaimed bytes. */
  clearRuntimeCache(categories?: string[]): Promise<{ reclaimed_bytes: number }>
  /** Absolute URL of a runtime cache export zip (for `window.open`). */
  runtimeExportUrl(category?: string): string
  /** Absolute URL of the backup bundle download (config + skills + state). */
  backupExportUrl(): string
  /** Import a backup bundle (zip); the agent restarts to apply. Resolves the
   *  import summary, throws on error. */
  importBackup(file: File | Blob): Promise<BackupImportSummary>
}

/** Per-model capability record from `GET /api/models` (`caps[name]`), the
 *  kernel's `model_caps` table. Drives the chat input's effort switcher:
 *  an empty `effortLevels` hides the badge (the model takes no
 *  `reasoning_effort` parameter, or nothing is known about it). */
export interface ModelCaps {
  vision: boolean
  contextTokens: number
  /** `forced` (always reasons) / `dynamic` (togglable) / `unknown`. */
  thinking: 'forced' | 'dynamic' | 'unknown'
  effortLevels: string[]
  /** The provider's server-side default effort (shown on the "default" row). */
  defaultEffort: string | null
}

export interface SafeCommands {
  learned: string[]
  max: number
}

export interface SafePaths {
  learned: string[]
  max: number
}

export interface RuntimeCacheCategory {
  path: string
  size_bytes: number
  file_count: number
  last_modified: string | null
}

export interface RuntimeCacheStat {
  root: string
  categories: Record<string, RuntimeCacheCategory>
}

/** One saved theme (`GET /api/themes`): applied at boot through the same
 *  channel as the `set_chat_style` live event. */
export interface ThemeContent {
  name: string
  css: string
  js: string
}

/** One row of `GET /api/releases` — a durable agent deliverable (published
 *  file, installed app or persistent UI plugin) with its provenance. */
export interface ReleaseRecord {
  kind: string
  name: string
  url?: string
  session_id?: string
  /** Joined title of the owning session (absent without persistence). */
  session_title?: string
  created_at?: string
  size: number
  republish_count?: number
  previous_session_id?: string
  /** `app` kind: `systemctl is-active` (active/inactive/failed/unknown). */
  status?: string
  /** `app` kind: `systemctl is-enabled`. */
  enabled?: string
  /** `app` kind: declared web port — build the page link from the current
   *  hostname (the kernel doesn't know its public address). */
  port?: number
  /** `app` kind: app version. */
  version?: string
  /** `app`/`theme` kind: human description (manifest / model-authored). */
  description?: string
  /** `theme` kind: representative hex colors for a swatch preview. */
  palette?: string[]
  /** `app` kind: runtime type (`self`/`native`/`python`/`node`). */
  runtime?: string
  /** `app` kind: run-to-completion task (not a resident daemon). */
  oneshot?: boolean
}

/** What `POST /api/backup/import` changed (mirrors the kernel's summary). */
export interface BackupImportSummary {
  config_applied: boolean
  skills_installed: string[]
  skills_skipped: string[]
  skills_state_applied: boolean
  safe_commands_added: number
  safe_paths_added: number
  runtime_files: number
  sessions_staged: boolean
}

export interface ChatClientOptions {
  /** UI surface tag recorded as the session's origin on its first save
   *  (e.g. `'terminal'` for the web-terminal assistant panel). */
  origin?: string
}

export function createChatClient(basePath = '', opts?: ChatClientOptions): ChatClient {
  const url = (p: string) => `${basePath}${p}`
  const origin = opts?.origin

  /** Pipe an SSE response body into `onEvent`, frame by frame. */
  async function pumpStream(res: Response, onEvent: (ev: ChatEvent) => void): Promise<void> {
    if (!res.body) throw new ChatUnavailableError('AI assistant is not available')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseFrame(frame)
        if (ev) onEvent(ev)
      }
    }
  }

  async function attach(
    sessionId: string,
    onEvent: (ev: ChatEvent) => void,
    signal: AbortSignal,
    follow?: boolean,
  ): Promise<void> {
    const path = `/api/chat/stream/${encodeURIComponent(sessionId)}${follow ? '?follow=1' : ''}`
    const res = await fetch(url(path), { signal })
    const ct = res.headers.get('content-type') || ''
    if (!res.ok || !ct.includes('text/event-stream')) {
      throw new ChatUnavailableError('AI assistant is not available')
    }
    await pumpStream(res, onEvent)
  }

  /** `POST /api/chat` — the turn trigger, shared by the send paths. */
  async function postChat(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ChatAck> {
    const res = await fetch(url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, ...body }),
      signal,
    })
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('application/json')) {
      throw new ChatUnavailableError('AI assistant is not available')
    }
    const ack = (await res.json()) as ChatAck & { error?: string; message?: string }
    if (res.status === 409 && ack.error === 'turn_in_flight') {
      throw new ChatBusyError(ack.session_id || String(body.session_id ?? ''))
    }
    if (!res.ok || ack.ok === false) {
      throw new Error(ack.error || `HTTP ${res.status}`)
    }
    return ack
  }

  return {
    async streamChat(
      message,
      sessionId,
      onEvent,
      signal,
      skillAction,
      attachments,
      model,
      reasoningEffort,
    ) {
      // Protocol 2: POST triggers the turn (JSON ack); the stream comes from
      // the attach endpoint — the exact same path a re-attached viewer takes.
      const ack = await postChat(
        {
          message,
          session_id: sessionId,
          skill_action: skillAction,
          attachments: attachments?.length ? attachments : undefined,
          model: model?.trim() ? model.trim() : undefined,
          reasoning_effort: reasoningEffort?.trim() ? reasoningEffort.trim() : undefined,
        },
        signal,
      )
      if (!ack.running) {
        // Reset-only: control-plane work already applied; nothing streams.
        // Synthesize the state updates a v1 stream used to deliver.
        onEvent({
          event: 'session',
          data: {
            session_id: ack.session_id,
            active_skill: ack.active_skill ?? null,
            auto_confirm: ack.auto_confirm === true,
          },
        })
        onEvent({ event: 'skill', data: { name: null, allowed_tools: [] } })
        onEvent({ event: 'done', data: { elapsed_ms: 0 } })
        return
      }
      await attach(ack.session_id, onEvent, signal)
    },

    sendMessage(message, sessionId, skillAction, attachments, model, reasoningEffort) {
      return postChat({
        message,
        session_id: sessionId,
        skill_action: skillAction,
        attachments: attachments?.length ? attachments : undefined,
        model: model?.trim() ? model.trim() : undefined,
        reasoning_effort: reasoningEffort?.trim() ? reasoningEffort.trim() : undefined,
      })
    },

    attachStream(sessionId, onEvent, signal, follow) {
      return attach(sessionId, onEvent, signal, follow)
    },

    queueMessage(message, sessionId, attachments, model, reasoningEffort) {
      return postChat({
        message,
        session_id: sessionId,
        attachments: attachments?.length ? attachments : undefined,
        model: model?.trim() ? model.trim() : undefined,
        reasoning_effort: reasoningEffort?.trim() ? reasoningEffort.trim() : undefined,
        queue: true,
      })
    },

    interruptMessage(message, sessionId, attachments, model, reasoningEffort) {
      return postChat({
        message,
        session_id: sessionId,
        attachments: attachments?.length ? attachments : undefined,
        model: model?.trim() ? model.trim() : undefined,
        reasoning_effort: reasoningEffort?.trim() ? reasoningEffort.trim() : undefined,
        interrupt: true,
      })
    },

    async removeQueued(sessionId, id) {
      try {
        const res = await fetch(url('/api/chat/queue/remove'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, id }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async editQueued(sessionId, id, message) {
      try {
        const res = await fetch(url('/api/chat/queue/edit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, id, message }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async cancelTask(sessionId, taskId) {
      try {
        const res = await fetch(url('/api/chat/task/cancel'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, task_id: taskId }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async steer(sessionId, message) {
      try {
        const res = await fetch(url('/api/chat/steer'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, message }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async rewind(sessionId, userIndex) {
      const res = await fetch(url('/api/chat/rewind'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, user_index: userIndex }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        message?: string
        active_skill?: string | null
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`)
      }
      return data.active_skill ?? null
    },

    async uploadFile(blob, name) {
      const res = await fetch(url('/api/chat/upload'), {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          ...(name ? { 'X-File-Name': encodeURIComponent(name) } : {}),
        },
        body: blob,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
      // The server decodes X-File-Name itself and echoes the REAL name —
      // use it verbatim (decoding again would corrupt names containing
      // literal escapes and could throw on a '%').
      return {
        id: String(data.id),
        name: String(data.name || ''),
        kind: data.kind === 'image' ? 'image' : 'file',
        size: Number(data.size) || 0,
        lines: typeof data.lines === 'number' ? data.lines : null,
      }
    },

    uploadUrl(id, name) {
      const base = url(`/api/chat/upload/${encodeURIComponent(id)}`)
      return name ? `${base}?name=${encodeURIComponent(name)}` : base
    },

    async confirm(sessionId, confirmed, amendedArgs, allowPattern, allowDir, auto, callId) {
      try {
        const res = await fetch(url('/api/chat/confirm'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            id: callId ?? null,
            confirmed,
            amended_args: amendedArgs ?? null,
            allow_pattern: allowPattern ?? null,
            allow_dir: allowDir ?? null,
            auto: auto ?? false,
          }),
        })
        return res.ok
      } catch {
        return false
      }
    },

    async answer(sessionId, answers, cancelled = false, callId) {
      await fetch(url('/api/chat/answer'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, id: callId ?? null, answers, cancelled }),
      })
    },

    async askActivity(sessionId, callId) {
      try {
        await fetch(url('/api/chat/answer'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, id: callId, activity: true }),
        })
      } catch {
        // Fire-and-forget: a failed ping must never surface to the user.
      }
    },

    async cancel(sessionId) {
      await fetch(url('/api/chat/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      })
    },

    async setAutoConfirm(sessionId, enabled) {
      await fetch(url('/api/chat/auto'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, enabled }),
      })
    },

    listSessions(q) {
      const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
      return fetch(url(`/api/sessions${query}`)).then((r) => (r.ok ? r.json() : []))
    },

    getSession(id) {
      return fetch(url(`/api/sessions/${encodeURIComponent(id)}`)).then((r) => r.json())
    },

    async listSessionArchive(id) {
      try {
        const r = await fetch(url(`/api/sessions/${encodeURIComponent(id)}/archive`))
        if (!r.ok) return []
        const data = await r.json()
        return Array.isArray(data?.generations) ? data.generations : []
      } catch {
        return []
      }
    },

    async getSessionArchive(id, generation) {
      const r = await fetch(
        url(`/api/sessions/${encodeURIComponent(id)}/archive/${generation}`),
      )
      if (!r.ok) throw new Error(`archive load failed (${r.status})`)
      const data = await r.json()
      return Array.isArray(data?.messages) ? data.messages : []
    },

    async updateSession(id, patch) {
      await fetch(url(`/api/sessions/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    },

    async deleteSession(id) {
      await fetch(url(`/api/sessions/${encodeURIComponent(id)}`), { method: 'DELETE' })
    },

    async listSkills() {
      try {
        const r = await fetch(url('/api/skills'))
        if (!r.ok) return { skills: [], diagnostics: [] }
        const data = await r.json()
        return {
          skills: Array.isArray(data?.skills) ? data.skills : [],
          diagnostics: Array.isArray(data?.diagnostics) ? data.diagnostics : [],
        }
      } catch {
        return { skills: [], diagnostics: [] }
      }
    },

    async getModels() {
      try {
        const r = await fetch(url('/api/models'))
        if (!r.ok) return { models: [], caps: {} }
        const data = await r.json()
        const models = Array.isArray(data?.models)
          ? data.models.filter((m: unknown): m is string => typeof m === 'string')
          : []
        const caps: Record<string, ModelCaps> = {}
        if (data?.caps && typeof data.caps === 'object') {
          for (const [name, raw] of Object.entries(data.caps as Record<string, unknown>)) {
            const c = raw as Record<string, unknown> | null
            if (!c) continue
            caps[name] = {
              vision: c.vision === true,
              contextTokens: typeof c.contextTokens === 'number' ? c.contextTokens : 0,
              thinking:
                c.thinking === 'forced' || c.thinking === 'dynamic' ? c.thinking : 'unknown',
              effortLevels: Array.isArray(c.effortLevels)
                ? c.effortLevels.filter((l): l is string => typeof l === 'string')
                : [],
              defaultEffort: typeof c.defaultEffort === 'string' ? c.defaultEffort : null,
            }
          }
        }
        return { models, caps }
      } catch {
        return { models: [], caps: {} }
      }
    },

    async listTools() {
      try {
        const r = await fetch(url('/api/tools'))
        if (!r.ok) return []
        const data = await r.json()
        return Array.isArray(data?.tools) ? data.tools : []
      } catch {
        return []
      }
    },

    async importSkill(file) {
      const r = await fetch(url('/api/skills/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        diagnostics: Array.isArray(data?.diagnostics) ? data.diagnostics : [],
      }
    },

    async installSkillUrl(skillUrl) {
      const r = await fetch(url('/api/skills/install-url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: skillUrl }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        diagnostics: Array.isArray(data?.diagnostics) ? data.diagnostics : [],
      }
    },

    async deleteSkill(name) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}`), { method: 'DELETE' })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
    },

    async setSkillEnabled(name, enabled) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}/enabled`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
    },

    async setSkillPinned(name, pinned) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}/pinned`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
    },

    async setSkillShared(name, shared) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}/shared`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
    },

    skillIconUrl(name) {
      return url(`/api/skills/${encodeURIComponent(name)}/icon`)
    },

    async getSkillReadme(name) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}/readme`))
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    },

    async getSkillChangelog(name) {
      const r = await fetch(url(`/api/skills/${encodeURIComponent(name)}/changelog`))
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    },

    skillExportUrl(name) {
      return url(`/api/skills/${encodeURIComponent(name)}/export`)
    },

    async getSkillsMarket() {
      const r = await fetch(url('/api/skills/market'))
      if (r.status === 404) return null
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        repo: String(data?.repo ?? ''),
        generated_at: data?.generated_at ?? null,
        skills: Array.isArray(data?.skills) ? data.skills : [],
      }
    },

    async installMarketSkill(name) {
      const r = await fetch(url('/api/skills/market/install'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        diagnostics: Array.isArray(data?.diagnostics) ? data.diagnostics : [],
      }
    },

    async getMarketSkillPreview(name) {
      const r = await fetch(url(`/api/skills/market/${encodeURIComponent(name)}/preview`))
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        readme: String(data?.readme ?? ''),
        changelog: data?.changelog ?? null,
      }
    },

    async getAppsMarket() {
      const r = await fetch(url('/api/apps/market'))
      if (r.status === 404) return null
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        repo: String(data?.repo ?? ''),
        generated_at: data?.generated_at ?? null,
        apps: Array.isArray(data?.apps) ? data.apps : [],
      }
    },

    async installMarketApp(name) {
      const r = await fetch(url('/api/apps/market/install'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        receipt: String(data?.receipt ?? ''),
      }
    },

    async importApp(file) {
      const r = await fetch(url('/api/apps/install'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: file,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        upgraded: Boolean(data?.upgraded),
        receipt: String(data?.receipt ?? ''),
      }
    },

    async installAppUrl(appUrl) {
      const r = await fetch(url('/api/apps/install-url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: appUrl }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return {
        name: String(data?.name ?? ''),
        upgraded: Boolean(data?.upgraded),
        receipt: String(data?.receipt ?? ''),
      }
    },

    getMeta() {
      return fetch(url('/api/chat/meta')).then((r) => r.json())
    },

    getConfig() {
      return fetch(url('/api/config')).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
    },

    async putConfig(cfg) {
      const r = await fetch(url('/api/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return data
    },

    async probe() {
      try {
        const r = await fetch(url('/api/chat/meta'))
        return (r.headers.get('content-type') || '').includes('application/json')
      } catch {
        return false
      }
    },

    async restartApp() {
      // The process may exit before the response lands; swallow network errors.
      await fetch(url('/api/restart'), { method: 'POST' }).catch(() => {})
    },

    logsExportUrl() {
      return url('/api/logs/export')
    },

    getSafeCommands() {
      return fetch(url('/api/safe-commands')).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
    },

    async clearSafeCommands() {
      const r = await fetch(url('/api/safe-commands'), { method: 'DELETE' })
      const data = await r.json().catch(() => ({}))
      return Array.isArray(data?.learned) ? data.learned : []
    },

    async removeSafeCommand(cmd) {
      const r = await fetch(url(`/api/safe-commands?cmd=${encodeURIComponent(cmd)}`), {
        method: 'DELETE',
      })
      const data = await r.json().catch(() => ({}))
      return Array.isArray(data?.learned) ? data.learned : []
    },

    getSafePaths() {
      return fetch(url('/api/safe-paths')).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
    },

    async clearSafePaths() {
      const r = await fetch(url('/api/safe-paths'), { method: 'DELETE' })
      const data = await r.json().catch(() => ({}))
      return Array.isArray(data?.learned) ? data.learned : []
    },

    async removeSafePath(dir) {
      const r = await fetch(url(`/api/safe-paths?dir=${encodeURIComponent(dir)}`), {
        method: 'DELETE',
      })
      const data = await r.json().catch(() => ({}))
      return Array.isArray(data?.learned) ? data.learned : []
    },

    async listReleases(params) {
      try {
        const q = new URLSearchParams()
        if (params?.kind) q.set('kind', params.kind)
        if (params?.sessionId) q.set('session_id', params.sessionId)
        const qs = q.toString()
        const r = await fetch(url(`/api/releases${qs ? `?${qs}` : ''}`))
        if (!r.ok) return []
        const data = await r.json()
        return Array.isArray(data?.releases) ? data.releases : []
      } catch {
        return []
      }
    },

    async deleteRelease(kind, name) {
      const r = await fetch(
        url(`/api/releases/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`),
        { method: 'DELETE' },
      )
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    async startApp(name) {
      const r = await fetch(url(`/api/releases/app/${encodeURIComponent(name)}/start`), {
        method: 'POST',
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    async stopApp(name) {
      const r = await fetch(url(`/api/releases/app/${encodeURIComponent(name)}/stop`), {
        method: 'POST',
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    async listThemes() {
      try {
        const r = await fetch(url('/api/themes'))
        if (!r.ok) return []
        const data = await r.json()
        return Array.isArray(data?.themes) ? data.themes : []
      } catch {
        return []
      }
    },

    async saveTheme(name, css, js, sessionId) {
      const r = await fetch(url(`/api/themes/${encodeURIComponent(name)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ css, js, session_id: sessionId ?? null }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    async activateTheme(name) {
      const r = await fetch(url('/api/themes/active'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    async deactivateTheme() {
      const r = await fetch(url('/api/themes/active'), { method: 'DELETE' })
      if (!r.ok) {
        const data = await r.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
    },

    getRuntimeStat(category) {
      const q = category ? `?category=${encodeURIComponent(category)}` : ''
      return fetch(url(`/api/runtime/stat${q}`)).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
    },

    async clearRuntimeCache(categories = []) {
      const r = await fetch(url('/api/runtime/clear'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories }),
      })
      const data = await r.json().catch(() => ({}))
      return { reclaimed_bytes: Number(data?.reclaimed_bytes) || 0 }
    },

    runtimeExportUrl(category) {
      const q = category ? `?category=${encodeURIComponent(category)}` : ''
      return url(`/api/runtime/export${q}`)
    },

    backupExportUrl() {
      return url('/api/backup/export')
    },

    async importBackup(file) {
      const r = await fetch(url('/api/backup/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`)
      return (data?.summary ?? {}) as BackupImportSummary
    },
  }
}
