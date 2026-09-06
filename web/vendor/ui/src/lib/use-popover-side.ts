import { useLayoutEffect, useState, type RefObject } from "react"

/**
 * Which side a toolbar popover should open on. Toolbar chips sit above the
 * composer, which on an empty chat is vertically centred — so "open upward"
 * can leave a tall panel with less headroom than it needs. Measure and flip:
 * open upward when the space above the anchor fits `wanted` px (or is at
 * least the larger side), otherwise downward. Recomputed while `open` on
 * resize/scroll; the caller passes the panel's expected height (a generous
 * upper bound is fine — flipping early is harmless, clipping is not).
 */
export function usePopoverSide(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  wanted: number,
  margin = 16,
): "top" | "bottom" {
  const [side, setSide] = useState<"top" | "bottom">("top")
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const above = r.top - margin
      const below = window.innerHeight - r.bottom - margin
      setSide(above >= wanted || above >= below ? "top" : "bottom")
    }
    compute()
    window.addEventListener("resize", compute)
    window.addEventListener("scroll", compute, true)
    return () => {
      window.removeEventListener("resize", compute)
      window.removeEventListener("scroll", compute, true)
    }
  }, [anchorRef, open, wanted, margin])
  return side
}

/** Tailwind classes positioning an absolutely-placed panel on `side`. */
export function popoverSideClass(side: "top" | "bottom"): string {
  return side === "top" ? "bottom-full mb-2" : "top-full mt-2"
}

/**
 * Horizontal correction, in px, that keeps an anchored panel inside the box
 * that would otherwise clip it.
 *
 * Toolbar chips further right in the composer open panels far wider than
 * themselves at `left-0`, so on a narrow window the panel's right part runs
 * past the chat column — and the column's `overflow-hidden` (also on
 * `.acc-root`) cuts it off there. While `open`, measure the
 * panel against its nearest clipping ancestor (first ancestor whose
 * `overflow-x` is not `visible`, else `.acc-root`, intersected with the
 * viewport) and return the offset to apply as `style.left`: negative pulls
 * the panel left until it fits, `0` keeps the default anchor. The width comes
 * from `offsetWidth`, not the bounding rect — the open animation scales the
 * panel from 96 %, so a rect taken on the first frame under-reports.
 * Recomputed on resize.
 */
export function usePopoverShift(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  margin = 16,
): number {
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const panel = panelRef.current
      if (!panel) return
      // `left-0` puts the panel's natural left edge at its offset parent's.
      const anchor = (panel.offsetParent ?? panel.parentElement) as HTMLElement | null
      if (!anchor) return
      const naturalLeft = anchor.getBoundingClientRect().left
      const clip = clippingAncestor(panel)?.getBoundingClientRect()
      const boundLeft = Math.max(0, clip?.left ?? 0) + margin
      const boundRight = Math.min(window.innerWidth, clip?.right ?? window.innerWidth) - margin
      const overflow = naturalLeft + panel.offsetWidth - boundRight
      // Pull left only as far as the left bound allows — a panel wider than
      // the clip box keeps its left edge visible (that is where the controls are).
      const next = overflow > 0 ? Math.max(-overflow, boundLeft - naturalLeft) : 0
      setShift(Math.round(Math.min(0, next)))
    }
    compute()
    window.addEventListener("resize", compute)
    return () => window.removeEventListener("resize", compute)
  }, [panelRef, open, margin])
  return shift
}

/** Nearest ancestor that clips horizontally, else the `.acc-root` host. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.classList.contains("acc-root")) return p
    const ox = getComputedStyle(p).overflowX
    if (ox && ox !== "visible") return p
  }
  return null
}
