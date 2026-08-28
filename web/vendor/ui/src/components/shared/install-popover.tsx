import { useEffect, useRef, useState, type RefObject } from "react"
import { ArrowLeft, Link, Upload } from "lucide-react"
import { t } from "@agentchat/lib/i18n"
import { Spinner } from "@agentchat/components/shared/spinner"

/** Install popover anchored under a toolbar "Install" button: a "from file"
 *  action plus a URL field (the agent downloads + installs the package).
 *  Portal-positioned by the caller, right-aligned, closes on outside click /
 *  Esc. Shared by the skills and apps pages; all copy is passed in so each
 *  page speaks about its own artifact (skill zip / app tarball). */
export function InstallPopover({
  anchorRef,
  installing,
  fromFileLabel,
  fromUrlLabel,
  urlPlaceholder,
  installLabel,
  onClose,
  onInstallUrl,
  onPickFile,
}: {
  anchorRef: RefObject<HTMLDivElement | null>
  installing: boolean
  fromFileLabel: string
  fromUrlLabel: string
  urlPlaceholder: string
  installLabel: string
  onClose: () => void
  onInstallUrl: (url: string) => void
  onPickFile: () => void
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  // Menu first (choose source), then reveal the URL field on "from URL".
  const [mode, setMode] = useState<"menu" | "url">("menu")
  const [url, setUrl] = useState("")
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Right-align a 288px (w-72) panel under the trigger, clamped to the viewport.
    setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 288) })
  }, [anchorRef])

  useEffect(() => {
    if (mode === "url") inputRef.current?.focus()
  }, [mode])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (anchorRef.current?.contains(e.target as Node)) return
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
  }, [anchorRef, onClose])

  const submit = () => {
    const v = url.trim()
    if (v) onInstallUrl(v)
  }

  return (
    <div
      ref={contentRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      className="w-72 rounded-md border border-border bg-card p-1 shadow-md animate-in fade-in-0 zoom-in-95"
    >
      {mode === "menu" ? (
        <>
          <button
            type="button"
            onClick={onPickFile}
            disabled={installing}
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload size={12} />
            {fromFileLabel}
          </button>
          <button
            type="button"
            onClick={() => setMode("url")}
            disabled={installing}
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Link size={12} />
            {fromUrlLabel}
          </button>
        </>
      ) : (
        <div className="p-1.5">
          <div className="mb-2 flex items-center gap-1 text-[11px] font-medium text-foreground/80">
            <button
              type="button"
              onClick={() => setMode("menu")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("back")}
            >
              <ArrowLeft size={13} />
            </button>
            <Link size={12} />
            {fromUrlLabel}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={urlPlaceholder}
              className="min-w-0 flex-1 rounded-[4px] border border-border bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={installing || !url.trim()}
              className="flex h-6 shrink-0 items-center justify-center gap-1 rounded-[4px] bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing ? <Spinner size="sm" className="h-3 w-3" /> : installLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
