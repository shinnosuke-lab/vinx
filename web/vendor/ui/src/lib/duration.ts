import { tf } from "./i18n"

/**
 * A duration BUDGET in human units — "25 min", "1 h 30 min", "45 s" — for the
 * limits and timeouts a reader compares against a running clock. Coarse by
 * design: a budget is a round figure, so seconds are dropped once there are
 * hours, and a figure is never shown as "1500s".
 *
 * Elapsed readouts are a different thing and keep their m:ss clock form
 * (`7:57`): they are read as a stopwatch, a budget as a quantity.
 */
export function formatBudget(secs: number): string {
  const total = Math.max(0, Math.round(secs))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h > 0) parts.push(tf("durationHours", h))
  if (m > 0) parts.push(tf("durationMinutes", m))
  if (s > 0 && h === 0) parts.push(tf("durationSeconds", s))
  if (parts.length === 0) parts.push(tf("durationSeconds", 0))
  return parts.join(" ")
}
