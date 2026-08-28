import { t } from "@agentchat/lib/i18n"

// Time buckets + weather glyphs mirror the TUI welcome card
// (src/tui/draw.rs `welcome_identity`): 5-11 morning 🌅, 12-17 afternoon ☀️,
// everything else (including the small hours) evening 🌙.
function greeting(): { key: "goodMorning" | "goodAfternoon" | "goodEvening"; emoji: string } {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return { key: "goodMorning", emoji: "🌅" }
  if (hour >= 12 && hour < 18) return { key: "goodAfternoon", emoji: "☀️" }
  return { key: "goodEvening", emoji: "🌙" }
}

/** Time-based greeting shown on an empty chat. Optionally branded: a logo
 *  mark above and a one-line tagline below (both driven by `/api/chat/meta`,
 *  so hosts opt in via config/meta.json without touching the library). */
export function ChatWelcome({ logo, tagline }: { logo?: string; tagline?: string } = {}) {
  const { key, emoji } = greeting()
  return (
    <div className="flex flex-col items-center gap-3">
      {logo ? (
        <img src={logo} alt="" className="h-14 w-14 rounded-2xl object-contain" />
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight">
        {t(key)} {emoji}
      </h1>
      {tagline ? (
        <p className="text-sm text-muted-foreground">{tagline}</p>
      ) : null}
    </div>
  )
}
