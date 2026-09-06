import { useState, useEffect, useRef, memo } from "react"
import { ChevronRight, Brain } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import { useFoldAll } from "@agentchat/lib/fold-all"
import { Markdown } from "./markdown"
import { Collapsible } from "./collapsible"

interface ReasoningBlockProps {
  content: string
  isStreaming: boolean
  /** Extra classes for the row (the transcript's entrance animation). */
  className?: string
}

export const ReasoningBlock = memo(function ReasoningBlock({ content, isStreaming, className }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming)
  const userToggledRef = useRef(false)

  useEffect(() => {
    if (userToggledRef.current) return
    setExpanded(isStreaming)
  }, [isStreaming])

  // Transcript-wide expand/collapse (header menu) counts as a user toggle so
  // the end-of-stream auto-fold does not undo it.
  useFoldAll((mode) => {
    userToggledRef.current = true
    setExpanded(mode === "expand")
  })

  if (!content) return null

  const handleToggle = () => {
    userToggledRef.current = true
    setExpanded((e) => !e)
  }

  return (
    <div data-acc="reasoning-block" className={cn("border-l border-l-muted-foreground/30 px-3", className)}>
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
        <Brain className="h-3 w-3" />
        {/* Keyed on the streaming flag so the label re-mounts — and fades in —
            when "Thinking…" settles into "Reasoning". */}
        <span key={isStreaming ? "live" : "done"} className="animate-label-in">
          {isStreaming ? t("thinkingLabel") : t("reasoning")}
        </span>
      </button>
      <Collapsible open={expanded}>
        <div className="reasoning-markdown pb-1 pt-1.5">
          <Markdown
            content={content}
            isStreaming={isStreaming}
            className="text-xs leading-relaxed text-muted-foreground"
          />
        </div>
      </Collapsible>
    </div>
  )
})
