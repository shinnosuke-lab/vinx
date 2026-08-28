/**
 * Lightweight imperative toast queue. The visual treatment mirrors Sonner's
 * top-right cards without pulling Sonner into this reusable component package.
 */

import * as React from "react"
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react"
import { cn } from "@agentchat/lib/utils"

export type ToastKind = "info" | "success" | "warning" | "error"

export interface ToastOptions {
  description?: string
  /** `null` keeps the toast visible until explicitly dismissed. */
  duration?: number | null
  /** Stable identity for upsert/dismiss flows such as connection state. */
  key?: string
}

export interface ToastItem {
  id: number
  key?: string
  kind: ToastKind
  title: string
  description?: string
  persistent: boolean
}

type Listener = (items: ToastItem[]) => void
type ToastTarget = number | string

const AUTO_DISMISS_MS = 4000
const MAX_VISIBLE = 4

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<Listener>()
const timers = new Map<number, number>()

function emit() {
  for (const listener of listeners) listener([...items])
}

function clearTimer(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
}

function findItem(target: ToastTarget) {
  return typeof target === "number"
    ? items.find((item) => item.id === target)
    : items.find((item) => item.key === target)
}

function dismiss(target: ToastTarget) {
  const item = findItem(target)
  if (!item) return
  clearTimer(item.id)
  items = items.filter((candidate) => candidate.id !== item.id)
  emit()
}

function scheduleDismiss(item: ToastItem, duration: number | null | undefined) {
  clearTimer(item.id)
  const timeout = duration === undefined ? AUTO_DISMISS_MS : duration
  if (timeout === null || timeout <= 0) return
  timers.set(item.id, window.setTimeout(() => dismiss(item.id), timeout))
}

function capVisible(next: ToastItem[]) {
  const capped = [...next]
  while (capped.length > MAX_VISIBLE) {
    // Keep persistent status notifications when transient operation feedback
    // arrives; evict the oldest transient entry first.
    const index = capped.findIndex((item) => !item.persistent)
    const [removed] = capped.splice(index >= 0 ? index : 0, 1)
    clearTimer(removed.id)
  }
  return capped
}

function push(kind: ToastKind, title: string, options: ToastOptions = {}) {
  const { description, duration, key } = options
  const existing = key
    ? items.find((item) => item.key === key)
    : items.find(
        (item) =>
          item.kind === kind &&
          item.title === title &&
          item.description === description,
      )

  if (existing) {
    // Keyed toasts are upserted so a long-lived status can refresh its copy or
    // severity without creating duplicates. Content-deduped toasts retain
    // their original timeout, matching the previous queue semantics.
    if (key) {
      const updated: ToastItem = {
        ...existing,
        kind,
        title,
        description,
        persistent: duration === null,
      }
      items = items.map((item) => (item.id === existing.id ? updated : item))
      emit()
      scheduleDismiss(updated, duration)
    }
    return existing.id
  }

  const item: ToastItem = {
    id: nextId++,
    key,
    kind,
    title,
    description,
    persistent: duration === null,
  }
  items = capVisible([...items, item])
  emit()
  scheduleDismiss(item, duration)
  return item.id
}

/** Imperative API — usable outside React (e.g. in promise `.catch`). */
export const toast = {
  info: (title: string, options?: ToastOptions) => push("info", title, options),
  success: (title: string, options?: ToastOptions) => push("success", title, options),
  warning: (title: string, options?: ToastOptions) => push("warning", title, options),
  error: (title: string, options?: ToastOptions) => push("error", title, options),
  dismiss,
}

const ICONS: Record<ToastKind, { Icon: LucideIcon; color: string }> = {
  success: { Icon: CheckCircle2, color: "text-emerald-500" },
  error: { Icon: XCircle, color: "text-destructive" },
  warning: { Icon: AlertTriangle, color: "text-amber-500" },
  info: { Icon: Info, color: "text-primary" },
}

/** Mount once in the app shell. */
export function Toaster() {
  const [list, setList] = React.useState<ToastItem[]>(() => [...items])

  React.useEffect(() => {
    const listener: Listener = (next) => setList(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  if (list.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed right-[13px] top-[69px] z-[10000] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
      role="status"
      aria-live="polite"
    >
      {list.map((item) => {
        const { Icon, color } = ICONS[item.kind]
        return (
          <div
            key={item.id}
            className="animate-toast-in pointer-events-auto flex w-[320px] max-w-full items-start gap-2 rounded-sm border border-border bg-card px-3 py-2.5"
          >
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", color)} strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium leading-4 text-foreground">
                {item.title}
              </div>
              {item.description && (
                <div className="mt-1 truncate text-[10px] text-muted-foreground">
                  {item.description}
                </div>
              )}
            </div>
            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Dismiss"
              >
                <X size={10} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
