import { useState, useRef, useEffect, type ReactNode } from "react"
import { Bell, BellOff, Check, ChevronsDownUp, ChevronsUpDown, EllipsisVertical, FileText, Printer } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import { setSoundEnabled, useSoundEnabled } from "@agentchat/lib/alerts"

interface ExportMenuProps {
  onMarkdown: () => void
  onPdf: () => void
  /** Expand every collapsible process block (step groups, reasoning, tool
   *  cards) — e.g. to export the full process to PDF. Optional: the menu
   *  shows the fold section only when both handlers are supplied. */
  onExpandAll?: () => void
  /** Collapse them all — an answers-only reading / export. */
  onCollapseAll?: () => void
}

function Item({
  icon,
  onClick,
  checked,
  children,
}: {
  icon: ReactNode
  onClick: () => void
  /** Toggle items: render as a checkbox with a trailing check mark. */
  checked?: boolean
  children: ReactNode
}) {
  const toggle = checked !== undefined
  return (
    <button
      type="button"
      role={toggle ? "menuitemcheckbox" : "menuitem"}
      aria-checked={toggle ? checked : undefined}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted"
    >
      <span className="[&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground">{icon}</span>
      <span className="flex-1">{children}</span>
      {toggle && <Check className={cn("h-4 w-4 text-primary", !checked && "invisible")} />}
    </button>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">{children}</div>
}

/** Tiny self-contained dropdown (no extra deps): transcript view controls
 *  (expand / collapse all process blocks) and Markdown / PDF export. The PDF
 *  prints the transcript as displayed, so the fold controls double as the
 *  "full process" vs "answers only" switch for the export. */
export function ExportMenu({ onMarkdown, onPdf, onExpandAll, onCollapseAll }: ExportMenuProps) {
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

  const hasFold = !!onExpandAll && !!onCollapseAll
  const sound = useSoundEnabled()

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-7 w-7 [&_svg]:size-4 text-muted-foreground hover:text-foreground"
        title={t("transcriptMenu")}
      >
        <EllipsisVertical />
      </Button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full z-20 mt-1 min-w-44 overflow-hidden rounded-md",
            "border border-border bg-card py-1 shadow-md",
          )}
        >
          {hasFold && (
            <>
              <SectionLabel>{t("transcriptView")}</SectionLabel>
              <Item icon={<ChevronsUpDown />} onClick={() => pick(onExpandAll)}>
                {t("expandAllSteps")}
              </Item>
              <Item icon={<ChevronsDownUp />} onClick={() => pick(onCollapseAll)}>
                {t("collapseAllSteps")}
              </Item>
              <div className="my-1 border-t border-border/60" />
            </>
          )}
          <SectionLabel>{t("alerts")}</SectionLabel>
          <Item
            icon={sound ? <Bell /> : <BellOff />}
            checked={sound}
            onClick={() => setSoundEnabled(!sound)}
          >
            {t("alertChime")}
          </Item>
          <div className="my-1 border-t border-border/60" />
          <SectionLabel>{t("export")}</SectionLabel>
          <Item icon={<FileText />} onClick={() => pick(onMarkdown)}>
            {t("exportMarkdown")}
          </Item>
          <Item icon={<Printer />} onClick={() => pick(onPdf)}>
            {t("exportPdf")}
          </Item>
        </div>
      )}
    </div>
  )
}
