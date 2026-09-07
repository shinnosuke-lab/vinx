import { useEffect, useRef, useState, type ReactNode } from "react"
import { Settings, MessagesSquare, Sparkles, LayoutGrid, Package, Palette, PanelLeftClose, type LucideIcon } from "lucide-react"
import { NewChatIcon } from "@agentchat/components/icons/new-chat-icon"
import { Separator } from "@agentchat/components/ui/separator"
import { cn, spaAnchorClick } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

/** Which main view the shell is showing. */
export type ShellView = "chat" | "sessions" | "skills" | "apps" | "releases" | "themes" | "config"

/**
 * Collapsed icon button: uniform size + hover, shared by every collapsed-rail
 * control so structure/sizing/feedback stay identical.
 */
const COLLAPSED_BTN_BASE =
  "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md p-0 cursor-pointer transition-colors"
const COLLAPSED_BTN_DEFAULT =
  "text-muted-foreground/70 hover:bg-muted-foreground/10 hover:text-foreground"
const COLLAPSED_BTN_ACTIVE = "text-primary hover:bg-primary/10"

const EXPANDED_NAV_ITEM =
  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-normal transition-colors cursor-pointer"

interface NavRailProps {
  brand?: string
  /** Logo: an image URL (rendered as `<img>`) or a custom node. */
  logo?: ReactNode | string
  /** Collapsed-rail logo; falls back to `logo` when absent. */
  logoCollapsed?: ReactNode | string
  /** App (distro) version shown in the About popover. */
  version?: string
  /** agent-core kernel version shown alongside the app version. */
  kernelVersion?: string
  /** SPA build timestamp shown in the About popover. */
  buildTime?: string
  /** Optional "check for updates" target; the link is hidden when absent. */
  updateUrl?: string
  /** Optional repository URL, shown as a link in the About popover (text: the
   *  URL without its scheme); hidden when absent. */
  sourceUrl?: string
  activeView: ShellView
  collapsed: boolean
  /** URL for a view (e.g. `#/sessions`). When set, nav entries render as real
   *  anchors so right/middle/modified clicks open them in a new tab; plain
   *  left-click still switches in-app via the `onOpen*` callbacks. */
  hrefFor?: (view: ShellView) => string
  onNewChat: () => void
  onOpenSessions: () => void
  onOpenSkills: () => void
  onOpenApps: () => void
  onOpenReleases: () => void
  onOpenThemes: () => void
  onOpenSettings: () => void
  onToggleCollapse: () => void
}

function LogoMark({ logo, size }: { logo?: ReactNode | string; size: string }) {
  if (typeof logo === "string")
    return <img src={logo} alt="" className={cn("shrink-0 object-contain", size)} />
  if (logo) return <span className={cn("flex shrink-0 items-center justify-center", size)}>{logo}</span>
  return null
}

function NavButton({
  icon: Icon,
  label,
  collapsed,
  active,
  href,
  onClick,
}: {
  icon: LucideIcon
  label: string
  collapsed: boolean
  active: boolean
  /** When set, renders a real anchor (browser affordances: open in new tab
   *  via right/middle-click); plain left-click still calls `onClick`. */
  href?: string
  onClick: () => void
}) {
  const className = collapsed
    ? cn(COLLAPSED_BTN_BASE, active ? COLLAPSED_BTN_ACTIVE : COLLAPSED_BTN_DEFAULT)
    : cn(
        EXPANDED_NAV_ITEM,
        "w-full",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
      )
  const inner = (
    <>
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
      {!collapsed && <span>{label}</span>}
    </>
  )
  if (href) {
    return (
      <a
        href={href}
        data-acc="nav-btn"
        onClick={(e) => spaAnchorClick(e, onClick)}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        title={collapsed ? label : undefined}
        className={cn(className, "no-underline")}
      >
        {inner}
      </a>
    )
  }
  return (
    <button
      type="button"
      data-acc="nav-btn"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={className}
    >
      {inner}
    </button>
  )
}

/**
 * Branded navigation rail for [`CopilotApp`]: brand row, a faint new-chat
 * pill, a sessions
 * entry, a settings entry and a brand footer. Only ships the entries the
 * agent process backs.
 */
export function NavRail({
  brand,
  logo,
  logoCollapsed,
  version,
  kernelVersion,
  buildTime,
  updateUrl,
  sourceUrl,
  activeView,
  collapsed,
  hrefFor,
  onNewChat,
  onOpenSessions,
  onOpenSkills,
  onOpenApps,
  onOpenReleases,
  onOpenThemes,
  onOpenSettings,
  onToggleCollapse,
}: NavRailProps) {
  const name = brand || t("defaultBrand")
  const initial = name.charAt(0).toUpperCase() || "A"
  const [aboutOpen, setAboutOpen] = useState(false)
  const aboutRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!aboutOpen) return
    const onDown = (e: MouseEvent) => {
      if (aboutRef.current && !aboutRef.current.contains(e.target as Node)) setAboutOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAboutOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [aboutOpen])

  return (
    <aside
      data-acc="nav-rail"
      className={cn(
        "flex h-screen flex-col border-r border-border bg-sidebar transition-all duration-200",
        collapsed ? "w-12" : "w-56",
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "h-14 shrink-0",
          collapsed ? "flex flex-col items-center px-1" : "flex items-center overflow-hidden px-2",
        )}
      >
        <button
          type="button"
          data-acc="brand-logo"
          onClick={collapsed ? onToggleCollapse : undefined}
          aria-label={collapsed ? t("expandSidebar") : undefined}
          title={collapsed ? t("expandSidebar") : undefined}
          className={
            collapsed
              ? cn(COLLAPSED_BTN_BASE, "my-3 hover:bg-muted-foreground/10")
              : "flex shrink-0 items-center justify-center rounded-md p-1 cursor-default"
          }
        >
          <LogoMark logo={collapsed ? (logoCollapsed ?? logo) : logo} size={collapsed ? "h-6 w-6" : "h-6 w-6"} />
        </button>
        {!collapsed && (
          <>
            <span className="ml-1.5 whitespace-nowrap text-sm font-semibold tracking-tight text-sidebar-foreground">
              {name}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={t("collapseSidebar")}
              className={cn(COLLAPSED_BTN_BASE, COLLAPSED_BTN_DEFAULT)}
            >
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>

      <Separator className={cn("w-auto opacity-50", collapsed ? "mx-2" : "mx-3")} />

      {/* New chat — faint tinted pill, not a solid button. */}
      <div
        className={cn(
          "shrink-0",
          collapsed ? "flex flex-col items-center px-1 pt-2 pb-1.5" : "px-2 py-2",
        )}
      >
        {(() => {
          const newChatClass = collapsed
            ? cn(COLLAPSED_BTN_BASE, COLLAPSED_BTN_DEFAULT)
            : "flex w-full items-center justify-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 cursor-pointer"
          const newChatInner = (
            <>
              <NewChatIcon width={collapsed ? 18 : 16} height={collapsed ? 18 : 16} strokeWidth={1.5} className="shrink-0" />
              {!collapsed && <span>{t("newChat")}</span>}
            </>
          )
          const href = hrefFor?.("chat")
          return href ? (
            <a
              href={href}
              data-acc="new-chat-btn"
              onClick={(e) => spaAnchorClick(e, onNewChat)}
              aria-label={t("newChat")}
              title={collapsed ? t("newChat") : undefined}
              className={cn(newChatClass, "no-underline")}
            >
              {newChatInner}
            </a>
          ) : (
            <button
              type="button"
              data-acc="new-chat-btn"
              onClick={onNewChat}
              aria-label={t("newChat")}
              title={collapsed ? t("newChat") : undefined}
              className={newChatClass}
            >
              {newChatInner}
            </button>
          )
        })()}
      </div>

      {/* Primary nav */}
      <div
        className={cn(
          "shrink-0",
          collapsed ? "flex flex-col items-center gap-1.5 px-1" : "space-y-1 px-2",
        )}
      >
        <NavButton
          icon={MessagesSquare}
          label={t("sessions")}
          collapsed={collapsed}
          active={activeView === "sessions"}
          href={hrefFor?.("sessions")}
          onClick={onOpenSessions}
        />
        <NavButton
          icon={Sparkles}
          label={t("skills")}
          collapsed={collapsed}
          active={activeView === "skills"}
          href={hrefFor?.("skills")}
          onClick={onOpenSkills}
        />
        <NavButton
          icon={LayoutGrid}
          label={t("apps")}
          collapsed={collapsed}
          active={activeView === "apps"}
          href={hrefFor?.("apps")}
          onClick={onOpenApps}
        />
        <NavButton
          icon={Package}
          label={t("releasesNav")}
          collapsed={collapsed}
          active={activeView === "releases"}
          href={hrefFor?.("releases")}
          onClick={onOpenReleases}
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom utility nav */}
      <div
        className={cn(
          "shrink-0",
          collapsed ? "flex flex-col items-center gap-1.5 px-1 pb-2" : "space-y-1 px-2 pb-1",
        )}
      >
        <NavButton
          icon={Palette}
          label={t("themesNav")}
          collapsed={collapsed}
          active={activeView === "themes"}
          href={hrefFor?.("themes")}
          onClick={onOpenThemes}
        />
        <NavButton
          icon={Settings}
          label={t("settings")}
          collapsed={collapsed}
          active={activeView === "config"}
          href={hrefFor?.("config")}
          onClick={onOpenSettings}
        />
      </div>

      <Separator className={cn("w-auto opacity-50", collapsed ? "mx-2" : "mx-3")} />

      {/* Footer — About: brand identity + version/build-time info popover. */}
      <div ref={aboutRef} className={cn("relative py-3", collapsed ? "flex flex-col items-center px-1" : "px-2")}>
        <button
          type="button"
          data-acc="about-btn"
          onClick={() => setAboutOpen((v) => !v)}
          aria-label={t("about")}
          title={collapsed ? t("about") : undefined}
          className={
            collapsed
              ? cn(COLLAPSED_BTN_BASE, aboutOpen ? COLLAPSED_BTN_ACTIVE : COLLAPSED_BTN_DEFAULT)
              : cn(
                  EXPANDED_NAV_ITEM,
                  "w-full",
                  aboutOpen
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
                )
          }
        >
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 font-semibold text-foreground",
              collapsed ? "h-5 w-5 text-[10px]" : "h-4 w-4 text-[9px]",
            )}
          >
            {initial}
          </span>
          {!collapsed && <span className="truncate">{t("about")}</span>}
        </button>

        {aboutOpen && (
          <div className="absolute bottom-full left-full z-50 mb-2 ml-5 w-56 animate-in fade-in-0 zoom-in-95 rounded-sm border border-border bg-popover shadow-md">
            {/* Header — brand */}
            <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
              {logo ? (
                <LogoMark logo={logo} size="h-6 w-6" />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                  {initial}
                </span>
              )}
              <span className="truncate text-xs font-medium text-foreground/90">{name}</span>
            </div>
            {/* Version + optional check-for-updates link */}
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[11px] text-muted-foreground">{t("version")}</span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-foreground/80">v{version ?? "—"}</span>
                {updateUrl && (
                  <a
                    href={updateUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {t("checkUpdate")}
                  </a>
                )}
              </span>
            </div>
            {/* Kernel (agent-core) version — dual-version model: app + kernel */}
            {kernelVersion && (
              <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">{t("kernelVersion")}</span>
                <span className="text-[11px] tabular-nums text-foreground/80">v{kernelVersion}</span>
              </div>
            )}
            {/* Build time */}
            <div className="flex items-center justify-between border-t border-border/40 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">{t("buildTime")}</span>
              <span className="text-[11px] tabular-nums text-foreground/80">{buildTime ?? "—"}</span>
            </div>
            {/* Source — where the code lives; the URL minus its scheme is the text */}
            {sourceUrl && (
              <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">{t("source")}</span>
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[11px] text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                >
                  {sourceUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "")}
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
