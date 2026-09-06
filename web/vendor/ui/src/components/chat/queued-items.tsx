import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, ChevronUp, Clock, FileText, Pencil, X, Zap } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { fileTypeTag, isImageUploadId } from "@agentchat/lib/attachments"
import { t, tf } from "@agentchat/lib/i18n"
import { formatBytes } from "@agentchat/lib/releases"
import type { AttachmentView } from "@agentchat/types"

/** One message parked in the server-side session queue (a `queue` frame item). */
export interface QueuedItem {
  /** Server-issued id addressing this item for remove/edit/send-now. */
  id: number
  /** Full message text (display truncation is CSS's job). */
  message: string
  /** Attachments riding the parked message, as upload references (the
   *  bytes stay behind `uploadUrl(id)`) — enough for thumbnails and the
   *  preview modal without another round-trip. */
  attachments: AttachmentView[]
}

interface QueuedItemsProps {
  items: QueuedItem[]
  /** Drop one parked message. */
  onRemove: (id: number) => void
  /** Replace one parked message's text (attachments ride along unchanged). */
  onEdit: (id: number, message: string) => void
  /** "Send now": stop the running turn and start this parked message next
   *  (it jumps to the queue front; attachments ride along). */
  onSendNow: (id: number) => void
  /** Drop every parked message (the header's "clear all"). */
  onClear: () => void
  /** `GET /api/chat/upload/{id}` URL builder (thumbnail sources). */
  uploadUrl: (id: string, name?: string) => string
  /** A row's attachment chip was clicked: open it (lightbox for images, the
   *  file preview for everything else — the host decides). */
  onPreviewAttachment: (attachment: AttachmentView) => void
}

/** Long queues collapse to this many rows plus an expander. */
const COLLAPSED_ROWS = 3

/** A row shows at most this many attachment chips; the rest fold into a
 *  "+N" tail whose tooltip lists their names — rows stay one line tall. */
const MAX_CHIPS = 4

/** The per-row attachment strip: image thumbnails and type-tagged file chips
 *  (`PDF`, `CSV`), each a button opening the preview. Icons rather than names
 *  on purpose — the message text owns the row's width; the full name and
 *  size live in the tooltip and in the preview itself. */
function AttachmentChips({
  attachments,
  uploadUrl,
  onPreview,
}: {
  attachments: AttachmentView[]
  uploadUrl: (id: string, name?: string) => string
  onPreview: (attachment: AttachmentView) => void
}) {
  const shown = attachments.slice(0, MAX_CHIPS)
  const rest = attachments.slice(MAX_CHIPS)
  return (
    <span className="flex shrink-0 items-center gap-1" data-acc="queued-attachments">
      {shown.map((a) => {
        const label = a.name || a.id
        const size = formatBytes(a.size)
        const title = size ? `${label} · ${size}` : label
        if (isImageUploadId(a.id)) {
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onPreview(a)}
              title={title}
              aria-label={title}
              className="h-5 w-5 shrink-0 cursor-zoom-in overflow-hidden rounded-[3px] border border-border bg-muted/40 transition-opacity hover:opacity-80"
            >
              <img
                src={uploadUrl(a.id)}
                alt={label}
                loading="lazy"
                draggable={false}
                className="h-full w-full object-cover"
              />
            </button>
          )
        }
        const tag = fileTypeTag(a)
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onPreview(a)}
            title={title}
            aria-label={title}
            className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-[3px] border border-border bg-muted/40 px-1 text-[9px] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <FileText className="h-2.5 w-2.5 shrink-0" />
            {tag && <span>{tag}</span>}
          </button>
        )
      })}
      {rest.length > 0 && (
        <span
          className="text-[10px] tabular-nums text-muted-foreground/70"
          title={rest.map((a) => a.name || a.id).join("\n")}
        >
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/** The queue panel docked above the composer: a bordered card with a header
 *  (count + clear-all) and one numbered row per parked message, with
 *  always-visible actions to send it now, edit its text in place or remove
 *  it (the same affordance rule as the sub-task strip: no hover-only
 *  controls). Queues longer than `COLLAPSED_ROWS` collapse behind a "+N more"
 *  expander. Rows never mutate optimistically — the server's next `queue`
 *  snapshot is the single source of truth, so every viewer converges the same
 *  way. */
export function QueuedItems({
  items,
  onRemove,
  onEdit,
  onSendNow,
  onClear,
  uploadUrl,
  onPreviewAttachment,
}: QueuedItemsProps) {
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
      <div className="animate-rise-in overflow-hidden rounded-lg border border-border bg-muted/20">
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
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
              >
                <span className="w-3.5 shrink-0 text-right tabular-nums text-muted-foreground/50">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/75">
                  {q.message}
                </span>
                {q.attachments.length > 0 && (
                  <AttachmentChips
                    attachments={q.attachments}
                    uploadUrl={uploadUrl}
                    onPreview={onPreviewAttachment}
                  />
                )}
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onSendNow(q.id)}
                    className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary [&_svg]:size-3"
                    title={t("queuedSendNow")}
                    aria-label={t("queuedSendNow")}
                  >
                    <Zap />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setDraft(q.message)
                      setEditingId(q.id)
                    }}
                    className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3"
                    title={t("edit")}
                    aria-label={t("edit")}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemove(q.id)}
                    className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive [&_svg]:size-3"
                    title={t("delete")}
                    aria-label={t("delete")}
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
