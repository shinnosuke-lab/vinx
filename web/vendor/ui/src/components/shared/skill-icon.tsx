import { useState } from "react"
import { Sparkles } from "lucide-react"
import { cn } from "@agentchat/lib/utils"

/** Identity glyph: the skill's own icon, or (when it has none / fails to load) a
 *  shared default skill glyph so unset icons read as "skill" rather than a
 *  per-name letter avatar. Both branches render without a background so
 *  icon-less skills match the bare `<img>` of skills that ship an icon.
 *  `className` sets the size (default fits the card). */
export function SkillIcon({
  src,
  hasIcon,
  className = "h-4 w-4",
}: {
  name: string
  src: string
  hasIcon: boolean
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  if (!hasIcon || broken) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-muted-foreground/70",
          className,
        )}
      >
        <Sparkles className="h-[80%] w-[80%]" strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className={cn("shrink-0 rounded-[4px] object-contain", className)}
    />
  )
}
