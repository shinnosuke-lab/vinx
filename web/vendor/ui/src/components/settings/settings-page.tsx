import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Settings,
  Sparkles,
  Bot,
  Palette,
  HardDrive,
  ShieldAlert,
  HelpCircle,
  Save,
  FileText,
  RotateCw,
  RefreshCw,
  ChevronRight,
  Download,
  FilePen,
  Folder,
  Paperclip,
  Clock,
  Trash2,
  X,
  Archive,
  Upload,
  Eye,
  EyeOff,
  Copy,
  Check,
  type LucideIcon,
} from "lucide-react"
import { createChatClient, type RuntimeCacheStat, type SafeCommands, type SafePaths } from "@agentchat/client"
import { CopyButton } from "@agentchat/components/chat/tools/shared"
import { cn, copyToClipboard } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { Spinner } from "@agentchat/components/shared/spinner"
import { Skeleton } from "@agentchat/components/ui/skeleton"
import { toast } from "@agentchat/components/ui/toast"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@agentchat/components/ui/tooltip"

/**
 * Full-page settings view (replaces the old 380px drawer), built from
 * `ConfigCard` sections + `FormRow` fields and
 * a sticky footer Save bar. The agent owns its config (`GET`/`PUT /api/config`),
 * so saving persists to the agent's file and the process restarts to apply —
 * this view waits for it to come back, then reloads.
 */

const inputClassName =
  "h-9 w-full rounded-[4px] border border-border/60 bg-transparent px-3 py-1.5 text-xs text-foreground shadow-none transition-all placeholder:text-muted-foreground/50 hover:border-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20"

const selectClassName =
  "h-9 w-full rounded-[4px] border border-border/60 bg-transparent px-3 py-1.5 text-xs text-foreground shadow-none transition-all appearance-none cursor-pointer pr-8 hover:border-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"

type FieldKind = "text" | "mono" | "password" | "number" | "toggle"

interface FieldDef {
  key: string
  /** i18n label key. */
  label: string
  kind?: FieldKind
  required?: boolean
  /** i18n helper key (shown in a hover tooltip on the help icon). */
  helper?: string
  placeholder?: string
}

interface SectionDef {
  id: string
  /** i18n label key. */
  label: string
  icon: LucideIcon
  fields: FieldDef[]
}

/** Required keys, validated client-side only when the agent is enabled (mirrors
 *  the backend `AiConfig::validate` which skips checks while disabled). */
const REQUIRED_KEYS = ["base_url", "model"] as const

const BRAND_MAX_LENGTH = 80
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
/** The brand copper-amber, matching theme.css's default `--color-primary`
 * (hsl(27 75% 40%)) and the mascot badge's disc. */
const DEFAULT_ACCENT = "#B25E1A"

/** The persisted contract is the hex value (not the display name), so a
 * custom color entered in the field interoperates with the presets. */
const THEME_PRESETS = [
  { name: "Vinx Copper", value: "#B25E1A" },
  { name: "Solar Amber", value: "#F0883E" },
  { name: "Crimson", value: "#D73A49" },
  { name: "Royal Purple", value: "#8957E5" },
  { name: "Ocean Blue", value: "#1F6FEB" },
  { name: "Teal", value: "#11809F" },
  { name: "Forest Green", value: "#2DA44E" },
  { name: "Slate", value: "#6E7681" },
] as const

type AppearanceField = "brand" | "accent"

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBrandOverride(config: Record<string, any> | null): string | undefined {
  const value = asObject(config?.meta)?.brand
  return typeof value === "string" ? value : undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAccentOverride(config: Record<string, any> | null): string | undefined {
  const theme = asObject(asObject(config?.meta)?.theme)
  return typeof theme?.accent === "string" ? theme.accent : undefined
}

/** Immutably update one runtime appearance override while preserving every
 * unknown key under `meta` and `meta.theme`. `undefined` removes the override
 * so the conventional `meta.json` / built-in value becomes effective again. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function updateAppearanceOverride(
  config: Record<string, any>,
  field: AppearanceField,
  value: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const next = { ...config }
  const meta = { ...(asObject(config.meta) ?? {}) }

  if (field === "brand") {
    if (value === undefined) delete meta.brand
    else meta.brand = value
  } else {
    const theme = { ...(asObject(meta.theme) ?? {}) }
    if (value === undefined) delete theme.accent
    else theme.accent = value
    if (Object.keys(theme).length) meta.theme = theme
    else delete meta.theme
  }

  if (Object.keys(meta).length) next.meta = meta
  else delete next.meta
  return next
}

// Empty drafts mean "restore the inherited value" and are removed only while
// building the payload, so the field does not jump back to the stale pre-save
// effective meta value while the user is still editing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeAppearanceOverrides(config: Record<string, any>): Record<string, any> {
  let next = config
  const brand = getBrandOverride(next)
  if (brand !== undefined) {
    const trimmed = brand.trim()
    next = updateAppearanceOverride(next, "brand", trimmed || undefined)
  }
  const accent = getAccentOverride(next)
  if (accent !== undefined) {
    const normalized = accent.trim().toUpperCase()
    next = updateAppearanceOverride(next, "accent", normalized || undefined)
  }
  return next
}

// Generic sections (uniform field grid). The Security and Runtime Cache cards are
// rendered separately because they wrap live, non-config controls.
//
// Vinx: upstream opens with a "runtime" section (an enabled toggle and a
// listen port) that configures the gateway process. This deployment has no
// process — the engine is wasm in this same tab and listens on nothing — so
// the section is dropped rather than shown asking questions with no answers.
const sections: SectionDef[] = [
  {
    id: "ai",
    label: "secAi",
    icon: Sparkles,
    fields: [
      { key: "base_url", label: "fldBaseUrl", required: true, placeholder: "http://127.0.0.1:11434/v1" },
      { key: "api_key", label: "fldApiKey", kind: "password", helper: "hlpApiKey" },
      { key: "model", label: "fldModel", required: true, placeholder: "qwen2.5" },
      { key: "temperature", label: "fldTemperature", kind: "number", helper: "hlpTemperature" },
      {
        key: "reasoning_effort",
        label: "fldReasoningEffort",
        helper: "hlpReasoningEffort",
        placeholder: "low / high / max",
      },
    ],
  },
  // Provider-independent agent settings (their own card, after the provider).
  // vinx: upstream also has `default_work_dir` here; the browser engine has no
  // working directory to default, so that field is left out.
  {
    id: "behavior",
    label: "secAgentBehavior",
    icon: Bot,
    fields: [
      {
        key: "default_full_auto",
        label: "fldDefaultFullAuto",
        kind: "toggle",
        helper: "hlpDefaultFullAuto",
      },
      {
        key: "subagent_reasoning_effort",
        label: "fldSubagentReasoningEffort",
        helper: "hlpSubagentReasoningEffort",
        placeholder: "low / high / max",
      },
      {
        key: "skills_repo",
        label: "fldSkillsRepo",
        helper: "hlpSkillsRepo",
        placeholder: "https://skills.example.com/repo",
      },
      {
        key: "apps_repo",
        label: "fldAppsRepo",
        helper: "hlpAppsRepo",
        placeholder: "https://apps.example.com/apps",
      },
    ],
  },
]

/** Icon-sized action button used inside/next to inputs (show, copy, …). */
function InlineIconButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void
  title: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  )
}

/**
 * Secret field for keys and tokens. The value in the form is only ever what
 * the user typed THIS session (`GET /api/config` redacts stored secrets), so:
 *  - the placeholder tells whether a secret is stored (`stored`),
 *  - show/hide and copy act on the in-form value only; copy is disabled while
 *    the field is blank, with a tooltip explaining why.
 *
 * vinx: upstream keys this off the Sand identity's token fingerprint; here the
 * config endpoint answers a plain `api_key_set` flag, so the placeholder says
 * "stored" without a suffix.
 */
function SecretInput({
  id,
  value,
  onChange,
  stored,
  className,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  /** Whether a secret is stored server-side (never sent to the browser). */
  stored: boolean
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)
  const hasValue = value.length > 0
  const placeholder = stored ? t("secretStored") : t("secretNotStored")
  const handleCopy = async () => {
    if (!hasValue) return
    await copyToClipboard(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={cn(inputClassName, "min-w-0 flex-1 font-mono placeholder:font-sans", className)}
        />
        <InlineIconButton
          onClick={() => setVisible((v) => !v)}
          title={visible ? t("secretHide") : t("secretShow")}
          disabled={!hasValue}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </InlineIconButton>
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            {/* span wrapper: a disabled button does not fire hover events. */}
            <span className="inline-flex">
              <InlineIconButton onClick={handleCopy} title={t("secretCopy")} disabled={!hasValue}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              </InlineIconButton>
            </span>
          </TooltipTrigger>
          {!hasValue && (
            <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
              {t("secretCopyStoredHint")}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
      {hasValue && <p className="text-[11px] text-primary/80">{t("secretNew")}</p>}
    </div>
  )
}

/** Runtime cache categories rendered in the management card (fixed order). All
 *  are clearable caches; published deliverables (`public`) are intentionally
 *  omitted here and managed on the Releases page instead. */
const RUNTIME_CATEGORIES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "drafts", label: "rcDrafts", icon: FilePen },
  { id: "downloads", label: "rcDownloads", icon: Download },
  { id: "uploads", label: "rcUploads", icon: Paperclip },
  { id: "tmp", label: "rcTmp", icon: Clock },
]

/** Human-readable byte size. */
function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** Small `?` icon revealing help copy on hover (keeps cards free of always-on
 *  explanatory paragraphs). */
function HelpTip({ text }: { text: string }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="help"
          className="inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground/70 transition-colors hover:text-primary"
        >
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

/** Collapsible sub-block inside a ConfigCard (detail-card.tsx's interaction
 *  pattern at row scale): a clickable header — chevron + title (+ HelpTip) —
 *  with a header-right action area that doesn't toggle. Collapsed by default:
 *  the allow-lists can grow long, and the count in the title already tells the
 *  story at a glance. */
function CollapsibleSubsection({
  title,
  help,
  actions,
  defaultOpen = false,
  children,
}: {
  title: string
  help?: string
  /** Header-right controls (clicks don't toggle the section). */
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => setOpen((v) => !v)
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            toggle()
          }
        }}
        className="-mx-1.5 flex cursor-pointer select-none items-center justify-between gap-2 rounded-[4px] px-1.5 py-0.5 transition-colors hover:bg-muted/40"
      >
        <span className="flex min-w-0 items-center gap-1 text-xs text-foreground/70">
          <ChevronRight
            size={12}
            className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <span className="truncate">{title}</span>
          {help && (
            <span onClick={(e) => e.stopPropagation()}>
              <HelpTip text={help} />
            </span>
          )}
        </span>
        {actions && (
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

function ConfigCard({
  title,
  icon: Icon,
  helpTooltip,
  children,
}: {
  title: string
  icon: LucideIcon
  helpTooltip?: string
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex h-9 items-center gap-2 border-b border-border/40 bg-muted/15 px-4">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <h3 className="text-xs font-medium text-foreground/80">{title}</h3>
        {helpTooltip && <HelpTip text={helpTooltip} />}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function FormRow({
  label,
  htmlFor,
  required,
  tooltip,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  tooltip?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <label htmlFor={htmlFor} className="text-xs text-foreground/70">
          {label}
        </label>
        {required && <span className="text-xs text-destructive">*</span>}
        {tooltip && (
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="help"
                className="inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground/70 transition-colors hover:text-primary"
              >
                <HelpCircle className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs whitespace-pre-line text-xs leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

function SelectControl({
  id,
  value,
  onChange,
  options,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="relative">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClassName}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  )
}

export interface SettingsPageProps {
  basePath?: string
  /** Current server-resolved brand, used when config.meta has no override. */
  brand?: string
  /** Current server-resolved accent, used when config.meta has no override. */
  accent?: string
}

export function SettingsPage({ basePath = "", brand, accent }: SettingsPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cfg, setCfg] = useState<Record<string, any> | null>(null)
  const [editable, setEditable] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Live shared run_shell allow-list (learned literals).
  const [safeCmds, setSafeCmds] = useState<SafeCommands | null>(null)
  // Live shared write/edit directory allow-list.
  const [safePaths, setSafePaths] = useState<SafePaths | null>(null)
  // Runtime cache stats + per-row busy / clear-confirm state.
  const [runtimeStat, setRuntimeStat] = useState<RuntimeCacheStat | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null)
  const [runtimeClearTarget, setRuntimeClearTarget] = useState<string | null>(null)
  // Backup bundle import: selected file awaiting inline confirmation.
  const [backupFile, setBackupFile] = useState<File | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const backupInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let alive = true
    client
      .getConfig()
      .then((c) => {
        if (alive) setCfg(c)
      })
      .catch(() => {
        if (alive) setEditable(false)
      })
    // The remaining loads are capability probes: their endpoints legitimately
    // 404 on agents without a data dir / skill registry, so failures just hide
    // the corresponding section (no toast).
    client
      .getSafeCommands()
      .then((s) => {
        if (alive) setSafeCmds(s)
      })
      .catch(() => {})
    client
      .getSafePaths()
      .then((s) => {
        if (alive) setSafePaths(s)
      })
      .catch(() => {})
    client
      .getRuntimeStat()
      .then((s) => {
        if (alive) setRuntimeStat(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [client])

  const handleClearLearned = useCallback(async () => {
    const learned = await client.clearSafeCommands().catch(() => null)
    if (learned) setSafeCmds((s) => (s ? { ...s, learned } : s))
    else toast.error(t("operationFailed"))
  }, [client])

  const handleRemoveLearned = useCallback(
    async (cmd: string) => {
      const learned = await client.removeSafeCommand(cmd).catch(() => null)
      if (learned) setSafeCmds((s) => (s ? { ...s, learned } : s))
      else toast.error(t("operationFailed"))
    },
    [client],
  )

  const handleClearLearnedDir = useCallback(async () => {
    const learned = await client.clearSafePaths().catch(() => null)
    if (learned) setSafePaths((s) => (s ? { ...s, learned } : s))
    else toast.error(t("operationFailed"))
  }, [client])

  const handleRemoveLearnedDir = useCallback(
    async (dir: string) => {
      const learned = await client.removeSafePath(dir).catch(() => null)
      if (learned) setSafePaths((s) => (s ? { ...s, learned } : s))
      else toast.error(t("operationFailed"))
    },
    [client],
  )

  const clearFieldError = useCallback((key: string) => {
    setErrors((e) => {
      if (!e[key]) return e
      const next = { ...e }
      delete next[key]
      return next
    })
  }, [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = useCallback(
    (key: string, value: any) => {
      setCfg((c) => ({ ...(c ?? {}), [key]: value }))
      setDirty(true)
      setErr(null)
      clearFieldError(key)
    },
    [clearFieldError],
  )

  const setAppearance = useCallback(
    (field: AppearanceField, value: string) => {
      setCfg((c) => (c ? updateAppearanceOverride(c, field, value) : c))
      setDirty(true)
      setErr(null)
      clearFieldError(field === "brand" ? "meta.brand" : "meta.theme.accent")
    },
    [clearFieldError],
  )

  const loadRuntimeStat = useCallback(
    async (category?: string) => {
      if (category) setRuntimeBusy(category)
      const next = await client.getRuntimeStat(category).catch(() => null)
      if (next) {
        setRuntimeStat((prev) =>
          prev && category
            ? { ...prev, categories: { ...prev.categories, ...next.categories } }
            : next,
        )
      }
      if (category) setRuntimeBusy(null)
    },
    [client],
  )

  const handleRuntimeExport = useCallback(
    (category: string) => {
      window.open(client.runtimeExportUrl(category), "_blank")
    },
    [client],
  )

  const handleRuntimeClear = useCallback(
    async (category: string) => {
      setRuntimeBusy(category)
      await client.clearRuntimeCache([category]).catch(() => toast.error(t("operationFailed")))
      setRuntimeClearTarget(null)
      await loadRuntimeStat(category)
      setRuntimeBusy(null)
    },
    [client, loadRuntimeStat],
  )

  // Wait for the agent to exit + the supervisor to relaunch, then reload to
  // reconnect cleanly (config changes — incl. port — take full effect).
  const waitForRestartAndReload = useCallback(async () => {
    await new Promise((r) => setTimeout(r, 1800))
    for (let i = 0; i < 40; i++) {
      if (await client.probe()) break
      await new Promise((r) => setTimeout(r, 750))
    }
    window.location.reload()
  }, [client])

  const onSave = useCallback(async () => {
    if (!cfg) return
    const validationErrors: Record<string, string> = {}
    // Client-side required check (only meaningful when the agent is enabled).
    if (cfg.enabled) {
      for (const k of REQUIRED_KEYS) {
        if (!String(cfg[k] ?? "").trim()) validationErrors[k] = t("fieldRequired")
      }
    }
    const accentOverride = getAccentOverride(cfg)?.trim()
    if (accentOverride && !HEX_COLOR_RE.test(accentOverride)) {
      validationErrors["meta.theme.accent"] = t("invalidThemeColor")
    }
    if (Object.keys(validationErrors).length) {
      setErrors(validationErrors)
      return
    }

    setErr(null)
    setErrors({})
    setSaving(true)
    const normalizedCfg = normalizeAppearanceOverrides(cfg)
    const payload: Record<string, unknown> = {
      ...normalizedCfg,
      port: Number(normalizedCfg.port) || 655,
      temperature:
        normalizedCfg.temperature === "" || normalizedCfg.temperature == null
          ? null
          : Number(normalizedCfg.temperature),
    }
    try {
      await client.putConfig(payload)
      setRestarting(true)
      await waitForRestartAndReload()
    } catch (e) {
      setSaving(false)
      setRestarting(false)
      setErr(e instanceof Error ? e.message : "Save failed")
    }
  }, [cfg, client, waitForRestartAndReload])

  // Restart without saving: the process exits + the supervisor relaunches it.
  const handleRestart = useCallback(async () => {
    setErr(null)
    setRestarting(true)
    await client.restartApp().catch(() => {})
    await waitForRestartAndReload()
  }, [client, waitForRestartAndReload])

  const handleExportLogs = useCallback(() => {
    window.open(client.logsExportUrl(), "_blank")
  }, [client])

  const handleBackupExport = useCallback(() => {
    window.open(client.backupExportUrl(), "_blank")
  }, [client])

  // Apply the selected bundle: the agent restarts to load it (same
  // wait-and-reload dance as saving the config).
  const handleBackupImport = useCallback(async () => {
    if (!backupFile) return
    setBackupBusy(true)
    try {
      const summary = await client.importBackup(backupFile)
      setBackupFile(null)
      toast.success(tf("backupImported", summary.skills_installed.length))
      setRestarting(true)
      await waitForRestartAndReload()
    } catch (e) {
      setBackupBusy(false)
      toast.error(e instanceof Error ? e.message : t("operationFailed"))
    }
  }, [backupFile, client, waitForRestartAndReload])

  function renderField(field: FieldDef) {
    const tooltip = field.helper ? t(field.helper) : undefined
    const label = t(field.label)
    const error = errors[field.key]

    if (field.kind === "toggle") {
      return (
        <FormRow key={field.key} label={label} htmlFor={field.key} tooltip={tooltip}>
          <SelectControl
            id={field.key}
            value={cfg?.[field.key] ? "1" : "0"}
            onChange={(v) => set(field.key, v === "1")}
            options={[
              { value: "1", label: t("enabled") },
              { value: "0", label: t("disabled") },
            ]}
          />
        </FormRow>
      )
    }

    const value = cfg?.[field.key]

    if (field.kind === "password") {
      // `GET /api/config` blanks the secret and answers `<key>_set` instead,
      // so the field can say whether one is stored without showing it.
      const stored = cfg?.[`${field.key}_set`] === true
      return (
        <FormRow key={field.key} label={label} htmlFor={field.key} required={field.required} tooltip={tooltip} error={error}>
          <SecretInput
            id={field.key}
            value={value == null ? "" : String(value)}
            onChange={(v) => set(field.key, v)}
            stored={stored}
            className={cn(error && "border-destructive")}
          />
        </FormRow>
      )
    }

    // Numeric fields stay text inputs (no native spinner arrows); parsed on save.
    return (
      <FormRow key={field.key} label={label} htmlFor={field.key} required={field.required} tooltip={tooltip} error={error}>
        <input
          id={field.key}
          type="text"
          inputMode={field.kind === "number" ? "decimal" : undefined}
          value={value == null ? "" : String(value)}
          onChange={(e) => set(field.key, e.target.value)}
          placeholder={field.placeholder}
          className={cn(inputClassName, field.kind === "mono" && "font-mono", error && "border-destructive")}
        />
      </FormRow>
    )
  }

  const brandOverride = getBrandOverride(cfg)
  const accentOverride = getAccentOverride(cfg)
  const brandValue = brandOverride ?? brand ?? ""
  const accentValue = accentOverride ?? accent ?? DEFAULT_ACCENT
  const accentIsHex = HEX_COLOR_RE.test(accentValue.trim())
  const appearanceSource = (value: string | undefined) => {
    if (value === undefined) return t("appearanceInherited")
    return value.trim() ? null : t("appearanceResetPending")
  }
  const brandSource = appearanceSource(brandOverride)
  const accentSource = appearanceSource(accentOverride)

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex h-14 shrink-0 items-center border-b border-border/50 px-4">
          <Settings className="mr-2 h-3.5 w-3.5 text-foreground/50" strokeWidth={1.5} />
          <h1 className="truncate text-sm font-medium text-foreground/80">{t("settings")}</h1>
        </div>

        {!editable ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {t("configExternal")}
          </div>
        ) : !cfg ? (
          <div className="scroll-on-hover flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-5 px-4 pb-6 pt-[50px]">
              {[0, 1, 2].map((i) => (
                <div key={i} className="overflow-hidden rounded-md border border-border bg-card">
                  <div className="flex h-9 items-center border-b border-border/40 bg-muted/15 px-4">
                    <Skeleton className="h-3.5 w-24 rounded-[4px]" />
                  </div>
                  <div className="grid gap-3 p-4">
                    <Skeleton className="h-9 w-full rounded-[4px]" />
                    <Skeleton className="h-9 w-full rounded-[4px]" />
                    <Skeleton className="h-9 w-full rounded-[4px]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="scroll-on-hover flex-1 overflow-y-auto">
              <div className="mx-auto max-w-2xl space-y-5 px-4 pb-6 pt-[50px]">
                {sections.map((section) => (
                  <ConfigCard key={section.id} title={t(section.label)} icon={section.icon}>
                    <div className="grid gap-3">{section.fields.map(renderField)}</div>
                  </ConfigCard>
                ))}

                <ConfigCard title={t("secAppearance")} icon={Palette}>
                  <div className="grid gap-4">
                    <FormRow
                      label={t("fldAppName")}
                      htmlFor="meta.brand"
                      tooltip={t("hlpAppName")}
                      error={errors["meta.brand"]}
                    >
                      <input
                        id="meta.brand"
                        type="text"
                        value={brandValue}
                        maxLength={BRAND_MAX_LENGTH}
                        onChange={(e) => setAppearance("brand", e.target.value)}
                        placeholder={
                          brandOverride === "" ? t("appearanceResetPending") : t("appNamePlaceholder")
                        }
                        className={cn(inputClassName, errors["meta.brand"] && "border-destructive")}
                      />
                      {brandSource && (
                        <p className="mt-1 text-[11px] text-muted-foreground/70">{brandSource}</p>
                      )}
                    </FormRow>

                    <FormRow
                      label={t("fldThemeColor")}
                      htmlFor="meta.theme.accent"
                      tooltip={t("hlpThemeColor")}
                      error={errors["meta.theme.accent"]}
                    >
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("themePresets")}>
                          {THEME_PRESETS.map((preset) => {
                            const selected = preset.value.toLowerCase() === accentValue.trim().toLowerCase()
                            return (
                              <button
                                key={preset.value}
                                type="button"
                                aria-pressed={selected}
                                aria-label={tf("selectThemePreset", preset.name, preset.value)}
                                title={`${preset.name} · ${preset.value}`}
                                onClick={() => setAppearance("accent", preset.value)}
                                className={cn(
                                  "h-5 w-5 rounded-[4px] border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                                  selected ? "border-foreground ring-1 ring-primary/30" : "border-border/40",
                                )}
                                style={{ backgroundColor: preset.value }}
                              />
                            )
                          })}
                        </div>
                        <div className="relative">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-[3px] border border-border/70",
                              !accentIsHex && "bg-muted",
                            )}
                            style={accentIsHex ? { backgroundColor: accentValue } : undefined}
                          />
                          <input
                            id="meta.theme.accent"
                            type="text"
                            inputMode="text"
                            value={accentValue}
                            maxLength={7}
                            onChange={(e) => setAppearance("accent", e.target.value)}
                            placeholder={DEFAULT_ACCENT}
                            spellCheck={false}
                            className={cn(
                              inputClassName,
                              "pl-9 font-mono uppercase",
                              errors["meta.theme.accent"] && "border-destructive",
                            )}
                          />
                        </div>
                        {accentSource && (
                          <p className="text-[11px] text-muted-foreground/70">{accentSource}</p>
                        )}
                      </div>
                    </FormRow>
                  </div>
                </ConfigCard>

                <ConfigCard title={t("secSecurity")} icon={ShieldAlert}>
                  <CollapsibleSubsection
                    title={tf("whitelistTitle", safeCmds?.learned.length ?? 0, safeCmds?.max ?? 0)}
                    help={t("hlpWhitelist")}
                    actions={
                      <button
                        type="button"
                        onClick={handleClearLearned}
                        disabled={!safeCmds || safeCmds.learned.length === 0}
                        title={t("clearWhitelist")}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    }
                  >
                    {safeCmds && safeCmds.learned.length > 0 ? (
                      <ul className="max-h-56 space-y-1 overflow-y-auto rounded-[4px] border border-border/50 bg-muted/10 p-1.5">
                        {safeCmds.learned.map((cmd) => (
                          <li
                            key={cmd}
                            className="group flex items-center gap-2 rounded-[4px] px-1.5 py-1 hover:bg-muted/40"
                          >
                            <span
                              className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80"
                              title={cmd}
                            >
                              {cmd}
                            </span>
                            <button
                              type="button"
                              aria-label="remove"
                              onClick={() => handleRemoveLearned(cmd)}
                              className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="rounded-[4px] border border-dashed border-border/50 px-3 py-2 text-[11px] text-muted-foreground/70">
                        {t("noWhitelist")}
                      </p>
                    )}
                  </CollapsibleSubsection>

                  <div className="mt-2 border-t border-border/40 pt-2">
                    <CollapsibleSubsection
                      title={tf("dirWhitelistTitle", safePaths?.learned.length ?? 0, safePaths?.max ?? 0)}
                      help={t("hlpDirWhitelist")}
                      actions={
                        <button
                          type="button"
                          onClick={handleClearLearnedDir}
                          disabled={!safePaths || safePaths.learned.length === 0}
                          title={t("clearWhitelist")}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      }
                    >
                      {safePaths && safePaths.learned.length > 0 ? (
                      <ul className="max-h-56 space-y-1 overflow-y-auto rounded-[4px] border border-border/50 bg-muted/10 p-1.5">
                        {safePaths.learned.map((dir) => (
                          <li
                            key={dir}
                            className="group flex items-center gap-2 rounded-[4px] px-1.5 py-1 hover:bg-muted/40"
                          >
                            <span
                              className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80"
                              title={dir}
                            >
                              {dir}
                            </span>
                            <button
                              type="button"
                              aria-label="remove"
                              onClick={() => handleRemoveLearnedDir(dir)}
                              className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="rounded-[4px] border border-dashed border-border/50 px-3 py-2 text-[11px] text-muted-foreground/70">
                        {t("noDirWhitelist")}
                      </p>
                    )}
                    </CollapsibleSubsection>
                  </div>
                </ConfigCard>

                <ConfigCard title={t("secRuntimeCache")} icon={HardDrive} helpTooltip={t("rcHint")}>
                  <div className="space-y-1.5">
                    {runtimeStat?.root && (
                      <div className="mb-1 flex items-center gap-2 rounded-[4px] border border-border/40 bg-muted/10 px-2.5 py-1.5">
                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                            {t("rcRoot")}
                          </span>
                          <span
                            className="min-w-0 truncate font-mono text-[11px] text-foreground/80"
                            title={runtimeStat.root}
                          >
                            {runtimeStat.root}
                          </span>
                        </div>
                        <CopyButton text={runtimeStat.root} />
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatBytes(
                            RUNTIME_CATEGORIES.reduce(
                              (sum, { id }) => sum + (runtimeStat.categories?.[id]?.size_bytes ?? 0),
                              0,
                            ),
                          )}
                        </span>
                      </div>
                    )}
                    {RUNTIME_CATEGORIES.map(({ id, label, icon: Icon }) => {
                      const cat = runtimeStat?.categories?.[id]
                      const empty = !cat || cat.file_count === 0
                      const confirming = runtimeClearTarget === id
                      const busy = runtimeBusy === id
                      return (
                        <div
                          key={id}
                          className="flex items-center justify-between gap-2 rounded-[4px] border border-border/60 bg-muted/15 px-2.5 py-1.5"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                            <span className="truncate text-xs text-foreground/70">{t(label)}</span>
                          </div>
                          {/* Size right-aligned next to the action icons; fixed width keeps
                              the rows' icon columns vertically aligned. */}
                          <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                            {cat ? formatBytes(cat.size_bytes) : "—"}
                          </span>
                          {confirming ? (
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleRuntimeClear(id)}
                                disabled={busy}
                                className="rounded-[4px] px-1.5 py-0.5 text-[11px] text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                              >
                                {t("delete")}
                              </button>
                              <button
                                type="button"
                                onClick={() => setRuntimeClearTarget(null)}
                                disabled={busy}
                                className="rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                              >
                                {t("cancel")}
                              </button>
                            </div>
                          ) : (
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => loadRuntimeStat(id)}
                                disabled={busy}
                                title={t("refresh")}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                              >
                                <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRuntimeExport(id)}
                                disabled={empty}
                                title={t("export")}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRuntimeClearTarget(id)}
                                disabled={empty || busy}
                                title={t("rcClear")}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ConfigCard>

                <ConfigCard title={t("secBackup")} icon={Archive} helpTooltip={t("backupHint")}>
                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) setBackupFile(f)
                      e.target.value = ""
                    }}
                  />
                  {backupFile ? (
                    <div className="flex items-center justify-between gap-2 rounded-[4px] border border-border/60 bg-muted/15 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={backupFile.name}>
                        {tf("backupImportConfirm", backupFile.name)}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={handleBackupImport}
                          disabled={backupBusy}
                          className="rounded-[4px] bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                        >
                          {backupBusy ? <Spinner size="sm" /> : t("confirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setBackupFile(null)}
                          disabled={backupBusy}
                          className="rounded-[4px] px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                        >
                          {t("cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleBackupExport}
                        className="inline-flex items-center gap-1.5 rounded-[4px] border border-border/60 bg-muted/25 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:text-foreground"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t("backupExport")}
                      </button>
                      <button
                        type="button"
                        onClick={() => backupInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-[4px] border border-border/60 bg-muted/25 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:text-foreground"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {t("backupImport")}
                      </button>
                    </div>
                  )}
                </ConfigCard>
              </div>
            </div>

            <div className="shrink-0 border-t border-border/40 bg-card px-4 py-2.5">
              <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportLogs}
                    className="inline-flex items-center gap-1.5 rounded-[4px] border border-border/60 bg-muted/25 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {t("exportLogs")}
                  </button>
                  <button
                    type="button"
                    onClick={handleRestart}
                    disabled={restarting || saving}
                    className="group inline-flex items-center gap-1.5 rounded-[4px] border border-border/60 bg-muted/25 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-destructive/30 hover:text-destructive disabled:opacity-50"
                  >
                    {restarting ? (
                      <Spinner size="sm" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5 transition-colors group-hover:text-destructive" />
                    )}
                    {t("restartApp")}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {/* Progress feedback lives here, in the blank space left of the
                      Save button, so the button label/width never changes. */}
                  {(saving || restarting) && (
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Spinner size="sm" />
                      {restarting ? t("restartingApply") : t("saving")}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={onSave}
                    disabled={!dirty || saving || restarting}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-sm px-3.5 py-1.5 text-xs font-medium transition-colors",
                      dirty && !saving && !restarting
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "cursor-not-allowed bg-primary/40 text-primary-foreground/80",
                    )}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("save")}
                  </button>
                </div>
              </div>
              {err && (
                <p className="mx-auto mt-1.5 max-w-2xl truncate text-[11px] text-destructive">{err}</p>
              )}
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
