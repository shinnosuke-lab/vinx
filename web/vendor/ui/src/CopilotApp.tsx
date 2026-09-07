import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Menu } from "lucide-react"

import { AgentChat } from "./AgentChat"
import { VINX_LOGO } from "./assets/vinx-logo"
import { createChatClient } from "./client"
import { applyLlmStyle, runLlmScript } from "./lib/llm-style"
import { NavRail, type ShellView } from "./components/shell/nav-rail"
import { SessionsPage } from "./components/sessions/sessions-page"
import { SettingsPage } from "./components/settings/settings-page"
import { SkillsPage } from "./components/skills/skills-page"
import { AppsPage } from "./components/apps/apps-page"
import { ReleasesPage } from "./components/releases/releases-page"
import { ThemesPage } from "./components/themes/themes-page"
import { ConfirmDialogHost } from "./components/ui/confirm-dialog"
import { ConnectionBanner } from "./components/shared/connection-banner"
import { Toaster, toast } from "./components/ui/toast"
import { useAttention } from "./lib/alerts"
import { setLabels, setLanguage, t } from "./lib/i18n"
import { themeToCssVars } from "./lib/theme"
import { cn, useMediaQuery, MOBILE_QUERY, MEDIUM_QUERY } from "./lib/utils"
import type { AgentChatHandle, Labels, ThemeTokens, ToolRenderer } from "./types"

/**
 * Full-page Copilot **shell**: a branded navigation rail (new chat / sessions /
 * settings) wrapping an always-mounted [`AgentChat`] plus a full conversation
 * manager and an editable settings drawer.
 *
 * Branding (brand / logo / theme / language) is driven by the agent's own
 * `/api/chat/meta` (sourced from its `meta.json` / config), so the standalone
 * SPA needs no host build to be customized — props here are only optional
 * overrides for source-level embedders.
 */
export interface CopilotAppProps {
  /** API origin prefix. `''` = same-origin (default). */
  basePath?: string
  /** Theme overrides; merged over (and winning against) `meta.theme`. */
  theme?: ThemeTokens
  /** Custom/override tool renderers (keyed by tool name). */
  toolRenderers?: Record<string, ToolRenderer>
  /** Label overrides (i18n). Default copy follows `meta.lang` then the browser. */
  labels?: Labels
  /** Brand/title override (else `meta.brand`). */
  brand?: string
  /** Logo override: image URL or node (else `meta.logo`). */
  logo?: ReactNode | string
  /** Collapsed-rail logo override (else `meta.logoCollapsed`, then `logo`). */
  logoCollapsed?: ReactNode | string
  /** Page favicon override (else `meta.favicon`, then the active logo). */
  favicon?: string
}

// ── hash routing (no router dependency) ──
// `#/chat[/<session_id>]`, `#/sessions`, `#/skills`, `#/apps`, `#/releases`,
// `#/themes`, `#/settings`. Hash (not
// history API) so a copied link opens without any server-side fallback, and
// the view survives reloads. The session id in the URL makes conversations
// shareable across browsers on the same agent (sessions are server-shared).

function parseHash(): { view: ShellView; sessionId?: string } {
  const raw = typeof window !== "undefined" ? window.location.hash : ""
  const [seg, id] = raw.replace(/^#\/?/, "").split("/")
  switch (seg) {
    case "sessions":
      return { view: "sessions" }
    case "skills":
      return { view: "skills" }
    case "apps":
      return { view: "apps" }
    case "releases":
      return { view: "releases" }
    case "themes":
      return { view: "themes" }
    case "settings":
      return { view: "config" }
    case "chat":
      return { view: "chat", sessionId: id || undefined }
    default:
      return { view: "chat" }
  }
}

function viewToHash(view: ShellView, sessionId: string | null): string {
  switch (view) {
    case "sessions":
      return "#/sessions"
    case "skills":
      return "#/skills"
    case "apps":
      return "#/apps"
    case "releases":
      return "#/releases"
    case "themes":
      return "#/themes"
    case "config":
      return "#/settings"
    default:
      return sessionId ? `#/chat/${sessionId}` : "#/chat"
  }
}

/** i18n label key per non-chat view for the tab title (same copy as the nav rail). */
const VIEW_LABEL_KEY: Record<ShellView, string> = {
  chat: "newChat",
  sessions: "sessions",
  skills: "skills",
  apps: "apps",
  releases: "releasesNav",
  themes: "themesNav",
  config: "settings",
}

interface AgentMeta {
  brand?: string
  logo?: string
  /** Small logo for the collapsed rail; falls back to `logo` when absent. */
  logoCollapsed?: string
  /** Page favicon; falls back to the active logo when absent. */
  favicon?: string
  lang?: string
  theme?: ThemeTokens
  model?: string
  /** App (distro) version (meta.json); shown in the About popover. */
  version?: string
  /** agent-core kernel version (kernel-owned, injected by the web layer). */
  kernelVersion?: string
  /** Optional "check for updates" link target shown in the About popover. */
  updateUrl?: string
  /** Where the code lives (a repository URL); the About popover shows it as
   *  a link, host and path as the text. Hidden when absent. */
  sourceUrl?: string
  readonly?: boolean
  history?: boolean
  configEditable?: boolean
}

const BRANDING_CACHE_PREFIX = "agent-chat-branding:"

function readBrandingCache(basePath: string): AgentMeta | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(`${BRANDING_CACHE_PREFIX}${basePath}`)
    return raw ? (JSON.parse(raw) as AgentMeta) : null
  } catch {
    return null
  }
}

function persistBrandingCache(basePath: string, meta: AgentMeta) {
  if (typeof sessionStorage === "undefined") return
  try {
    const { brand, logo, logoCollapsed, favicon } = meta
    sessionStorage.setItem(
      `${BRANDING_CACHE_PREFIX}${basePath}`,
      JSON.stringify({ brand, logo, logoCollapsed, favicon }),
    )
  } catch {
    // Ignore quota / private-mode failures; branding still works without cache.
  }
}

export function CopilotApp({
  basePath = "",
  theme,
  toolRenderers,
  labels,
  brand,
  logo,
  logoCollapsed,
  favicon,
}: CopilotAppProps) {
  const chatRef = useRef<AgentChatHandle>(null)
  const [view, setView] = useState<ShellView>(() => parseHash().view)
  // Starts collapsed when the page loads inside the medium band (768–1279px),
  // where the expanded rail would crowd the content; see the isMedium effect.
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(MEDIUM_QUERY).matches,
  )
  // Seed from the URL: `openSession` (deep link) only reports back through
  // `onSessionChange` after its fetch resolves, and the state→URL effect runs
  // before that — without the seed it would overwrite `#/chat/<id>` to
  // `#/chat`, losing the shared link on an early reload or failed fetch.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    () => parseHash().sessionId ?? null,
  )
  // Tracks the session actually LOADED in the chat (deliberately not seeded:
  // the mount-time apply() must still call openSession for the deep link).
  const activeSessionIdRef = useRef<string | null>(null)
  // Bumped whenever the chat mutates a session so the sessions view re-fetches.
  const [sessionsRefresh, setSessionsRefresh] = useState(0)
  const [meta, setMeta] = useState<AgentMeta | null>(() => readBrandingCache(basePath))
  const [metaLoaded, setMetaLoaded] = useState(false)
  // Title of the conversation currently shown in the chat (`''` = new chat),
  // reported by AgentChat; feeds the tab title so open tabs are telling apart.
  const [chatTitle, setChatTitle] = useState("")
  const attention = useAttention()

  const client = useMemo(() => createChatClient(basePath), [basePath])

  // Narrow viewport (phone): the rail stays collapsed to 48px and "expand"
  // opens the full rail as an overlay drawer (backdrop / Esc / nav action all
  // dismiss it). The desktop collapse toggle keeps its own state.
  const isNarrow = useMediaQuery(MOBILE_QUERY)
  const [navDrawerOpen, setNavDrawerOpen] = useState(false)

  // Medium band (768–1279px): still the desktop layout, but the expanded
  // 224px rail crowds the content — auto-collapse to the icon rail when the
  // viewport crosses INTO the band, restore when it crosses back out. The
  // manual toggle keeps working in between (only crossings override it).
  const isMedium = useMediaQuery(MEDIUM_QUERY)
  const prevMediumRef = useRef(isMedium)
  useEffect(() => {
    if (prevMediumRef.current === isMedium) return
    prevMediumRef.current = isMedium
    setCollapsed(isMedium)
  }, [isMedium])
  // Leaving the narrow layout closes the drawer so it can't linger open.
  useEffect(() => {
    if (!isNarrow) setNavDrawerOpen(false)
  }, [isNarrow])
  useEffect(() => {
    if (!navDrawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavDrawerOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navDrawerOpen])
  const handleToggleCollapse = useCallback(() => {
    if (isNarrow) setNavDrawerOpen((v) => !v)
    else setCollapsed((c) => !c)
  }, [isNarrow])

  // Touch gesture (narrow only): swipe-left closes the open nav drawer. We do
  // NOT bind left-edge swipe-to-open — that collides with Android's system
  // back gesture (which wins and exits the app). Opening is the hamburger.
  const navTouchStart = useRef<{ x: number; y: number } | null>(null)
  const onRootTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isNarrow || !navDrawerOpen) return
      const t = e.touches[0]
      navTouchStart.current = { x: t.clientX, y: t.clientY }
    },
    [isNarrow, navDrawerOpen],
  )
  const onRootTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isNarrow || !navDrawerOpen) return
      const start = navTouchStart.current
      navTouchStart.current = null
      if (!start) return
      const t = e.changedTouches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (Math.abs(dy) > 50) return
      if (dx < -60) setNavDrawerOpen(false)
    },
    [isNarrow, navDrawerOpen],
  )

  // Pull branding/capabilities from the agent itself (its meta.json / config).
  useEffect(() => {
    let alive = true
    client
      .getMeta()
      .then((m) => {
        if (!alive) return
        if (m) {
          const next = m as AgentMeta
          setMeta(next)
          persistBrandingCache(basePath, next)
        }
      })
      .catch(() => {
        if (alive) toast.error(t("loadFailed"))
      })
      .finally(() => {
        if (alive) setMetaLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [basePath, client])

  // Saved themes: fetch once at boot and inject through the same channel the
  // `set_chat_style` live event uses — an in-session restyle replaces the
  // slot for this page, a refresh restores the persisted look. `?notheme=1`
  // skips fetch AND injection entirely: the escape hatch when a bad persisted
  // style breaks the page (script errors are already contained by
  // runLlmScript's try/catch).
  useEffect(() => {
    if (typeof window === "undefined") return
    if (new URLSearchParams(window.location.search).has("notheme")) return
    let alive = true
    client.listThemes().then((themes) => {
      if (!alive || themes.length === 0) return
      for (const th of themes) {
        applyLlmStyle(th.css)
        runLlmScript(th.js ?? "")
      }
    })
    return () => {
      alive = false
    }
  }, [client])

  // Apply locale (meta.lang) then i18n overrides so the nav rail / sessions page
  // pick them up independent of the chat's render order.
  useMemo(() => {
    setLanguage(meta?.lang)
    setLabels(labels)
  }, [meta?.lang, labels])

  const effectiveBrand = brand ?? meta?.brand
  // Only fall back to the bundled Vinx logo after meta has loaded and the host
  // configured none — avoids flashing the default while `/api/chat/meta` resolves.
  const effectiveLogo = logo ?? meta?.logo ?? (metaLoaded ? VINX_LOGO : undefined)
  // Collapsed rail prefers a dedicated small logo, then falls back to the main one.
  const effectiveLogoCollapsed = logoCollapsed ?? meta?.logoCollapsed ?? effectiveLogo
  // Favicon prefers a dedicated icon (e.g. a square mark), then falls back to the
  // active logo so the tab still matches the branding when none is configured.
  const effectiveFavicon =
    favicon ??
    meta?.favicon ??
    (metaLoaded && typeof effectiveLogo === "string" ? effectiveLogo : undefined)
  // SPA build stamp (injected at app build; absent in the library build).
  const buildTime = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : undefined
  const effectiveTheme = useMemo<ThemeTokens | undefined>(() => {
    if (!meta?.theme && !theme) return undefined
    return { ...(meta?.theme ?? {}), ...(theme ?? {}) }
  }, [meta?.theme, theme])

  // Mirror the active favicon (host `meta.favicon`, else the logo) onto the page
  // so the browser tab matches the in-app branding.
  useEffect(() => {
    if (typeof document === "undefined" || typeof effectiveFavicon !== "string") return
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      document.head.appendChild(link)
    }
    link.href = effectiveFavicon
  }, [effectiveFavicon])

  // Keep the tab title in sync with what is on screen: `<session> · <brand>`
  // in the chat (untitled/new chat = `<New chat> · <brand>`), `<page> · <brand>`
  // elsewhere, so several open tabs can be told apart at a glance. When the
  // host configured no brand, fall back to the default identity once meta has
  // loaded (avoids clobbering the title while /api/chat/meta resolves).
  useEffect(() => {
    if (typeof document === "undefined") return
    const brandTitle = effectiveBrand ?? (metaLoaded ? t("defaultBrand") : undefined)
    if (!brandTitle) return
    const context = view === "chat" ? chatTitle || t("newChat") : t(VIEW_LABEL_KEY[view])
    // `●` while a background tab has an unseen turn end / decision point:
    // the one glance at the tab bar that says which session wants you.
    const badge = attention ? "● " : ""
    document.title = badge + (context ? `${context} · ${brandTitle}` : brandTitle)
  }, [effectiveBrand, metaLoaded, view, chatTitle, attention])

  const handleNewChat = useCallback(() => {
    chatRef.current?.newChat()
    setView("chat")
  }, [])
  const handleOpenSession = useCallback((id: string) => {
    chatRef.current?.openSession(id)
    setView("chat")
  }, [])
  const handleSessionChange = useCallback((id: string | null) => {
    activeSessionIdRef.current = id
    setActiveSessionId(id)
    setSessionsRefresh((n) => n + 1)
  }, [])

  // The chat stays mounted while other views are shown, so its sidebar list
  // never sees archive / restore / delete / pin edits made on the sessions
  // page. Re-sync it each time the chat view comes back into view.
  const prevViewRef = useRef<ShellView>(view)
  useEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = view
    if (view === "chat" && prev !== "chat") chatRef.current?.refreshSessions?.()
  }, [view])

  // URL → state: on mount (deep link, incl. a shared `#/chat/<id>`) and on
  // back/forward navigation.
  useEffect(() => {
    const apply = () => {
      const { view: v, sessionId } = parseHash()
      setView(v)
      if (v === "chat" && sessionId && sessionId !== activeSessionIdRef.current) {
        chatRef.current?.openSession(sessionId)
      }
    }
    apply()
    window.addEventListener("hashchange", apply)
    return () => window.removeEventListener("hashchange", apply)
  }, [])

  // State → URL: keep the hash shareable/reload-safe. No-op when in sync
  // (breaks the hashchange feedback loop).
  useEffect(() => {
    const target = viewToHash(view, activeSessionId)
    if (window.location.hash !== target) {
      window.location.hash = target
    }
  }, [view, activeSessionId])

  return (
    <div
      className={cn(
        "acc-root flex h-full w-full overflow-hidden bg-background text-foreground",
        effectiveTheme?.scheme === "dark" && "dark",
      )}
      style={{ position: "fixed", inset: 0, ...themeToCssVars(effectiveTheme) }}
      onTouchStart={onRootTouchStart}
      onTouchEnd={onRootTouchEnd}
    >
      {/* Wide screens: the rail is a permanent flex sibling. Narrow screens
          hide it entirely (a floating hamburger + edge-swipe open the drawer),
          so the SPA gets the full width like a native mobile app. */}
      {!isNarrow && (
        <NavRail
          brand={effectiveBrand}
          logo={effectiveLogo}
          logoCollapsed={effectiveLogoCollapsed}
          version={meta?.version}
          kernelVersion={meta?.kernelVersion}
          buildTime={buildTime}
          updateUrl={meta?.updateUrl}
          sourceUrl={meta?.sourceUrl}
          activeView={view}
          collapsed={collapsed}
          hrefFor={(v) => viewToHash(v, null)}
          onNewChat={handleNewChat}
          onOpenSessions={() => setView("sessions")}
          onOpenSkills={() => setView("skills")}
          onOpenApps={() => setView("apps")}
          onOpenReleases={() => setView("releases")}
          onOpenThemes={() => setView("themes")}
          onOpenSettings={() => setView("config")}
          onToggleCollapse={handleToggleCollapse}
        />
      )}
      {/* Narrow: floating hamburger to open the nav drawer (hidden while open). */}
      {isNarrow && !navDrawerOpen && (
        <button
          type="button"
          onClick={() => setNavDrawerOpen(true)}
          aria-label={t("expandSidebar")}
          className="fixed left-2 top-2 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/85 text-foreground shadow-sm backdrop-blur"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>
      )}
      {isNarrow && navDrawerOpen && (
        <>
          {/* Backdrop: tap-outside dismisses the drawer. */}
          <div
            className="fixed inset-0 z-40 animate-fade-in bg-black/40"
            aria-hidden
            onClick={() => setNavDrawerOpen(false)}
          />
          {/* `[&>aside]:h-full` beats the rail's `h-screen`: iOS's 100vh can
              exceed the fixed wrapper, which would push the footer (About)
              under the URL bar. */}
          <div className="fixed inset-y-0 left-0 z-50 flex animate-slide-in-left shadow-2xl [&>aside]:h-full">
            <NavRail
              brand={effectiveBrand}
              logo={effectiveLogo}
              logoCollapsed={effectiveLogoCollapsed}
              version={meta?.version}
              kernelVersion={meta?.kernelVersion}
              buildTime={buildTime}
              updateUrl={meta?.updateUrl}
              sourceUrl={meta?.sourceUrl}
              activeView={view}
              collapsed={false}
              hrefFor={(v) => viewToHash(v, null)}
              onNewChat={() => {
                handleNewChat()
                setNavDrawerOpen(false)
              }}
              onOpenSessions={() => {
                setView("sessions")
                setNavDrawerOpen(false)
              }}
              onOpenSkills={() => {
                setView("skills")
                setNavDrawerOpen(false)
              }}
              onOpenApps={() => {
                setView("apps")
                setNavDrawerOpen(false)
              }}
              onOpenReleases={() => {
                setView("releases")
                setNavDrawerOpen(false)
              }}
              onOpenThemes={() => {
                setView("themes")
                setNavDrawerOpen(false)
              }}
              onOpenSettings={() => {
                setView("config")
                setNavDrawerOpen(false)
              }}
              onToggleCollapse={() => setNavDrawerOpen(false)}
            />
          </div>
        </>
      )}

      {/* Chat stays mounted (preserves conversation state) and is hidden while
          another view is active. */}
      <div data-acc="main-view" className={cn("relative h-full min-w-0 flex-1", view !== "chat" && "hidden")}>
        <AgentChat
          ref={chatRef}
          basePath={basePath}
          theme={effectiveTheme}
          toolRenderers={toolRenderers}
          labels={labels}
          hideSidebar
          onSessionChange={handleSessionChange}
          onTitleChange={setChatTitle}
          onBack={isNarrow ? undefined : () => setView("sessions")}
          sessionHref={(id) => viewToHash("chat", id)}
        />
      </div>

      {view === "sessions" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <SessionsPage
            basePath={basePath}
            activeId={activeSessionId}
            onOpen={handleOpenSession}
            onNewChat={handleNewChat}
            refreshKey={sessionsRefresh}
            sessionHref={(id) => viewToHash("chat", id)}
          />
        </div>
      )}

      {view === "skills" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <SkillsPage basePath={basePath} />
        </div>
      )}

      {view === "apps" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <AppsPage basePath={basePath} onOpenSession={handleOpenSession} />
        </div>
      )}

      {view === "releases" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <ReleasesPage basePath={basePath} onOpenSession={handleOpenSession} />
        </div>
      )}

      {view === "themes" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <ThemesPage basePath={basePath} onOpenSession={handleOpenSession} />
        </div>
      )}

      {view === "config" && (
        <div className="flex h-full min-w-0 flex-1 animate-fade-in overflow-hidden">
          <SettingsPage
            basePath={basePath}
            brand={meta?.brand}
            accent={meta?.theme?.accent}
          />
        </div>
      )}

      {/* Invisible full-screen overlay for the `set_chat_style` easter egg:
          LLM-injected CSS targets its ::before/::after for confetti/star
          effects. pointer-events:none keeps it out of hit-testing. */}
      <div
        data-acc="fx-layer"
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999, overflow: "hidden" }}
      />

      <ConnectionBanner basePath={basePath} />
      <Toaster />
      <ConfirmDialogHost />
    </div>
  )
}

