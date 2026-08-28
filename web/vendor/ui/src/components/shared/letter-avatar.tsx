import { cn } from "@agentchat/lib/utils"

// Stable color palette for initial-letter avatars. Class strings are literals
// so Tailwind's JIT collects them. Shared by the sessions and skills cards so
// both generate identical avatars.
const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-pink-500",
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * A circular avatar showing `label`'s first character, tinted by a stable color
 * derived from `seed` (same seed → same hue). The base class carries no size;
 * callers pass sizing via `className` (e.g. `h-4 w-4 text-[10px]` on cards,
 * `h-9 w-9 text-sm` in detail views).
 */
export function LetterAvatar({
  seed,
  label,
  className,
}: {
  seed: string
  label: string
  className?: string
}) {
  const ch = ([...label.trim()][0] || "?").toUpperCase()
  const color = AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length]
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        color,
        className,
      )}
      title={label}
    >
      {ch}
    </span>
  )
}
