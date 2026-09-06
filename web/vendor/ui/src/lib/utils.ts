import { useEffect, useState } from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Viewport narrower than Tailwind's `md` breakpoint (phones; tablets at
 *  768px keep the desktop layout). Shared by the shell nav rail and the
 *  chat's history panel so both switch to overlay drawers at the same width. */
export const MOBILE_QUERY = "(max-width: 767px)"

/** Viewport narrower than Tailwind's `xl` breakpoint: still a desktop layout,
 *  but tight enough that the expanded nav rail crowds the content — the shell
 *  auto-collapses it to the icon rail in this band. */
export const MEDIUM_QUERY = "(max-width: 1279px)"

/** Reactive media-query match. SSR-safe (false before mount), updates live on
 *  viewport changes (rotation, window resize, devtools device toggle). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}

/**
 * SPA-friendly anchor click handler: a plain left-click is intercepted into
 * `navigate` (in-app switch, no full navigation), while modified clicks
 * (Cmd/Ctrl/Shift/Alt), middle-clicks and the context menu keep the anchor's
 * native browser behavior — "open in new tab" works because the `href` is
 * real.
 */
export function spaAnchorClick(e: React.MouseEvent, navigate: () => void) {
  if (e.defaultPrevented) return
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate()
}

/** Portal target inside the library's `.acc-root` subtree (falls back to
 *  `document.body`). Portaled content (dropdowns, tooltips) must stay under
 *  `.acc-root` or it loses the scoped theme variables, dark-mode class and
 *  base control resets — e.g. menu buttons regrow native UA borders. */
export function portalContainer(): HTMLElement {
  return (document.querySelector(".acc-root") as HTMLElement | null) ?? document.body
}

/**
 * Copy text to the clipboard, working on plain-HTTP deployments.
 *
 * Gateways serve this UI over `http://<gateway-ip>` — an insecure context
 * where `navigator.clipboard` is undefined (only localhost/HTTPS get it), so
 * a direct `navigator.clipboard.writeText` silently breaks every copy button
 * in production while working in local dev. Falls back to the classic hidden
 * textarea + `execCommand("copy")`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.top = "-9999px"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
