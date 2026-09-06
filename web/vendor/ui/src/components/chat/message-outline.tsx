import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from "react"
import { Paperclip } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"

/**
 * Thin vertical rail of tick marks, one per user message, docked to the right
 * edge of the transcript column. Hover a tick to preview the message, click
 * to scroll to it; the tick nearest the reading line is highlighted while
 * scrolling. Purely a viewer aid — it reads the DOM (`[data-msg-id]` on user
 * rows) and never touches transcript state.
 *
 * Layout: the rail sits at `calc(50% + 24rem + 0.75rem)` — 12px right of the
 * centered `max-w-3xl` column — so it follows the column as the pane resizes
 * instead of hugging the far edge of the viewport. It only renders when the
 * pane is wide enough (`@4xl` container query, 56rem) that the gutter beside
 * the column can hold it; narrower than that it would overlap the right-
 * aligned user bubbles. Hover-only devices too: there is no hover on touch.
 *
 * Density: the tick column is vertically centered in the pane and must never
 * grow past it (the pane does not clip, so an overflowing column would run
 * up into the header and down over the composer). The per-tick advance
 * ("pitch" = 8px hit box + gap) shrinks from 16px towards 8px as messages
 * accumulate; once even 8px cannot seat every message the list is thinned
 * by sampling. The column is additionally clamped with `max-h-full` +
 * `overflow-hidden` as a hard stop.
 */

export interface OutlineEntry {
  /** Transcript message id, matching the row's `data-msg-id`. */
  id: number
  /** Bubble text (shown clamped in the hover preview). */
  content: string
  attachments?: number
}

interface MessageOutlineProps {
  entries: OutlineEntry[]
  /** The scrolling transcript container (owner of the `scroll` events). */
  containerRef: React.RefObject<HTMLDivElement | null>
}

/** Fraction of the container height that acts as the "reading line": the
 *  active tick is the last message whose top is above it. */
const READING_LINE = 0.35
/** Hover delay before the preview card appears (skims across ticks don't flash). */
const PREVIEW_DELAY_MS = 120
/** Height of one tick's hit box (`h-2` on the button) — the flex item the
 *  column actually stacks; the visible 2px line sits inside it. Every
 *  height calculation below is in terms of this box, not the 2px line. */
const TICK_BOX_PX = 8
/** Per-tick advance (box + gap): relaxed spacing for short transcripts … */
const MAX_TICK_PITCH_PX = 16
/** … down to touching hit boxes; below this the list is thinned by sampling. */
const MIN_TICK_PITCH_PX = TICK_BOX_PX
/** Column padding, `py-2` top + bottom. */
const RAIL_PAD_PX = 16
/** Seats the sampler leaves free for the active + last entries it always keeps. */
const RESERVED_TICKS = 2

export const MessageOutline = memo(function MessageOutline({ entries, containerRef }: MessageOutlineProps) {
  const [activeId, setActiveId] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [railHeight, setRailHeight] = useState(0)
  const railRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<number | null>(null)

  // Active tick follows the scroll position (rAF-throttled: the container
  // already fires a listener per scroll event for the jump-to-bottom button).
  // Layout effect so the first measurement lands before paint: the density
  // math below depends on `railHeight`, and a long transcript would otherwise
  // flash one frame of the relaxed 16px layout before compressing.
  useLayoutEffect(() => {
    const c = containerRef.current
    if (!c || entries.length === 0) return
    let raf = 0
    const update = () => {
      raf = 0
      const cRect = c.getBoundingClientRect()
      const line = cRect.top + c.clientHeight * READING_LINE
      let current: number | null = entries[0].id
      for (const e of entries) {
        const el = c.querySelector<HTMLElement>(`[data-msg-id="${e.id}"]`)
        if (!el) continue
        if (el.getBoundingClientRect().top <= line) current = e.id
        else break
      }
      // At the very bottom the last message is "current" even if its top is
      // below the reading line (short final question + long answer).
      if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) current = entries[entries.length - 1].id
      setActiveId(current)
      setRailHeight(c.clientHeight)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    c.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(c)
    return () => {
      c.removeEventListener("scroll", onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef, entries])

  // Thin the list when there are more ticks than seats: keep every k-th
  // entry, but always keep the active one so the highlight never vanishes,
  // and the last one so the rail always reaches "now". `capacity` is how many
  // 8px hit boxes fit inside the padded rail; the sampler targets two fewer
  // so those two forced keeps never push the column past the pane.
  const shown = useMemo(() => {
    if (!railHeight) return entries
    const capacity = Math.max(1, Math.floor((railHeight - RAIL_PAD_PX) / MIN_TICK_PITCH_PX))
    if (entries.length <= capacity) return entries
    const budget = Math.max(1, capacity - RESERVED_TICKS)
    const stride = Math.ceil(entries.length / budget) // ⇒ ceil(n / stride) ≤ budget
    return entries.filter((e, i) => i % stride === 0 || e.id === activeId || i === entries.length - 1)
  }, [entries, railHeight, activeId])

  // Gap between hit boxes: spread the ticks to at most a 16px pitch, and let
  // the pitch fall to 8px (touching boxes) before sampling has to kick in.
  // Column height = pad + n·pitch − gap ≤ railHeight by construction.
  const gap = useMemo(() => {
    if (!railHeight || shown.length === 0) return MAX_TICK_PITCH_PX - TICK_BOX_PX
    const pitch = Math.max(
      MIN_TICK_PITCH_PX,
      Math.min(MAX_TICK_PITCH_PX, Math.floor((railHeight - RAIL_PAD_PX) / shown.length)),
    )
    return pitch - TICK_BOX_PX
  }, [railHeight, shown.length])

  const scrollTo = useCallback(
    (id: number) => {
      const c = containerRef.current
      const el = c?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
      if (!el) return
      el.scrollIntoView({ block: "start", behavior: "smooth" })
    },
    [containerRef],
  )

  const onEnter = (id: number) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHoverId(id), PREVIEW_DELAY_MS)
  }
  const onLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHoverId(null)
  }
  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
  }, [])

  // Ticks that appear after mount (a new user message while the rail is up)
  // pop in; the initial set renders settled. Same snapshot idea as the
  // transcript rows: ids are monotonic, remember the highest one seen.
  const seenMaxIdRef = useRef(-1)
  const prevMax = seenMaxIdRef.current
  let maxId = prevMax
  for (const e of entries) if (e.id > maxId) maxId = e.id
  useEffect(() => {
    seenMaxIdRef.current = maxId
  }, [maxId])
  // First render of the rail: nothing animates (prevMax is -1 → treat all as seen).
  const animateAboveId = prevMax < 0 ? Number.POSITIVE_INFINITY : prevMax

  if (entries.length < 2) return null

  const hovered = hoverId != null ? entries.find((e) => e.id === hoverId) : undefined
  const hoveredOrdinal = hovered ? entries.indexOf(hovered) + 1 : 0

  return (
    <div
      ref={railRef}
      data-acc="msg-outline"
      role="navigation"
      aria-label={t("outlineAria")}
      onMouseLeave={onLeave}
      // `@4xl` = Tailwind v4 container query (56rem). The parent pane is a
      // `@container`; below that width the gutter can't fit the rail.
      // Flex column centering (not top-1/2 + translate) so the tick column
      // below can be clamped to the rail's height.
      className="pointer-events-none absolute inset-y-0 z-10 hidden w-6 flex-col justify-center [@media(hover:hover)]:@4xl:flex print:hidden"
      style={{ left: "calc(50% + 24rem + 0.75rem)" }}
    >
      <div
        // Hard stop: even if the density math ever drifts, the column is
        // clipped at the pane's edges instead of running into the header /
        // composer (the pane itself does not clip).
        className="pointer-events-auto flex max-h-full min-h-0 w-6 flex-col items-center overflow-hidden py-2"
        style={{ gap }}
      >
        {shown.map((e) => {
          const active = e.id === activeId
          const hot = e.id === hoverId
          return (
            <button
              key={e.id}
              type="button"
              onMouseEnter={() => onEnter(e.id)}
              onFocus={() => setHoverId(e.id)}
              onBlur={onLeave}
              onClick={() => scrollTo(e.id)}
              data-outline-id={e.id}
              aria-label={tf("outlineJumpTo", entries.indexOf(e) + 1)}
              aria-current={active ? "true" : undefined}
              // 24px-wide hit target around a 2px tick: easy to hover, thin to look at.
              className={cn(
                "group/tick flex h-2 w-6 items-center justify-center outline-none",
                e.id > animateAboveId && "acc-tick-enter",
              )}
            >
              <span
                data-active={active || undefined}
                data-hot={hot || undefined}
                className={cn(
                  // Fixed 12px box for every tick; the active/hot emphasis is
                  // colour plus a transform-only stretch (.acc-tick), so the
                  // column never reflows.
                  "acc-tick block h-0.5 w-3 rounded-full",
                  active
                    ? "bg-primary"
                    : hot
                      ? "bg-foreground/60"
                      : "bg-muted-foreground/35 group-hover/tick:bg-foreground/60",
                )}
              />
            </button>
          )
        })}
      </div>

      {hovered && (
        <OutlinePreview
          entry={hovered}
          ordinal={hoveredOrdinal}
          anchorEl={railRef.current?.querySelector<HTMLElement>(`[data-outline-id="${hovered.id}"]`) ?? null}
          railEl={railRef.current}
        />
      )}
    </div>
  )
})

/** Hover card: ordinal, attachment count, 3-line clamped text. Positioned
 *  beside the hovered tick, clamped inside the rail's vertical bounds so it
 *  never spills past the top/bottom of the transcript. */
function OutlinePreview({
  entry,
  ordinal,
  anchorEl,
  railEl,
}: {
  entry: OutlineEntry
  ordinal: number
  anchorEl: HTMLElement | null
  railEl: HTMLDivElement | null
}) {
  const [top, setTop] = useState<number | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!anchorEl || !railEl) return
    const a = anchorEl.getBoundingClientRect()
    const r = railEl.getBoundingClientRect()
    const h = cardRef.current?.offsetHeight ?? 72
    const centered = a.top - r.top + a.height / 2 - h / 2
    setTop(Math.max(8, Math.min(r.height - h - 8, centered)))
  }, [anchorEl, railEl, entry.id])

  return (
    <div
      ref={cardRef}
      role="tooltip"
      // Sits to the LEFT of the rail, overlapping the column's right gutter.
      // `.acc-outline-preview`: slides in from the rail on mount; when the
      // pointer moves to another tick the card stays mounted and `top`
      // transitions, so it glides to the new anchor instead of jumping.
      className="acc-outline-preview pointer-events-none absolute right-full mr-2 w-64 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
      style={{ top: top ?? 0, visibility: top == null ? "hidden" : undefined }}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono">#{ordinal}</span>
        {entry.attachments ? (
          <span className="inline-flex items-center gap-0.5">
            <Paperclip className="h-2.5 w-2.5" />
            {entry.attachments}
          </span>
        ) : null}
      </div>
      <div className="line-clamp-3 whitespace-pre-wrap wrap-anywhere text-xs leading-4">
        {entry.content || t("outlineAttachmentOnly")}
      </div>
    </div>
  )
}
