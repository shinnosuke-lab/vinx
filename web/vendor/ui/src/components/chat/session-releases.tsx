import { useCallback, useEffect, useRef, useState } from "react"
import { Box, FileText, Globe, Image as ImageIcon, Package, Palette } from "lucide-react"
import type { ChatClient, ReleaseRecord } from "@agentchat/client"
import { t } from "@agentchat/lib/i18n"
import { fileCategory, isHtmlName, statusDotClass } from "@agentchat/lib/releases"

/**
 * Chat-header badge + popover: the durable deliverables THIS conversation
 * produced (published pages, installed apps, saved theme), from
 * `GET /api/releases?session_id=`. Hidden while the session has none — the
 * common case stays visually quiet. The full cross-session overview lives on
 * the Apps page; this is the "what did we just ship here" glance.
 */
export function SessionReleases({
  client,
  sessionId,
  refreshKey,
  basePath = "",
}: {
  client: ChatClient
  sessionId: string | null
  /** Bump to re-fetch (e.g. when a turn finishes — tools may have published). */
  refreshKey?: unknown
  /** API origin prefix, for the `/public/*` file links (matches ReleaseCard). */
  basePath?: string
}) {
  const [releases, setReleases] = useState<ReleaseRecord[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(() => {
    if (!sessionId) {
      setReleases([])
      return
    }
    client.listReleases({ sessionId }).then(setReleases)
  }, [client, sessionId])

  useEffect(() => {
    refresh()
  }, [refresh, refreshKey])

  // Also refetch whenever the popover opens: out-of-turn changes (the "save
  // this theme" button, deletions on the releases page) don't bump refreshKey,
  // so this keeps the glance current whenever the user actually looks.
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // Light dismiss: click anywhere outside closes the popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const iconFor = useCallback((r: ReleaseRecord) => {
    if (r.kind === "app") return <Box className="h-3.5 w-3.5 shrink-0 text-sky-400" />
    if (r.kind === "theme") return <Palette className="h-3.5 w-3.5 shrink-0 text-violet-400" />
    if (fileCategory(r.name) === "image")
      return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
    if (isHtmlName(r.name)) return <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
    return <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
  }, [])

  if (!sessionId || releases.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("sessionReleases")}
        title={t("sessionReleases")}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {/* The button only renders when there IS at least one deliverable, so
            the icon's presence alone is the signal — no count, no dot. */}
        <Package className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-30 w-72 rounded-md border border-border bg-popover p-1.5 shadow-lg">
          <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t("sessionReleases")}
          </div>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {releases.map((r) => {
              // External target: a published file (/public, basePath-prefixed
              // like ReleaseCard) or an app's page (its own host:port).
              const external = r.url
                ? `${basePath}${r.url}`
                : r.port && typeof window !== "undefined"
                  ? `${window.location.protocol}//${window.location.hostname}:${r.port}/`
                  : undefined
              const row = (
                <>
                  {iconFor(r)}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{r.name}</span>
                  {r.kind === "app" && r.status && (
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(r.status)}`}
                      title={r.status}
                    />
                  )}
                </>
              )
              const rowClass =
                "flex items-center gap-2 rounded px-1.5 py-1.5 no-underline transition-colors hover:bg-muted"
              return external ? (
                <a
                  key={`${r.kind}/${r.name}`}
                  href={external}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={rowClass}
                >
                  {row}
                </a>
              ) : (
                // No external target (themes): link to the themes page to
                // manage it (activate / delete). Internal hash nav, not a new
                // tab; close the popover on click.
                <a
                  key={`${r.kind}/${r.name}`}
                  href="#/themes"
                  onClick={() => setOpen(false)}
                  className={rowClass}
                >
                  {row}
                </a>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
