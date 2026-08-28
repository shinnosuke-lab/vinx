/**
 * Collapsible detail-panel building blocks (`DetailCard` + `DefRow`): a
 * bordered section with an icon+title header that
 * toggles its body, and a fixed-label key/value row for metadata.
 */

import { useState, type ElementType, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { Spinner } from "@agentchat/components/shared/spinner"

export function DetailCard({
  icon: Icon,
  title,
  children,
  defaultOpen = true,
  actions,
  stickyHeader = false,
}: {
  icon: ElementType
  title: string
  children: ReactNode
  defaultOpen?: boolean
  /** Header-right controls (clicks don't toggle the card). */
  actions?: ReactNode
  /** Pin the header to the top of the nearest scroll container, so its
   *  actions stay reachable while long card content scrolls underneath. */
  stickyHeader?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => setOpen((v) => !v)
  return (
    <div className={cn("rounded-[4px] border border-border bg-card", !stickyHeader && "overflow-hidden")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            toggle()
          }
        }}
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 border-b border-border/40 bg-muted/15 px-4 py-1.5 pr-2 transition-colors hover:bg-muted/50",
          stickyHeader && "sticky top-0 z-10 rounded-t-[4px] bg-card backdrop-blur",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="flex-1 truncate text-left text-xs font-medium text-foreground/80">
          {title}
        </span>
        {actions && (
          <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </div>
      {open && <div className="space-y-2 p-4 text-xs">{children}</div>}
    </div>
  )
}

/** Fixed-width label + flexible value row for metadata lists. */
export function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-6">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  )
}

/** Detail-panel status pill: one shared shape (small-radius bordered chip) so
 *  enabled-state, built-in and invocation badges read as one family. Shared by
 *  the skills and apps detail panels. */
export function Pill({
  children,
  tone = "muted",
  title,
  className,
}: {
  children: ReactNode
  tone?: "muted" | "primary" | "success" | "info"
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px]",
        tone === "success" && "border-emerald-500/20 bg-emerald-500/15 text-emerald-600",
        tone === "primary" && "border-primary/20 bg-primary/10 text-primary",
        tone === "info" && "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Full-width action row: icon + title + hint.
 *  `href` renders an anchor: same-origin downloads by default, or `external`
 *  opens in a new tab (for links to a running app's own web page). Shared by
 *  the skills and apps detail panels. */
export function ActionRow({
  icon: Icon,
  title,
  hint,
  destructive,
  disabled,
  busy,
  onClick,
  href,
  external,
}: {
  icon: ElementType
  title: string
  hint: string
  destructive?: boolean
  disabled?: boolean
  busy?: boolean
  onClick?: () => void
  href?: string
  /** With `href`: open in a new tab instead of downloading (external page). */
  external?: boolean
}) {
  const inner = (
    <>
      {busy ? (
        <Spinner size="sm" className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Icon
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground",
            destructive && "group-hover:text-destructive",
          )}
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-xs font-medium text-foreground",
            destructive && "group-hover:text-destructive",
          )}
        >
          {title}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </>
  )
  const className = cn(
    "group flex w-full items-center gap-3 rounded-[4px] border border-border px-3 py-2 text-left transition-colors",
    destructive ? "hover:border-destructive/30" : "hover:border-primary/40",
    disabled && "cursor-not-allowed opacity-40",
  )
  if (href) {
    if (external) {
      // External page (e.g. a running app's own port): open in a new tab.
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn(className, "no-underline")}>
          {inner}
        </a>
      )
    }
    // `download` (same-origin file) instead of `target="_blank"`: no blank-tab
    // flash, and `no-underline` guards against host link styles.
    return (
      <a href={href} download className={cn(className, "no-underline")}>
        {inner}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {inner}
    </button>
  )
}
