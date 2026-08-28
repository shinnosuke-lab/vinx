import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  Sparkles,
  Upload,
  Download,
  Trash2,
  RefreshCw,
  Zap,
  ZapOff,
  AlertTriangle,
  TriangleAlert,
  ArrowLeft,
  CalendarClock,
  Check,
  Copy,
  ExternalLink,
  EyeOff,
  FileCode,
  FileText,
  FolderOpen,
  Info,
  Package,
  Share2,
  X,
  Search,
  ChevronDown,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Wrench,
} from "lucide-react"
import { createPortal } from "react-dom"
import { createChatClient } from "@agentchat/client"
import type {
  MarketSkillInfo,
  MarketSkillPreview,
  SkillDiagnostic,
  SkillInfo,
  SkillsMarket,
} from "@agentchat/types"
import { cn, copyToClipboard, portalContainer } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { Spinner } from "@agentchat/components/shared/spinner"
import { SkillIcon } from "@agentchat/components/shared/skill-icon"
import { DetailCard, DefRow, Pill, ActionRow } from "@agentchat/components/shared/detail-card"
import { InstallPopover } from "@agentchat/components/shared/install-popover"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { toast } from "@agentchat/components/ui/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@agentchat/components/ui/tooltip"
import { Markdown } from "@agentchat/components/chat/markdown"

/**
 * Full-page skill manager, styled to match the sessions page: an `h-14` header,
 * a filter/toolbar row (select-all + count, search, sort, refresh, batch menu),
 * and a compact fixed-width card grid split into pinned / enabled / disabled
 * sections. Cards mirror the session card's size and layout (checkbox + small
 * icon + name + footer meta + a hover action cluster of pin / toggle / export /
 * delete). Supports drag-and-drop / click import of skill packages (zip) and
 * surfaces the discovery diagnostics from `GET /api/skills`.
 */

export interface SkillsPageProps {
  basePath?: string
}

type SortField = "name" | "tools"
type SortOrder = "asc" | "desc"

// One card width for both tabs, so switching installed <-> market never
// reflows the grid.
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,220px)] gap-4"

// Desktop detail-panel width: drag range + the localStorage key remembering it.
const PANEL_MIN = 380
const PANEL_MAX = 780
const PANEL_DEFAULT = 480
const PANEL_WIDTH_KEY = "acc.skillPanelWidth"

/** Download a same-origin file (the server sets Content-Disposition) without
 *  the blank-tab flash `window.open(url, "_blank")` causes. */
function triggerDownload(url: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = ""
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function Badge({
  children,
  tone = "muted",
  title,
  className,
}: {
  children: ReactNode
  tone?: "muted" | "primary" | "info" | "warning"
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 rounded-[4px] px-1 py-px text-[10px] uppercase tracking-wide",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "info" && "bg-sky-500/10 text-sky-600 dark:text-sky-400",
        tone === "warning" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        tone === "muted" && "bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}

const diagColor = (kind: string) =>
  kind === "parse_error"
    ? "text-destructive"
    : kind === "shadowed"
      ? "text-amber-500"
      : "text-muted-foreground"

/** Icon URL for a repository entry: absolute URLs pass through, relative
 *  ones resolve against the repo base (mirrors the agent-side resolution). */
function marketIconUrl(repo: string, icon?: string | null): string | null {
  if (!icon) return null
  if (/^https?:\/\//i.test(icon)) return icon
  return `${repo.replace(/\/+$/, "")}/${icon.replace(/^\/+/, "")}`
}

/** Human-readable byte size for package meta ("12.3 KB"). */
function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** Render a free-form `author` value: a trailing `<email-or-url>` contact is
 *  linked (mailto for an address, href for an http(s) URL); anything else shows
 *  as plain text. Convention mirrors npm/Cargo/git author strings. */
function renderAuthor(author: string): ReactNode {
  const m = author.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (!m) return author
  const name = m[1]
  const contact = m[2].trim()
  const href = /^https?:\/\//i.test(contact)
    ? contact
    : contact.includes("@")
      ? `mailto:${contact}`
      : null
  if (!href) return author
  return (
    <>
      {name ? `${name} ` : ""}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {contact}
      </a>
    </>
  )
}

/** Identity avatar: a fixed-size slot holding the skill's own icon or, when it
 *  has none, the accent-tinted default glyph (no background, so it reads as a
 *  plain icon rather than a chip). `className` sets the slot size. */
function SkillAvatar({
  name,
  src,
  hasIcon,
  className = "h-6 w-6",
}: {
  name: string
  src: string
  hasIcon: boolean
  className?: string
}) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center", className)}>
      <SkillIcon name={name} src={src} hasIcon={hasIcon} className="h-full w-full text-primary" />
    </span>
  )
}

/** Quiet install-state pill for the market detail panel. Uninstalled entries
 *  get no badge; installed / updatable / app-managed all use muted tone so the
 *  panel stays calm (the ActionRow carries the real call-to-action). */
function MarketStateBadge({ entry }: { entry: MarketSkillInfo }) {
  const installed = entry.installed_version != null
  if (!installed) return null
  if (entry.repo_managed === false) {
    return <Pill tone="muted">{t("skillsMarketAppManaged")}</Pill>
  }
  if (entry.update_available) {
    return <Pill tone="muted">{t("skillsMarketUpdatable")}</Pill>
  }
  return (
    <Pill tone="muted">
      <Check size={10} />
      {t("skillsMarketInstalledBadge")}
    </Pill>
  )
}

/** Repository grid card, mirroring `SkillCard`'s quiet layout: title row =
 *  name + one small icon action in the corner cluster (install / update with
 *  a primary dot / an inert check when already installed), then a two-line
 *  description and the identity/meta footer. The whole card opens the detail
 *  panel; the action stops propagation. */
function MarketCard({
  entry,
  iconUrl,
  installing,
  onInstall,
  onOpen,
}: {
  entry: MarketSkillInfo
  iconUrl: string | null
  installing: boolean
  onInstall: () => void
  onOpen: () => void
}) {
  const installed = entry.installed_version != null
  const update = !!entry.update_available
  // Installed outside the repo-managed install dir (app-shipped / built-in):
  // not installable, not updatable.
  const appManaged = installed && entry.repo_managed === false
  // Env targets exclude this agent: the server refuses the install, so the
  // action is inert with the reason as its tooltip.
  const envBlocked = !!entry.env_mismatch
  const actionable = !appManaged && !envBlocked && (!installed || update)
  return (
    <div
      onClick={onOpen}
      className="group relative flex min-w-0 w-full cursor-pointer overflow-hidden rounded-[6px] border border-border bg-card transition-colors hover:border-primary/30"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-3 py-3.5">
        <div className="flex items-center gap-2">
          <SkillAvatar
            name={entry.name}
            src={iconUrl ?? ""}
            hasIcon={!!iconUrl}
            className="h-5 w-5"
          />
          <h3
            className="min-w-0 flex-1 truncate text-[11px] font-medium leading-snug text-foreground"
            title={entry.name}
          >
            {entry.name}
          </h3>
          <div className="flex shrink-0 items-center justify-end gap-0.5">
            {actionable ? (
              <button
                type="button"
                disabled={installing}
                onClick={(e) => {
                  e.stopPropagation()
                  onInstall()
                }}
                title={update ? t("skillsMarketUpdate") : t("skillsMarketInstall")}
                className="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                {installing ? (
                  <Spinner size="sm" className="h-3 w-3" />
                ) : update ? (
                  <RefreshCw size={11} />
                ) : (
                  <Plus size={13} strokeWidth={2.5} />
                )}
                {/* Update available: a quiet primary dot on the action. */}
                {update && !installing && (
                  <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            ) : envBlocked && !installed ? (
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/40"
                title={tf("skillsMarketEnvMismatchHint", (entry.env ?? []).join(", "))}
              >
                <Plus size={13} strokeWidth={2.5} />
              </span>
            ) : (
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500"
                title={
                  appManaged ? t("skillsMarketAppManagedHint") : t("skillsMarketInstalledBadge")
                }
              >
                <Check size={11} />
              </span>
            )}
          </div>
        </div>

        <p
          className="line-clamp-1 text-[11px] leading-snug text-muted-foreground"
          title={entry.description}
        >
          {entry.description || "—"}
        </p>
      </div>
    </div>
  )
}

/** Reusable markdown document card for the detail panels' instructions /
 *  changelog tabs (shared by both the installed and market panels so they
 *  read as one design). `content`: undefined = loading (spinner), null =
 *  unavailable (`emptyText`), string = body with a rendered/raw toggle and
 *  copy / open-in-new-tab / download actions. */
function DocCard({
  content,
  title,
  downloadName,
  emptyText,
}: {
  content: string | null | undefined
  title: string
  downloadName: string
  emptyText: string
}) {
  const [rawView, setRawView] = useState(false)
  const [copied, setCopied] = useState(false)
  // Reset the raw toggle whenever the document changes (skill/tab switch).
  useEffect(() => {
    setRawView(false)
  }, [content])
  const copy = () => {
    if (!content) return
    void copyToClipboard(content).then((ok) => {
      if (!ok) {
        toast.error(t("copyFailed"))
        return
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const download = () => {
    if (!content) return
    const blob = new Blob([content], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = downloadName
    a.click()
    URL.revokeObjectURL(url)
  }
  const openInNewTab = () => {
    if (!content) return
    // text/plain renders inline in every browser (text/markdown downloads).
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    window.open(URL.createObjectURL(blob), "_blank", "noopener")
  }
  return (
    // 30px from the scroll-area top: 20px shared container pt + 10px.
    <div className="mt-[10px]">
      {content !== null ? (
        <DetailCard
          icon={Sparkles}
          title={title}
          defaultOpen
          stickyHeader
          actions={
            content ? (
              <>
                <button
                  type="button"
                  onClick={() => setRawView((v) => !v)}
                  className={cn(
                    "rounded p-1.5 transition-colors hover:bg-muted/60",
                    rawView ? "text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                  title={rawView ? t("skillsRenderedView") : t("skillsRawView")}
                >
                  <FileCode size={13} />
                </button>
                <button
                  type="button"
                  onClick={copy}
                  className={cn(
                    "rounded p-1.5 transition-colors hover:bg-muted/60",
                    copied ? "text-emerald-600" : "text-muted-foreground hover:text-foreground",
                  )}
                  title={t("copy")}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button
                  type="button"
                  onClick={openInNewTab}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  title={t("openInNewTab")}
                >
                  <ExternalLink size={13} />
                </button>
                <button
                  type="button"
                  onClick={download}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  title={t("download")}
                >
                  <Download size={13} />
                </button>
              </>
            ) : undefined
          }
        >
          {content === undefined ? (
            <div className="flex items-center gap-2 py-2 text-muted-foreground">
              <Spinner size="sm" className="h-3 w-3" />
              {t("loading")}
            </div>
          ) : rawView ? (
            <pre className="whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
              {content}
            </pre>
          ) : (
            <Markdown content={content} />
          )}
        </DetailCard>
      ) : (
        <p className="text-xs text-muted-foreground/70">{emptyText}</p>
      )}
    </div>
  )
}

/** Market detail panel (desktop right column / mobile full-screen takeover),
 *  mirroring `SkillDetailPanel`'s shell so both tabs feel like one page:
 *  identity header, state badges, the install/update action, and every field
 *  the repository index carries (description / when-to-use / package meta). */
function MarketDetailPanel({
  entry,
  iconUrl,
  installing,
  preview,
  mobile,
  onClose,
  onInstall,
}: {
  entry: MarketSkillInfo
  iconUrl: string | null
  installing: boolean
  /** SKILL.md body + CHANGELOG for the instructions / changelog tabs (agent
   *  downloads on demand): undefined = loading, null = load failed. */
  preview: MarketSkillPreview | null | undefined
  mobile: boolean
  onClose: () => void
  onInstall: () => void
}) {
  const [tab, setTab] = useState<MarketPanelTab>("overview")
  const installed = entry.installed_version != null
  const update = !!entry.update_available
  const appManaged = installed && entry.repo_managed === false
  const envBlocked = !!entry.env_mismatch
  const actionable = !appManaged && !envBlocked && (!installed || update)
  // Doc-tab contents derived from the lazy preview: undefined = loading,
  // null = unavailable (empty state), string = body.
  const readmeContent =
    preview === undefined ? undefined : preview?.readme?.trim() ? preview.readme : null
  const changelogContent =
    preview === undefined
      ? undefined
      : preview?.changelog?.trim()
        ? preview.changelog
        : null
  return (
    <div className="flex h-full w-full flex-col bg-card">
      {/* Header bar */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          {mobile && (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("skillsClose")}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <SkillIcon
            name={entry.name}
            src={iconUrl ?? ""}
            hasIcon={!!iconUrl}
            className="h-6 w-6 text-primary"
          />
          <span className="truncate text-sm font-medium text-foreground" title={entry.name}>
            {entry.name}
          </span>
        </div>
        {!mobile && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("skillsClose")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Tab bar — mirrors the installed detail panel so both read as one page. */}
      <div role="tablist" className="flex h-10 shrink-0 items-end gap-6 border-b border-border px-4">
        {(
          [
            ["overview", t("skillsTabOverview")],
            ["detail", t("skillsTabDetail")],
            ["changelog", t("skillsTabChangelog")],
          ] as [MarketPanelTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px h-10 border-b-2 px-1 text-xs font-medium transition-colors",
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-foreground/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-5 py-5">
          {tab === "overview" && (
            <>
          {/* Actions — same DetailCard + ActionRow shape as the installed
              panel, so both detail views read as one design. */}
          <DetailCard icon={Zap} title={t("skillsCommonActions")} defaultOpen>
            {actionable ? (
              <ActionRow
                icon={Download}
                title={
                  update
                    ? tf("skillsMarketUpdateTo", entry.version ? `v${entry.version}` : "")
                    : t("skillsMarketInstall")
                }
                hint={update ? t("skillsMarketUpdateHint") : t("skillsMarketInstallHint")}
                busy={installing}
                disabled={installing}
                onClick={onInstall}
              />
            ) : envBlocked && (!installed || update) ? (
              // The agent refuses env-mismatched installs; surface the reason
              // where the action would have been.
              <ActionRow
                icon={TriangleAlert}
                title={t("skillsMarketEnvMismatch")}
                hint={tf("skillsMarketEnvMismatchHint", (entry.env ?? []).join(", "))}
                disabled
              />
            ) : (
              <ActionRow
                icon={Check}
                title={
                  appManaged ? t("skillsMarketAppManaged") : t("skillsMarketInstalledBadge")
                }
                hint={
                  appManaged
                    ? t("skillsMarketAppManagedHint")
                    : t("skillsMarketUpToDateHint")
                }
                disabled
              />
            )}
          </DetailCard>

          <DetailCard icon={Info} title={t("skillsInfoTitle")} defaultOpen>
            <DefRow label={t("skillsMarketVersionLabel")}>
              <span className="tabular-nums">{entry.version ? `v${entry.version}` : "—"}</span>
            </DefRow>
            {entry.author && (
              <DefRow label={t("skillsAuthorLabel")}>{renderAuthor(entry.author)}</DefRow>
            )}
            {entry.env && entry.env.length > 0 && (
              <DefRow label={t("skillsMarketEnvLabel")}>
                {entry.env.join(", ")}
              </DefRow>
            )}
            <DefRow label={t("skillsStatusLabel")}>
              {installed ? (
                <MarketStateBadge entry={entry} />
              ) : (
                <Pill tone="muted">{t("skillsMarketNotInstalled")}</Pill>
              )}
            </DefRow>
          </DetailCard>

          {entry.description && (
            <DetailCard icon={FileText} title={t("skillsDescription")} defaultOpen>
              <p className="leading-relaxed text-foreground/80">{entry.description}</p>
            </DetailCard>
          )}

          {entry.when_to_use && (
            <DetailCard icon={CalendarClock} title={t("skillsWhenToUse")} defaultOpen>
              <p className="leading-relaxed text-foreground/80">{entry.when_to_use}</p>
            </DetailCard>
          )}

          <DetailCard icon={Package} title={t("skillsMarketPackage")} defaultOpen>
            <DefRow label={t("skillsMarketVersionLabel")}>
              <span className="tabular-nums">{entry.version || "—"}</span>
            </DefRow>
            <DefRow label={t("skillsMarketSizeLabel")}>
              <span className="tabular-nums">{entry.size ? formatBytes(entry.size) : "—"}</span>
            </DefRow>
            {entry.apps?.length ? (
              <DefRow label={t("skillsMarketAppsLabel")}>{entry.apps.join(", ")}</DefRow>
            ) : null}
            {entry.env?.length ? (
              <DefRow label={t("skillsMarketEnvLabel")}>{entry.env.join(", ")}</DefRow>
            ) : null}
            {entry.tags?.length ? (
              <DefRow label={t("skillsMarketTagsLabel")}>{entry.tags.join(", ")}</DefRow>
            ) : null}
            {entry.url ? (
              <DefRow label={t("skillsMarketFileLabel")}>
                <code className="break-all rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {entry.url}
                </code>
              </DefRow>
            ) : null}
            {entry.sha256 ? (
              <DefRow label="sha256">
                <code className="break-all rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {entry.sha256}
                </code>
              </DefRow>
            ) : null}
          </DetailCard>
            </>
          )}

          {tab === "detail" && (
            <DocCard
              content={readmeContent}
              title={t("skillsReadme")}
              downloadName={`${entry.name}-SKILL.md`}
              emptyText={t("skillsNoReadme")}
            />
          )}

          {tab === "changelog" && (
            <DocCard
              content={changelogContent}
              title={t("skillsTabChangelog")}
              downloadName={`${entry.name}-CHANGELOG.md`}
              emptyText={t("skillsChangelogEmpty")}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** Portal-anchored dropdown for the `...` (batch) menu, mirrors the sessions page. */
function DropdownMenu({
  menuRef,
  onClose,
  children,
}: {
  menuRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.right - 160 })
  }, [menuRef])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return
      if (contentRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [menuRef, onClose])

  return (
    <div
      ref={contentRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      className="w-40 rounded-md border border-border bg-card p-1 shadow-md animate-in fade-in-0 zoom-in-95"
    >
      {children}
    </div>
  )
}

type SkillPanelTab = "overview" | "actions" | "detail" | "changelog"
type MarketPanelTab = "overview" | "detail" | "changelog"

/** Compact grid card: title row = checkbox +
 *  name + inline enable-toggle + `...` menu; meta row = identity icon +
 *  version/badges on the left, tool count on the right. */
function SkillCard({
  skill: s,
  selected,
  isBusy,
  iconUrl,
  onOpen,
  onToggleSelect,
  onTogglePin,
  onToggleEnabled,
  onExport,
  onDelete,
}: {
  skill: SkillInfo
  selected: boolean
  isBusy: boolean
  iconUrl: string
  onOpen: () => void
  onToggleSelect: () => void
  onTogglePin: () => void
  onToggleEnabled: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const enabled = s.enabled !== false
  return (
    <div
      onClick={onOpen}
      className={cn(
        "group relative flex min-w-0 w-full cursor-pointer overflow-hidden rounded-[6px] border bg-card transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : cn("border-border hover:border-primary/30", !enabled && "opacity-60"),
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-3 py-3.5">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={onToggleSelect}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white"
          />
          <h3
            className="min-w-0 flex-1 truncate text-[11px] font-medium leading-snug text-foreground"
            title={s.name}
          >
            {s.name}
          </h3>
          <div className="flex shrink-0 items-center justify-end gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleEnabled()
              }}
              disabled={isBusy}
              title={enabled ? t("skillsDisable") : t("skillsEnable")}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-50",
                enabled
                  ? "text-emerald-500 hover:bg-emerald-500/10"
                  : "text-muted-foreground/40 hover:bg-muted hover:text-foreground",
              )}
            >
              {isBusy ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : enabled ? (
                <Zap size={11} />
              ) : (
                <ZapOff size={11} />
              )}
            </button>
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((v) => !v)
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal size={11} />
              </button>
              {menuOpen &&
                createPortal(
                  <DropdownMenu menuRef={menuRef} onClose={() => setMenuOpen(false)}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen(false)
                        onTogglePin()
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
                    >
                      {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                      {s.pinned ? t("unpin") : t("pin")}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpen(false)
                        onExport()
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
                    >
                      <Download size={12} />
                      {t("skillsExport")}
                    </button>
                    {s.deletable && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen(false)
                          onDelete()
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 size={12} />
                        {t("skillsDelete")}
                      </button>
                    )}
                  </DropdownMenu>,
                  portalContainer(),
                )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground/70">
          <span className="flex shrink-0 items-center gap-1">
            <SkillIcon name={s.name} src={iconUrl} hasIcon={!!s.has_icon} className="h-3.5 w-3.5" />
            {s.version ? <span className="tabular-nums">v{s.version}</span> : null}
          </span>
          {s.builtin && <Badge>{t("skillsBuiltinBadge")}</Badge>}
          {!s.builtin && !s.deletable && (
            <Badge title={t("skillsBundledHint")}>{t("skillsBundledBadge")}</Badge>
          )}
          {s.disable_model_invocation && <Badge>{t("skillsManualBadge")}</Badge>}
          {!s.user_invocable && <Badge>{t("skillsModelOnlyBadge")}</Badge>}
          <span className="ml-auto shrink-0 tabular-nums" title={tf("skillsToolsTitle", s.allowed_tools.length)}>
            {tf("skillsToolsCount", s.allowed_tools.length)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Master-detail right panel (desktop 480px column / mobile full-screen
 *  takeover), segmented into three tabs:
 *  overview (what it is), actions (pin/enable/export/delete), detail
 *  (SKILL.md + location meta). */
function SkillDetailPanel({
  skill: s,
  iconUrl,
  exportUrl,
  busy,
  readme,
  changelog,
  toolDescs,
  mobile,
  onClose,
  onTogglePin,
  onToggleEnabled,
  onToggleShared,
  onDelete,
}: {
  skill: SkillInfo
  iconUrl: string
  exportUrl: string
  busy: boolean
  /** SKILL.md body: undefined = loading, null = unavailable. */
  readme: string | null | undefined
  /** CHANGELOG.md body: undefined = loading, null = none. */
  changelog: string | null | undefined
  /** Registered tool name → description (for allowed-tools tooltips). */
  toolDescs: Map<string, string>
  mobile: boolean
  onClose: () => void
  onTogglePin: () => void
  onToggleEnabled: () => void
  onToggleShared: () => void
  onDelete: () => void
}) {
  const enabled = s.enabled !== false
  const shared = s.shared !== false
  const [tab, setTab] = useState<SkillPanelTab>("overview")

  return (
    <div className="flex h-full w-full flex-col bg-card">
      {/* Header bar */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          {mobile && (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("skillsClose")}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <SkillIcon
            name={s.name}
            src={iconUrl}
            hasIcon={!!s.has_icon}
            className="h-6 w-6 text-primary"
          />
          <span className="truncate text-sm font-medium text-foreground" title={s.name}>
            {s.name}
          </span>
        </div>
        {!mobile && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("skillsClose")}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Tab bar (vinx ScheduleDetailPanel style) */}
      <div role="tablist" className="flex h-10 shrink-0 items-end gap-6 border-b border-border px-4">
        {(
          [
            ["overview", t("skillsTabOverview")],
            ["actions", t("skillsTabActions")],
            ["detail", t("skillsTabDetail")],
            ["changelog", t("skillsTabChangelog")],
          ] as [SkillPanelTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px h-10 border-b-2 px-1 text-xs font-medium transition-colors",
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-foreground/70 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-5 py-5">
          {tab === "overview" && (
            <>
              <DetailCard icon={Info} title={t("skillsInfoTitle")} defaultOpen>
                <DefRow label={t("skillsMarketVersionLabel")}>
                  <span className="tabular-nums">{s.version ? `v${s.version}` : "—"}</span>
                </DefRow>
                {s.author && (
                  <DefRow label={t("skillsAuthorLabel")}>{renderAuthor(s.author)}</DefRow>
                )}
                {s.env && s.env.length > 0 && (
                  <DefRow label={t("skillsMarketEnvLabel")}>
                    {s.env.join(", ")}
                  </DefRow>
                )}
                <DefRow label={t("skillsStatusLabel")}>
                  <Pill tone={enabled ? "success" : "muted"}>
                    {enabled ? <Zap size={10} /> : <ZapOff size={10} />}
                    {enabled ? t("skillsEnabled") : t("skillsDisabled")}
                  </Pill>
                </DefRow>
                {(s.builtin ||
                  s.disable_model_invocation ||
                  !s.user_invocable ||
                  (!shared && !s.builtin)) && (
                  <DefRow label={t("skillsMarketTagsLabel")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {s.builtin && <Pill>{t("skillsBuiltinBadge")}</Pill>}
                      {s.disable_model_invocation && <Pill tone="muted">{t("skillsManualBadge")}</Pill>}
                      {!s.user_invocable && <Pill tone="muted">{t("skillsModelOnlyBadge")}</Pill>}
                      {!shared && !s.builtin && (
                        <Pill tone="muted">
                          <EyeOff size={10} />
                          {t("skillsUnsharedBadge")}
                        </Pill>
                      )}
                    </div>
                  </DefRow>
                )}
              </DetailCard>

              {s.description && (
                <DetailCard icon={FileText} title={t("skillsDescription")} defaultOpen>
                  <p className="leading-relaxed text-foreground/80">{s.description}</p>
                </DetailCard>
              )}

              <DetailCard icon={CalendarClock} title={t("skillsWhenToUse")} defaultOpen>
                {s.when_to_use ? (
                  <p className="leading-relaxed text-foreground/80">{s.when_to_use}</p>
                ) : (
                  <p className="text-muted-foreground/70">—</p>
                )}
                {s.argument_hint && (
                  <DefRow label={t("skillsArgumentHint")}>
                    <code className="block rounded-[4px] bg-muted px-2 py-1 font-mono text-[10px] text-foreground/80">
                      {s.argument_hint}
                    </code>
                  </DefRow>
                )}
              </DetailCard>

              <DetailCard icon={Wrench} title={t("skillsAllowedTools")} defaultOpen>
                {s.allowed_tools.length > 0 ? (
                  <TooltipProvider delayDuration={150}>
                    <div className="flex flex-wrap gap-1">
                      {s.allowed_tools.map((tool) => (
                        <Tooltip key={tool}>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-default items-center gap-1 rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">
                              <Wrench size={9} />
                              {tool}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="max-w-xs whitespace-pre-line text-xs leading-relaxed"
                          >
                            {toolDescs.get(tool) ?? t("skillsToolUnregistered")}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </TooltipProvider>
                ) : (
                  <p className="text-muted-foreground/70">{t("skillsUnrestricted")}</p>
                )}
              </DetailCard>

              <DetailCard icon={FolderOpen} title={t("skillsLocation")} defaultOpen>
                {/* The card title already says "Location"; the path needs no
                    second label (the version already sits in the badge row). */}
                <code className="block break-all rounded-[4px] bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {s.dir}
                </code>
              </DetailCard>
            </>
          )}

          {tab === "actions" && (
            <>
              <DetailCard icon={Zap} title={t("skillsCommonActions")} defaultOpen>
                <ActionRow
                  icon={s.pinned ? PinOff : Pin}
                  title={s.pinned ? t("unpin") : t("pin")}
                  hint={t("skillsPinHint")}
                  onClick={onTogglePin}
                />
                <ActionRow
                  icon={enabled ? ZapOff : Zap}
                  title={enabled ? t("skillsDisable") : t("skillsEnable")}
                  hint={enabled ? t("skillsDisableHint") : t("skillsEnableHint")}
                  busy={busy}
                  disabled={busy}
                  onClick={onToggleEnabled}
                />
                {/* Hub listing toggle — distribution only, local use untouched.
                    Built-ins are never served by the hub, so no toggle. */}
                {!s.builtin && (
                  <ActionRow
                    icon={shared ? EyeOff : Share2}
                    title={shared ? t("skillsUnshare") : t("skillsShare")}
                    hint={shared ? t("skillsUnshareHint") : t("skillsShareHint")}
                    busy={busy}
                    disabled={busy}
                    onClick={onToggleShared}
                  />
                )}
                <ActionRow
                  icon={Download}
                  title={t("skillsExport")}
                  hint={t("skillsExportHint")}
                  href={exportUrl}
                />
              </DetailCard>

              {s.deletable && (
                <DetailCard icon={TriangleAlert} title={t("skillsDangerZone")} defaultOpen>
                  <ActionRow
                    icon={Trash2}
                    title={t("skillsDelete")}
                    hint={t("skillsDeleteHint")}
                    destructive
                    disabled={busy}
                    onClick={onDelete}
                  />
                </DetailCard>
              )}
            </>
          )}

          {tab === "detail" && (
            <DocCard
              content={readme}
              title={t("skillsReadme")}
              downloadName={`${s.name}-SKILL.md`}
              emptyText={t("skillsNoReadme")}
            />
          )}

          {tab === "changelog" && (
            <DocCard
              content={changelog}
              title={t("skillsTabChangelog")}
              downloadName={`${s.name}-CHANGELOG.md`}
              emptyText={t("skillsChangelogEmpty")}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export function SkillsPage({ basePath = "" }: SkillsPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [diags, setDiags] = useState<SkillDiagnostic[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // skill name currently mutating
  const [importing, setImporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const [searchQuery, setSearchQuery] = useState("")
  const [sortField, setSortField] = useState<SortField>("name")
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc")
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [detailName, setDetailName] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const installRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Online repository ("market") tab. `market`: undefined = loading, null =
  // no repository configured (tab hidden), otherwise the proxied index.
  const [tab, setTab] = useState<"installed" | "market">("installed")
  const [market, setMarket] = useState<SkillsMarket | null | undefined>(undefined)
  const [marketErr, setMarketErr] = useState<string | null>(null)
  const [marketRefreshing, setMarketRefreshing] = useState(false)
  const [marketQuery, setMarketQuery] = useState("")
  // Repo entries this agent's environment can't run are hidden until the
  // operator expands them via the footer row.
  const [showEnvMismatch, setShowEnvMismatch] = useState(false)
  const [installingName, setInstallingName] = useState<string | null>(null)
  const [marketDetailName, setMarketDetailName] = useState<string | null>(null)

  const loadMarket = useCallback(async () => {
    setMarketRefreshing(true)
    setMarketErr(null)
    try {
      setMarket(await client.getSkillsMarket())
    } catch (e) {
      setMarketErr(e instanceof Error ? e.message : String(e))
      // Repo configured but unreachable: keep the tab visible with an error
      // state (only a 404 = unconfigured hides it).
      setMarket((prev) =>
        prev === undefined ? { repo: "", generated_at: null, skills: [] } : prev,
      )
    } finally {
      setMarketRefreshing(false)
    }
  }, [client])

  useEffect(() => {
    void loadMarket()
  }, [loadMarket])

  // Registered tool name → description, for the allowed-tools tooltips.
  const [toolDescs, setToolDescs] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let alive = true
    client.listTools().then((tools) => {
      if (alive) setToolDescs(new Map(tools.map((t) => [t.name, t.description])))
    })
    return () => {
      alive = false
    }
  }, [client])

  // Desktop detail-panel width, remembered across visits.
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
      if (Number.isFinite(saved) && saved >= PANEL_MIN && saved <= PANEL_MAX) return saved
    } catch {
      /* non-browser env */
    }
    return PANEL_DEFAULT
  })

  /** Left-edge drag: width = panel's right edge − pointer x, clamped. */
  const startPanelResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const panel = e.currentTarget.parentElement
    const right = panel ? panel.getBoundingClientRect().right : window.innerWidth
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    const onMove = (ev: PointerEvent) => {
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(right - ev.clientX))))
    }
    const onUp = () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      setPanelWidth((w) => {
        try {
          window.localStorage.setItem(PANEL_WIDTH_KEY, String(w))
        } catch {
          /* ignore */
        }
        return w
      })
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }, [])

  const reload = useCallback(async () => {
    setRefreshing(true)
    const r = await client.listSkills().catch(() => null)
    setRefreshing(false)
    if (!r) {
      setUnavailable(true)
      setSkills([])
      return
    }
    setUnavailable(false)
    setSkills(r.skills)
    setDiags(r.diagnostics)
  }, [client])

  useEffect(() => {
    void reload()
  }, [reload])

  // Reset the selection whenever the visible set changes via search.
  useEffect(() => {
    setSelectedNames(new Set())
  }, [searchQuery])

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  const doImport = useCallback(
    async (file: File | Blob) => {
      setImporting(true)
      try {
        const res = await client.importSkill(file)
        toast.success(tf("skillsInstallOk", res.name))
        await reload()
      } catch (e) {
        toast.error(tf("skillsInstallFailed", e instanceof Error ? e.message : "error"))
      } finally {
        setImporting(false)
      }
    },
    [client, reload],
  )

  const doInstallUrl = useCallback(
    async (rawUrl: string) => {
      const u = rawUrl.trim()
      if (!/^https?:\/\//i.test(u)) {
        toast.error(t("skillsInstallUrlInvalid"))
        return
      }
      setImporting(true)
      try {
        const res = await client.installSkillUrl(u)
        toast.success(tf("skillsInstallOk", res.name))
        setInstallOpen(false)
        await reload()
      } catch (e) {
        toast.error(tf("skillsInstallFailed", e instanceof Error ? e.message : "error"))
      } finally {
        setImporting(false)
      }
    },
    [client, reload],
  )

  const onPickFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void doImport(file)
      e.target.value = "" // allow re-selecting the same file
    },
    [doImport],
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void doImport(file)
    },
    [doImport],
  )

  const toggleEnabled = useCallback(
    async (s: SkillInfo) => {
      const next = s.enabled === false
      setBusy(s.name)
      try {
        await client.setSkillEnabled(s.name, next)
        setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, enabled: next } : x)) ?? prev)
      } catch {
        /* leave state as-is on failure */
      } finally {
        setBusy(null)
      }
    },
    [client],
  )

  const togglePin = useCallback(
    async (s: SkillInfo) => {
      const next = !s.pinned
      setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, pinned: next } : x)) ?? prev)
      try {
        await client.setSkillPinned(s.name, next)
      } catch {
        setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, pinned: s.pinned } : x)) ?? prev)
        toast.error(t("operationFailed"))
      }
    },
    [client],
  )

  /** Hub listing toggle (share/unshare on this agent's own /repo index);
   *  orthogonal to enable/disable, which stays local. */
  const toggleShared = useCallback(
    async (s: SkillInfo) => {
      const next = s.shared === false
      setBusy(s.name)
      try {
        await client.setSkillShared(s.name, next)
        setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, shared: next } : x)) ?? prev)
      } catch {
        toast.error(t("operationFailed"))
      } finally {
        setBusy(null)
      }
    },
    [client],
  )

  const doDelete = useCallback(
    async (name: string) => {
      if (!(await confirmDialog(tf("skillsDeleteConfirm", name)))) return
      setBusy(name)
      try {
        await client.deleteSkill(name)
        await reload()
      } catch (e) {
        toast.error(t("skillsDeleteFailed"), {
          description: e instanceof Error ? e.message : "error",
        })
      } finally {
        setBusy(null)
      }
    },
    [client, reload],
  )

  /** One-click repository install/update: the agent downloads + verifies +
   *  installs; both tabs refresh so state badges follow immediately. */
  const doMarketInstall = useCallback(
    async (entry: MarketSkillInfo) => {
      setInstallingName(entry.name)
      try {
        const res = await client.installMarketSkill(entry.name)
        toast.success(tf("skillsMarketInstallOk", res.name))
        await Promise.all([reload(), loadMarket()])
      } catch (e) {
        toast.error(tf("skillsMarketInstallFailed", e instanceof Error ? e.message : "error"))
      } finally {
        setInstallingName(null)
      }
    },
    [client, reload, loadMarket],
  )

  // Entries the server marks env-incompatible AND that aren't installed:
  // hidden by default (the install would be refused anyway). Installed ones
  // stay visible so a local install never "disappears" from the list.
  const marketEnvHiddenCount = useMemo(
    () =>
      (market?.skills ?? []).filter((s) => s.env_mismatch && s.installed_version == null).length,
    [market],
  )

  const marketFiltered = useMemo(() => {
    const list = market?.skills ?? []
    const visible = showEnvMismatch
      ? list
      : list.filter((s) => !s.env_mismatch || s.installed_version != null)
    const q = marketQuery.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.tags || []).some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [market, marketQuery, showEnvMismatch])

  // Derive the market detail entry from its name so an install/refresh flows
  // through (state badge flips in place) and a delisted entry closes it.
  const marketDetail = useMemo(
    () => market?.skills.find((s) => s.name === marketDetailName) ?? null,
    [market, marketDetailName],
  )

  useEffect(() => {
    if (!marketDetailName) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMarketDetailName(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [marketDetailName])

  const filtered = useMemo(() => {
    const list = skills ?? []
    let result = list
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (s) => s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q),
      )
    }
    return [...result].sort((a, b) => {
      const cmp =
        sortField === "tools"
          ? a.allowed_tools.length - b.allowed_tools.length
          : a.name.localeCompare(b.name)
      return sortOrder === "asc" ? cmp : -cmp
    })
  }, [skills, searchQuery, sortField, sortOrder])

  // Pinned is cross-cutting (a pinned+disabled skill still shows under Pinned);
  // the rest split into enabled / disabled.
  const pinnedList = useMemo(() => filtered.filter((s) => s.pinned), [filtered])
  const enabledList = useMemo(
    () => filtered.filter((s) => !s.pinned && s.enabled !== false),
    [filtered],
  )
  const disabledList = useMemo(
    () => filtered.filter((s) => !s.pinned && s.enabled === false),
    [filtered],
  )

  const currentNames = useMemo(() => new Set(filtered.map((s) => s.name)), [filtered])
  const allSelected = filtered.length > 0 && filtered.every((s) => selectedNames.has(s.name))
  const someSelected = filtered.some((s) => selectedNames.has(s.name))

  const toggleSelectAll = () => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      if (allSelected) currentNames.forEach((n) => next.delete(n))
      else currentNames.forEach((n) => next.add(n))
      return next
    })
  }

  const toggleSelect = (name: string) => {
    setSelectedNames((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const batchSetEnabled = useCallback(
    async (enabled: boolean) => {
      const names = Array.from(selectedNames).filter((n) => currentNames.has(n))
      if (names.length === 0) return
      setMenuOpen(false)
      await Promise.allSettled(names.map((n) => client.setSkillEnabled(n, enabled)))
      await reload()
    },
    [client, reload, selectedNames, currentNames],
  )

  const batchDelete = useCallback(async () => {
    const selectedInView = (skills ?? []).filter((s) => selectedNames.has(s.name))
    const names = selectedInView.filter((s) => s.deletable).map((s) => s.name)
    // Read-only skills (app-bundled / built-in) can't be deleted; count them so
    // we can tell the user why they weren't removed instead of silently skipping.
    const skipped = selectedInView.length - names.length
    if (names.length === 0) return
    if (!(await confirmDialog(tf("skillsBatchDeleteConfirm", names.length)))) return
    setMenuOpen(false)
    await Promise.allSettled(names.map((n) => client.deleteSkill(n)))
    setSelectedNames((prev) => {
      const next = new Set(prev)
      names.forEach((n) => next.delete(n))
      return next
    })
    if (skipped > 0) toast.success(tf("skillsBatchDeleteResult", names.length, skipped))
    await reload()
  }, [client, reload, skills, selectedNames])

  const deletableSelected = useMemo(
    () => (skills ?? []).some((s) => selectedNames.has(s.name) && s.deletable),
    [skills, selectedNames],
  )
  // Split the selection into deletable vs read-only (app-bundled / built-in) so
  // the batch-delete menu item can show how many will actually be removed and
  // explain why it's greyed out / partial.
  const selectedDeletableCount = useMemo(
    () => (skills ?? []).filter((s) => selectedNames.has(s.name) && s.deletable).length,
    [skills, selectedNames],
  )
  const selectedReadonlyCount = useMemo(
    () => (skills ?? []).filter((s) => selectedNames.has(s.name) && !s.deletable).length,
    [skills, selectedNames],
  )

  // Derive the detail-view skill from its name so pin/enable edits flow through
  // automatically, and a deleted skill (gone from `skills`) closes the modal.
  const detailSkill = useMemo(
    () => (skills ?? []).find((s) => s.name === detailName) ?? null,
    [skills, detailName],
  )

  // Lazy-load the SKILL.md body when the detail view opens.
  // undefined = loading, null = unavailable (endpoint missing / no body).
  const [detailReadme, setDetailReadme] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!detailName) return
    let alive = true
    setDetailReadme(undefined)
    client
      .getSkillReadme(detailName)
      .then((body) => {
        if (alive) setDetailReadme(body.trim() ? body : null)
      })
      .catch(() => {
        if (alive) setDetailReadme(null)
      })
    return () => {
      alive = false
    }
  }, [client, detailName])

  // Lazy-load the installed skill's CHANGELOG.md alongside the readme.
  // undefined = loading, null = none shipped.
  const [detailChangelog, setDetailChangelog] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!detailName) return
    let alive = true
    setDetailChangelog(undefined)
    client
      .getSkillChangelog(detailName)
      .then((body) => {
        if (alive) setDetailChangelog(body && body.trim() ? body : null)
      })
      .catch(() => {
        if (alive) setDetailChangelog(null)
      })
    return () => {
      alive = false
    }
  }, [client, detailName])

  // Lazy-load the repository skill's SKILL.md + CHANGELOG (agent downloads the
  // package) when a market detail view opens. undefined = loading, null = failed.
  const [marketPreview, setMarketPreview] = useState<MarketSkillPreview | null | undefined>(
    undefined,
  )
  useEffect(() => {
    if (!marketDetailName) return
    let alive = true
    setMarketPreview(undefined)
    client
      .getMarketSkillPreview(marketDetailName)
      .then((p) => {
        if (alive) setMarketPreview(p)
      })
      .catch(() => {
        if (alive) setMarketPreview(null)
      })
    return () => {
      alive = false
    }
  }, [client, marketDetailName])

  useEffect(() => {
    if (!detailName) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailName(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [detailName])

  const renderCard = (s: SkillInfo) => (
    <SkillCard
      key={s.name}
      skill={s}
      selected={selectedNames.has(s.name)}
      isBusy={busy === s.name}
      iconUrl={client.skillIconUrl(s.name)}
      onOpen={() => setDetailName(s.name)}
      onToggleSelect={() => toggleSelect(s.name)}
      onTogglePin={() => void togglePin(s)}
      onToggleEnabled={() => void toggleEnabled(s)}
      onExport={() => triggerDownload(client.skillExportUrl(s.name))}
      onDelete={() => void doDelete(s.name)}
    />
  )

  const renderSection = (
    label: string,
    dotClass: string,
    list: SkillInfo[],
    hideTitle = false,
  ) => {
    if (list.length === 0) return null
    return (
      <div className="space-y-2">
        {!hideTitle && (
          <div className="flex items-center gap-2">
            <div className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
            <h3 className="text-xs font-medium text-muted-foreground">
              {label}
              <span className="ml-1.5 tabular-nums text-muted-foreground/60">{list.length}</span>
            </h3>
          </div>
        )}
        <div className={GRID_CLASS}>{list.map(renderCard)}</div>
      </div>
    )
  }

  const renderBody = () => {
    if (unavailable) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("skillsUnavailable")}
        </div>
      )
    }
    if (skills === null) {
      return (
        <div className={GRID_CLASS}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[70px] animate-pulse rounded-[6px] border border-border bg-card" />
          ))}
        </div>
      )
    }
    if (skills.length === 0) {
      return (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          <Upload className="h-5 w-5" />
          {t("skillsEmpty")}
        </button>
      )
    }
    if (filtered.length === 0) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("skillsNoMatch")}
        </div>
      )
    }
    // With no pinned and no disabled skills there is only one group left; a
    // lone "Enabled" heading over everything reads odd, so drop it.
    const enabledOnly = pinnedList.length === 0 && disabledList.length === 0
    return (
      <div className="space-y-5">
        {renderSection(t("pinnedLabel"), "bg-primary", pinnedList)}
        {renderSection(t("skillsEnabled"), "bg-emerald-500", enabledList, enabledOnly)}
        {renderSection(t("skillsDisabled"), "bg-muted-foreground", disabledList)}
      </div>
    )
  }

  const renderMarketBody = () => {
    if (market === undefined) {
      return (
        <div className={GRID_CLASS}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-[6px] border border-border bg-card" />
          ))}
        </div>
      )
    }
    if (marketErr) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          {/* Keep the raw error reachable (hover) without dumping a stack-trace
              string onto the page. */}
          <span title={marketErr ?? undefined}>{t("skillsMarketError")}</span>
          <button
            type="button"
            onClick={() => void loadMarket()}
            className="mt-1 flex h-6 cursor-pointer items-center gap-1 rounded-[4px] border border-border px-2 text-xs text-foreground/80 transition-colors hover:bg-muted"
          >
            <RefreshCw size={11} className={marketRefreshing ? "animate-spin" : ""} />
            {t("skillsRefresh")}
          </button>
        </div>
      )
    }
    if (!market || market.skills.length === 0) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("skillsMarketEmpty")}
        </div>
      )
    }
    // "No match" only when a search is active; with an empty query an empty
    // result means everything visible was env-hidden, which the footer row
    // below explains (and can expand).
    if (marketFiltered.length === 0 && marketQuery.trim()) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("skillsNoMatch")}
        </div>
      )
    }
    return (
      <div className="space-y-3">
        {marketFiltered.length > 0 && (
          <div className={GRID_CLASS}>
            {marketFiltered.map((entry) => (
              <MarketCard
                key={entry.name}
                entry={entry}
                iconUrl={marketIconUrl(market.repo, entry.icon)}
                installing={installingName === entry.name}
                onInstall={() => void doMarketInstall(entry)}
                onOpen={() => setMarketDetailName(entry.name)}
              />
            ))}
          </div>
        )}
        {marketEnvHiddenCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <span>
              {showEnvMismatch
                ? tf("skillsMarketEnvShown", marketEnvHiddenCount)
                : tf("skillsMarketEnvHidden", marketEnvHiddenCount)}
            </span>
            <button
              type="button"
              onClick={() => setShowEnvMismatch((v) => !v)}
              className="cursor-pointer text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {showEnvMismatch ? t("skillsMarketEnvHide") : t("skillsMarketEnvShow")}
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderMarketDetailPanel = (mobile: boolean) =>
    marketDetail && (
      <MarketDetailPanel
        entry={marketDetail}
        iconUrl={market ? marketIconUrl(market.repo, marketDetail.icon) : null}
        installing={installingName === marketDetail.name}
        preview={marketPreview}
        mobile={mobile}
        onClose={() => setMarketDetailName(null)}
        onInstall={() => void doMarketInstall(marketDetail)}
      />
    )

  // Installed / repository switch: quiet pill buttons leading the filter bar
  // (only when a repository is configured), ending in a hairline divider so
  // the view switch reads as the first-level filter of everything after it.
  const tabSwitcher = market !== null && market !== undefined && (
    <div className="flex shrink-0 items-center gap-1">
      {(
        [
          { id: "installed", label: "skillsTabInstalled" },
          { id: "market", label: "skillsTabMarket" },
        ] as const
      ).map((tb) => (
        <button
          key={tb.id}
          type="button"
          onClick={() => setTab(tb.id)}
          className={cn(
            "flex cursor-pointer items-center rounded-[4px] px-2.5 py-1 text-xs transition-colors",
            tab === tb.id
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {t(tb.label)}
          {/* Quiet nudge toward the repository while on the installed tab. */}
          {tb.id === "market" && tab === "installed" && (
            <span className="animate-attention-pulse ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          )}
        </button>
      ))}
      <div className="mx-1 h-4 w-px shrink-0 bg-border" />
    </div>
  )

  const renderDetailPanel = (mobile: boolean) =>
    detailSkill && (
      <SkillDetailPanel
        skill={detailSkill}
        iconUrl={client.skillIconUrl(detailSkill.name)}
        exportUrl={client.skillExportUrl(detailSkill.name)}
        busy={busy === detailSkill.name}
        readme={detailReadme}
        changelog={detailChangelog}
        toolDescs={toolDescs}
        mobile={mobile}
        onClose={() => setDetailName(null)}
        onTogglePin={() => void togglePin(detailSkill)}
        onToggleEnabled={() => void toggleEnabled(detailSkill)}
        onToggleShared={() => void toggleShared(detailSkill)}
        onDelete={() => void doDelete(detailSkill.name)}
      />
    )

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false)
      }}
      onDrop={onDrop}
    >
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-sm font-medium text-foreground">{t("skillsPageTitle")}</h1>
        </div>
      </div>

      {/* Filter bar / toolbar */}
      {tab === "market" ? (
        <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-border bg-card px-5">
          {tabSwitcher}
          <span className="shrink-0 text-xs text-muted-foreground">
            {tf("skillsCountLabel", marketFiltered.length)}
          </span>
          <div className="relative shrink-0">
            <Search
              size={12}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={marketQuery}
              onChange={(e) => setMarketQuery(e.target.value)}
              placeholder={t("searchSkills")}
              className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
            />
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void loadMarket()}
            disabled={marketRefreshing}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t("skillsRefresh")}
          >
            <RefreshCw size={12} className={marketRefreshing ? "animate-spin" : ""} />
          </button>
        </div>
      ) : (
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-border bg-card px-5">
        {tabSwitcher}
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected
            }}
            onChange={toggleSelectAll}
            disabled={!skills || skills.length === 0}
            className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white disabled:cursor-not-allowed disabled:opacity-40"
          />
          {selectedNames.size > 0 ? (
            <span className="shrink-0 text-xs font-medium text-primary">
              {tf("selectedCount", selectedNames.size)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {tf("skillsCountLabel", filtered.length)}
            </span>
          )}
        </div>

        <div className="relative shrink-0">
          <Search
            size={12}
            className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchSkills")}
            className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
          />
        </div>

        <div className="relative shrink-0 rounded">
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className="h-6 cursor-pointer appearance-none border-none bg-transparent pl-2 pr-5 text-xs font-medium text-foreground/80 hover:text-foreground focus:outline-none"
          >
            <option value="name">{t("skillsSortByName")}</option>
            <option value="tools">{t("skillsSortByTools")}</option>
          </select>
          <ChevronDown
            size={10}
            className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>

        <button
          type="button"
          onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={sortOrder === "desc" ? t("sortDesc") : t("sortAsc")}
        >
          {sortOrder === "desc" ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
        </button>

        <div className="flex-1" />

        <div ref={installRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setInstallOpen((v) => !v)}
            disabled={importing || unavailable}
            className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t("skillsInstall")}
          >
            {importing ? (
              <Spinner size="sm" className="h-3 w-3" />
            ) : (
              <Plus size={13} strokeWidth={2.5} />
            )}
            {t("skillsInstall")}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={onPickFile}
        />
        {installOpen &&
          createPortal(
            <InstallPopover
              anchorRef={installRef}
              installing={importing}
              fromFileLabel={t("skillsInstallFromFile")}
              fromUrlLabel={t("skillsInstallFromUrl")}
              urlPlaceholder={t("skillsInstallUrlPlaceholder")}
              installLabel={t("skillsInstall")}
              onClose={() => setInstallOpen(false)}
              onInstallUrl={(u) => void doInstallUrl(u)}
              onPickFile={() => {
                setInstallOpen(false)
                fileRef.current?.click()
              }}
            />,
            portalContainer(),
          )}

        <button
          type="button"
          onClick={() => void reload()}
          disabled={refreshing}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title={t("skillsRefresh")}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
        </button>

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={selectedNames.size === 0}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title={t("skillsBatchMenu")}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>
      )}

      {menuOpen &&
        createPortal(
          <DropdownMenu menuRef={menuRef} onClose={closeMenu}>
            <button
              type="button"
              onClick={() => void batchSetEnabled(true)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              <Zap size={12} />
              {t("skillsBatchEnable")}
            </button>
            <button
              type="button"
              onClick={() => void batchSetEnabled(false)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              <ZapOff size={12} />
              {t("skillsBatchDisable")}
            </button>
            <button
              type="button"
              onClick={() => void batchDelete()}
              disabled={!deletableSelected}
              title={
                !deletableSelected
                  ? t("skillsBatchDeleteDisabledHint")
                  : selectedReadonlyCount > 0
                    ? tf(
                        "skillsBatchDeletePartialHint",
                        selectedDeletableCount,
                        selectedReadonlyCount,
                      )
                    : undefined
              }
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={12} />
              {t("skillsBatchDelete")}
              {deletableSelected && selectedReadonlyCount > 0 && (
                <span className="tabular-nums opacity-70">({selectedDeletableCount})</span>
              )}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {/* Main area: master-detail split */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto bg-background">
        <div className="space-y-5 px-4 pb-4 pt-3">
          {tab === "market" ? renderMarketBody() : renderBody()}

          {/* Diagnostics */}
          {tab === "installed" && diags.length > 0 && (
            <div className="border-t border-border/40 pt-4">
              <div className="mb-1.5 text-xs text-foreground/70">{tf("skillsDiagnostics", diags.length)}</div>
              <ul className="space-y-1 rounded-[4px] border border-border/50 bg-muted/10 p-1.5">
                {diags.map((d, i) => (
                  <li key={`${d.kind}-${i}`} className="flex items-start gap-1.5 rounded-[4px] px-1.5 py-1">
                    <AlertTriangle className={cn("mt-0.5 h-3 w-3 shrink-0", diagColor(d.kind))} />
                    <div className="min-w-0 flex-1">
                      <span className={cn("font-mono text-[10px] uppercase", diagColor(d.kind))}>{d.kind}</span>
                      <p className="text-[11px] text-foreground/80">{d.message}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground/60" title={d.path}>
                        {d.path}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Desktop: right column, resizable via the left-edge handle */}
      {tab === "installed" && detailSkill && (
        <div
          className="relative hidden shrink-0 border-l border-border lg:flex"
          style={{ width: panelWidth }}
        >
          <div
            onPointerDown={startPanelResize}
            title={t("skillsResizeHandle")}
            className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
          />
          {renderDetailPanel(false)}
        </div>
      )}
      {tab === "market" && marketDetail && (
        <div
          className="relative hidden shrink-0 border-l border-border lg:flex"
          style={{ width: panelWidth }}
        >
          <div
            onPointerDown={startPanelResize}
            title={t("skillsResizeHandle")}
            className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
          />
          {renderMarketDetailPanel(false)}
        </div>
      )}
      </div>

      {/* Mobile: full-screen takeover (back arrow to return; no backdrop) */}
      {tab === "installed" && detailSkill && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-2xl lg:hidden">
          {renderDetailPanel(true)}
        </div>
      )}
      {tab === "market" && marketDetail && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-2xl lg:hidden">
          {renderMarketDetailPanel(true)}
        </div>
      )}

      {/* Drag overlay */}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary/50 px-10 py-8 text-sm text-primary">
            <Upload className="h-6 w-6" />
            {t("skillsImportDropActive")}
          </div>
        </div>
      )}
    </div>
  )
}
