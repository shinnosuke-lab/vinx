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
  Archive,
  ArchiveRestore,
  Tag,
  Clock,
} from "lucide-react"
import { createPortal } from "react-dom"
import { createChatClient } from "@agentchat/client"
import { clearDraft } from "@agentchat/lib/composer-draft"
import { cn, portalContainer, spaAnchorClick } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { toast } from "@agentchat/components/ui/toast"
import { CategoryPicker, DropdownMenu, MENU_ITEM_CLS } from "./category-picker"
import type { SessionPatch, SessionSummary } from "@agentchat/types"

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

type SortField = "time" | "created" | "messages" | "title"
type SortOrder = "desc" | "asc"
type FilterMode = "all" | "active" | "pinned"
/** Axis the card grid is sectioned by. `time` = last-activity bucket (the
 *  default), `category` = the manual per-session label, `none` = the flat
 *  pinned → running → rest layout. */
type GroupBy = "time" | "category" | "origin" | "none"

const SORT_FIELDS: readonly SortField[] = ["time", "created", "messages", "title"]
const SORT_ORDERS: readonly SortOrder[] = ["desc", "asc"]
const GROUP_AXES: readonly GroupBy[] = ["time", "category", "origin", "none"]

// View preferences survive reloads (per browser); nothing here is session data.
const GROUP_BY_KEY = "acc.sessions.groupBy"
const SORT_FIELD_KEY = "acc.sessions.sortField"
const SORT_ORDER_KEY = "acc.sessions.sortOrder"
const COLLAPSED_KEY = "acc.sessions.collapsed"

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode / quota exceeded: the preference simply doesn't persist.
  }
}

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")
    return new Set(
      Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [],
    )
  } catch {
    return new Set()
  }
}

function timestamp(iso: string | null | undefined): number {
  const ts = iso ? new Date(iso).getTime() : NaN
  return Number.isNaN(ts) ? 0 : ts
}

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

type TimeBucket = "today" | "yesterday" | "week" | "month" | "older"
const TIME_BUCKETS: readonly TimeBucket[] = ["today", "yesterday", "week", "month", "older"]
const DAY_MS = 86_400_000

function timeBucket(iso: string | null | undefined, startOfToday: number): TimeBucket {
  const ts = timestamp(iso)
  if (ts >= startOfToday) return "today"
  if (ts >= startOfToday - DAY_MS) return "yesterday"
  if (ts >= startOfToday - 7 * DAY_MS) return "week"
  if (ts >= startOfToday - 30 * DAY_MS) return "month"
  return "older"
}

function timeBucketLabel(bucket: TimeBucket): string {
  switch (bucket) {
    case "today":
      return t("timeToday")
    case "yesterday":
      return t("timeYesterday")
    case "week":
      return t("timeLast7Days")
    case "month":
      return t("timeLast30Days")
    default:
      return t("timeOlder")
  }
}

type OriginKind = "web" | "tui" | "terminal"

function originKind(origin?: string): OriginKind {
  return origin === "tui" || origin === "terminal" ? origin : "web"
}

function groupByLabel(axis: GroupBy): string {
  switch (axis) {
    case "time":
      return t("groupByTime")
    case "category":
      return t("groupByCategory")
    case "origin":
      return t("groupByOrigin")
    default:
      return t("groupByNone")
  }
}

function sortFieldLabel(field: SortField): string {
  switch (field) {
    case "created":
      return t("sessionSortCreated")
    case "messages":
      return t("sortByMessages")
    case "title":
      return t("sessionSortTitle")
    default:
      return t("sortByTime")
  }
}

function compareSessions(
  a: SessionSummary,
  b: SessionSummary,
  field: SortField,
  order: SortOrder,
): number {
  let cmp: number
  switch (field) {
    case "messages":
      cmp = (a.message_count ?? 0) - (b.message_count ?? 0)
      break
    case "created":
      cmp = timestamp(a.created_at) - timestamp(b.created_at)
      break
    case "title":
      cmp = (a.title || "").localeCompare(b.title || "", undefined, {
        sensitivity: "base",
        numeric: true,
      })
      break
    default:
      cmp = timestamp(a.updated_at) - timestamp(b.updated_at)
  }
  return order === "asc" ? cmp : -cmp
}

/** One section of the grid. `value` is the raw axis value (time bucket id,
 *  category text, origin kind; "" = the catch-all bucket). The
 *  display label is derived at render time so it follows the UI language. */
interface SessionGroup {
  key: string
  axis: GroupBy
  value: string
  items: SessionSummary[]
}

function buildGroups(
  list: SessionSummary[],
  axis: GroupBy,
  sortField: SortField,
  sortOrder: SortOrder,
): SessionGroup[] {
  if (list.length === 0) return []
  if (axis === "none") return [{ key: "none:all", axis, value: "", items: list }]
  const map = new Map<string, SessionGroup>()
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  // Time buckets follow the column being sorted on: created date when
  // sorting by creation, last activity otherwise.
  const timeField = sortField === "created" ? "created_at" : "updated_at"
  for (const s of list) {
    const value =
      axis === "category"
        ? (s.category ?? "").trim()
        : axis === "origin"
          ? originKind(s.origin)
          : timeBucket(s[timeField], startOfToday)
    const key = `${axis}:${value}`
    let group = map.get(key)
    if (!group) {
      group = { key, axis, value, items: [] }
      map.set(key, group)
    }
    group.items.push(s)
  }
  if (axis === "time") {
    // Fixed chronological order, flipped along with an ascending sort.
    const order = sortOrder === "asc" ? [...TIME_BUCKETS].reverse() : TIME_BUCKETS
    return order
      .map((bucket) => map.get(`time:${bucket}`))
      .filter((g): g is SessionGroup => g !== undefined)
  }
  // Insertion order follows the sorted list, so the group holding the most
  // relevant session leads; the catch-all bucket (no category)
  // always sinks to the bottom.
  const groups = Array.from(map.values())
  const catchAll = groups.findIndex((g) => g.value === "")
  if (catchAll >= 0) groups.push(...groups.splice(catchAll, 1))
  return groups
}

function groupTitle(group: SessionGroup): string {
  switch (group.axis) {
    case "category":
      return group.value || t("groupUncategorized")
    case "origin":
      return group.value === "tui"
        ? t("groupOriginTui")
        : group.value === "terminal"
          ? t("groupOriginTerminal")
          : t("groupOriginWeb")
    case "time":
      return timeBucketLabel(group.value as TimeBucket)
    default:
      return t("otherSessions")
  }
}

/** Section-header glyph for a group axis (mirrors the card-level icons). */
function GroupGlyph({ axis, value }: { axis: GroupBy; value: string }) {
  const cls = "shrink-0 text-muted-foreground/70"
  switch (axis) {
    case "time":
      return <Clock size={12} className={cls} />
    case "category":
      return <Tag size={12} className={cls} />
    case "origin": {
      const Icon = value === "tui" ? SquareTerminal : value === "terminal" ? Terminal : Globe
      return <Icon size={12} className={cls} />
    }
    default:
      return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
  }
}

/** Pulsing emerald dot: a turn is in flight (card title + "Active" header). */
function RunningDot({ size }: { size: "sm" | "md" }) {
  const dim = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"
  return (
    <span className={cn("relative flex shrink-0", dim)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      <span className={cn("relative inline-flex rounded-full bg-emerald-500", dim)} />
    </span>
  )
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

/** Card hover-cluster icon button (pin / category / rename / archive). */
const ACTION_BTN_CLS =
  "flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/40"

/**
 * Full-featured conversation manager mounted by [`CopilotApp`] when the user
 * navigates to the "sessions" view: search, sort, group (time / category /
 * origin), pin, rename, categorise, archive, batch actions,
 * pagination and a responsive card grid. Self-contained for agent-core (no
 * origin / auth / toast / router dependencies).
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
  const [sortField, setSortField] = useState<SortField>(() =>
    readChoice(SORT_FIELD_KEY, SORT_FIELDS, "time"),
  )
  const [sortOrder, setSortOrder] = useState<SortOrder>(() =>
    readChoice(SORT_ORDER_KEY, SORT_ORDERS, "desc"),
  )
  const [filterMode, setFilterMode] = useState<FilterMode>("all")
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    readChoice(GROUP_BY_KEY, GROUP_AXES, "time"),
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 100
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [savedId, setSavedId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Category picker: the sessions it applies to + the button it hangs off
  // (a card's tag button or the batch `...` menu).
  const [categoryTarget, setCategoryTarget] = useState<string[] | null>(null)
  const categoryAnchorRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    writeStored(GROUP_BY_KEY, groupBy)
  }, [groupBy])
  useEffect(() => {
    writeStored(SORT_FIELD_KEY, sortField)
  }, [sortField])
  useEffect(() => {
    writeStored(SORT_ORDER_KEY, sortOrder)
  }, [sortOrder])
  useEffect(() => {
    writeStored(COLLAPSED_KEY, JSON.stringify(Array.from(collapsed)))
  }, [collapsed])

  // One request covers both the live grid and the archive section: the
  // server returns every scope and the split happens on `archived_at`.
  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true)
      client
        .listSessions(searchQuery, "all")
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
        clearDraft(id)
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
  const closeCategoryPicker = useCallback(() => setCategoryTarget(null), [])

  /** PATCH every id with `patch`, mirroring it locally first (optimistic
   *  UI); only the rows whose request failed are rolled back. */
  const patchSessions = async (
    ids: string[],
    patch: SessionPatch,
    local: Partial<SessionSummary>,
  ) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const snapshot = new Map(
      sessions.filter((s) => idSet.has(s.id)).map((s) => [s.id, s] as const),
    )
    setSessions((prev) => prev.map((s) => (idSet.has(s.id) ? { ...s, ...local } : s)))
    const results = await Promise.allSettled(ids.map((id) => client.updateSession(id, patch)))
    const failed = new Set(ids.filter((_, i) => results[i].status === "rejected"))
    if (failed.size > 0) {
      setSessions((prev) => prev.map((s) => (failed.has(s.id) ? (snapshot.get(s.id) ?? s) : s)))
      toast.error(t("operationFailed"))
    }
  }

  /** Archive (`true`) or restore (`false`) sessions. Running conversations
   *  are skipped when archiving: the turn's completion un-archives on the
   *  server anyway, so it would only flicker. Archiving also un-pins. */
  const setArchived = async (ids: string[], archived: boolean) => {
    const byId = new Map(sessions.map((s) => [s.id, s] as const))
    const targets = ids.filter((id) => {
      const s = byId.get(id)
      if (!s) return false
      return archived ? !s.archived_at && !s.running : !!s.archived_at
    })
    if (targets.length === 0) return
    setMenuOpen(false)
    await patchSessions(
      targets,
      { archived },
      archived ? { archived_at: new Date().toISOString(), pinned: false } : { archived_at: null },
    )
    // The cards move between the grid and the (usually collapsed) archive
    // section; keeping them selected would be invisible state.
    setSelectedIds((prev) => {
      const next = new Set(prev)
      targets.forEach((id) => next.delete(id))
      return next
    })
    // Pick up the server's timestamp (and whatever else moved meanwhile).
    load(true)
  }

  const openCategoryPicker = (ids: string[], anchor: HTMLElement) => {
    if (categoryTarget && categoryAnchorRef.current === anchor) {
      setCategoryTarget(null)
      return
    }
    categoryAnchorRef.current = anchor
    setCategoryTarget(ids)
  }

  const applyCategory = (category: string | null) => {
    const ids = categoryTarget ?? []
    setCategoryTarget(null)
    const value = category?.trim() || null
    void patchSessions(ids, { category: value }, { category: value })
  }

  const categoryTargets = useMemo(
    () => (categoryTarget ? sessions.filter((s) => categoryTarget.includes(s.id)) : []),
    [categoryTarget, sessions],
  )
  const sharedCategory = useMemo(() => {
    if (categoryTargets.length === 0) return null
    const first = categoryTargets[0].category ?? null
    return categoryTargets.every((s) => (s.category ?? null) === first) ? first : null
  }, [categoryTargets])
  const canClearCategory = categoryTargets.some((s) => !!s.category)
  const knownCategories = useMemo(
    () =>
      Array.from(
        new Set(sessions.map((s) => s.category?.trim()).filter((c): c is string => !!c)),
      ).sort((a, b) => a.localeCompare(b)),
    [sessions],
  )

  // Search happens server-side (title + message content, see
  // GET /api/sessions?q=&scope=all); the archive split, mode filter, sorting
  // and grouping remain client-side.
  const liveSessions = useMemo(() => sessions.filter((s) => !s.archived_at), [sessions])
  const archivedSessions = useMemo(
    () =>
      sessions
        .filter((s) => !!s.archived_at)
        .sort((a, b) => timestamp(b.archived_at) - timestamp(a.archived_at)),
    [sessions],
  )

  const filtered = useMemo(() => {
    const scoped = liveSessions.filter((s) =>
      filterMode === "active" ? s.running : filterMode === "pinned" ? s.pinned : true,
    )
    return [...scoped].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return compareSessions(a, b, sortField, sortOrder)
    })
  }, [liveSessions, sortField, sortOrder, filterMode])

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

  // Sections: pinned → running ("none" axis only) → the rest, grouped by the
  // chosen axis. A pinned running session stays in the pinned group
  // (placement follows the pin, the running dot still shows); with a real
  // grouping axis running sessions sit in their own time/category/… group.
  const pinnedList = useMemo(() => filtered.filter((s) => s.pinned), [filtered])
  const splitRunning = groupBy === "none"
  const activeList = useMemo(
    () => (splitRunning ? filtered.filter((s) => !s.pinned && s.running) : []),
    [filtered, splitRunning],
  )
  const restList = useMemo(
    () => filtered.filter((s) => !s.pinned && !(splitRunning && s.running)),
    [filtered, splitRunning],
  )

  // Pagination applies only to the non-pinned list; the pinned section always
  // renders in full atop the page. Groups are cut from the current page.
  const total = restList.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [searchQuery])

  const currentRest = useMemo(() => {
    const start = (page - 1) * pageSize
    return restList.slice(start, start + pageSize)
  }, [restList, page])

  const groups = useMemo(
    () => buildGroups(currentRest, groupBy, sortField, sortOrder),
    [currentRest, groupBy, sortField, sortOrder],
  )

  // The archive section only exists in the unfiltered view (archived
  // sessions are never running or pinned) and its cards only count as
  // "visible" — for select-all and batch actions — while it is expanded.
  const showArchive = filterMode === "all" && archivedSessions.length > 0
  const archivedVisible = useMemo(
    () => (showArchive && archivedOpen ? archivedSessions : []),
    [showArchive, archivedOpen, archivedSessions],
  )

  const currentData = useMemo(
    () => [...pinnedList, ...activeList, ...currentRest, ...archivedVisible],
    [pinnedList, activeList, currentRest, archivedVisible],
  )
  const currentIds = useMemo(() => new Set(currentData.map((s) => s.id)), [currentData])
  const allCurrentSelected =
    currentData.length > 0 && currentData.every((s) => selectedIds.has(s.id))
  const someCurrentSelected = currentData.some((s) => selectedIds.has(s.id))
  const selectedVisible = useMemo(
    () => currentData.filter((s) => selectedIds.has(s.id)),
    [currentData, selectedIds],
  )
  const batchArchivable = selectedVisible.filter((s) => !s.archived_at && !s.running)
  const batchRestorable = selectedVisible.filter((s) => !!s.archived_at)

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

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleBatchDelete = async () => {
    const ids = selectedVisible.map((s) => s.id)
    if (ids.length === 0) return
    if (!(await confirmDialog(tf("batchDeleteConfirm", ids.length)))) return
    setMenuOpen(false)
    const results = await Promise.allSettled(ids.map((id) => client.deleteSession(id)))
    const succeeded = new Set<string>()
    results.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.add(ids[i])
    })
    succeeded.forEach((id) => clearDraft(id))
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

  const handleBatchSetCategory = () => {
    setMenuOpen(false)
    if (menuRef.current && selectedVisible.length > 0) {
      openCategoryPicker(
        selectedVisible.map((s) => s.id),
        menuRef.current,
      )
    }
  }

  // When a search only hits archived conversations, unfold the archive so
  // the results are not hidden behind a collapsed header.
  const onlyArchivedMatch = filtered.length === 0 && showArchive && searchQuery.trim() !== ""
  useEffect(() => {
    if (onlyArchivedMatch) setArchivedOpen(true)
  }, [onlyArchivedMatch])

  // The card's hit area is a sibling <a>/<button> stretched to inset-0 (z-0).
  // The content layer is pointer-events-none so clicks fall through to it,
  // while the checkbox / rename input / action cluster re-enable pointer
  // events and sit above via relative+z-10. (No nested interactive elements.)
  const renderCard = (s: SessionSummary) => {
    const selected = selectedIds.has(s.id)
    const isActive = s.id === activeId
    const archived = !!s.archived_at
    const title = s.title || t("untitled")
    // Cards carry no automatic labels: the only chip is a category the user
    // set.
    const category = (s.category ?? "").trim()
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
          archived && !selected && "opacity-75 hover:opacity-100",
        )}
      >
        {sessionHref ? (
          // Real anchor hit area: right/middle/modified clicks open the
          // session in a new tab; plain left-click switches in-app.
          <a
            href={sessionHref(s.id)}
            onClick={(e) => spaAnchorClick(e, () => onOpen(s.id))}
            aria-label={title}
            tabIndex={-1}
            className="absolute inset-0 z-0 cursor-pointer rounded-[6px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => onOpen(s.id)}
            aria-label={title}
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
                title={title}
              >
                {s.running && (
                  <span
                    className="flex shrink-0"
                    title={t("runningBadge")}
                    aria-label={t("runningBadge")}
                  >
                    <RunningDot size="md" />
                  </span>
                )}
                <span className="truncate">{title}</span>
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

          {category !== "" && (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <span
                className="inline-flex max-w-full items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary"
                title={`${t("category")}: ${category}`}
              >
                <Tag size={9} className="shrink-0" />
                <span className="truncate">{category}</span>
              </span>
            </div>
          )}

          <div className="flex items-center text-[10px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground/70">
            <span className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-0.5">
                <MessageSquare size={8} />
                {s.message_count}
              </span>
              <span title={formatDate(s.updated_at)}>{relativeTime(s.updated_at)}</span>
            </span>
            {archived ? (
              <span
                className="ml-auto flex min-w-0 items-center gap-0.5"
                title={tf("archivedAt", formatDate(s.archived_at))}
              >
                <Archive size={8} className="shrink-0" />
                <span className="truncate">{relativeTime(s.archived_at)}</span>
              </span>
            ) : (
              <span className="ml-auto truncate tabular-nums">{formatDate(s.created_at)}</span>
            )}
          </div>
        </div>
        <div className="pointer-events-auto absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md bg-card/95 px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-border/50 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {!archived && (
            <button
              type="button"
              onClick={(e) => handleTogglePin(s.id, s.pinned, e)}
              className={cn(ACTION_BTN_CLS, s.pinned ? "text-primary" : "text-muted-foreground/40")}
              title={s.pinned ? t("unpin") : t("pin")}
            >
              {s.pinned ? <PinOff size={11} /> : <Pin size={11} />}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openCategoryPicker([s.id], e.currentTarget)
            }}
            className={cn(ACTION_BTN_CLS, category !== "" ? "text-primary" : "text-muted-foreground/40")}
            title={category !== "" ? `${t("category")}: ${category}` : t("setCategory")}
          >
            <Tag size={11} />
          </button>
          <button
            type="button"
            onClick={(e) => startEditing(s.id, s.title || "", e)}
            className={cn(ACTION_BTN_CLS, "text-muted-foreground/40")}
            title={t("rename")}
          >
            {savedId === s.id ? <Check size={11} className="text-green-500" /> : <Pencil size={11} />}
          </button>
          {archived ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void setArchived([s.id], false)
              }}
              className={cn(ACTION_BTN_CLS, "text-muted-foreground/40")}
              title={t("unarchive")}
            >
              <ArchiveRestore size={11} />
            </button>
          ) : (
            <button
              type="button"
              disabled={!!s.running}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void setArchived([s.id], true)
              }}
              className={cn(ACTION_BTN_CLS, "text-muted-foreground/40")}
              title={s.running ? t("archiveRunningHint") : t("archive")}
            >
              <Archive size={11} />
            </button>
          )}
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

  const renderGrid = (items: SessionSummary[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,220px)] gap-4">{items.map(renderCard)}</div>
  )

  /** One axis group: collapsible header + card grid. The header is omitted
   *  for the flat ("none") layout unless pinned/running sections precede it,
   *  matching the classic pinned → running → "other" page. */
  const renderGroup = (group: SessionGroup, withHeader: boolean) => {
    const isCollapsed = withHeader && collapsed.has(group.key)
    return (
      <div key={group.key} className="space-y-2">
        {withHeader && (
          <SectionHeader
            glyph={<GroupGlyph axis={group.axis} value={group.value} />}
            title={groupTitle(group)}
            count={group.items.length}
            tooltip={isCollapsed ? t("expandGroup") : t("collapseGroup")}
            collapsed={isCollapsed}
            onToggle={() => toggleCollapsed(group.key)}
          />
        )}
        {!isCollapsed && renderGrid(group.items)}
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

    if (filtered.length === 0 && !showArchive) {
      return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-sm font-medium text-foreground">{t("noSessions")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noSessionsDesc")}</p>
        </div>
      )
    }

    const pinnedCollapsed = collapsed.has("pinned")
    const groupHeaders = groupBy !== "none" || pinnedList.length > 0 || activeList.length > 0

    return (
      <div className="space-y-5 px-4 pb-4 pt-3">
        {filtered.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {searchQuery.trim() ? t("noLiveSessions") : t("noSessionsDesc")}
          </p>
        )}
        {pinnedList.length > 0 && (
          <div className="space-y-2">
            <SectionHeader
              glyph={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
              title={t("pinnedLabel")}
              count={pinnedList.length}
              tooltip={pinnedCollapsed ? t("expandGroup") : t("collapseGroup")}
              collapsed={pinnedCollapsed}
              onToggle={() => toggleCollapsed("pinned")}
            />
            {!pinnedCollapsed && renderGrid(pinnedList)}
          </div>
        )}
        {activeList.length > 0 && (
          <div className="space-y-2">
            <SectionHeader
              glyph={<RunningDot size="sm" />}
              title={t("groupActive")}
              count={activeList.length}
            />
            {renderGrid(activeList)}
          </div>
        )}
        {groups.map((g) => renderGroup(g, groupHeaders))}
        {showArchive && (
          <div
            className={cn(
              "space-y-2",
              (filtered.length > 0 || pinnedList.length > 0) && "border-t border-border/60 pt-4",
            )}
          >
            <SectionHeader
              glyph={<Archive size={12} className="shrink-0 text-muted-foreground/70" />}
              title={t("archivedSection")}
              count={archivedSessions.length}
              tooltip={archivedOpen ? t("collapseGroup") : t("expandGroup")}
              collapsed={!archivedOpen}
              onToggle={() => setArchivedOpen((v) => !v)}
            />
            {archivedOpen && (
              <>
                <p className="text-[11px] leading-snug text-muted-foreground/70">
                  {t("archivedHint")}
                </p>
                {renderGrid(archivedSessions)}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  const selectCls =
    "h-6 cursor-pointer appearance-none border-none bg-transparent pl-1 pr-5 text-xs font-medium focus:outline-none"

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
              selectCls,
              "pl-2",
              filterMode === "all" ? "text-foreground/80 hover:text-foreground" : "text-primary",
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

        {/* Group axis: labelled so it reads apart from the sort select. */}
        <label className="flex shrink-0 items-center gap-0.5" title={t("groupLabel")}>
          <span className="pl-1 text-[11px] text-muted-foreground">{t("groupLabel")}</span>
          <span className="relative rounded">
            <select
              value={groupBy}
              onChange={(e) => {
                setGroupBy(e.target.value as GroupBy)
                setPage(1)
              }}
              className={cn(
                selectCls,
                groupBy === "none" ? "text-foreground/80 hover:text-foreground" : "text-primary",
              )}
            >
              {GROUP_AXES.map((axis) => (
                <option key={axis} value={axis}>
                  {groupByLabel(axis)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={10}
              className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </span>
        </label>

        <label className="flex shrink-0 items-center gap-0.5" title={t("sortLabel")}>
          <span className="pl-1 text-[11px] text-muted-foreground">{t("sortLabel")}</span>
          <span className="relative rounded">
            <select
              value={sortField}
              onChange={(e) => {
                setSortField(e.target.value as SortField)
                setPage(1)
              }}
              className={cn(selectCls, "text-foreground/80 hover:text-foreground")}
            >
              {SORT_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {sortFieldLabel(field)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={10}
              className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </span>
        </label>

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
            className={cn(
              "flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground",
              menuOpen ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
            title={t("batchActions")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>

      {menuOpen &&
        createPortal(
          <DropdownMenu anchorRef={menuRef} onClose={closeMenu} width={200}>
            <button
              type="button"
              onClick={() => void setArchived(batchArchivable.map((s) => s.id), true)}
              disabled={batchArchivable.length === 0}
              className={cn(MENU_ITEM_CLS, "text-foreground")}
            >
              <Archive size={12} className="shrink-0" />
              {t("batchArchive")}
            </button>
            <button
              type="button"
              onClick={() => void setArchived(batchRestorable.map((s) => s.id), false)}
              disabled={batchRestorable.length === 0}
              className={cn(MENU_ITEM_CLS, "text-foreground")}
            >
              <ArchiveRestore size={12} className="shrink-0" />
              {t("batchUnarchive")}
            </button>
            <button
              type="button"
              onClick={handleBatchSetCategory}
              disabled={selectedVisible.length === 0}
              className={cn(MENU_ITEM_CLS, "text-foreground")}
            >
              <Tag size={12} className="shrink-0" />
              {t("batchSetCategory")}
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={handleBatchDelete}
              disabled={selectedVisible.length === 0}
              className={cn(MENU_ITEM_CLS, "text-destructive hover:bg-destructive/10")}
            >
              <Trash2 size={12} className="shrink-0" />
              {t("batchDelete")}
            </button>
          </DropdownMenu>,
          portalContainer(),
        )}

      {categoryTarget &&
        createPortal(
          <CategoryPicker
            anchorRef={categoryAnchorRef}
            categories={knownCategories}
            current={sharedCategory}
            canClear={canClearCategory}
            onPick={applyCategory}
            onClose={closeCategoryPicker}
          />,
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

/** Section title row. With `onToggle` the whole row is a button that folds
 *  the section (chevron reflects the state); without it, a static label. */
function SectionHeader({
  glyph,
  title,
  count,
  tooltip,
  collapsed = false,
  onToggle,
}: {
  glyph: React.ReactNode
  title: string
  count: number
  tooltip?: string
  collapsed?: boolean
  onToggle?: () => void
}) {
  const body = (
    <>
      {glyph}
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground/60">{count}</span>
    </>
  )
  if (!onToggle) {
    return (
      <h3
        className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground"
        title={tooltip}
      >
        {body}
      </h3>
    )
  }
  return (
    <h3 className="flex min-w-0 items-center text-xs font-medium text-muted-foreground">
      <button
        type="button"
        onClick={onToggle}
        title={tooltip}
        aria-expanded={!collapsed}
        className="flex min-w-0 max-w-full cursor-pointer select-none items-center gap-2 rounded py-0.5 pr-2 text-left transition-colors hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight size={12} className="shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-muted-foreground/60" />
        )}
        {body}
      </button>
    </h3>
  )
}
