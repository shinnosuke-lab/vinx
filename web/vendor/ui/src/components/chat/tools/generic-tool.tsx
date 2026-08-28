import { useState } from "react"
import { cn } from "@agentchat/lib/utils"
import { t, tf } from "@agentchat/lib/i18n"
import { CopyButton, RunningIndicator, tryFormatJson } from "./shared"
import type { ToolDisplayProps } from "./index"

const OUTPUT_COLLAPSE_THRESHOLD = 2000

export function GenericTool({ args, result, isRunning }: ToolDisplayProps) {
  const [outputExpanded, setOutputExpanded] = useState(false)

  const hasArgs = !!args && args !== "{}" && args !== ""
  const hasResult = !!result
  const isLargeOutput = hasResult && result.length > OUTPUT_COLLAPSE_THRESHOLD
  const formattedArgs = hasArgs ? tryFormatJson(args) : ""

  return (
    <div className="mt-1 space-y-3 pb-1">
      {hasArgs && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("input")}
            </span>
            <CopyButton text={formattedArgs} />
          </div>
          <pre className="max-h-40 overflow-hidden rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground hover:overflow-auto">
            {formattedArgs}
          </pre>
        </div>
      )}

      {hasResult && (
        <div className="group/block">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              {t("output")}
            </span>
            <CopyButton text={result} />
          </div>
          <pre
            className={cn(
              "overflow-hidden whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground hover:overflow-auto",
              !outputExpanded && isLargeOutput && "max-h-32",
            )}
          >
            {outputExpanded || !isLargeOutput
              ? result
              : result.slice(0, OUTPUT_COLLAPSE_THRESHOLD) + "…"}
          </pre>
          {isLargeOutput && (
            <button
              onClick={() => setOutputExpanded((e) => !e)}
              className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              {outputExpanded ? t("showLess") : tf("showMoreChars", result.length.toLocaleString())}
            </button>
          )}
        </div>
      )}

      {isRunning && !hasResult && <RunningIndicator />}
    </div>
  )
}
