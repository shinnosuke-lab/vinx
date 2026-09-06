import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, Plus, Tag, X } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

/** Server-side cap on a category label; mirrored so the input stops early. */
export const MAX_CATEGORY_CHARS = 64

/** Row style shared by the small anchored menus (batch menu, category picker). */
export const MENU_ITEM_CLS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"

/** Portal-anchored dropdown (batch menu, category picker). Hangs off the
 *  anchor's bottom-right corner, flips above it when the viewport is short,
 *  and closes on outside click / Escape / page scroll. Render it through
 *  `createPortal(…, portalContainer())` so it escapes overflow clipping. */
export function DropdownMenu({
  anchorRef,
  onClose,
  width = 144,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  width?: number
  children: React.ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const height = contentRef.current?.offsetHeight ?? 0
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    let top = rect.bottom + 4
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - 4 - height)
    }
    setPos({ top, left })
  }, [anchorRef, width])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (anchorRef.current?.contains(e.target as Node)) return
      if (contentRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    function handleScroll(e: Event) {
      // The menu is position:fixed and does not follow its anchor; close
      // instead of floating loose. Scrolling inside the menu itself is fine.
      if (contentRef.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    document.addEventListener("scroll", handleScroll, true)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
      document.removeEventListener("scroll", handleScroll, true)
    }
  }, [anchorRef, onClose])

  return (
    <div
      ref={contentRef}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        zIndex: 9999,
        visibility: pos ? "visible" : "hidden",
      }}
      className="rounded-md border border-border bg-card p-1 shadow-md animate-in fade-in-0 zoom-in-95"
    >
      {children}
    </div>
  )
}

/** Category chooser for one or many sessions: every label already in use
 *  (reuse beats typos), a free-text line for a new one, and a clear action.
 *  A session has at most one category, so picking replaces. Shared by the
 *  sessions page (card tag button, batch menu) and the chat header. */
export function CategoryPicker({
  anchorRef,
  categories,
  current,
  canClear,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  categories: string[]
  /** Category shared by every target (null = none, or mixed): shown checked. */
  current: string | null
  canClear: boolean
  onPick: (category: string | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState("")
  const submit = () => {
    const value = draft.trim()
    if (value) onPick(value)
  }
  return (
    <DropdownMenu anchorRef={anchorRef} onClose={onClose} width={208}>
      {categories.length > 0 && (
        <div className="max-h-52 overflow-y-auto">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              className={cn(MENU_ITEM_CLS, "text-foreground")}
              title={c}
            >
              <Tag size={12} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{c}</span>
              {current === c && <Check size={12} className="shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
      {categories.length > 0 && <div className="my-1 h-px bg-border" />}
      <div className="flex items-center gap-2 px-2 py-1">
        <Plus size={12} className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          type="text"
          value={draft}
          maxLength={MAX_CATEGORY_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={t("newCategory")}
          aria-label={t("categoryPlaceholder")}
          className="h-6 min-w-0 flex-1 border-none bg-transparent text-xs text-foreground placeholder-muted-foreground focus:outline-none"
        />
        {draft.trim() && (
          <button
            type="button"
            onClick={submit}
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-primary transition-colors hover:bg-muted"
            title={t("setCategory")}
          >
            <Check size={12} />
          </button>
        )}
      </div>
      {canClear && (
        <>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => onPick(null)}
            className={cn(MENU_ITEM_CLS, "text-muted-foreground hover:text-destructive")}
          >
            <X size={12} className="shrink-0" />
            {t("clearCategory")}
          </button>
        </>
      )}
    </DropdownMenu>
  )
}
