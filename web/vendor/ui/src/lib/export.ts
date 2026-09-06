/**
 * Client-side export helpers shared by the transcript header menu, the
 * per-message actions and the task tool card: save text as a Markdown file,
 * print a DOM region to PDF, and derive a filename-safe title from content.
 */

/**
 * A human-readable, filename-safe title for exported content: the first
 * non-empty line with markdown decoration stripped, truncated. Beats the app
 * brand ("Save as PDF" default) or an opaque timestamp as a file name.
 */
export function deriveMessageTitle(content: string): string {
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

/** Download `content` as `<title>.md` via a transient object URL. */
export function saveMarkdownFile(content: string, title: string) {
  const blob = new Blob([content], { type: "text/markdown" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${title}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Print ONE element from inside the transcript as a single-page PDF, hiding
 * everything else. Shared by the per-message export button and the task
 * tool's prompt/result export buttons.
 *
 * Isolation is CSS-driven: `.print-solo` on the `[data-chat-messages]`
 * container plus `data-print-solo` on the target element activate theme.css's
 * solo print rules (hide every element that is not the target, an ancestor of
 * it, or inside it; strip ancestor chrome so the page height measured from
 * the target alone stays exact). Both markers are removed on `afterprint`.
 *
 * Outside a transcript (no `[data-chat-messages]` ancestor) it degrades to a
 * plain [`printElementToPdf`] of the element.
 */
export function printSoloElementToPdf(el: HTMLElement, title: string) {
  const container = el.closest<HTMLElement>("[data-chat-messages]")
  if (container) {
    container.classList.add("print-solo")
    el.setAttribute("data-print-solo", "")
    window.addEventListener(
      "afterprint",
      () => {
        container.classList.remove("print-solo")
        el.removeAttribute("data-print-solo")
      },
      { once: true },
    )
  }
  printElementToPdf(el, { title })
}

/**
 * Save a DOM region to PDF via the browser print dialog. Shared by the header
 * "export PDF" (whole transcript) and the per-message / task-block export
 * buttons.
 *
 * Sizes a single tall `@page` to the content: measures `el` at the printed
 * width (190mm) so wrapping matches the PDF, injects a one-shot `@page`, and
 * reproduces the active chat skin's page background. Cleaned up on `afterprint`.
 *
 * `neutralizeInnerColumn` handles the transcript container, whose inner column
 * (`mx-auto max-w-3xl px-4`) and print-only title (`[data-print-title]`) must
 * be measured the way the print stylesheet renders them. For a single message
 * body element there is no such column, so leave it off.
 */
export function printElementToPdf(
  el: HTMLElement,
  opts: { title?: string; neutralizeInnerColumn?: boolean } = {},
) {
  const prevTitle = document.title
  const cleanup = () => {
    document.getElementById("print-single-page")?.remove()
    document.title = prevTitle
  }

  const run = () => {
    // Measure with the SAME box the print stylesheet renders: theme.css's
    // `@media print` widens the transcript by dropping the inner column's
    // `px-4` / `max-w-3xl`. Measuring with the on-screen padding narrows the
    // text, wraps more lines, and over-counts the height — which then sizes
    // the single page too tall and leaves a long blank tail.
    const inner = opts.neutralizeInnerColumn
      ? el.querySelector<HTMLElement>(":scope > div:not([data-print-title])")
      : null
    // Save whole inline styles: the overrides below use `!important`
    // priority, which a property-by-property restore can't clear.
    const elCss = el.style.cssText
    const innerCss = inner?.style.cssText ?? ""
    // The print-only title is `display: none` on screen, so it would be
    // missing from the measured scrollHeight and the printed page would come
    // up short. Show it for the (synchronous, paint-free) measurement, then
    // restore.
    const titleEl = opts.neutralizeInnerColumn
      ? el.querySelector<HTMLElement>("[data-print-title]")
      : null
    const titleCss = titleEl?.style.cssText ?? ""
    titleEl?.style.setProperty("display", "block", "important")
    // Force the SAME geometry the print stylesheet forces (full width, no
    // column max-width/margins) — and with `!important`, so an active
    // `set_chat_style` skin's own `!important` width/padding can't narrow
    // the MEASURED content below the PRINTED width. A narrower measurement
    // wraps more lines and over-counts the height, sizing the single page
    // far too tall and leaving a long blank tail (the reported bug).
    el.style.setProperty("overflow", "visible", "important")
    el.style.setProperty("height", "auto", "important")
    el.style.setProperty("width", "190mm", "important")
    el.style.setProperty("max-width", "190mm", "important")
    if (inner) {
      inner.style.setProperty("max-width", "none", "important")
      inner.style.setProperty("margin-left", "0", "important")
      inner.style.setProperty("margin-right", "0", "important")
      inner.style.setProperty("padding-left", "0", "important")
      inner.style.setProperty("padding-right", "0", "important")
    }
    const contentHeightMm = Math.ceil((el.scrollHeight * 25.4) / 96)
    el.style.cssText = elCss
    if (inner) inner.style.cssText = innerCss
    if (titleEl) titleEl.style.cssText = titleCss
    // The page must clear the content plus the `@page` top+bottom margins;
    // a small safety margin guards against sub-pixel rounding clipping the
    // last line. Nothing more, so the tail stays tight (no long blank).
    // Keep in sync with the `[data-chat-messages]` print `padding` in
    // theme.css: the @page margin is dropped to 0 so a custom-skin page
    // background can bleed to the paper edge, and this inset moves into
    // that padding instead — so the single page is still sized around it.
    const PAGE_MARGIN_MM = 10
    const SAFETY_MM = 4
    const pageHeightMm = contentHeightMm + PAGE_MARGIN_MM * 2 + SAFETY_MM
    // Reproduce the active chat skin's page background (the resolved
    // `--color-background`, read off `.acc-root`) so a themed transcript
    // exports on themed "paper" instead of white — which also keeps a dark
    // skin's light text readable. Decorative background images / JS effects
    // are deliberately NOT reproduced (they only add noise to a document).
    const accRoot = el.closest(".acc-root") ?? document.body
    const pageBg = getComputedStyle(accRoot).backgroundColor
    const style = document.createElement("style")
    style.id = "print-single-page"
    // Geometry guard, re-stated here on top of theme.css's static print
    // rules: a `set_chat_style` skin is arbitrary LLM-written CSS injected
    // AFTER theme.css, so its `!important` margins / paddings / min-heights
    // win the source-order tie against the stylesheet and re-inflate the
    // print flow past the content-sized single page — the trailing blank
    // second page (reproduced headless: `body{margin:24px!important}` alone
    // spills it). This one-shot style element is appended at print time,
    // last in <head>, so the same tie always resolves back to the guard.
    const geometryGuard = `
      html, html body { height: auto !important; min-height: 0 !important; max-height: none !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }
      html body :has([data-chat-messages]) { position: static !important; height: auto !important; min-height: 0 !important; max-height: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: visible !important; transform: none !important; }
      html body [data-chat-messages] { margin: 0 !important; min-height: 0 !important; max-height: none !important; }`
    style.textContent = `@media print { @page { size: 210mm ${pageHeightMm}mm !important; margin: 0 !important; } html { background: ${pageBg} !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; } ${geometryGuard} }`
    document.head.appendChild(style)
    // The browser derives the default "Save as PDF" filename from
    // document.title — swap in the session title for the dialog's lifetime.
    if (opts.title) document.title = opts.title
    window.addEventListener("afterprint", cleanup, { once: true })
    requestAnimationFrame(() => window.print())
  }

  // Late-loading webfonts change line metrics (hence wrapping and height);
  // wait for them so the measurement matches what actually prints.
  const fonts = document.fonts
  if (fonts?.ready) {
    fonts.ready.then(run, run)
  } else {
    run()
  }
}
