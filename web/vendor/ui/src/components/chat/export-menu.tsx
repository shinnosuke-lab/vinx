import { useState, useRef, useEffect } from "react"
import { EllipsisVertical, FileText, Printer } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

interface ExportMenuProps {
  onMarkdown: () => void
  onPdf: () => void
}

/** Tiny self-contained dropdown (no extra deps): Markdown / PDF export. */
export function ExportMenu({ onMarkdown, onPdf }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const pick = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        className="h-7 w-7 [&_svg]:size-4 text-muted-foreground hover:text-foreground"
        title={t("export")}
      >
        <EllipsisVertical />
      </Button>
      {open && (
        <div
          className={cn(
            "absolute right-0 top-full z-20 mt-1 min-w-36 overflow-hidden rounded-md",
            "border border-border bg-card py-1 shadow-md",
          )}
        >
          <button
            onClick={() => pick(onMarkdown)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t("exportMarkdown")}
          </button>
          <button
            onClick={() => pick(onPdf)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted"
          >
            <Printer className="h-4 w-4 text-muted-foreground" />
            {t("exportPdf")}
          </button>
        </div>
      )}
    </div>
  )
}
