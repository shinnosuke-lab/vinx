import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, ChevronUp, Clock, Paperclip, Pencil, X } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { t, tf } from "@agentchat/lib/i18n"

/** One message parked in the server-side session queue (a `queue` frame item). */
export interface QueuedItem {
  /** Server-issued id addressing this item for remove/edit. */
  id: number
  /** Full message text (display truncation is CSS's job). */
  message: string
  /** Number of attachments riding the parked message. */
  attachments: number
}

interface QueuedItemsProps {
  items: QueuedItem[]
  /** Drop one parked message. */
  onRemove: (id: number) => void
  /** Replace one parked message's text (attachments ride along unchanged). */
  onEdit: (id: number, message: string) => void
  /** Drop every parked message (the header's "clear all"). */
  onClear: () => void
}

/** Long queues collapse to this many rows plus an expander. */
const COLLAPSED_ROWS = 3

/** The queue panel docked above the composer: a bordered card with a header
 *  (count + clear-all) and one numbered row per parked message, with actions
 *  to remove it or edit its text in place (revealed on hover on fine
 *  pointers, always visible on touch). Queues longer than `COLLAPSED_ROWS`
 *  collapse behind a "+N more" expander. Rows never mutate optimistically —
 *  the server's next `queue` snapshot is the single source of truth, so
 *  every viewer converges the same way. */
export function QueuedItems({ items, onRemove, onEdit, onClear }: QueuedItemsProps) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState("")
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The edited item can vanish under the editor (the turn ended and the
  // backend started it, or another client removed it): close the editor.
  useEffect(() => {
    if (editingId !== null && !items.some((q) => q.id === editingId)) {
      setEditingId(null)
    }
  }, [items, editingId])

  useEffect(() => {
    if (editingId !== null) inputRef.current?.focus()
  }, [editingId])

  const commit = () => {
    if (editingId === null) return
    const text = draft.trim()
    const original = items.find((q) => q.id === editingId)
    if (text && original && text !== original.message) onEdit(editingId, text)
    setEditingId(null)
  }

  const collapsed = !expanded && items.length > COLLAPSED_ROWS
  const visible = collapsed ? items.slice(0, COLLAPSED_ROWS) : items
  const hiddenCount = items.length - visible.length

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1.5 print:hidden">
      <div className="animate-fade-in overflow-hidden rounded-lg border border-border bg-muted/20">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {tf("queuedHeader", items.length)}
          </span>
          {items.length > 1 && (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-sm px-1 py-px text-[11px] text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              {t("queuedClear")}
            </button>
          )}
        </div>
        <div className="space-y-px p-1">
          {visible.map((q, idx) =>
            q.id === editingId ? (
              <div key={q.id} className="flex items-start gap-1.5 px-1.5 py-1 text-[11px]">
                <span className="mt-1 w-3.5 shrink-0 text-right tabular-nums text-muted-foreground/50">
                  {idx + 1}
                </span>
                {/* A textarea, not an <input>: the browser strips newlines from
                    <input> values, so editing a multiline message would silently
                    flatten it. Enter saves, Shift+Enter inserts a newline. */}
                <textarea
                  ref={inputRef}
                  value={draft}
                  rows={Math.min(draft.split("\n").length, 4)}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      commit()
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      setEditingId(null)
                    }
                  }}
                  className="min-w-0 flex-1 resize-none rounded-[3px] border border-border bg-background px-1.5 py-1 text-[11px] leading-4 text-foreground outline-none focus:border-ring"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={commit}
                  className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                  title={t("save")}
                >
                  <Check />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setEditingId(null)}
                  className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                  title={t("cancel")}
                >
                  <X />
                </Button>
              </div>
            ) : (
              <div
                key={q.id}
                title={q.message}
                className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
              >
                <span className="w-3.5 shrink-0 text-right tabular-nums text-muted-foreground/50">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/75">
                  {q.message}
                </span>
                {q.attachments > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[10px]">
                    <Paperclip className="h-2.5 w-2.5" />
                    {q.attachments}
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setDraft(q.message)
                      setEditingId(q.id)
                    }}
                    className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                    title={t("edit")}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemove(q.id)}
                    className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive [&_svg]:size-3"
                    title={t("delete")}
                  >
                    <X />
                  </Button>
                </div>
              </div>
            ),
          )}
          {(collapsed || (expanded && items.length > COLLAPSED_ROWS)) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              {collapsed ? (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t("queuedMore").replace("{n}", String(hiddenCount))}
                </>
              ) : (
                <>
                  <ChevronUp className="h-3 w-3" />
                  {t("queuedCollapse")}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
