import type { CSSProperties } from "react"
import type { ThemeTokens } from "../types"

/**
 * Map [`ThemeTokens`] to the CSS custom properties the `.acc-root` container
 * consumes (`--acc-accent` / `--acc-bg` / `--acc-fg`). Applied as an inline
 * `style` on the root by [`AgentChat`] and [`CopilotApp`]; absent tokens fall
 * back to the defaults declared in `theme.css`.
 */
export function themeToCssVars(theme?: ThemeTokens): CSSProperties {
  const vars: Record<string, string> = {}
  if (theme?.accent) vars["--acc-accent"] = theme.accent
  if (theme?.background) vars["--acc-bg"] = theme.background
  if (theme?.foreground) vars["--acc-fg"] = theme.foreground
  return vars as CSSProperties
}
