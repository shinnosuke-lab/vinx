import { t, tf } from "./i18n"

/**
 * Shared helpers for rendering release records (the deliverables inventory):
 * one status→color mapping and one relative-time formatter, used by the
 * releases page, the app cards, the in-chat tool cards and the session badge
 * — previously three drifting copies.
 */

/** systemd `is-active` → status dot color class. */
export function statusDotClass(status?: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500"
    case "failed":
      return "bg-red-500"
    case "inactive":
      return "bg-zinc-500"
    default:
      return "bg-amber-500/70" // unknown (e.g. no systemd on this host)
  }
}

/** Compact relative time for cards (i18n'd: "3m ago" / "3 分钟前"). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t("timeJustNow")
  if (mins < 60) return tf("timeMinAgo", mins)
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tf("timeHourAgo", hrs)
  return tf("timeDayAgo", Math.floor(hrs / 24))
}

/** Published files that render as live pages get the globe icon. */
export function isHtmlName(name: string): boolean {
  return /\.(html?|svg)$/i.test(name)
}

/** Coarse content class for the published-files filter, by extension. Kept
 *  purely client-side (the kernel serves bytes, not types). `page` groups the
 *  formats the /public route renders inline (html/svg); everything unmatched
 *  falls to `other` so nothing is ever hidden. */
export type FileCategory = "page" | "image" | "document" | "other"

export function fileCategory(name: string): FileCategory {
  if (/\.(html?|svg)$/i.test(name)) return "page"
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(name)) return "image"
  if (/\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|pdf|log|tex)$/i.test(name)) return "document"
  return "other"
}

/** Human-readable byte size for release cards (`0` → empty; unknown sizes are
 *  simply not shown). */
export function formatBytes(n: number | undefined | null): string {
  if (!n || n <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
