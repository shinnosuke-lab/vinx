import { useState } from "react"
import { Plus, PanelLeftClose, Pencil, Trash2, Check } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { confirmDialog } from "@agentchat/components/ui/confirm-dialog"
import { cn, spaAnchorClick } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import type { SessionSummary } from "@agentchat/types"

interface SessionsPanelProps {
  sessions: SessionSummary[]
  activeId: string | null
  onResume: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClose: () => void
  /** When set, session rows render as real anchors (`href = sessionHref(id)`)
   *  so browser affordances work — right-click "open in new tab",
   *  middle-click, Cmd/Ctrl+click. Plain left-click still goes through
   *  `onResume` (in-app switch). Hosts without URL routing leave it unset. */
  sessionHref?: (id: string) => string
}

export function SessionsPanel({
  sessions,
  activeId,
  onResume,
  onNew,
  onRename,
  onDelete,
  onClose,
  sessionHref,
}: SessionsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const startEdit = (s: SessionSummary) => {
    setEditingId(s.id)
    setDraft(s.title || "")
  }
  const commitEdit = (id: string) => {
    const title = draft.trim()
    if (title) onRename(id, title)
    setEditingId(null)
  }

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="default"
          onClick={onNew}
          className="h-9 flex-1 justify-center gap-1.5 [&_svg]:size-4"
          title={t("newChat")}
        >
          <Plus />
          <span className="truncate">{t("newChat")}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8 shrink-0 [&_svg]:size-4 text-muted-foreground hover:text-foreground"
          title={t("history")}
        >
          <PanelLeftClose />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">
            {t("noSessions")}
          </div>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((s) => {
              const isActive = s.id === activeId
              const isEditing = s.id === editingId
              return (
                <div
                  key={s.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-sm px-2 py-1.5 text-xs transition-colors",
                    isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {isEditing ? (
                    <>
                      <input
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(s.id)
                          if (e.key === "Escape") setEditingId(null)
                        }}
                        className="min-w-0 flex-1 rounded-[4px] border border-border bg-background px-1.5 py-0.5 text-xs focus:border-primary focus:outline-none"
                      />
                      <button
                        onClick={() => commitEdit(s.id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        title={t("rename")}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      {/* A real anchor when the host provides an URL scheme,
                          so right/middle/modified clicks get native browser
                          behavior; plain left-click stays an in-app switch. */}
                      {(() => {
                        const rowInner = (
                          <>
                            {s.running && (
                              <span
                                className="relative flex h-1.5 w-1.5 shrink-0"
                                title={t("runningBadge")}
                              >
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              </span>
                            )}
                            <span className="truncate">{s.title || t("untitled")}</span>
                          </>
                        )
                        const rowClass = "flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        return sessionHref ? (
                          <a
                            href={sessionHref(s.id)}
                            onClick={(e) => spaAnchorClick(e, () => onResume(s.id))}
                            className={cn(rowClass, "text-inherit no-underline")}
                            title={s.title || t("untitled")}
                          >
                            {rowInner}
                          </a>
                        ) : (
                          <button
                            onClick={() => onResume(s.id)}
                            className={rowClass}
                            title={s.title || t("untitled")}
                          >
                            {rowInner}
                          </button>
                        )
                      })()}
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        <button
                          onClick={() => startEdit(s)}
                          className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
                          title={t("rename")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => {
                            void confirmDialog(t("deleteConfirm")).then((ok) => {
                              if (ok) onDelete(s.id)
                            })
                          }}
                          className="rounded p-0.5 text-muted-foreground/60 hover:text-destructive"
                          title={t("delete")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
