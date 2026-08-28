import { SquareTerminal } from "lucide-react"
import { t } from "@agentchat/lib/i18n"
import { RunningIndicator } from "./shared"
import type { ToolDisplayProps } from "./index"

/**
 * `open_terminal` tool card: the backend does nothing — the whole point is
 * this button, which lets the user open the web terminal in a new tab.
 */

/**
 * The terminal page's URL, derived from where this document lives rather than
 * hard-coded absolute: the site is built with relative paths (`base: './'`)
 * and may be served under a sub-path (GitHub Pages), where `/terminal` would
 * resolve against the domain root and 404. The document is either the chat
 * page at `<root>` or the console at `<root>terminal/`; strip down to
 * `<root>` and append `terminal/`.
 */
function terminalUrl(): string {
  const root = window.location.pathname
    .replace(/\/index\.html$/, "/")
    .replace(/\/terminal\/?$/, "/")
  return `${root}terminal/`
}

export function OpenTerminalTool({ result, isRunning }: ToolDisplayProps) {
  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {result && (
        <button
          type="button"
          // The card header also reads "Open Terminal" (the humanized tool
          // name) and the label is localized; tests need a handle that is
          // neither.
          data-testid="open-terminal"
          onClick={() => window.open(terminalUrl(), "_blank", "noopener,noreferrer")}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20"
        >
          <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
          {t("openTerminalBtn")}
        </button>
      )}
      {isRunning && !result && <RunningIndicator />}
    </div>
  )
}
