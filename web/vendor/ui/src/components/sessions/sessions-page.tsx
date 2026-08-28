import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  MessagesSquare,
  Search,
  RefreshCw,
  MessageSquare,
  Trash2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Globe,
  MoreHorizontal,
  MessageSquarePlus,
  Pencil,
  Check,
  Pin,
  PinOff,
  SquareTerminal,
  Terminal,
} from "lucide-react"
import { createPortal } from "react-dom"
import { createChatClient } from "@agentchat/client"
import { cn, portalContainer, spaAnchorClick } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { toast } from "@agentchat/components/ui/toast"
import type { SessionSummary } from "@agentchat/types"

interface SessionsPageProps {
  basePath?: string
  /** The session currently open in the chat view (subtly highlighted). */
  activeId?: string | null
  onOpen: (id: string) => void
  onNewChat: () => void
  /** Bump to force a re-fetch (e.g. after a chat turn created/renamed a session). */
  refreshKey?: number
  /** When set, each card's hit area is a real anchor (`href = sessionHref(id)`)
   *  so right/middle/modified clicks open the session in a new tab; plain
   *  left-click still goes through `onOpen` (in-app switch). */
  sessionHref?: (id: string) => string
}

type SortField = "time" | "messages"
type SortOrder = "desc" | "asc"
type FilterMode = "all" | "active" | "pinned"

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t("timeJustNow")
  if (mins < 60) return tf("timeMinAgo", mins)
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tf("timeHourAgo", hrs)
  const days = Math.floor(hrs / 24)
  return tf("timeDayAgo", days)
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

/** Origin glyph on the card's top-right: where the session was created.
 *  Full brand color: an identity mark, not
 *  gray metadata. `tui` = on-device TUI, `terminal` = web-terminal assistant
 *  panel, anything else = main web chat. */
function OriginIcon({ origin }: { origin?: string }) {
  const [Icon, label] =
    origin === "tui"
      ? ([SquareTerminal, t("originTui")] as const)
      : origin === "terminal"
        ? ([Terminal, t("originTerminal")] as const)
        : ([Globe, t("originWeb")] as const)
  return (
    <span className="flex items-center" title={label}>
      <Icon size={13} strokeWidth={1.75} className="text-primary" aria-label={label} />
    </span>
  )
}

/** Portal-anchored dropdown for the `...` (batch) menu. */
function DropdownMenu({
  menuRef,
  onClose,
  children,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  children: React.ReactNode
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.right - 144 })
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
      className="w-36 rounded-md border border-border bg-card p-1 shadow-md animate-in fade-in-0 zoom-in-95"
    >
      {children}
    </div>
  )
}

/**
 * Full-featured conversation manager mounted by [`CopilotApp`] when the user
 * navigates to the "sessions" view: search, sort, pin, rename, batch-delete,
 * pagination and a responsive card grid (no origin / auth / router coupling).
 */
export function SessionsPage({
  basePath = "",
  activeId,
  onOpen,
  onNewChat,
  refreshKey = 0,
  sessionHref,
}: SessionsPageProps) {
  const client = useMemo(() => createChatClient(basePath), [basePath])

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [sortField, setSortField] = useState<SortField>("time")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [filterMode, setFilterMode] = useState<FilterMode>("all")
  const [page, setPage] = useState(1)
  const pageSize = 100
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [savedId, setSavedId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true)
      client
        .listSessions(searchQuery)
        .then((list) => {
          setSessions(Array.isArray(list) ? list : [])
          setError(null)
        })
        .catch(() => {
          if (!silent) setError(t("loadFailed"))
        })
        .finally(() => {
          if (!silent) setLoading(false)
        })
    },
    [client, searchQuery],
  )

  // First mount loads with a spinner; later refreshKey bumps (a chat turn
  // created/renamed a session) and search-query edits refresh silently to
  // avoid a loading flicker. Edits are debounced: search runs server-side
  // (title + message content), one request per keystroke would be wasteful.
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      load(false)
      return
    }
    const timer = setTimeout(() => load(true), 250)
    return () => clearTimeout(timer)
  }, [load, refreshKey])

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!(await confirmDialog(t("deleteConfirm")))) return
    client
      .deleteSession(id)
      .then(() => {
        setSessions((prev) => prev.filter((s) => s.id !== id))
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      })
      .catch(() => toast.error(t("operationFailed")))
  }

  const handleTogglePin = (id: string, currentPinned: boolean, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next = !currentPinned
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: next } : s)))
    client.updateSession(id, { pinned: next }).catch(() => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: currentPinned } : s)))
      toast.error(t("operationFailed"))
    })
  }

  const startEditing = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(id)
    setEditingTitle(currentTitle)
  }

  const commitEditing = () => {
    if (!editingId) return
    const id = editingId
    const trimmed = editingTitle.trim()
    setEditingId(null)
    setEditingTitle("")
    if (trimmed) {
      client
        .updateSession(id, { title: trimmed })
        .then(() => {
          setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s)))
          setSavedId(id)
          setTimeout(() => setSavedId((prev) => (prev === id ? null : prev)), 1500)
        })
        .catch(() => toast.error(t("operationFailed")))
    }
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditingTitle("")
  }

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  // Search happens server-side (title + message content, see
  // GET /api/sessions?q=); the mode filter and sorting remain client-side.
  const filtered = useMemo(() => {
    const scoped = sessions.filter((s) =>
      filterMode === "active" ? s.running : filterMode === "pinned" ? s.pinned : true,
    )
    const sorted = [...scoped].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      let cmp: number
      if (sortField === "messages") {
        cmp = (a.message_count ?? 0) - (b.message_count ?? 0)
      } else {
        cmp = new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime()
      }
      return sortOrder === "asc" ? cmp : -cmp
    })
    return sorted
  }, [sessions, sortField, sortOrder, filterMode])

  // While anything is running, keep the list fresh (silently, page visible
  // only) so the active group and running dots track reality.
  const anyRunning = useMemo(() => sessions.some((s) => s.running), [sessions])
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => {
      if (!document.hidden) load(true)
    }, 5000)
    return () => clearInterval(timer)
  }, [anyRunning, load])

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    const visibleIds = new Set(filtered.map((s) => s.id))
    const ids = Array.from(selectedIds).filter((id) => visibleIds.has(id))
    if (ids.length === 0) return
    if (!(await confirmDialog(tf("batchDeleteConfirm", ids.length)))) return
    setMenuOpen(false)
    const results = await Promise.allSettled(ids.map((id) => client.deleteSession(id)))
    const succeeded = new Set<string>()
    results.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.add(ids[i])
    })
    if (succeeded.size < ids.length) toast.error(t("operationFailed"))
    if (succeeded.size > 0) {
      setSessions((prev) => prev.filter((s) => !succeeded.has(s.id)))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        succeeded.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  // Grouping: pinned → active (running, unpinned) → the rest. A pinned
  // running session stays in the pinned group (placement follows the pin,
  // the running dot still shows).
  const pinnedList = useMemo(() => filtered.filter((s) => s.pinned), [filtered])
  const activeList = useMemo(
    () => filtered.filter((s) => !s.pinned && s.running),
    [filtered],
  )
  const unpinnedList = useMemo(
    () => filtered.filter((s) => !s.pinned && !s.running),
    [filtered],
  )

  // Pagination applies only to the non-pinned list; the pinned section always
  // renders in full atop the page.
  const total = unpinnedList.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [searchQuery])

  const currentUnpinned = useMemo(() => {
    const start = (page - 1) * pageSize
    return unpinnedList.slice(start, start + pageSize)
  }, [unpinnedList, page])

  const currentData = useMemo(
    () => [...pinnedList, ...activeList, ...currentUnpinned],
    [pinnedList, activeList, currentUnpinned],
  )
  const currentIds = useMemo(() => new Set(currentData.map((s) => s.id)), [currentData])
  const allCurrentSelected = currentData.length > 0 && currentData.every((s) => selectedIds.has(s.id))
  const someCurrentSelected = currentData.some((s) => selectedIds.has(s.id))

  const toggleSelectAll = () => {
    if (allCurrentSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        currentIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        currentIds.forEach((id) => next.add(id))
        return next
      })
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // The card's hit area is a sibling <button> stretched to inset-0 (z-0). The
  // content layer is pointer-events-none so clicks fall through to it, while
  // the checkbox / rename input / action cluster re-enable pointer events and
  // sit above via relative+z-10. (No nested interactive elements.)
  const renderCard = (s: SessionSummary) => {
    const selected = selectedIds.has(s.id)
    const isActive = s.id === activeId
    return (
      <div
        key={s.id}
        className={cn(
          "group relative flex min-w-0 w-full overflow-hidden rounded-[6px] border bg-card transition-colors",
          selected
            ? "border-primary/50 bg-primary/5"
            : isActive
              ? "border-primary/40"
              : "border-border hover:border-primary/30",
        )}
      >
        {sessionHref ? (
          // Real anchor hit area: right/middle/modified clicks open the
          // session in a new tab; plain left-click switches in-app.
          <a
            href={sessionHref(s.id)}
            onClick={(e) => spaAnchorClick(e, () => onOpen(s.id))}
            aria-label={s.title || t("untitled")}
            tabIndex={-1}
            className="absolute inset-0 z-0 cursor-pointer rounded-[6px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => onOpen(s.id)}
            aria-label={s.title || t("untitled")}
            tabIndex={-1}
            className="absolute inset-0 z-0 cursor-pointer rounded-[6px]"
          />
        )}
        <div className="pointer-events-none flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-3 py-3.5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleSelect(s.id)}
              className="pointer-events-auto relative z-10 h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white"
            />
            {editingId === s.id ? (
              <input
                autoFocus
                type="text"
                value={editingTitle}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEditing()
                  if (e.key === "Escape") cancelEditing()
                }}
                className="pointer-events-auto relative z-10 min-w-0 flex-1 border-b border-primary/50 bg-transparent py-0 text-[11px] font-medium text-foreground outline-none"
              />
            ) : (
              <h3
                className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium leading-snug text-foreground"
                title={s.title || t("untitled")}
              >
                {s.running && (
                  <span
                    className="relative flex h-2 w-2 shrink-0"
                    title={t("runningBadge")}
                    aria-label={t("runningBadge")}
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                )}
                <span className="truncate">{s.title || t("untitled")}</span>
              </h3>
            )}
            <span className="flex shrink-0 items-center">
              {savedId === s.id ? (
                <Check size={14} className="text-green-500" />
              ) : (
                <OriginIcon origin={s.origin} />
              )}
            </span>
          </div>

          <div className="flex items-center text-[10px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground/70">
            <span className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-0.5">
                <MessageSquare size={8} />
                {s.message_count}
              </span>
              <span title={formatDate(s.updated_at)}>{relativeTime(s.updated_at)}</span>
            </span>
            <span className="ml-auto truncate tabular-nums">{formatDate(s.created_at)}</span>
          </div>
        </div>
        <div className="pointer-events-auto absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md bg-card/95 px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-border/50 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <button
            type="button"
            onClick={(e) => handleTogglePin(s.id, s.pinned, e)}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground",
              s.pinned ? "text-primary" : "text-muted-foreground/40",
            )}
            title={s.pinned ? t("unpin") : t("pin")}
          >
            {s.pinned ? <PinOff size={11} /> : <Pin size={11} />}
          </button>
          <button
            type="button"
            onClick={(e) => startEditing(s.id, s.title || "", e)}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
            title={t("rename")}
          >
            {savedId === s.id ? (
              <Check size={11} className="text-green-500" />
            ) : (
              <Pencil size={11} />
            )}
          </button>
          <button
            type="button"
            onClick={(e) => handleDelete(s.id, e)}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
            title={t("delete")}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    )
  }

  const renderContent = () => {
    if (loading && sessions.length === 0) {
      return (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <RefreshCw size={18} className="animate-spin" />
        </div>
      )
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          >
            <RefreshCw size={12} />
            {t("refresh")}
          </button>
        </div>
      )
    }

    // With server-side search an empty list can just mean "no match": only
    // show the start-chat empty state when there is no active query.
    if (sessions.length === 0 && !searchQuery.trim()) {
      return (
        <div className="flex h-full flex-col items-center justify-center pb-20 text-center">
          <MessageSquare size={36} className="mb-3 text-muted-foreground/30" strokeWidth={1.5} />
          <p className="text-sm font-medium text-foreground">{t("noSessions")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noSessionsDesc")}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={onNewChat}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              <MessageSquare size={12} />
              {t("startChat")}
            </button>
          </div>
        </div>
      )
    }

    if (filtered.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-sm font-medium text-foreground">{t("noSessions")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noSessionsDesc")}</p>
        </div>
      )
    }

    return (
      <div className="space-y-5 px-4 pb-4 pt-3">
        {pinnedList.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-primary" />
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("pinnedLabel")}
                <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                  {pinnedList.length}
                </span>
              </h3>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-4">
              {pinnedList.map(renderCard)}
            </div>
          </div>
        )}
        {activeList.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </div>
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("groupActive")}
                <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                  {activeList.length}
                </span>
              </h3>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-4">
              {activeList.map(renderCard)}
            </div>
          </div>
        )}
        {currentUnpinned.length > 0 && (
          <div className="space-y-2">
            {(pinnedList.length > 0 || activeList.length > 0) && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                <h3 className="text-xs font-medium text-muted-foreground">{t("otherSessions")}</h3>
              </div>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-4">
              {currentUnpinned.map(renderCard)}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-2">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-sm font-medium text-foreground">{t("sessions")}</h1>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 overflow-x-auto border-b border-border bg-card px-5">
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            type="checkbox"
            checked={allCurrentSelected && currentData.length > 0}
            ref={(el) => {
              if (el) el.indeterminate = someCurrentSelected && !allCurrentSelected
            }}
            onChange={toggleSelectAll}
            className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white"
          />
          {selectedIds.size > 0 ? (
            <span className="shrink-0 text-xs font-medium text-primary">
              {tf("selectedCount", selectedIds.size)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {tf("sessionsCount", filtered.length)}
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
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPage(1)
            }}
            placeholder={t("searchSessions")}
            className="h-6 w-32 border-none bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder-muted-foreground transition-all focus:w-48 focus:outline-none"
          />
        </div>

        <div className="relative shrink-0 rounded">
          <select
            value={filterMode}
            onChange={(e) => {
              setFilterMode(e.target.value as FilterMode)
              setPage(1)
            }}
            className={cn(
              "h-6 cursor-pointer appearance-none border-none bg-transparent pl-2 pr-5 text-xs font-medium focus:outline-none",
              filterMode === "all"
                ? "text-foreground/80 hover:text-foreground"
                : "text-primary",
            )}
          >
            <option value="all">{t("filterAll")}</option>
            <option value="active">{t("filterActive")}</option>
            <option value="pinned">{t("filterPinned")}</option>
          </select>
          <ChevronDown
            size={10}
            className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>

        <div className="relative shrink-0 rounded">
          <select
            value={sortField}
            onChange={(e) => {
              setSortField(e.target.value as SortField)
              setPage(1)
            }}
            className="h-6 cursor-pointer appearance-none border-none bg-transparent pl-2 pr-5 text-xs font-medium text-foreground/80 hover:text-foreground focus:outline-none"
          >
            <option value="time">{t("sortByTime")}</option>
            <option value="messages">{t("sortByMessages")}</option>
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

        <button
          type="button"
          onClick={onNewChat}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t("newChat")}
        >
          <MessageSquarePlus size={12} />
        </button>

        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title={t("refresh")}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("batchDelete")}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>

      {menuOpen &&
        createPortal(
          <DropdownMenu menuRef={menuRef} onClose={closeMenu}>
            <button
              type="button"
              onClick={handleBatchDelete}
              disabled={selectedIds.size === 0}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={12} />
              {t("batchDelete")}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {/* Main content */}
      <div className="flex-1 overflow-y-auto bg-background">
        <div className="mx-auto h-full">{renderContent()}</div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex h-9 shrink-0 items-center justify-center gap-1.5 border-t border-border/40 px-5">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="select-none text-[11px] tabular-nums text-muted-foreground/60">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
