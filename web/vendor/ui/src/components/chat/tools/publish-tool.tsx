import { ExternalLink, Globe } from "lucide-react"
import { t } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryParseJson, getFileName } from "./shared"
import type { ToolDisplayProps } from "./index"

/**
 * `publish` tool card: the result carries a `URL: /public/<name>` line — lift
 * it out and render an open-in-new-tab link plus a copy button holding the
 * absolute URL (the shareable form).
 */
export function PublishTool({ args, result, isRunning }: ToolDisplayProps) {
  const parsed = tryParseJson(args)
  const path = String(parsed?.path ?? "")

  const urlMatch = result?.match(/^URL: (\/public\/\S+)\s*$/m)
  const url = urlMatch?.[1]
  const resultText = urlMatch ? result!.replace(urlMatch[0], "").trimEnd() : result
  const shareUrl = url ? new URL(url, window.location.href).href : ""

  return (
    <div className="mt-1 space-y-1.5 pb-1">
      {path && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80 wrap-anywhere">
            <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            {getFileName(path)}
          </span>
        </div>
      )}

      {result && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 break-all">{resultText}</span>
          {url && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary no-underline transition-colors hover:bg-primary/20"
              >
                <ExternalLink className="h-3 w-3" />
                {t("openInNewTab")}
              </a>
              <CopyButton text={shareUrl} />
            </span>
          )}
        </div>
      )}

      {isRunning && !result && <RunningIndicator />}
    </div>
  )
}
