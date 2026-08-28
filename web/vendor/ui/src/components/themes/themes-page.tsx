import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  MoreHorizontal,
  Palette,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import { createPortal } from "react-dom"
import { createChatClient, type ReleaseRecord } from "@agentchat/client"
import { t, tf } from "@agentchat/lib/i18n"
import { toast } from "@agentchat/components/ui/toast"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { portalContainer } from "@agentchat/lib/utils"
import { applyLlmStyle, clearLlmStyle, runLlmScript } from "@agentchat/lib/llm-style"
import { DropdownMenu } from "@agentchat/components/shared/dropdown-menu"
import { ReleaseCard } from "@agentchat/components/releases/release-card"

type SortField = "time" | "name"
type SortOrder = "asc" | "desc"

interface ThemesPageProps {
  basePath?: string
  /** Open a conversation in the chat view (provenance link on cards). */
  onOpenSession?: (id: string) => void
}

/**
 * Themes ("主题") page — the agent's saved looks (`kind=theme`): a persistent
 * CSS/JS skin the user can activate, restore-default, or remove. Split out of
 * the Releases page so deliverables and skins each get a focused page, both
 * sharing the skills/apps toolbar (select-all, search, sort, batch, refresh).
 */
export function ThemesPage({ basePath = "", onOpenSession }: ThemesPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  const [themes, setThemes] = useState<ReleaseRecord[]>([])
  // The active theme's name — `GET /api/themes` returns only the injected one.
  const [activeTheme, setActiveTheme] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [searchQuery, setSearchQuery] = useState("")
  const [sortField, setSortField] = useState<SortField>("time")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    Promise.all([client.listReleases({ kind: "theme" }), client.listThemes()])
      .then(([rs, ts]) => {
        setThemes(rs.filter((r) => r.kind === "theme"))
        setActiveTheme(ts[0]?.name ?? null)
      })
      .finally(() => setRefreshing(false))
  }, [client])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleActivate = useCallback(
    (r: ReleaseRecord) => {
      client
        .activateTheme(r.name)
        // `listThemes()` returns only the active theme — after activation that
        // is the one we just picked, so apply it LIVE (no page refresh needed).
        .then(() => client.listThemes())
        .then((ts) => {
          const active = ts[0]
          if (active) {
            applyLlmStyle(active.css)
            runLlmScript(active.js ?? "")
          }
          setActiveTheme(active?.name ?? null)
        })
        .catch((e) => {
          toast.error(e instanceof Error ? e.message : String(e))
          refresh()
        })
    },
    [client, refresh],
  )

  const handleDeactivate = useCallback(() => {
    client
      .deactivateTheme()
      .then(() => {
        clearLlmStyle()
        setActiveTheme(null)
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : String(e))
        refresh()
      })
  }, [client, refresh])

  const handleDelete = useCallback(
    async (r: ReleaseRecord) => {
      if (!(await confirmDialog(tf("themeRemoveConfirm", r.name)))) return
      try {
        await client.deleteRelease(r.kind, r.name)
        // Removing the injected theme: drop its live styles too.
        if (activeTheme === r.name) {
          clearLlmStyle()
          setActiveTheme(null)
        }
        refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        refresh()
      }
    },
    [client, refresh, activeTheme],
  )

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = q
      ? themes.filter(
          (r) =>
            r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
        )
      : themes
    return [...list].sort((a, b) => {
      const cmp =
        sortField === "name"
          ? a.name.localeCompare(b.name)
          : (a.created_at ?? "").localeCompare(b.created_at ?? "")
      return sortOrder === "asc" ? cmp : -cmp
    })
  }, [themes, searchQuery, sortField, sortOrder])

  const currentNames = useMemo(() => new Set(filtered.map((r) => r.name)), [filtered])
  const allSelected = filtered.length > 0 && filtered.every((r) => selectedNames.has(r.name))
  const someSelected = filtered.some((r) => selectedNames.has(r.name))

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

  const batchDelete = useCallback(async () => {
    const names = themes.filter((r) => selectedNames.has(r.name)).map((r) => r.name)
    if (names.length === 0) return
    if (!(await confirmDialog(tf("themesBatchDeleteConfirm", names.length)))) return
    setMenuOpen(false)
    await Promise.allSettled(names.map((n) => client.deleteRelease("theme", n)))
    if (activeTheme && names.includes(activeTheme)) {
      clearLlmStyle()
      setActiveTheme(null)
    }
    setSelectedNames((prev) => {
      const next = new Set(prev)
      names.forEach((n) => next.delete(n))
      return next
    })
    refresh()
  }, [client, refresh, themes, selectedNames, activeTheme])

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center border-b border-border bg-card px-5">
        <div className="flex shrink-0 items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-sm font-medium text-foreground">{t("themesTitle")}</h1>
        </div>
      </div>

      {/* Toolbar (mirrors skills/apps) */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-border bg-card px-5">
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected
            }}
            onChange={toggleSelectAll}
            disabled={filtered.length === 0}
            className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white disabled:cursor-not-allowed disabled:opacity-40"
          />
          {selectedNames.size > 0 ? (
            <span className="shrink-0 text-xs font-medium text-primary">
              {tf("selectedCount", selectedNames.size)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {tf("themesCountLabel", filtered.length)}
            </span>
          )}
        </div>

        <div className="relative shrink-0">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchThemes")}
            className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
          />
        </div>

        <div className="relative shrink-0 rounded">
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as SortField)}
            className="h-6 cursor-pointer appearance-none border-none bg-transparent pl-2 pr-5 text-xs font-medium text-foreground/80 hover:text-foreground focus:outline-none"
          >
            <option value="time">{t("sortByCreated")}</option>
            <option value="name">{t("sortByName")}</option>
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

        {activeTheme && (
          <button
            type="button"
            onClick={handleDeactivate}
            title={t("themeReset")}
            className="flex h-6 shrink-0 cursor-pointer items-center rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("themeReset")}
          </button>
        )}

        <button
          type="button"
          onClick={refresh}
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

      {menuOpen &&
        createPortal(
          <DropdownMenu menuRef={menuRef} onClose={() => setMenuOpen(false)}>
            <button
              type="button"
              onClick={() => void batchDelete()}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 size={12} />
              {t("themesBatchDelete")}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <p className="text-[12px] text-muted-foreground/60">
            {themes.length === 0 ? t("themesEmpty") : t("themesNoMatch")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
            {filtered.map((r) => (
              <ReleaseCard
                key={`${r.kind}/${r.name}`}
                release={r}
                basePath={basePath}
                onOpenSession={onOpenSession}
                onDelete={handleDelete}
                selected={selectedNames.has(r.name)}
                onToggleSelect={toggleSelect}
                isActive={activeTheme === r.name}
                onActivate={handleActivate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
