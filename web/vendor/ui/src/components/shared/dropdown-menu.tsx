import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"

/**
 * Portal-anchored dropdown for the `...` (batch) menu, anchored under
 * `menuRef`. Mirrors the sessions/skills pages so every toolbar overflow menu
 * looks and behaves identically. Render inside a `createPortal` at the app
 * root so it escapes any `overflow-hidden` toolbar clipping.
 */
export function DropdownMenu({
  menuRef,
  onClose,
  children,
}: {
  menuRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.right - 160 })
  }, [menuRef])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return
      if (contentRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [menuRef, onClose])

  return (
    <div
      ref={contentRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      data-side="bottom"
      data-align="end"
      className="acc-pop w-40 rounded-md border border-border bg-card p-1 shadow-md"
    >
      {children}
    </div>
  )
}
