import { useMemo, useState } from "react"
import { AlertTriangle, ShieldCheck, X } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { t } from "@agentchat/lib/i18n"
import { humanizeToolName, tryParseJson } from "./tools/shared"

interface ConfirmBarProps {
  toolName: string
  toolArgs: string
  // amendedArgs is forwarded as `amended_args` in the confirm POST. The
  // generic / shell render path always passes undefined; only the schedule
  // authorize render path calls it with the user-edited tool list.
  onConfirm: (amendedArgs?: unknown) => void
  onCancel: () => void
  // "Confirm + add to allow-list" for run_shell: approves now AND learns the
  // exact command so identical future commands auto-run. The literal command
  // string rides back as `allow_pattern`.
  onConfirmAndAllow?: (pattern: string) => void
  // "Confirm + allow this folder" for write_file / edit_file: approves now AND
  // learns the target's directory so future writes/edits inside it auto-run.
  // The directory rides back as `allow_dir`.
  onConfirmAndAllowDir?: (dir: string) => void
  // Red "full auto (this session)" button: approves now AND enables
  // session-scoped auto-confirm, so every later confirmation in this session
  // is skipped (ask_user still prompts). Rides back as `auto: true`.
  onConfirmAll?: () => void
}

// Mirrors the backend `has_shell_metachars`: a command can only be learned /
// auto-approved when it can't chain a second command.
function hasShellMetachars(cmd: string): boolean {
  return /[;&|><`\n\r]/.test(cmd) || cmd.includes("$(")
}

/** The literal `run_shell` command, or "" when absent/not run_shell. */
function learnableCommand(name: string, parsed: Record<string, unknown> | null): string {
  if (name !== "run_shell" || !parsed) return ""
  const cmd = typeof parsed.command === "string" ? parsed.command.trim() : ""
  if (!cmd || hasShellMetachars(cmd)) return ""
  return cmd
}

/** Directory component of a path (handles `/` and `\`); "" when path is bare. */
function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (idx < 0) return ""
  if (idx === 0) return p.slice(0, 1) // filesystem root
  return p.slice(0, idx)
}

/**
 * The directory to allow-list for a write/edit, or "" when not applicable. A
 * bare-filename write_file is redirected to the runtime drafts bucket (no real
 * dir to trust), so it returns "".
 */
function learnableDir(name: string, parsed: Record<string, unknown> | null): string {
  if (!parsed) return ""
  if (!WRITE_TOOLS.has(name) && !EDIT_TOOLS.has(name)) return ""
  const path = typeof parsed.path === "string" ? parsed.path.trim() : ""
  if (!path) return ""
  const bare = !path.includes("/") && !path.includes("\\")
  if (bare) return ""
  return dirOf(path)
}

const CMD_TOOLS = new Set([
  "web_terminal_exec",
  "run_shell",
  "ssh_exec",
  "vinx_run",
])

/** Command-style tools: the kernel's own plus any host bridge tool that follows
 *  the `*_exec` / `*_run` / `*_shell` naming convention (their args carry a
 *  `command`/`cmd` string, which is what the summary shows). */
function isCmdTool(name: string): boolean {
  return CMD_TOOLS.has(name) || /_(exec|run|shell)$/.test(name)
}

const WRITE_TOOLS = new Set([
  "write_file",
  "web_terminal_write_file",
  "gw_write_file",
])

const EDIT_TOOLS = new Set([
  "edit_file",
  "web_terminal_edit_file",
  "edit_project_file",
])

const PATH_TOOLS = new Set([
  "read_file",
  "web_terminal_read_file",
  "gw_read_file",
  "list_files",
  "web_terminal_list_dir",
  "gw_list_dir",
])

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// Args fields that are typically too long to inline in the one-line confirm
// summary. The generic fallback skips these so it can pick smaller, more
// recognisable identifiers instead.
const GENERIC_SKIP_KEYS = new Set([
  "content",
  "body",
  "body_markdown",
  "source_path",
  "prompt",
  "commands",
  "attachments",
  "html",
  "markdown",
])

// Last-resort summary for tools without a specialized branch. Picks up to 3
// short scalar fields and renders them as `key=value · key=value`. Without
// this, any new dangerous tool added to risk.rs would silently regress to
// "tool name only" in the confirm bar.
function summarizeArgsGeneric(parsed: Record<string, unknown>): string | null {
  const parts: string[] = []
  for (const [k, v] of Object.entries(parsed)) {
    if (GENERIC_SKIP_KEYS.has(k)) continue
    if (parts.length >= 3) break
    let val: string
    if (typeof v === "string") {
      if (!v) continue
      val = truncate(v, 30)
    } else if (typeof v === "number" || typeof v === "boolean") {
      val = String(v)
    } else {
      continue
    }
    parts.push(`${k}=${val}`)
  }
  if (parts.length === 0) return null
  return truncate(parts.join(" · "), 80)
}

function getConfirmSummary(name: string, args: string): string | null {
  const parsed = tryParseJson(args)
  if (!parsed) return null

  if (WRITE_TOOLS.has(name)) {
    const path = typeof parsed.path === "string" ? parsed.path : ""
    const content = typeof parsed.content === "string" ? parsed.content : ""
    const mode = parsed.mode === "append" ? t("append") : t("overwrite")
    const lineCount = content ? content.split("\n").length : 0
    const lineWord = lineCount === 1 ? t("lineSingular") : t("linePlural")
    const parts: string[] = []
    if (path) parts.push(path)
    if (lineCount > 0) parts.push(`${lineCount} ${lineWord}`)
    parts.push(mode)
    return parts.join(" · ")
  }

  if (EDIT_TOOLS.has(name)) {
    const path = typeof parsed.path === "string" ? parsed.path : ""
    const oldStr = typeof parsed.old_str === "string" ? parsed.old_str : ""
    const newStr = typeof parsed.new_str === "string" ? parsed.new_str : ""
    const replaceAll = parsed.replace_all === true
    // Count "lines" as how many `\n`-separated rows old/new spans — gives the
    // user a quick sense of the edit's blast radius before they approve.
    const removes = oldStr ? oldStr.replace(/\n$/, "").split("\n").length : 0
    const adds = newStr ? newStr.replace(/\n$/, "").split("\n").length : 0
    const parts: string[] = []
    if (path) parts.push(path)
    if (adds > 0 || removes > 0) parts.push(`+${adds} −${removes}`)
    if (replaceAll) parts.push(t("editReplaceAll"))
    return parts.length > 0 ? parts.join(" · ") : null
  }

  if (isCmdTool(name)) {
    const cmd =
      (typeof parsed.command === "string" && parsed.command) ||
      (typeof parsed.cmd === "string" && parsed.cmd) ||
      ""
    if (!cmd) return null
    const oneLine = cmd.replace(/\s+/g, " ").trim()
    return truncate(oneLine, 80)
  }

  if (name === "install_skill") {
    const url = typeof parsed.url === "string" ? parsed.url : ""
    const path = typeof parsed.path === "string" ? parsed.path : ""
    const src = url || path
    return src ? truncate(src, 80) : null
  }

  if (name === "update_skill") {
    const skill = typeof parsed.name === "string" ? parsed.name.trim() : ""
    return skill || "all"
  }

  if (name === "delete_skill") {
    return typeof parsed.name === "string" && parsed.name ? parsed.name : null
  }

  if (PATH_TOOLS.has(name)) {
    return typeof parsed.path === "string" && parsed.path ? parsed.path : null
  }

  if (name === "config_manage") {
    const action = typeof parsed.action === "string" ? parsed.action : ""
    const key = typeof parsed.key === "string" ? parsed.key : ""
    const value = typeof parsed.value === "string" ? parsed.value : ""
    if (action === "set") {
      if (key && value) return `set ${key} = ${truncate(value, 40)}`
      if (key) return `set ${key}`
      return "set"
    }
    if (action === "get") return key ? `get ${key}` : "get"
    if (action === "show") return "show all"
    return action || null
  }

  if (name === "proxy_manage") {
    const action = typeof parsed.action === "string" ? parsed.action : ""
    const target = typeof parsed.target === "string" ? parsed.target : ""
    const port = typeof parsed.port === "number" ? `:${parsed.port}` : ""
    if (!action) return null
    if (action === "status") return "status"
    const tail = `${target}${port}`.trim()
    return tail ? `${action} ${tail}` : action
  }

  // schedule_manage create is handled separately by ScheduleAuthorizeBar; the
  // remaining actions (delete/toggle/update/list/history) all benefit from
  // showing the task name + interval.
  if (name === "schedule_manage") {
    const action = typeof parsed.action === "string" ? parsed.action : ""
    const taskName = typeof parsed.name === "string" ? parsed.name : ""
    const interval =
      (typeof parsed.interval === "string" && parsed.interval) ||
      (typeof parsed.cron === "string" && parsed.cron) ||
      ""
    if (!action) return null
    if (action === "list") return "list"
    if (action === "update") {
      if (taskName && interval) return `update ${taskName} (${interval})`
      if (taskName) return `update ${taskName}`
      return "update"
    }
    return taskName ? `${action} ${taskName}` : action
  }

  if (name === "publish_file") {
    return typeof parsed.filename === "string" && parsed.filename
      ? parsed.filename
      : null
  }

  if (name === "deploy_file") {
    const filename =
      typeof parsed.filename === "string" ? parsed.filename : ""
    const target =
      typeof parsed.target_path === "string" ? parsed.target_path : ""
    const exec = parsed.execute === true
    const parts: string[] = []
    if (filename && target) parts.push(`${filename} → ${target}`)
    else if (target) parts.push(target)
    else if (filename) parts.push(filename)
    if (exec) parts.push("execute")
    return parts.length > 0 ? parts.join(" · ") : null
  }

  if (name === "wechat_notify") {
    const toCount = Array.isArray(parsed.to) ? parsed.to.length : 0
    const content =
      typeof parsed.content === "string"
        ? parsed.content.replace(/\s+/g, " ").trim()
        : ""
    const parts: string[] = []
    if (toCount > 0) parts.push(`to ${toCount}`)
    if (content) parts.push(truncate(content, 60))
    return parts.length > 0 ? parts.join(" · ") : null
  }

  if (name === "email_notify") {
    const toArr = Array.isArray(parsed.to) ? (parsed.to as unknown[]) : []
    const first = typeof toArr[0] === "string" ? (toArr[0] as string) : ""
    const more = toArr.length > 1 ? ` +${toArr.length - 1}` : ""
    const subject =
      typeof parsed.subject === "string" ? parsed.subject : ""
    const parts: string[] = []
    if (first) parts.push(`to ${first}${more}`)
    if (subject) parts.push(`subject "${truncate(subject, 40)}"`)
    return parts.length > 0 ? parts.join(" · ") : null
  }

  if (name === "task_queue" || name === "task_queue_clear") {
    const action = typeof parsed.action === "string" ? parsed.action : ""
    const queue =
      (typeof parsed.queue === "string" && parsed.queue) ||
      (typeof parsed.type === "string" && parsed.type) ||
      ""
    const parts: string[] = []
    if (action) parts.push(action)
    if (queue) parts.push(queue)
    return parts.length > 0 ? parts.join(" ") : null
  }

  return summarizeArgsGeneric(parsed)
}

// Detects schedule_manage's create / update-with-auto-approve case. When
// matched, the confirm bar swaps in the "Authorize scheduled task" UI which
// lets the user revoke individual tools from the LLM-proposed whitelist
// before approving. The amended whitelist rides back via amended_args.
//
// `update` is included so the recovery path ("add run_shell to that task")
// gets the same per-tool review as create — otherwise update would fall back
// to the generic confirm bar, which neither lists nor lets you trim the
// dangerous tools being granted.
function getScheduleAuthorize(
  name: string,
  parsed: Record<string, unknown> | null,
): {
  taskName: string
  cron: string | null
  promptSummary: string | null
  proposedTools: string[]
} | null {
  if (name !== "schedule_manage") return null
  if (!parsed) return null
  if (parsed.action !== "create" && parsed.action !== "update") return null
  const proposed = parsed.auto_approve_tools
  if (!Array.isArray(proposed) || proposed.length === 0) return null
  const tools = proposed.filter((v): v is string => typeof v === "string")
  if (tools.length === 0) return null

  // update calls usually identify the task via task_id / name_match rather
  // than name, so fall back through them to avoid showing "(unnamed)".
  const taskName =
    (typeof parsed.name === "string" && parsed.name) ||
    (typeof parsed.name_match === "string" && parsed.name_match) ||
    (typeof parsed.task_id === "string" && parsed.task_id) ||
    "(unnamed)"
  const cron =
    (typeof parsed.interval === "string" && parsed.interval) ||
    (typeof parsed.cron === "string" && parsed.cron) ||
    null
  const promptRaw = typeof parsed.prompt === "string" ? parsed.prompt : ""
  const promptSummary = promptRaw
    ? promptRaw.replace(/\s+/g, " ").trim().slice(0, 120) +
      (promptRaw.length > 120 ? "…" : "")
    : null

  return { taskName, cron, promptSummary, proposedTools: tools }
}

function ScheduleAuthorizeBar({
  taskName,
  cron,
  promptSummary,
  proposedTools,
  parsedArgs,
  onConfirm,
  onCancel,
}: {
  taskName: string
  cron: string | null
  promptSummary: string | null
  proposedTools: string[]
  parsedArgs: Record<string, unknown>
  onConfirm: (amendedArgs?: unknown) => void
  onCancel: () => void
}) {
  // Default = LLM proposal accepted as-is. User can deselect chips to
  // shrink the whitelist (or empty it entirely — task still gets created
  // but every dangerous tool will be denied at run time).
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(proposedTools),
  )

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const handleApprove = () => {
    const finalTools = proposedTools.filter((t) => selected.has(t))
    const amended = { ...parsedArgs, auto_approve_tools: finalTools }
    onConfirm(amended)
  }

  return (
    <div className="animate-rise-in bg-background px-4 pb-2 pt-1">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-sm border border-border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="text-xs font-medium text-foreground">
              {t("scheduleAuthorizeTitle")}
            </span>
            <span className="shrink-0 text-muted-foreground/30">·</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {taskName}
              {cron ? ` · ${cron}` : ""}
            </span>
          </div>
          {promptSummary && (
            <div className="mt-1.5 truncate pl-5 text-[11px] text-muted-foreground/80">
              {promptSummary}
            </div>
          )}
          <div className="mt-2 pl-5 text-[11px] text-muted-foreground">
            {t("scheduleAuthorizeIntro")}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 pl-5">
            {proposedTools.map((name) => {
              const isSelected = selected.has(name)
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggle(name)}
                  className={
                    "group inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 font-mono text-[11px] uppercase transition-colors " +
                    (isSelected
                      ? "border-warning/40 bg-warning/10 text-foreground hover:border-warning/60"
                      : "border-border/60 bg-transparent text-muted-foreground line-through hover:border-border")
                  }
                  title={name}
                >
                  <span>{name}</span>
                  <X
                    className={
                      "h-3 w-3 transition-opacity " +
                      (isSelected
                        ? "opacity-50 group-hover:opacity-100"
                        : "opacity-30")
                    }
                  />
                </button>
              )
            })}
          </div>
          {selected.size === 0 && (
            <div className="mt-2 flex items-center gap-1.5 pl-5 text-[11px] text-destructive">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>{t("scheduleAuthorizeNoneSelected")}</span>
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-end gap-2 pl-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleApprove}
              className="h-7 px-3 text-xs"
            >
              {t("scheduleAuthorizeApprove")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ConfirmBar({
  toolName,
  toolArgs,
  onConfirm,
  onCancel,
  onConfirmAndAllow,
  onConfirmAndAllowDir,
  onConfirmAll,
}: ConfirmBarProps) {
  const parsed = useMemo(() => tryParseJson(toolArgs), [toolArgs])
  const scheduleAuthorize = useMemo(
    () => getScheduleAuthorize(toolName, parsed),
    [toolName, parsed],
  )
  const allowCmd = useMemo(() => learnableCommand(toolName, parsed), [toolName, parsed])
  const allowDir = useMemo(() => learnableDir(toolName, parsed), [toolName, parsed])

  if (scheduleAuthorize && parsed) {
    return (
      <ScheduleAuthorizeBar
        taskName={scheduleAuthorize.taskName}
        cron={scheduleAuthorize.cron}
        promptSummary={scheduleAuthorize.promptSummary}
        proposedTools={scheduleAuthorize.proposedTools}
        parsedArgs={parsed}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
  }

  const label = humanizeToolName(toolName)
  const summary = getConfirmSummary(toolName, toolArgs)

  return (
    <div className="animate-rise-in bg-background px-4 pb-2 pt-1">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 rounded-sm border border-border bg-card px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="shrink-0 text-xs font-medium text-foreground">
            {label}
          </span>
          {summary ? (
            <>
              <span className="shrink-0 text-muted-foreground/30">·</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {summary}
              </span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("cancel")}
          </Button>
          {allowCmd && onConfirmAndAllow && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onConfirmAndAllow(allowCmd)}
              title={t("addToWhitelistHint")}
              className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("addToWhitelist")}
            </Button>
          )}
          {allowDir && onConfirmAndAllowDir && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onConfirmAndAllowDir(allowDir)}
              title={allowDir}
              className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("addDirToWhitelist")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => onConfirm()}
            className="h-7 shrink-0 px-3 text-xs"
          >
            {t("confirm")}
          </Button>
          {onConfirmAll && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onConfirmAll}
              title={t("fullAutoHint")}
              className="h-7 shrink-0 px-3 text-xs"
            >
              {t("fullAuto")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
