import { useState, useEffect, useRef, memo } from "react"
import { ChevronRight, Brain } from "lucide-react"
import { cn } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"
import { Markdown } from "./markdown"

interface ReasoningBlockProps {
  content: string
  isStreaming: boolean
}

export const ReasoningBlock = memo(function ReasoningBlock({ content, isStreaming }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(isStreaming)
  const userToggledRef = useRef(false)

  useEffect(() => {
    if (userToggledRef.current) return
    setExpanded(isStreaming)
  }, [isStreaming])

  if (!content) return null

  const handleToggle = () => {
    userToggledRef.current = true
    setExpanded((e) => !e)
  }

  return (
    <div data-acc="reasoning-block" className="border-l border-l-muted-foreground/30 px-3">
      <button
        onClick={handleToggle}
        className="flex w-full items-center gap-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <Brain className="h-3 w-3" />
        {isStreaming ? t("thinkingLabel") : t("reasoning")}
      </button>
      {expanded && (
        <div className="reasoning-markdown pb-1 pt-1.5">
          <Markdown
            content={content}
            isStreaming={isStreaming}
            className="text-xs leading-relaxed text-muted-foreground"
          />
        </div>
      )}
    </div>
  )
})
