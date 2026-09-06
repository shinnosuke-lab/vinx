import { useEffect, useState } from "react"
import { Download, FileText, X } from "lucide-react"
import { Button } from "@agentchat/components/ui/button"
import { Spinner } from "@agentchat/components/shared/spinner"
import { isTextLikeAttachment, fileTypeTag } from "@agentchat/lib/attachments"
import { t, tf } from "@agentchat/lib/i18n"
import { formatBytes } from "@agentchat/lib/releases"
import type { AttachmentView } from "@agentchat/types"

/** The text preview stops reading here: enough to recognise a file, small
 *  enough that a 20 MB log never lands in the DOM. The download link is the
 *  path to the full bytes. */
const PREVIEW_MAX_BYTES = 256 * 1024

type Body =
  | { status: "loading" }
  | { status: "ready"; text: string; truncated: boolean }
  | { status: "error" }

/** Read the first `PREVIEW_MAX_BYTES` of an upload as UTF-8, cancelling the
 *  body stream once enough has arrived (the upload endpoint has no Range
 *  support, so stopping the reader is what keeps big files cheap). */
async function readHead(
  src: string,
  knownSize: number | null | undefined,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(src, { signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  let done = false
  while (got < PREVIEW_MAX_BYTES) {
    const step = await reader.read()
    if (step.done) {
      done = true
      break
    }
    chunks.push(step.value)
    got += step.value.byteLength
  }
  if (!done) void reader.cancel()
  const buf = new Uint8Array(Math.min(got, PREVIEW_MAX_BYTES))
  let off = 0
  for (const c of chunks) {
    if (off >= buf.length) break
    const slice = c.subarray(0, Math.min(c.byteLength, buf.length - off))
    buf.set(slice, off)
    off += slice.byteLength
  }
  const truncated = knownSize && knownSize > 0 ? knownSize > PREVIEW_MAX_BYTES : !done
  return { text: new TextDecoder("utf-8").decode(buf), truncated }
}

/** Modal preview of a non-image attachment (queue strip chips). Text-like
 *  files (the server measured a line count, or the extension says text) show
 *  their head inline; everything else shows its metadata with a download
 *  button. Same chrome and dismissal rules as the image `Lightbox`: dimmed
 *  backdrop, Escape or backdrop click closes. */
export function FilePreview({
  file,
  src,
  downloadHref,
  onClose,
}: {
  file: AttachmentView
  /** Raw upload URL (what the text preview fetches). */
  src: string
  /** Upload URL carrying `?name=` so the browser saves the original name. */
  downloadHref: string
  onClose: () => void
}) {
  const textLike = isTextLikeAttachment(file)
  const [body, setBody] = useState<Body>({ status: "loading" })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  useEffect(() => {
    if (!textLike) return
    const ctrl = new AbortController()
    let live = true
    setBody({ status: "loading" })
    readHead(src, file.size, ctrl.signal)
      .then((r) => {
        if (live) setBody({ status: "ready", ...r })
      })
      .catch(() => {
        if (live) setBody({ status: "error" })
      })
    return () => {
      live = false
      ctrl.abort()
    }
  }, [src, textLike, file.size])

  const name = file.name || file.id
  const meta = [
    fileTypeTag(file),
    formatBytes(file.size),
    typeof file.lines === "number" ? `${file.lines} ${t("lines")}` : "",
  ].filter(Boolean)

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3 py-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={name}>
              {name}
            </div>
            {meta.length > 0 && (
              <div className="truncate text-[11px] text-muted-foreground">{meta.join(" · ")}</div>
            )}
          </div>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          >
            <a href={downloadHref} title={t("downloadFile")} aria-label={t("downloadFile")}>
              <Download />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
            title={t("close")}
            aria-label={t("close")}
          >
            <X />
          </Button>
        </div>
        {textLike ? (
          <>
            <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
              {body.status === "loading" ? (
                <div className="flex items-center justify-center gap-2 px-6 py-12 text-xs text-muted-foreground">
                  <Spinner size="sm" />
                  {t("loading")}
                </div>
              ) : body.status === "error" ? (
                <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground">
                  {t("filePreviewFailed")}
                  <Button asChild variant="outline" size="sm">
                    <a href={downloadHref}>
                      <Download />
                      {t("downloadFile")}
                    </a>
                  </Button>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-foreground/90">
                  {body.text}
                </pre>
              )}
            </div>
            {body.status === "ready" && body.truncated && (
              <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                {tf("filePreviewTruncated", formatBytes(PREVIEW_MAX_BYTES))}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground">
            <FileText className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} />
            {t("filePreviewUnavailable")}
            <Button asChild variant="outline" size="sm">
              <a href={downloadHref}>
                <Download />
                {t("downloadFile")}
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
