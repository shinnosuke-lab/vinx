import { useRef, useState } from "react"
import { Tag } from "lucide-react"
import { CategoryPicker } from "@agentchat/components/sessions/category-picker"
import { t } from "@agentchat/lib/i18n"
import { cn } from "@agentchat/lib/utils"

/**
 * Chat-header category control: shows the open session's category as a
 * small tag pill (icon only while uncategorised) and opens the shared
 * [`CategoryPicker`] on click, so a conversation can be filed without a
 * detour through the sessions page. Sizing matches the neighbouring h-8
 * icon buttons; the label hides on narrow viewports (the tooltip keeps it).
 */
export function SessionCategoryButton({
  category,
  knownCategories,
  disabled,
  onChange,
}: {
  category: string | null
  /** Labels already in use across sessions — the picker offers them first. */
  knownCategories: string[]
  disabled?: boolean
  onChange: (category: string | null) => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const title = category ? `${t("category")}: ${category}` : t("setCategory")

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        data-acc="session-category"
        className={cn(
          "inline-flex h-8 min-w-8 max-w-40 shrink-0 items-center justify-center gap-1 rounded-md border text-xs transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-40",
          category
            ? "border-border bg-muted/40 px-2 text-foreground hover:bg-muted"
            : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <Tag className="h-4 w-4 shrink-0" />
        {category && <span className="hidden truncate sm:inline">{category}</span>}
      </button>
      {open && (
        <CategoryPicker
          anchorRef={anchorRef}
          categories={knownCategories}
          current={category}
          canClear={category !== null}
          onPick={(next) => {
            setOpen(false)
            if (next !== category) onChange(next)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
