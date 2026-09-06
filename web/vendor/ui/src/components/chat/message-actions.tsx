import { useState, memo, type RefObject } from "react"
import { Copy, Check, Download, Printer } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { copyToClipboard } from "@agentchat/lib/utils"
import { deriveMessageTitle, saveMarkdownFile } from "@agentchat/lib/export"
import { t } from "@agentchat/lib/i18n"

interface MessageActionsProps {
  content: string
  /** The rendered answer body element, exported as-is to PDF. */
  bodyRef: RefObject<HTMLElement>
  /** Save just this message's body to PDF (browser print dialog). */
  onExportPdf: (bodyEl: HTMLElement | null, title: string) => void
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
    saveMarkdownFile(content, deriveMessageTitle(content))
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
