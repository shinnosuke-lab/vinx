import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  Box,
  Terminal,
  ExternalLink,
  MessageSquare,
  Play,
  Square,
  Trash2,
  Plus,
  RefreshCw,
  Check,
  AlertTriangle,
  TriangleAlert,
  Search,
  ChevronDown,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  MoreHorizontal,
  X,
  ArrowLeft,
  Info,
  FileText,
  Package,
  Zap,
  Upload,
  type LucideIcon,
} from "lucide-react"
import { createPortal } from "react-dom"
import { createChatClient, type ReleaseRecord } from "@agentchat/client"
import type { AppsMarket, MarketAppInfo } from "@agentchat/types"
import { t, tf } from "@agentchat/lib/i18n"
import { cn, portalContainer } from "@agentchat/lib/utils"
import { toast } from "@agentchat/components/ui/toast"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { Spinner } from "@agentchat/components/shared/spinner"
import {
  DetailCard,
  DefRow,
  Pill,
  ActionRow,
} from "@agentchat/components/shared/detail-card"
import { InstallPopover } from "@agentchat/components/shared/install-popover"
import { relativeTime, statusDotClass, formatBytes } from "@agentchat/lib/releases"

/**
 * Apps ("扩展") page, structured to match the skills page: an `h-14` header, an
 * `h-10` toolbar (tab pills + select-all/count + inline search + sort + refresh
 * + batch menu), a fixed-width card grid split into dot-headed sections
 * (built-in tools / running / stopped), and a master-detail right panel that
 * mirrors `SkillDetailPanel` / `MarketDetailPanel`. Two tabs: installed apps
 * (`kind=app` releases: systemd services with live state) and the online apps
 * repository (Apps Hub) when one is configured.
 */

type SortField = "name" | "status"
type SortOrder = "asc" | "desc"
type InstalledPanelTab = "overview" | "actions"
type MarketPanelTab = "overview" | "package"

// One card width for both tabs, so switching installed <-> market never reflows.
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,220px)] gap-4"

// Desktop detail-panel width: drag range + the localStorage key remembering it.
const PANEL_MIN = 380
const PANEL_MAX = 780
const PANEL_DEFAULT = 480
const PANEL_WIDTH_KEY = "acc.appPanelWidth"

/** Icon URL for a repository app: absolute URLs pass through, relative ones
 *  resolve against the repo base (mirrors the skills market). */
function marketIconUrl(repo: string, icon?: string | null): string | null {
  if (!icon) return null
  if (/^https?:\/\//i.test(icon)) return icon
  return `${repo.replace(/\/+$/, "")}/${icon.replace(/^\/+/, "")}`
}

/** The app's own web page URL from its declared port + current hostname (the
 *  kernel doesn't know its public address). */
function appPageUrl(port?: number | null): string | undefined {
  if (!port || typeof window === "undefined") return undefined
  return `${window.location.protocol}//${window.location.hostname}:${port}/`
}

/** Human status label for the given systemd `is-active` value. */
function statusLabel(status?: string): string {
  switch (status) {
    case "active":
      return t("appsStatusActive")
    case "failed":
      return t("appsStatusFailed")
    case "inactive":
      return t("appsStatusInactive")
    default:
      return t("appsStatusUnknown")
  }
}

/** Sort rank for "status" ordering: running first, then failed, stopped, unknown. */
function statusRank(status?: string): number {
  switch (status) {
    case "active":
      return 0
    case "failed":
      return 1
    case "inactive":
      return 2
    default:
      return 3
  }
}

/** Small muted meta chip for the card footer (runtime / one-shot / port). */
function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-muted/60 px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

interface BuiltinApp {
  icon: LucideIcon | ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  iconClassName?: string
  title: string
  description: string
  href: string
}

/** Built-in tool card: a plain external link (no backing release record, so no
 *  detail panel / selection). Restyled to match the grid's other cards. */
function AppCard({ icon: Icon, iconClassName, title, description, href }: BuiltinApp) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
      className="group relative flex min-w-0 cursor-pointer overflow-hidden rounded-[6px] border border-border bg-card no-underline transition-colors hover:border-primary/30"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-3 py-3.5">
        <div className="flex items-center gap-2">
          <Icon
            size={14}
            strokeWidth={1.75}
            className={cn("shrink-0", iconClassName ?? "text-muted-foreground")}
          />
          <h3
            className="flex-1 truncate text-[11px] font-medium leading-snug text-foreground"
            title={title}
          >
            {title}
          </h3>
          <ExternalLink
            size={11}
            className="shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/70"
          />
        </div>
        <p
          className="line-clamp-1 text-[11px] leading-snug text-muted-foreground"
          title={description}
        >
          {description}
        </p>
      </div>
    </a>
  )
}

/** Portal-anchored dropdown for `...` menus, mirrors the skills page. */
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

/** One installed app card, mirroring `SkillCard`: checkbox + name + inline
 *  start/stop toggle + `...` menu (open page / open conversation / uninstall);
 *  footer meta = status dot + version + runtime/one-shot/port chips + time. The
 *  whole card opens the detail panel; inline actions stop propagation. */
function InstalledAppCard({
  release,
  selected,
  busy,
  onOpen,
  onToggleSelect,
  onStart,
  onStop,
  onOpenSession,
  onDelete,
}: {
  release: ReleaseRecord
  selected: boolean
  busy: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onStart: () => void
  onStop: () => void
  onOpenSession?: (id: string) => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const active = release.status === "active"
  const pageUrl = appPageUrl(release.port)
  return (
    <div
      onClick={onOpen}
      className={cn(
        "group relative flex min-w-0 w-full cursor-pointer overflow-hidden rounded-[6px] border bg-card transition-colors",
        selected ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30",
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
            title={release.name}
          >
            {release.name}
          </h3>
          <div className="flex shrink-0 items-center justify-end gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (active) onStop()
                else onStart()
              }}
              disabled={busy}
              title={active ? t("appStop") : t("appStart")}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-colors disabled:opacity-50",
                active
                  ? "text-emerald-500 hover:bg-amber-500/10 hover:text-amber-500"
                  : "text-muted-foreground/40 hover:bg-emerald-500/10 hover:text-emerald-500",
              )}
            >
              {busy ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : active ? (
                <Square size={11} />
              ) : (
                <Play size={11} />
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
                    {pageUrl && (
                      <a
                        href={pageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen(false)
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 no-underline transition-colors hover:bg-muted"
                      >
                        <ExternalLink size={12} />
                        {t("appOpenPage")}
                      </a>
                    )}
                    {release.session_id && onOpenSession && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpen(false)
                          onOpenSession(release.session_id!)
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
                      >
                        <MessageSquare size={12} />
                        {t("appsOpenSessionAction")}
                      </button>
                    )}
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
                      {t("appRemove")}
                    </button>
                  </DropdownMenu>,
                  portalContainer(),
                )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground/70">
          <span className="flex shrink-0 items-center gap-1">
            <span
              title={statusLabel(release.status)}
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass(release.status))}
            />
            {release.version ? <span className="tabular-nums">v{release.version}</span> : null}
          </span>
          {release.runtime && <MetaChip>{release.runtime}</MetaChip>}
          {release.oneshot && <MetaChip>{t("appOneshot")}</MetaChip>}
          {release.port ? <MetaChip>:{release.port}</MetaChip> : null}
          {release.created_at && (
            <span className="ml-auto shrink-0 tabular-nums">{relativeTime(release.created_at)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** One repository app card, mirroring the skills `MarketCard`: icon + name +
 *  one corner icon action (install / update-with-dot / inert check / blocked),
 *  then a one-line description. The whole card opens the detail panel. */
function MarketAppCard({
  entry,
  iconUrl,
  installing,
  onInstall,
  onOpen,
}: {
  entry: MarketAppInfo
  iconUrl: string | null
  installing: boolean
  onInstall: () => void
  onOpen: () => void
}) {
  const installed = entry.installed_version != null
  const update = !!entry.update_available
  const foreign = !!entry.foreign
  const envBlocked = !!entry.env_mismatch
  const actionable = !foreign && !envBlocked && (!installed || update)
  return (
    <div
      onClick={onOpen}
      className="group relative flex min-w-0 w-full cursor-pointer overflow-hidden rounded-[6px] border border-border bg-card transition-colors hover:border-primary/30"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-3 py-3.5">
        <div className="flex items-center gap-2">
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
          ) : (
            <Box className="h-5 w-5 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
          )}
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
                title={update ? t("appsHubUpdate") : t("appsHubInstall")}
                className="relative flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                {installing ? (
                  <Spinner size="sm" className="h-3 w-3" />
                ) : update ? (
                  <RefreshCw size={11} />
                ) : (
                  <Plus size={13} strokeWidth={2.5} />
                )}
                {update && !installing && (
                  <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </button>
            ) : (foreign || envBlocked) && !installed ? (
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/40"
                title={
                  foreign
                    ? t("appsHubForeign")
                    : tf("appsHubEnvMismatchHint", (entry.env ?? []).join(", "))
                }
              >
                <AlertTriangle size={11} />
              </span>
            ) : (
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500"
                title={t("appsHubInstalledBadge")}
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

/** Installed-app detail panel (desktop right column / mobile full-screen),
 *  mirroring `SkillDetailPanel`'s shell. Tabs: overview (info + description),
 *  actions (start/stop/open/uninstall). */
function InstalledAppDetailPanel({
  release,
  busy,
  mobile,
  onClose,
  onStart,
  onStop,
  onOpenSession,
  onDelete,
}: {
  release: ReleaseRecord
  busy: boolean
  mobile: boolean
  onClose: () => void
  onStart: () => void
  onStop: () => void
  onOpenSession?: (id: string) => void
  onDelete: () => void
}) {
  const [tab, setTab] = useState<InstalledPanelTab>("overview")
  const active = release.status === "active"
  const failed = release.status === "failed"
  const pageUrl = appPageUrl(release.port)
  const sessionLabel = release.session_id
    ? release.session_title || `${release.session_id.slice(0, 8)}…`
    : t("releaseUnattributed")
  return (
    <div className="flex h-full w-full flex-col bg-card">
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
          <Box className="h-6 w-6 shrink-0 text-primary" strokeWidth={1.5} />
          <span className="truncate text-sm font-medium text-foreground" title={release.name}>
            {release.name}
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

      <div role="tablist" className="flex h-10 shrink-0 items-end gap-6 border-b border-border px-4">
        {(
          [
            ["overview", t("skillsTabOverview")],
            ["actions", t("skillsTabActions")],
          ] as [InstalledPanelTab, string][]
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-5 py-5">
          {tab === "overview" && (
            <>
              <DetailCard icon={Info} title={t("skillsInfoTitle")} defaultOpen>
                <DefRow label={t("skillsMarketVersionLabel")}>
                  <span className="tabular-nums">{release.version ? `v${release.version}` : "—"}</span>
                </DefRow>
                <DefRow label={t("skillsStatusLabel")}>
                  <Pill
                    tone={active ? "success" : "muted"}
                    className={failed ? "border-red-500/20 bg-red-500/10 text-red-600" : undefined}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass(release.status))} />
                    {statusLabel(release.status)}
                  </Pill>
                </DefRow>
                {release.runtime && (
                  <DefRow label={t("appsRuntimeLabel")}>{release.runtime}</DefRow>
                )}
                {release.enabled && (
                  <DefRow label={t("appsAutostartLabel")}>
                    {release.enabled === "enabled" ? t("appsYes") : t("appsNo")}
                  </DefRow>
                )}
                <DefRow label={t("appsOneshotLabel")}>
                  {release.oneshot ? t("appsYes") : t("appsNo")}
                </DefRow>
                {release.port ? (
                  <DefRow label={t("appsPortLabel")}>
                    {pageUrl ? (
                      <a
                        href={pageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        :{release.port}
                      </a>
                    ) : (
                      <span className="tabular-nums">:{release.port}</span>
                    )}
                  </DefRow>
                ) : null}
                {release.size ? (
                  <DefRow label={t("skillsMarketSizeLabel")}>
                    <span className="tabular-nums">{formatBytes(release.size)}</span>
                  </DefRow>
                ) : null}
                {release.created_at && (
                  <DefRow label={t("appsCreatedLabel")}>{relativeTime(release.created_at)}</DefRow>
                )}
                <DefRow label={t("releaseFromSession")}>
                  {release.session_id && onOpenSession ? (
                    <button
                      type="button"
                      onClick={() => onOpenSession(release.session_id!)}
                      className="inline-flex min-w-0 items-center gap-1 truncate text-primary transition-colors hover:underline"
                    >
                      <MessageSquare className="h-3 w-3 shrink-0" />
                      <span className="truncate">{sessionLabel}</span>
                    </button>
                  ) : (
                    <span className="text-muted-foreground/70">{sessionLabel}</span>
                  )}
                </DefRow>
              </DetailCard>

              {release.description && (
                <DetailCard icon={FileText} title={t("skillsDescription")} defaultOpen>
                  <p className="leading-relaxed text-foreground/80">{release.description}</p>
                </DetailCard>
              )}
            </>
          )}

          {tab === "actions" && (
            <>
              <DetailCard icon={Zap} title={t("skillsCommonActions")} defaultOpen>
                {active ? (
                  <ActionRow
                    icon={Square}
                    title={t("appStop")}
                    hint={t("appsStopHint")}
                    busy={busy}
                    disabled={busy}
                    onClick={onStop}
                  />
                ) : (
                  <ActionRow
                    icon={Play}
                    title={t("appStart")}
                    hint={t("appsStartHint")}
                    busy={busy}
                    disabled={busy}
                    onClick={onStart}
                  />
                )}
                {pageUrl && (
                  <ActionRow
                    icon={ExternalLink}
                    title={t("appOpenPage")}
                    hint={t("appsOpenPageHint")}
                    href={pageUrl}
                    external
                  />
                )}
                {release.session_id && onOpenSession && (
                  <ActionRow
                    icon={MessageSquare}
                    title={t("appsOpenSessionAction")}
                    hint={t("appsOpenSessionHint")}
                    onClick={() => onOpenSession(release.session_id!)}
                  />
                )}
              </DetailCard>

              <DetailCard icon={TriangleAlert} title={t("skillsDangerZone")} defaultOpen>
                <ActionRow
                  icon={Trash2}
                  title={t("appRemove")}
                  hint={t("appsRemoveHint")}
                  destructive
                  disabled={busy}
                  onClick={onDelete}
                />
              </DetailCard>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Market app detail panel, mirroring `MarketDetailPanel`'s shell. Tabs:
 *  overview (action + info + description), package (integrity / meta). */
function MarketAppDetailPanel({
  entry,
  iconUrl,
  installing,
  mobile,
  onClose,
  onInstall,
}: {
  entry: MarketAppInfo
  iconUrl: string | null
  installing: boolean
  mobile: boolean
  onClose: () => void
  onInstall: () => void
}) {
  const [tab, setTab] = useState<MarketPanelTab>("overview")
  const installed = entry.installed_version != null
  const update = !!entry.update_available
  const foreign = !!entry.foreign
  const envBlocked = !!entry.env_mismatch
  const actionable = !foreign && !envBlocked && (!installed || update)
  return (
    <div className="flex h-full w-full flex-col bg-card">
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
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
          ) : (
            <Box className="h-6 w-6 shrink-0 text-primary" strokeWidth={1.5} />
          )}
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

      <div role="tablist" className="flex h-10 shrink-0 items-end gap-6 border-b border-border px-4">
        {(
          [
            ["overview", t("skillsTabOverview")],
            ["package", t("skillsMarketPackage")],
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-5 py-5">
          {tab === "overview" && (
            <>
              <DetailCard icon={Zap} title={t("skillsCommonActions")} defaultOpen>
                {actionable ? (
                  <ActionRow
                    icon={update ? RefreshCw : Plus}
                    title={
                      update
                        ? tf("appsHubUpdateTo", entry.version ? `v${entry.version}` : "")
                        : t("appsHubInstall")
                    }
                    hint={update ? t("appsHubUpdateHint") : t("appsHubInstallHint")}
                    busy={installing}
                    disabled={installing}
                    onClick={onInstall}
                  />
                ) : foreign ? (
                  <ActionRow
                    icon={TriangleAlert}
                    title={t("appsHubForeign")}
                    hint={t("appsHubForeignHint")}
                    disabled
                  />
                ) : envBlocked && !installed ? (
                  <ActionRow
                    icon={TriangleAlert}
                    title={t("appsHubEnvMismatch")}
                    hint={tf("appsHubEnvMismatchHint", (entry.env ?? []).join(", "))}
                    disabled
                  />
                ) : (
                  <ActionRow
                    icon={Check}
                    title={t("appsHubUpToDate")}
                    hint={t("appsHubUpToDateHint")}
                    disabled
                  />
                )}
              </DetailCard>

              <DetailCard icon={Info} title={t("skillsInfoTitle")} defaultOpen>
                <DefRow label={t("skillsMarketVersionLabel")}>
                  <span className="tabular-nums">{entry.version ? `v${entry.version}` : "—"}</span>
                </DefRow>
                {installed && (
                  <DefRow label={t("appsInstalledVersionLabel")}>
                    <span className="tabular-nums">v{entry.installed_version}</span>
                  </DefRow>
                )}
                {entry.env && entry.env.length > 0 && (
                  <DefRow label={t("skillsMarketEnvLabel")}>{entry.env.join(", ")}</DefRow>
                )}
                <DefRow label={t("skillsStatusLabel")}>
                  {installed ? (
                    update ? (
                      <Pill tone="muted">{t("appsHubUpdate")}</Pill>
                    ) : (
                      <Pill tone="muted">
                        <Check size={10} />
                        {t("appsHubInstalledBadge")}
                      </Pill>
                    )
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
            </>
          )}

          {tab === "package" && (
            <DetailCard icon={Package} title={t("skillsMarketPackage")} defaultOpen>
              <DefRow label={t("skillsMarketVersionLabel")}>
                <span className="tabular-nums">{entry.version || "—"}</span>
              </DefRow>
              <DefRow label={t("skillsMarketSizeLabel")}>
                <span className="tabular-nums">{entry.size ? formatBytes(entry.size) : "—"}</span>
              </DefRow>
              <DefRow label={t("appsOneshotLabel")}>
                {entry.oneshot ? t("appsYes") : t("appsNo")}
              </DefRow>
              {entry.port != null && (
                <DefRow label={t("appsPortLabel")}>
                  <span className="tabular-nums">:{entry.port}</span>
                </DefRow>
              )}
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
          )}
        </div>
      </div>
    </div>
  )
}

interface AppsPageProps {
  basePath?: string
  /** Open a conversation in the chat view (provenance link on app cards). */
  onOpenSession?: (id: string) => void
}

export function AppsPage({ basePath = "", onOpenSession }: AppsPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  const [apps, setApps] = useState<ReleaseRecord[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // app name currently mutating

  const [tab, setTab] = useState<"installed" | "market">("installed")
  // undefined = loading; null = no repo configured (hide the tab).
  const [market, setMarket] = useState<AppsMarket | null | undefined>(undefined)
  const [marketErr, setMarketErr] = useState<string | null>(null)
  const [marketRefreshing, setMarketRefreshing] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState("")
  const [marketQuery, setMarketQuery] = useState("")
  const [sortField, setSortField] = useState<SortField>("name")
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc")
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Local install (upload / URL): mirrors the skills page toolbar.
  const [importing, setImporting] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const installRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [detailName, setDetailName] = useState<string | null>(null)
  const [marketDetailName, setMarketDetailName] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    client
      .listReleases({ kind: "app" })
      .then(setApps)
      .catch(() => setApps([]))
      .finally(() => setRefreshing(false))
  }, [client])

  const loadMarket = useCallback(async () => {
    setMarketRefreshing(true)
    setMarketErr(null)
    try {
      setMarket(await client.getAppsMarket())
    } catch (e) {
      setMarketErr(e instanceof Error ? e.message : String(e))
      // Repo configured but unreachable: keep the tab visible with an error
      // state (only a 404 = unconfigured hides it).
      setMarket((prev) => (prev === undefined ? { repo: "", generated_at: null, apps: [] } : prev))
    } finally {
      setMarketRefreshing(false)
    }
  }, [client])

  useEffect(() => {
    refresh()
    void loadMarket()
  }, [refresh, loadMarket])

  // Reset the selection whenever the visible installed set changes via search.
  useEffect(() => {
    setSelectedNames(new Set())
  }, [searchQuery])

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

  const fail = useCallback(
    (e: unknown) => {
      toast.error(e instanceof Error ? e.message : String(e))
      refresh()
    },
    [refresh],
  )

  const handleStart = useCallback(
    (r: ReleaseRecord) => {
      setBusy(r.name)
      client
        .startApp(r.name)
        .then(refresh)
        .catch(fail)
        .finally(() => setBusy(null))
    },
    [client, refresh, fail],
  )

  const handleStop = useCallback(
    (r: ReleaseRecord) => {
      setBusy(r.name)
      client
        .stopApp(r.name)
        .then(refresh)
        .catch(fail)
        .finally(() => setBusy(null))
    },
    [client, refresh, fail],
  )

  const handleDelete = useCallback(
    async (r: ReleaseRecord) => {
      if (!(await confirmDialog(tf("appRemoveConfirm", r.name)))) return
      setBusy(r.name)
      try {
        await client.deleteRelease(r.kind, r.name)
        refresh()
        await loadMarket()
      } catch (e) {
        fail(e)
      } finally {
        setBusy(null)
      }
    },
    [client, refresh, loadMarket, fail],
  )

  const handleInstall = useCallback(
    async (entry: MarketAppInfo) => {
      const isUpdate = !!entry.update_available
      const prompt = isUpdate
        ? tf("appsHubUpdateConfirm", entry.name)
        : tf("appsHubInstallConfirm", entry.name)
      if (!(await confirmDialog(prompt))) return
      setInstalling(entry.name)
      try {
        await client.installMarketApp(entry.name)
        toast.success(tf(isUpdate ? "appsHubUpdateOk" : "appsHubInstallOk", entry.name))
        refresh()
        await loadMarket()
      } catch (e) {
        toast.error(tf("appsHubInstallFailed", e instanceof Error ? e.message : String(e)))
      } finally {
        setInstalling(null)
      }
    },
    [client, refresh, loadMarket],
  )

  // Install an app from a local tarball. Heavier than a skill zip (it starts a
  // systemd service), so confirm first (showing the file name).
  const doImport = useCallback(
    async (file: File) => {
      if (!(await confirmDialog(tf("appsInstallConfirm", file.name)))) return
      setImporting(true)
      try {
        const res = await client.importApp(file)
        toast.success(tf(res.upgraded ? "appsHubUpdateOk" : "appsHubInstallOk", res.name || file.name))
        refresh()
        await loadMarket()
      } catch (e) {
        toast.error(tf("appsHubInstallFailed", e instanceof Error ? e.message : String(e)))
      } finally {
        setImporting(false)
      }
    },
    [client, refresh, loadMarket],
  )

  const doInstallUrl = useCallback(
    async (rawUrl: string) => {
      const u = rawUrl.trim()
      if (!/^https?:\/\//i.test(u)) {
        toast.error(t("appsInstallUrlInvalid"))
        return
      }
      if (!(await confirmDialog(tf("appsInstallConfirm", u)))) return
      setImporting(true)
      try {
        const res = await client.installAppUrl(u)
        toast.success(tf(res.upgraded ? "appsHubUpdateOk" : "appsHubInstallOk", res.name || u))
        setInstallOpen(false)
        refresh()
        await loadMarket()
      } catch (e) {
        toast.error(tf("appsHubInstallFailed", e instanceof Error ? e.message : String(e)))
      } finally {
        setImporting(false)
      }
    },
    [client, refresh, loadMarket],
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

  const hasMarket = market != null
  const showMarket = hasMarket && tab === "market"

  const marketFiltered = useMemo(() => {
    const list = market?.apps ?? []
    const q = marketQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q) ||
        (a.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [market, marketQuery])

  const installedFiltered = useMemo(() => {
    const list = apps ?? []
    let result = list
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q),
      )
    }
    return [...result].sort((a, b) => {
      const cmp =
        sortField === "status"
          ? statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name)
      return sortOrder === "asc" ? cmp : -cmp
    })
  }, [apps, searchQuery, sortField, sortOrder])

  const runningList = useMemo(
    () => installedFiltered.filter((a) => a.status === "active"),
    [installedFiltered],
  )
  const stoppedList = useMemo(
    () => installedFiltered.filter((a) => a.status !== "active"),
    [installedFiltered],
  )

  const builtins = useMemo<BuiltinApp[]>(
    () => [
      {
        icon: Terminal,
        iconClassName: "text-[#3b82f6]",
        title: t("appsSshTitle"),
        description: t("appsSshDesc"),
        href: `${basePath}/terminal/`,
      },
    ],
    [basePath],
  )

  const currentNames = useMemo(
    () => new Set(installedFiltered.map((a) => a.name)),
    [installedFiltered],
  )
  const allSelected =
    installedFiltered.length > 0 && installedFiltered.every((a) => selectedNames.has(a.name))
  const someSelected = installedFiltered.some((a) => selectedNames.has(a.name))

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

  // Batch targets, restricted to the selected + currently-visible apps. Start/
  // stop skip one-shot tasks (starting one re-runs the task — not idempotent).
  const selectedApps = useMemo(
    () => (apps ?? []).filter((a) => selectedNames.has(a.name) && currentNames.has(a.name)),
    [apps, selectedNames, currentNames],
  )
  const startableCount = useMemo(
    () => selectedApps.filter((a) => !a.oneshot).length,
    [selectedApps],
  )
  const oneshotSkipped = useMemo(
    () => selectedApps.filter((a) => a.oneshot).length,
    [selectedApps],
  )

  const batchStart = useCallback(async () => {
    const names = selectedApps.filter((a) => !a.oneshot).map((a) => a.name)
    if (names.length === 0) return
    setMenuOpen(false)
    await Promise.allSettled(names.map((n) => client.startApp(n)))
    refresh()
  }, [client, refresh, selectedApps])

  const batchStop = useCallback(async () => {
    const names = selectedApps.filter((a) => !a.oneshot).map((a) => a.name)
    if (names.length === 0) return
    setMenuOpen(false)
    await Promise.allSettled(names.map((n) => client.stopApp(n)))
    refresh()
  }, [client, refresh, selectedApps])

  const batchRemove = useCallback(async () => {
    if (selectedApps.length === 0) return
    if (!(await confirmDialog(tf("appsBatchRemoveConfirm", selectedApps.length)))) return
    setMenuOpen(false)
    const names = selectedApps.map((a) => a.name)
    await Promise.allSettled(selectedApps.map((a) => client.deleteRelease(a.kind, a.name)))
    setSelectedNames((prev) => {
      const next = new Set(prev)
      names.forEach((n) => next.delete(n))
      return next
    })
    refresh()
    await loadMarket()
  }, [client, refresh, loadMarket, selectedApps])

  // Derive detail entries from their names so edits/refresh flow through and a
  // removed/delisted entry closes the panel.
  const detailApp = useMemo(
    () => (apps ?? []).find((a) => a.name === detailName) ?? null,
    [apps, detailName],
  )
  const marketDetail = useMemo(
    () => market?.apps.find((a) => a.name === marketDetailName) ?? null,
    [market, marketDetailName],
  )

  useEffect(() => {
    if (!detailName) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailName(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [detailName])

  useEffect(() => {
    if (!marketDetailName) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMarketDetailName(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [marketDetailName])

  const renderInstalledCard = (r: ReleaseRecord) => (
    <InstalledAppCard
      key={`${r.kind}/${r.name}`}
      release={r}
      selected={selectedNames.has(r.name)}
      busy={busy === r.name}
      onOpen={() => setDetailName(r.name)}
      onToggleSelect={() => toggleSelect(r.name)}
      onStart={() => handleStart(r)}
      onStop={() => handleStop(r)}
      onOpenSession={onOpenSession}
      onDelete={() => void handleDelete(r)}
    />
  )

  const renderSection = (
    label: string,
    dotClass: string,
    count: number,
    children: ReactNode,
  ) => (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
        <h3 className="text-xs font-medium text-muted-foreground">
          {label}
          <span className="ml-1.5 tabular-nums text-muted-foreground/60">{count}</span>
        </h3>
      </div>
      {children}
    </div>
  )

  const renderInstalledBody = () => {
    if (apps === null) {
      return (
        <div className={GRID_CLASS}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[70px] animate-pulse rounded-[6px] border border-border bg-card"
            />
          ))}
        </div>
      )
    }
    // No "install an app" empty box: the toolbar's install button + the
    // built-in tools section already carry the page when nothing is installed.
    // A no-match box only appears when a search hides existing apps.
    const noMatch = apps.length > 0 && installedFiltered.length === 0
    return (
      <div className="space-y-5">
        {builtins.length > 0 &&
          renderSection(
            t("appsBuiltinSection"),
            "bg-primary",
            builtins.length,
            <div className={GRID_CLASS}>
              {builtins.map((b) => (
                <AppCard key={b.href} {...b} />
              ))}
            </div>,
          )}

        {noMatch ? (
          <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
            {t("appsHubNoMatch")}
          </div>
        ) : (
          <>
            {runningList.length > 0 &&
              renderSection(
                t("appsRunningSection"),
                "bg-emerald-500",
                runningList.length,
                <div className={GRID_CLASS}>{runningList.map(renderInstalledCard)}</div>,
              )}
            {stoppedList.length > 0 &&
              renderSection(
                t("appsStoppedSection"),
                "bg-muted-foreground",
                stoppedList.length,
                <div className={GRID_CLASS}>{stoppedList.map(renderInstalledCard)}</div>,
              )}
          </>
        )}
      </div>
    )
  }

  const renderMarketBody = () => {
    if (market === undefined) {
      return (
        <div className={GRID_CLASS}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[70px] animate-pulse rounded-[6px] border border-border bg-card"
            />
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
          <span title={marketErr}>{t("appsHubError")}</span>
          <button
            type="button"
            onClick={() => void loadMarket()}
            className="mt-1 flex h-6 cursor-pointer items-center gap-1 rounded-[4px] border border-border px-2 text-xs text-foreground/80 transition-colors hover:bg-muted"
          >
            <RefreshCw size={11} className={marketRefreshing ? "animate-spin" : ""} />
            {t("appsHubRefresh")}
          </button>
        </div>
      )
    }
    if (!market || market.apps.length === 0) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("appsHubEmpty")}
        </div>
      )
    }
    if (marketFiltered.length === 0) {
      return (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/60 p-10 text-center text-sm text-muted-foreground">
          {t("appsHubNoMatch")}
        </div>
      )
    }
    return (
      <div className={GRID_CLASS}>
        {marketFiltered.map((entry) => (
          <MarketAppCard
            key={entry.name}
            entry={entry}
            iconUrl={marketIconUrl(market.repo, entry.icon)}
            installing={installing === entry.name}
            onInstall={() => void handleInstall(entry)}
            onOpen={() => setMarketDetailName(entry.name)}
          />
        ))}
      </div>
    )
  }

  const renderDetailPanel = (mobile: boolean) =>
    detailApp && (
      <InstalledAppDetailPanel
        release={detailApp}
        busy={busy === detailApp.name}
        mobile={mobile}
        onClose={() => setDetailName(null)}
        onStart={() => handleStart(detailApp)}
        onStop={() => handleStop(detailApp)}
        onOpenSession={onOpenSession}
        onDelete={() => void handleDelete(detailApp)}
      />
    )

  const renderMarketDetailPanel = (mobile: boolean) =>
    marketDetail && (
      <MarketAppDetailPanel
        entry={marketDetail}
        iconUrl={market ? marketIconUrl(market.repo, marketDetail.icon) : null}
        installing={installing === marketDetail.name}
        mobile={mobile}
        onClose={() => setMarketDetailName(null)}
        onInstall={() => void handleInstall(marketDetail)}
      />
    )

  // Installed / repository switch: quiet pill buttons leading the toolbar (only
  // when a repository is configured), ending in a hairline divider.
  const tabSwitcher = hasMarket && (
    <div className="flex shrink-0 items-center gap-1">
      {(
        [
          { id: "installed", label: "appsTabInstalled" },
          { id: "market", label: "appsTabHub" },
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

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
      onDragOver={(e) => {
        if (showMarket) return
        e.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragActive(false)
      }}
      onDrop={(e) => {
        if (showMarket) {
          e.preventDefault()
          setDragActive(false)
          return
        }
        onDrop(e)
      }}
    >
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center border-b border-border bg-card px-5">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-sm font-medium text-foreground">{t("appsTitle")}</h1>
        </div>
      </div>

      {/* Toolbar */}
      {showMarket ? (
        <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-border bg-card px-5">
          {tabSwitcher}
          <span className="shrink-0 text-xs text-muted-foreground">
            {tf("appsHubCountLabel", marketFiltered.length)}
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
              placeholder={t("appsHubSearch")}
              className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
            />
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void loadMarket()}
            disabled={marketRefreshing}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t("appsHubRefresh")}
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
              disabled={installedFiltered.length === 0}
              className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white disabled:cursor-not-allowed disabled:opacity-40"
            />
            {selectedNames.size > 0 ? (
              <span className="shrink-0 text-xs font-medium text-primary">
                {tf("selectedCount", selectedNames.size)}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {tf("appsHubCountLabel", installedFiltered.length)}
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
              placeholder={t("appsHubSearch")}
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
              <option value="status">{t("skillsSortByState")}</option>
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
            {sortOrder === "desc" ? (
              <ArrowDownWideNarrow size={12} />
            ) : (
              <ArrowUpNarrowWide size={12} />
            )}
          </button>

          <div className="flex-1" />

          <div ref={installRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setInstallOpen((v) => !v)}
              disabled={importing}
              className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={t("appsInstall")}
            >
              {importing ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : (
                <Plus size={13} strokeWidth={2.5} />
              )}
              {t("appsInstall")}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            className="hidden"
            onChange={onPickFile}
          />
          {installOpen &&
            createPortal(
              <InstallPopover
                anchorRef={installRef}
                installing={importing}
                fromFileLabel={t("appsInstallFromFile")}
                fromUrlLabel={t("appsInstallFromUrl")}
                urlPlaceholder={t("appsInstallUrlPlaceholder")}
                installLabel={t("appsInstall")}
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
            onClick={refresh}
            disabled={refreshing}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t("appsHubRefresh")}
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
          <DropdownMenu menuRef={menuRef} onClose={() => setMenuOpen(false)}>
            <button
              type="button"
              onClick={() => void batchStart()}
              disabled={startableCount === 0}
              title={oneshotSkipped > 0 ? tf("appsBatchSkipHint", oneshotSkipped) : undefined}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={12} />
              {t("appsBatchStart")}
              {startableCount > 0 && oneshotSkipped > 0 && (
                <span className="tabular-nums opacity-70">({startableCount})</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void batchStop()}
              disabled={startableCount === 0}
              title={oneshotSkipped > 0 ? tf("appsBatchSkipHint", oneshotSkipped) : undefined}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Square size={12} />
              {t("appsBatchStop")}
            </button>
            <button
              type="button"
              onClick={() => void batchRemove()}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 size={12} />
              {t("appsBatchRemove")}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {/* Main area: master-detail split */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto bg-background">
          <div className="px-4 pb-4 pt-3">
            {showMarket ? renderMarketBody() : renderInstalledBody()}
          </div>
        </div>

        {/* Desktop: right column, resizable via the left-edge handle */}
        {!showMarket && detailApp && (
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
        {showMarket && marketDetail && (
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

      {/* Mobile: full-screen takeover */}
      {!showMarket && detailApp && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-2xl lg:hidden">
          {renderDetailPanel(true)}
        </div>
      )}
      {showMarket && marketDetail && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-2xl lg:hidden">
          {renderMarketDetailPanel(true)}
        </div>
      )}

      {/* Drag overlay (installed tab only) */}
      {dragActive && !showMarket && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary/50 px-10 py-8 text-sm text-primary">
            <Upload className="h-6 w-6" />
            {t("appsInstallDropActive")}
          </div>
        </div>
      )}
    </div>
  )
}
