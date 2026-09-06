import type { ReactNode } from 'react'
import type { Labels } from './lib/i18n'

export type { Labels }

/** A decoded SSE frame: `{ event, data }`. */
export interface ChatEvent {
  event: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

/** Deterministic user-originated skill control sent with `POST /api/chat`. */
export type SkillAction =
  | { op: 'activate'; name: string }
  | { op: 'reset' }

export interface AskOption {
  id: string
  label: string
  hint?: string
}

export interface AskQuestion {
  id: string
  question: string
  options: AskOption[]
  allow_custom: boolean
  multi_select: boolean
  default_id?: string
}

export interface AskAnswer {
  question_id: string
  selected_ids: string[]
  custom_text?: string | null
}

/** One skill from `GET /api/skills`, used by the `/` command palette and the
 *  skill management page. */
export interface SkillInfo {
  name: string
  description: string
  when_to_use?: string | null
  allowed_tools: string[]
  argument_hint?: string | null
  version?: string | null
  /** Optional author / maintainer (free-form; convention `Name <email-or-url>`). */
  author?: string | null
  disable_model_invocation: boolean
  user_invocable: boolean
  dir: string
  /** User enable/disable state (management-page toggle). Older agents omit it. */
  enabled?: boolean
  /** User pin state (management-page ordering hint). Older agents omit it. */
  pinned?: boolean
  /** Hub listing state: whether this skill appears on the agent's own
   *  `/repo/index.json` (default true; orthogonal to `enabled`). */
  shared?: boolean
  /** Target execution environments (SKILL.md `env:`); empty = anywhere. */
  env?: string[]
  /** True for kernel-embedded skills (read-only: not deletable). */
  builtin?: boolean
  /** True when the skill lives in the writable install dir (can be deleted). */
  deletable?: boolean
  /** True when the skill has an icon served at `/api/skills/{name}/icon`. */
  has_icon?: boolean
}

/** One skill-discovery diagnostic from `GET /api/skills`. */
export interface SkillDiagnostic {
  kind: string
  path: string
  message: string
}

/** One repository entry of `GET /api/skills/market` (index.json fields +
 *  the agent-merged local install state). */
export interface MarketSkillInfo {
  name: string
  version?: string
  description?: string
  when_to_use?: string | null
  /** Optional author / maintainer (free-form; convention `Name <email-or-url>`). */
  author?: string | null
  tags?: string[]
  apps?: string[]
  size?: number | null
  /** Hex sha256 of the package zip (integrity; shown in the detail panel). */
  sha256?: string
  /** Package zip URL relative to the repo base (or absolute). */
  url?: string
  /** Icon URL relative to the repo base (absolute URLs pass through). */
  icon?: string | null
  /** Locally installed version (`null`/absent = not installed). */
  installed_version?: string | null
  /** True when the repo has a newer version of a repo-managed install. */
  update_available?: boolean
  /** True when the local copy lives in the repo-managed install dir. False
   *  for app-shipped / built-in skills — those cannot be replaced from the
   *  repository (the install button is hidden for them). */
  repo_managed?: boolean
  /** True when `apps` declares distro targets that do not include this
   *  agent — a display-only "built for app X" hint, never an install block. */
  apps_foreign?: boolean
  /** Target execution environments (`env` of the entry); empty = anywhere. */
  env?: string[]
  /** True when `env` excludes this agent's configured environment — the
   *  agent refuses such installs, so the UI disables the button. */
  env_mismatch?: boolean
}

/** `GET /api/skills/market` payload (agent-proxied repository index). */
export interface SkillsMarket {
  repo: string
  generated_at?: string | null
  skills: MarketSkillInfo[]
}

/** `GET /api/skills/market/{name}/preview` payload: the repository skill's
 *  SKILL.md body (frontmatter stripped) and its CHANGELOG.md, read WITHOUT
 *  installing (the agent downloads + extracts the package on demand).
 *  `changelog` is null when the package ships none. */
export interface MarketSkillPreview {
  readme: string
  changelog: string | null
}

/** One repository entry of `GET /api/apps/market` (apps `index.json` fields +
 *  the agent-merged local install state). Mirrors {@link MarketSkillInfo}. */
export interface MarketAppInfo {
  name: string
  version?: string
  description?: string
  /** Declared web port (the "open this app's page" hint). */
  port?: number | null
  /** Run-to-completion task (not a resident daemon). */
  oneshot?: boolean
  /** Target execution environments (`env` of the entry); empty = anywhere. */
  env?: string[]
  tags?: string[]
  /** Hex sha256 of the package tarball (integrity; shown in the detail row). */
  sha256?: string
  /** Package size in bytes. */
  size?: number | null
  /** Package tarball URL relative to the repo base (or absolute). */
  url?: string
  /** Icon URL relative to the repo base (absolute URLs pass through). */
  icon?: string | null
  /** Installed version of a managed app of this name (`null`/absent = none). */
  installed_version?: string | null
  /** True when the repo has a newer version of a managed install. */
  update_available?: boolean
  /** True when the name is taken by a NON-managed occupant (gateway-native
   *  app) — the market refuses to touch it. */
  foreign?: boolean
  /** True when `env` excludes this agent's configured environment — the agent
   *  refuses such installs, so the UI disables the button. */
  env_mismatch?: boolean
}

/** `GET /api/apps/market` payload (agent-proxied apps repository index). */
export interface AppsMarket {
  repo: string
  generated_at?: string | null
  apps: MarketAppInfo[]
}

/** One row of `GET /api/sessions`. */
export interface SessionSummary {
  id: string
  title: string
  pinned: boolean
  /** Whether a turn is currently running in this session (live state). */
  running?: boolean
  /** Where the session was created: `web` (HTTP chat), `terminal` (web-terminal
   *  assistant panel) or `tui` (on-device terminal chat). */
  origin?: 'web' | 'tui' | 'terminal' | string
  created_at: string
  updated_at: string
  message_count: number
  /** RFC 3339 archive stamp; absent/null = live. Archived sessions are
   *  hidden from the default list (`scope=active`) and come back
   *  automatically when a new turn runs in them. */
  archived_at?: string | null
  /** User-assigned category label (absent/null = uncategorised). */
  category?: string | null
}

/** Which sessions `GET /api/sessions` returns. */
export type SessionScope = 'active' | 'archived' | 'all'

/** Body of `PATCH /api/sessions/{id}`; every field is optional. `category`
 *  distinguishes "leave alone" (absent) from "clear" (`null`). */
export interface SessionPatch {
  title?: string
  pinned?: boolean
  archived?: boolean
  category?: string | null
}

/** Image attachment reference riding a message (bytes live server-side;
 *  fetch via `uploadUrl(id)`). */
export interface AttachmentView {
  id: string
  name?: string | null
  mime?: string | null
  /** Bytes, measured at upload time (0 for legacy rows). */
  size?: number | null
  /** Line count for text-like files; null/absent for images and binaries. */
  lines?: number | null
}

/** One archived pre-compaction snapshot ("generation") of a session, as
 *  listed by `GET /api/sessions/{id}/archive`. The full history that a
 *  context compaction replaced with a summary stays readable through these. */
export interface ArchiveGeneration {
  generation: number
  archived_at: string
  message_count: number
}

/** A persisted message as returned by `GET /api/sessions/{id}`. */
export interface MessageView {
  /** `skill` = injected skill context (explicit activation); collapsed in replay. */
  role: 'user' | 'assistant' | 'tool' | 'system' | 'skill'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string | null
  attachments?: AttachmentView[] | null
}

/**
 * Props passed to every tool renderer.
 *
 * `args` is the accumulated arguments string (may be partial JSON while
 * streaming — parse defensively). `result` is the tool output once available.
 * `status` mirrors `isRunning` as a discriminated string for convenience.
 */
export interface ToolRenderProps {
  name: string
  args?: string
  result?: string
  isRunning: boolean
  status: 'running' | 'done'
  /** The tool_call id, when the host surface knows it. Lets a renderer join
   *  per-call live state (e.g. the `task` card reading its sub-agent's
   *  current activity from the chat runtime). */
  callId?: string
  /** The surface's complete renderer map (defaults merged with the host's),
   *  for composite cards that present ANOTHER tool's output the way that
   *  tool's own card would — the `recall_result` card re-rendering a
   *  recalled `run_shell` result as a shell card, say. */
  renderers?: Record<string, ToolRenderer>
}

export type ToolRenderer = (props: ToolRenderProps) => ReactNode

/** Theme overrides applied as CSS variables on the `.acc-root` container. */
export interface ThemeTokens {
  /** Accent / primary color, any CSS color string (e.g. `hsl(var(--primary))`). */
  accent?: string
  background?: string
  foreground?: string
  /** Force a base color scheme; default follows the host (`.dark` ancestor). */
  scheme?: 'light' | 'dark'
}

export interface AgentChatProps {
  /** API origin prefix. `''` = same-origin (default). */
  basePath?: string
  /** Custom/override tool renderers, merged over the defaults (keyed by tool name). */
  toolRenderers?: Record<string, ToolRenderer>
  /** Theme variable overrides. */
  theme?: ThemeTokens
  /** Label overrides (i18n). */
  labels?: Labels
  /** Show the session history sidebar (requires backend persistence). Default true. */
  enableHistory?: boolean
  /** Show the export-transcript action. Default true. */
  enableExport?: boolean
  /** Optional model name shown in the composer; falls back to `/api/chat/meta`. */
  modelName?: string
  /** Called when the active session id changes (created or switched). */
  onSessionChange?: (sessionId: string | null) => void
  /**
   * Called whenever the title shown in the chat header changes (session
   * loaded, auto-titled by the agent, renamed; `''` for an untitled/new chat).
   * An outer shell (e.g. `CopilotApp`) mirrors it into `document.title` so
   * several open tabs can be told apart.
   */
  onTitleChange?: (title: string) => void
  /**
   * When set, the chat header shows a back (`<`) button on its left that calls
   * this. An outer shell (e.g. `CopilotApp`) wires it to open the sessions list.
   */
  onBack?: () => void
  /**
   * Hide the built-in session sidebar. Set by an outer shell (e.g. `CopilotApp`)
   * that provides its own navigation and drives the chat via the ref handle.
   * Session logic (resume/new/persistence) stays active. Default false.
   */
  hideSidebar?: boolean
  /**
   * URL for a session, e.g. `(id) => "#/chat/" + id` when the host routes by
   * hash. When set, the sidebar's session rows render as real anchors so
   * browser affordances (open in new tab via right/middle-click) work; plain
   * left-click still switches in-app. Unset = plain buttons (no host routing).
   */
  sessionHref?: (id: string) => string
}

/**
 * Imperative handle exposed by [`AgentChat`] (via `ref`) so an outer shell can
 * drive it: start a fresh chat, open a persisted session, or re-sync the
 * sidebar list after another view (the sessions page) mutated sessions.
 */
export interface AgentChatHandle {
  newChat(): void
  openSession(id: string): void
  /** Re-fetch the sidebar's session list (archive / delete / pin happened elsewhere). */
  refreshSessions?(): void
}
