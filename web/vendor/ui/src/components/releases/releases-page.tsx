import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  MoreHorizontal,
  Package,
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
import { fileCategory, type FileCategory } from "@agentchat/lib/releases"
import { DropdownMenu } from "@agentchat/components/shared/dropdown-menu"
import { ReleaseCard } from "./release-card"

type SortField = "time" | "name"
type SortOrder = "asc" | "desc"

/**
 * Releases ("发布内容") page — the agent's published deliverables
 * (`kind=file`, served at /public/*), each linking back to the conversation
 * that produced it. Saved themes moved to their own Themes page; installed
 * apps live on the Apps page. Shares the skills/apps toolbar (select-all,
 * search, type filter, sort, batch, refresh).
 */
interface ReleasesPageProps {
  basePath?: string
  /** Open a conversation in the chat view (provenance link on cards). */
  onOpenSession?: (id: string) => void
}

export function ReleasesPage({ basePath = "", onOpenSession }: ReleasesPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])
  const [files, setFiles] = useState<ReleaseRecord[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const [searchQuery, setSearchQuery] = useState("")
  const [filter, setFilter] = useState<FileCategory | "all">("all")
  const [sortField, setSortField] = useState<SortField>("time")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    client
      .listReleases({ kind: "file" })
      .then((rs) => setFiles(rs.filter((r) => r.kind === "file")))
      .finally(() => setRefreshing(false))
  }, [client])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleDelete = useCallback(
    async (r: ReleaseRecord) => {
      if (!(await confirmDialog(tf("releaseDeleteConfirm", r.name)))) return
      try {
        await client.deleteRelease(r.kind, r.name)
        refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
        refresh()
      }
    },
    [client, refresh],
  )

  // Categories actually present, in a stable order — the type dropdown appears
  // only when there is more than one to choose between.
  const presentCategories = useMemo(() => {
    const order: FileCategory[] = ["page", "image", "document", "other"]
    const present = new Set(files.map((r) => fileCategory(r.name)))
    return order.filter((c) => present.has(c))
  }, [files])
  // Self-heal a stale selection (e.g. the last file of a type was deleted).
  const effectiveFilter =
    filter !== "all" && !presentCategories.includes(filter) ? "all" : filter

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let list = effectiveFilter === "all" ? files : files.filter((r) => fileCategory(r.name) === effectiveFilter)
    if (q) {
      list = list.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
      )
    }
    return [...list].sort((a, b) => {
      const cmp =
        sortField === "name"
          ? a.name.localeCompare(b.name)
          : (a.created_at ?? "").localeCompare(b.created_at ?? "")
      return sortOrder === "asc" ? cmp : -cmp
    })
  }, [files, effectiveFilter, searchQuery, sortField, sortOrder])

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
    const names = files.filter((r) => selectedNames.has(r.name)).map((r) => r.name)
    if (names.length === 0) return
    if (!(await confirmDialog(tf("releasesBatchDeleteConfirm", names.length)))) return
    setMenuOpen(false)
    await Promise.allSettled(names.map((n) => client.deleteRelease("file", n)))
    setSelectedNames((prev) => {
      const next = new Set(prev)
      names.forEach((n) => next.delete(n))
      return next
    })
    refresh()
  }, [client, refresh, files, selectedNames])

  const categoryLabel = (c: FileCategory) =>
    c === "page"
      ? t("releaseFilterPage")
      : c === "image"
        ? t("releaseFilterImage")
        : c === "document"
          ? t("releaseFilterDocument")
          : t("releaseFilterOther")

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center border-b border-border bg-card px-5">
        <div className="flex shrink-0 items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-sm font-medium text-foreground">{t("releasesTitle")}</h1>
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
              {tf("releasesCountLabel", filtered.length)}
            </span>
          )}
        </div>

        <div className="relative shrink-0">
          <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchReleases")}
            className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
          />
        </div>

        {presentCategories.length > 1 && (
          <div className="relative shrink-0 rounded">
            <select
              value={effectiveFilter}
              onChange={(e) => setFilter(e.target.value as FileCategory | "all")}
              className="h-6 cursor-pointer appearance-none border-none bg-transparent pl-2 pr-5 text-xs font-medium text-foreground/80 hover:text-foreground focus:outline-none"
            >
              <option value="all">{t("filterAll")}</option>
              {presentCategories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={10}
              className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        )}

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
              {t("releasesBatchDelete")}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <p className="text-[12px] text-muted-foreground/60">
            {files.length === 0 ? t("releasesEmpty") : t("releasesNoMatch")}
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
