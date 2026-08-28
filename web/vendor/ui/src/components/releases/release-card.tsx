import {
  Check,
  Circle,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  Palette,
  Trash2,
} from "lucide-react"
import type { ReleaseRecord } from "@agentchat/client"
import { t, tf } from "@agentchat/lib/i18n"
import { fileCategory, formatBytes, isHtmlName, relativeTime } from "@agentchat/lib/releases"
import { CopyButton } from "../chat/tools/shared"

/**
 * One deliverable card, shared by the Releases (published files) and Themes
 * pages: open / copy link / download / jump to source session / remove, plus
 * an optional selection checkbox and theme activation control. Kept generic
 * over `kind` so both pages render an identical card.
 */
export function ReleaseCard({
  release,
  basePath,
  onOpenSession,
  onDelete,
  selected,
  onToggleSelect,
  isActive,
  onActivate,
}: {
  release: ReleaseRecord
  basePath: string
  onOpenSession?: (id: string) => void
  onDelete: (r: ReleaseRecord) => void
  /** When provided, render a selection checkbox wired to these. */
  selected?: boolean
  onToggleSelect?: (name: string) => void
  /** Theme kind only: whether this is the injected (active) theme. */
  isActive?: boolean
  /** Theme kind only: make this the active theme. */
  onActivate?: (r: ReleaseRecord) => void
}) {
  const Icon =
    release.kind === "theme"
      ? Palette
      : fileCategory(release.name) === "image"
        ? ImageIcon
        : isHtmlName(release.name)
          ? Globe
          : FileText
  const iconClass = release.kind === "theme" ? "text-violet-400" : "text-emerald-400"
  const href = release.url ? `${basePath}${release.url}` : undefined
  const shareUrl = href && typeof window !== "undefined" ? new URL(href, window.location.href).href : ""
  // Force-download path (attachment + nosniff), distinct from the inline
  // /public open link. Only published files have a downloadable artifact.
  const downloadHref =
    release.kind === "file"
      ? `${basePath}/api/runtime/file/public/${encodeURIComponent(release.name)}`
      : undefined
  const sizeLabel = formatBytes(release.size)
  const sessionLabel = release.session_id
    ? release.session_title || `${release.session_id.slice(0, 8)}…`
    : t("releaseUnattributed")

  return (
    <div
      className={`group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-[6px] border bg-card px-3 py-3 transition-colors ${
        selected ? "border-primary/60" : "border-border hover:border-primary/40"
      }`}
    >
      <div className="flex items-center gap-2">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(release.name)}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-muted-foreground/30 bg-transparent transition-colors checked:border-primary checked:bg-primary checked:text-white"
          />
        )}
        <Icon size={14} strokeWidth={1.75} className={`shrink-0 ${iconClass}`} />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-foreground" title={release.name}>
          {release.name}
        </h3>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={t("releaseOpen")}
            className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {shareUrl && <CopyButton text={shareUrl} />}
        {downloadHref && (
          <a
            href={downloadHref}
            download
            title={t("releaseDownload")}
            className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          >
            <Download className="h-3 w-3" />
          </a>
        )}
        {release.kind === "theme" &&
          onActivate &&
          (isActive ? (
            <span
              title={t("themeActive")}
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 text-[10px] font-medium text-emerald-400"
            >
              <Check className="h-3 w-3" />
            </span>
          ) : (
            <button
              onClick={() => onActivate(release)}
              title={t("themeActivate")}
              className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-primary"
            >
              <Circle className="h-3 w-3" />
            </button>
          ))}
        <button
          onClick={() => onDelete(release)}
          title={release.kind === "theme" ? t("remove") : t("releaseUnpublish")}
          className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {release.description && (
        <p className="truncate text-[11px] text-muted-foreground/70" title={release.description}>
          {release.description}
        </p>
      )}
      {release.palette && release.palette.length > 0 && (
        <div className="flex items-center gap-1">
          {release.palette.slice(0, 5).map((c, i) => (
            <span
              key={`${c}-${i}`}
              className="h-3 w-3 rounded-sm border border-border/60"
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground/60">
        {release.session_id && onOpenSession ? (
          <button
            onClick={() => onOpenSession(release.session_id!)}
            title={`${t("releaseFromSession")}: ${sessionLabel}`}
            className="inline-flex min-w-0 items-center gap-1 truncate rounded bg-transparent p-0 text-[11px] text-muted-foreground/70 transition-colors hover:text-primary"
          >
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">{sessionLabel}</span>
          </button>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">{sessionLabel}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {sizeLabel && <span>{sizeLabel}</span>}
          {typeof release.republish_count === "number" && release.republish_count > 0 && (
            <span>{tf("releaseRepublished", release.republish_count)}</span>
          )}
          <span>{relativeTime(release.created_at)}</span>
        </span>
      </div>
    </div>
  )
}
