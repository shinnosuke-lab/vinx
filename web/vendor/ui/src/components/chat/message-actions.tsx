import { useState, memo, type RefObject } from "react"
import { Copy, Check, Download, Printer } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { copyToClipboard } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

interface MessageActionsProps {
  content: string
  /** The rendered answer body element, exported as-is to PDF. */
  bodyRef: RefObject<HTMLElement>
  /** Save just this message's body to PDF (browser print dialog). */
  onExportPdf: (bodyEl: HTMLElement | null, title: string) => void
}

/**
 * A human-readable, filename-safe title for a single exported message: the
 * first non-empty line with markdown decoration stripped, truncated. Beats the
 * app brand ("Save as PDF" default) or an opaque timestamp as a file name.
 */
function deriveMessageTitle(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  const plain = firstLine
    .replace(/^#{1,6}\s+/, "") // heading marker
    .replace(/^[>\-*+]\s+/, "") // quote / list marker
    .replace(/[*_`~]/g, "") // emphasis / code marks
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ") // filename-unsafe chars
    .replace(/\s+/g, " ")
    .trim()
  const truncated = plain.length > 40 ? plain.slice(0, 40).trim() : plain
  return truncated || "message"
}

export const MessageActions = memo(function MessageActions({ content, bodyRef, onExportPdf }: MessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!content) return null

  const handleCopy = async () => {
    await copyToClipboard(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSaveMd = () => {
    const blob = new Blob([content], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${deriveMessageTitle(content)}.md`
    a.click()
    URL.revokeObjectURL(url)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 [@media(hover:none)]:opacity-100 print:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleCopy}
        className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
        title={copied ? t("copied") : t("copy")}
      >
        {copied ? (
          <Check className="text-success" />
        ) : (
          <Copy />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleSaveMd}
        className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
        title={t("saveAsMarkdown")}
      >
        {saved ? (
          <Check className="text-success" />
        ) : (
          <Download />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onExportPdf(bodyRef.current, deriveMessageTitle(content))}
        className="h-6 w-6 [&_svg]:size-3 text-muted-foreground/60 hover:text-muted-foreground"
        title={t("saveAsPdf")}
      >
        <Printer />
      </Button>
    </div>
  )
})
