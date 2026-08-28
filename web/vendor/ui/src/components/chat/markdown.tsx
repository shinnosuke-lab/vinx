import { useEffect, useRef, useState, useMemo, memo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import DOMPurify from "dompurify"
import type { Components } from "react-markdown"
import { Code, Eye, Copy, Check, Download, ExternalLink, Braces, Database, Globe, RotateCcw, Settings2, Workflow, FileCode2 } from "lucide-react"
import PythonIcon from "react-devicons/python/original"
import JavascriptIcon from "react-devicons/javascript/original"
import TypescriptIcon from "react-devicons/typescript/original"
import GoIcon from "react-devicons/go/original"
import RustIcon from "react-devicons/rust/original"
import CIcon from "react-devicons/c/original"
import CppIcon from "react-devicons/cplusplus/original"
import JavaIcon from "react-devicons/java/original"
import KotlinIcon from "react-devicons/kotlin/original"
import SwiftIcon from "react-devicons/swift/original"
import CsharpIcon from "react-devicons/csharp/original"
import RubyIcon from "react-devicons/ruby/original"
import Html5Icon from "react-devicons/html5/original"
import Css3Icon from "react-devicons/css3/original"
import BashIcon from "react-devicons/bash/original"
import MarkdownIcon from "react-devicons/markdown/original"
import DockerIcon from "react-devicons/docker/original"
import PhpIcon from "react-devicons/php/original"
import LuaIcon from "react-devicons/lua/original"
import ScalaIcon from "react-devicons/scala/original"
import PerlIcon from "react-devicons/perl/original"
import RLangIcon from "react-devicons/r/original"
import { cn, copyToClipboard } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

let mermaidIdCounter = 0

function cleanupMermaidErrorArtifacts() {
  document
    .querySelectorAll('body > svg[id^="mermaid-"][aria-roledescription="error"]')
    .forEach((el) => el.remove())
  document
    .querySelectorAll("body > #d" + "mermaid-error")
    .forEach((el) => el.remove())
}

const MERMAID_DEBOUNCE_MS = 600
/** Pause before the one automatic re-render after a failed attempt. */
const MERMAID_RETRY_MS = 300

/** mermaid is a singleton: `initialize()` mutates global config and
 *  `render()` shares parser/layout state, so two blocks rendering
 *  concurrently (typical right after a stream ends, when every block's
 *  debounce fires together) can cross-contaminate themes or throw
 *  spuriously. All renders funnel through this one promise chain. */
let mermaidRenderChain: Promise<void> = Promise.resolve()

function renderMermaidSerialized(
  code: string,
  themeVariables: Record<string, string | boolean>,
): Promise<string> {
  const run = async (): Promise<string> => {
    const mermaid = (await import("mermaid")).default
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables,
      suppressErrorRendering: true,
    })
    const id = `mermaid-${++mermaidIdCounter}`
    const { svg } = await mermaid.render(id, code)
    return svg
  }
  // Chain regardless of the predecessor's outcome; park the chain's own
  // rejection so a failed render never surfaces as an unhandled rejection.
  const result = mermaidRenderChain.then(run, run)
  mermaidRenderChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Resolve chat-surface theme tokens from `host`'s computed style into concrete
 * `rgb()` strings. Mermaid's color math (khroma) can't parse Tailwind v4's
 * space-separated `hsl(220 13% 91%)` values, so each token is normalized
 * through a probe element. Missing/invalid tokens are simply omitted.
 */
function resolveThemeTokens(host: Element, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const cs = getComputedStyle(host)
    const probe = document.createElement("span")
    probe.style.display = "none"
    document.body.appendChild(probe)
    for (const n of names) {
      const raw = cs.getPropertyValue(n).trim()
      if (!raw) continue
      probe.style.color = ""
      probe.style.color = raw
      if (!probe.style.color) continue
      const resolved = getComputedStyle(probe).color
      if (resolved) out[n] = resolved
    }
    probe.remove()
  } catch {
    /* detached node / non-browser env: fall back to the static palette */
  }
  return out
}

/**
 * Diagram palette derived from the hosting surface's theme tokens, so mermaid
 * blends into whatever panel renders it (main chat: navy; terminal assistant
 * panel: zinc — `.tac-panel` remaps the tokens). The hardcoded values are the
 * fallback when tokens are unavailable.
 */
function mermaidThemeVars(isDark: boolean, host?: Element | null): Record<string, string | boolean> {
  let fill = isDark ? "#1e293b" : "#f1f3f5"
  let border = isDark ? "#334155" : "#e4e7eb"
  let text = isDark ? "#f8fafc" : "#030712"
  let line = isDark ? "#94a3b8" : "#cbd5e1"
  let bg = isDark ? "#0f172a" : "#ffffff"
  let tertiary = isDark ? "#111c2e" : "#f8fafc"
  if (host) {
    const tok = resolveThemeTokens(host, [
      "--color-background",
      "--color-secondary",
      "--color-border",
      "--color-foreground",
      "--color-muted-foreground",
      "--color-muted",
    ])
    bg = tok["--color-background"] ?? bg
    fill = tok["--color-secondary"] ?? fill
    border = tok["--color-border"] ?? border
    text = tok["--color-foreground"] ?? text
    line = tok["--color-muted-foreground"] ?? line
    tertiary = tok["--color-muted"] ?? tertiary
  }
  return {
    darkMode: isDark,
    background: bg,
    // Match the container background so edge labels have no visible plate while
    // still masking the link line that runs behind them (transparent would let
    // the line cut through the text). mermaid otherwise derives this from
    // secondaryColor and, in dark mode, darkens it into a grey block.
    edgeLabelBackground: bg,
    primaryColor: fill,
    primaryBorderColor: border,
    primaryTextColor: text,
    lineColor: line,
    secondaryColor: bg,
    tertiaryColor: tertiary,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    actorBkg: fill,
    actorBorder: line,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: fill,
    labelBoxBorderColor: line,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: fill,
    noteBorderColor: line,
    noteTextColor: text,
    activationBkgColor: border,
    activationBorderColor: line,
    sequenceNumberColor: text,
  }
}

const LANG_EXT: Record<string, string> = {
  javascript: "js", typescript: "ts", python: "py", ruby: "rb",
  rust: "rs", golang: "go", go: "go", java: "java", kotlin: "kt",
  swift: "swift", csharp: "cs", cpp: "cpp", c: "c", html: "html",
  css: "css", json: "json", yaml: "yml", yml: "yml", xml: "xml",
  sql: "sql", bash: "sh", shell: "sh", sh: "sh", zsh: "sh",
  markdown: "md", toml: "toml", ini: "ini",
  dockerfile: "Dockerfile", makefile: "Makefile",
}

type IconFC = React.ComponentType<{ className?: string; size?: string | number }>

// Colored language marks via devicons on the code-block headers.
const DEVICON_MAP: Record<string, IconFC> = {
  python: PythonIcon, py: PythonIcon,
  javascript: JavascriptIcon, js: JavascriptIcon,
  typescript: TypescriptIcon, ts: TypescriptIcon,
  go: GoIcon, golang: GoIcon,
  rust: RustIcon, rs: RustIcon,
  c: CIcon,
  cpp: CppIcon, "c++": CppIcon, cplusplus: CppIcon,
  java: JavaIcon,
  kotlin: KotlinIcon, kt: KotlinIcon,
  swift: SwiftIcon,
  csharp: CsharpIcon, cs: CsharpIcon,
  ruby: RubyIcon, rb: RubyIcon,
  html: Html5Icon,
  css: Css3Icon,
  bash: BashIcon, shell: BashIcon, sh: BashIcon, zsh: BashIcon,
  markdown: MarkdownIcon, md: MarkdownIcon,
  dockerfile: DockerIcon, docker: DockerIcon,
  php: PhpIcon,
  lua: LuaIcon,
  scala: ScalaIcon,
  perl: PerlIcon,
  r: RLangIcon,
}

// Lucide fallbacks for languages without a (sensible) devicon.
const LUCIDE_FALLBACK: Record<string, IconFC> = {
  json: Braces,
  sql: Database,
  xml: Globe,
  yaml: Settings2, yml: Settings2, toml: Settings2, ini: Settings2,
  mermaid: Workflow,
}

function getLangIcon(lang: string): IconFC {
  const key = lang.toLowerCase()
  return DEVICON_MAP[key] || LUCIDE_FALLBACK[key] || FileCode2
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (typeof node === "object" && "props" in node)
    return extractText((node as any).props.children)
  return ""
}

function downloadFile(content: string, filename: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        copyToClipboard(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="code-toolbar-btn"
      title={copied ? t("copied") : t("copyCode")}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function DlBtn({ content, name, mime }: { content: string; name: string; mime?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        downloadFile(content, name, mime)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
      className="code-toolbar-btn"
      title={t("download")}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Download className="h-3.5 w-3.5" />}
    </button>
  )
}

/* ── Mermaid helpers: SVG → PNG, new tab, markdown wrap ── */

function buildMermaidMarkdown(code: string): string {
  return "```mermaid\n" + code + "\n```\n"
}

function getSvgIntrinsicSize(svgText: string): { width: number; height: number } {
  const tagMatch = svgText.match(/<svg\b[^>]*>/i)
  if (!tagMatch) return { width: 800, height: 600 }
  const tag = tagMatch[0]
  let vbW = 0
  let vbH = 0
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(tag)
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number)
    vbW = Number.isFinite(parts[2]) ? parts[2] : 0
    vbH = Number.isFinite(parts[3]) ? parts[3] : 0
  }
  const parsePx = (raw: string | undefined): number => {
    if (!raw) return 0
    const m = /^(\d+(?:\.\d+)?)(px)?$/i.exec(raw.trim())
    return m ? Number(m[1]) : 0
  }
  const wm = /\bwidth\s*=\s*["']([^"']+)["']/i.exec(tag)
  const hm = /\bheight\s*=\s*["']([^"']+)["']/i.exec(tag)
  const pxW = parsePx(wm?.[1])
  const pxH = parsePx(hm?.[1])
  const w = pxW || vbW || 800
  const h = pxH || vbH || 600
  return { width: w, height: h }
}

function svgWithFixedSize(svgText: string, w: number, h: number): string {
  const stripMax = (css: string) =>
    css
      .replace(/max-width\s*:[^;"']*;?/gi, "")
      .replace(/max-height\s*:[^;"']*;?/gi, "")
  return svgText.replace(/<svg\b([^>]*)>/i, (_m, rawAttrs: string) => {
    let attrs = rawAttrs
      .replace(/\s(width|height)\s*=\s*"[^"]*"/gi, "")
      .replace(/\s(width|height)\s*=\s*'[^']*'/gi, "")
    attrs = attrs
      .replace(/style\s*=\s*"([^"]*)"/gi, (_s, css: string) => `style="${stripMax(css)}"`)
      .replace(/style\s*=\s*'([^']*)'/gi, (_s, css: string) => `style='${stripMax(css)}'`)
    return `<svg${attrs} width="${w}" height="${h}">`
  })
}

async function svgToPngBlob(svgText: string): Promise<Blob> {
  const { width: srcW, height: srcH } = getSvgIntrinsicSize(svgText)
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const long = Math.max(srcW, srcH)
  const minLong = 1600
  const scaleForDpr = Math.max(2, dpr)
  const desiredLong = Math.max(minLong, long * scaleForDpr)
  const maxLong = 4096
  const finalLong = Math.min(maxLong, desiredLong)
  const scale = finalLong / long
  const cw = Math.max(1, Math.round(srcW * scale))
  const ch = Math.max(1, Math.round(srcH * scale))
  const fixedSvg = svgWithFixedSize(svgText, cw, ch)
  const svgBlob = new Blob([fixedSvg], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(svgBlob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error("svg image load failed"))
      i.src = url
    })
    const canvas = document.createElement("canvas")
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas 2d context unavailable")
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, cw, ch)
    ctx.drawImage(img, 0, 0, cw, ch)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
        "image/png",
      )
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function openDiagramInNewTab(svgText: string) {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>Diagram</title>` +
    `<style>html,body{margin:0;background:#fff}` +
    `body{min-height:100vh;padding:24px;box-sizing:border-box;display:flex;align-items:center;justify-content:center}` +
    `svg{display:block;max-width:none;max-height:none;height:auto;width:auto}</style>` +
    `</head><body>${svgText}</body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
  const win = window.open(url, "_blank", "noopener,noreferrer")
  if (!win) {
    const a = document.createElement("a")
    a.href = url
    a.target = "_blank"
    a.rel = "noopener noreferrer"
    a.click()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function CopyImageBtn({ svg }: { svg: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          const png = await svgToPngBlob(svg)
          if (
            typeof ClipboardItem !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.write === "function"
          ) {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
            return
          }
          throw new Error("clipboard image api unavailable")
        } catch {
          try {
            const png = await svgToPngBlob(svg)
            const url = URL.createObjectURL(png)
            const a = document.createElement("a")
            a.href = url
            a.download = `diagram-${Date.now()}.png`
            a.click()
            URL.revokeObjectURL(url)
          } catch (e) {
            console.warn("[agent-chat] copy image failed:", e)
          }
        }
      }}
      className="code-toolbar-btn"
      title={copied ? t("copied") : t("copyImage")}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/* ── MermaidBlock ── */

function MermaidBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const [svg, setSvg] = useState("")
  const [error, setError] = useState("")
  const [showCode, setShowCode] = useState(false)
  // Manual "retry render" from the error card: bumping it re-runs the render
  // effect without waiting for a code change or a page reload.
  const [retryNonce, setRetryNonce] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codeBodyRef = useRef<HTMLPreElement>(null)
  // Attached to whichever branch is mounted; used for scoped dark-mode
  // detection + theme-token resolution (the `dark` class may sit on a wrapper
  // div — e.g. the terminal SPA's `.acc-root.dark` — not on <html>).
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStreaming) {
      setSvg("")
      setError("")
      return
    }

    let cancelled = false
    setSvg("")
    setError("")

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      if (cancelled) return
      const host = rootRef.current
      const isDark =
        !!host?.closest(".dark") || document.documentElement.classList.contains("dark")
      const themeVariables = mermaidThemeVars(isDark, host)
      try {
        let rendered: string
        try {
          rendered = await renderMermaidSerialized(code, themeVariables)
        } catch {
          // One automatic retry: transient failures (a dynamic-import hiccup,
          // a race right after stream end) self-heal on a second pass, and
          // without it the error card latches until the code changes.
          cleanupMermaidErrorArtifacts()
          await new Promise((r) => setTimeout(r, MERMAID_RETRY_MS))
          if (cancelled) return
          rendered = await renderMermaidSerialized(code, themeVariables)
        }
        if (!cancelled)
          setSvg(DOMPurify.sanitize(rendered, {
            USE_PROFILES: { svg: true, svgFilters: true, html: true },
            ADD_TAGS: ["foreignObject"],
            HTML_INTEGRATION_POINTS: { foreignobject: true },
          }))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        cleanupMermaidErrorArtifacts()
      }
    }, MERMAID_DEBOUNCE_MS)

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [code, isStreaming, retryNonce])

  useEffect(() => {
    if (isStreaming && codeBodyRef.current)
      codeBodyRef.current.scrollTop = codeBodyRef.current.scrollHeight
  }, [code, isStreaming])

  const MermaidIcon = getLangIcon("mermaid")
  const codeView = (headerExtra?: React.ReactNode) => (
    <div ref={rootRef} className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">
          <MermaidIcon className="lang-icon" size="14px" />
          mermaid
        </span>
        <div className="code-block-actions">
          {headerExtra}
          <CopyBtn text={code} />
          <DlBtn
            content={buildMermaidMarkdown(code)}
            name={`diagram-${Date.now()}.md`}
            mime="text/markdown"
          />
        </div>
      </div>
      <pre className="code-block-body" ref={codeBodyRef}>
        <code>{code}</code>
      </pre>
    </div>
  )

  if (isStreaming || (!svg && !error)) return codeView()

  if (error) {
    return (
      <div ref={rootRef} className="code-block-wrapper">
        <div className="code-block-header">
          <span className="code-block-lang text-destructive">
            <MermaidIcon className="lang-icon" size="14px" />
            mermaid — {t("renderError")}
          </span>
          <div className="code-block-actions">
            <button
              onClick={() => setRetryNonce((n) => n + 1)}
              className="code-toolbar-btn"
              title={t("retryRender")}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <CopyBtn text={code} />
            <DlBtn
              content={buildMermaidMarkdown(code)}
              name={`diagram-${Date.now()}.md`}
              mime="text/markdown"
            />
          </div>
        </div>
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          {error}
        </div>
        <pre className="code-block-body">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  if (showCode) {
    return codeView(
      <button
        onClick={() => setShowCode(false)}
        className="code-toolbar-btn"
        title={t("viewDiagram")}
      >
        <Eye className="h-3.5 w-3.5" />
      </button>,
    )
  }

  return (
    <div ref={rootRef} className="mermaid-container">
      <div className="mermaid-toolbar">
        <button onClick={() => setShowCode(true)} className="code-toolbar-btn" title={t("viewCode")}>
          <Code className="h-3.5 w-3.5" />
        </button>
        <CopyImageBtn svg={svg} />
        <DlBtn content={svg} name={`diagram-${Date.now()}.svg`} mime="image/svg+xml" />
        <button
          onClick={() => openDiagramInNewTab(svg)}
          className="code-toolbar-btn"
          title={t("openInNewTab")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="flex justify-center overflow-x-auto p-3 [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

/* ── CodeBlock ── */

function CodeBlock({ lang, code, children, isStreaming }: { lang: string; code: string; children: React.ReactNode; isStreaming?: boolean }) {
  const ext = LANG_EXT[lang] || lang || "txt"
  const bodyRef = useRef<HTMLPreElement>(null)
  const LangIcon = getLangIcon(lang)

  useEffect(() => {
    if (isStreaming && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [code, isStreaming])

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">
          <LangIcon className="lang-icon" size="14px" />
          {lang || t("code")}
        </span>
        <div className="code-block-actions">
          <CopyBtn text={code} />
          <DlBtn content={code} name={`code-${Date.now()}.${ext}`} />
        </div>
      </div>
      <pre className="code-block-body" ref={bodyRef}>
        {children}
      </pre>
    </div>
  )
}

/* ── Streaming: close unclosed code fences so react-markdown renders them ── */

function ensureClosedCodeFences(md: string): string {
  let open = false
  let fenceChar = ""
  let fenceLen = 0
  for (const line of md.split("\n")) {
    const trimmed = line.trimStart()
    if (!open) {
      const m = /^(`{3,}|~{3,})/.exec(trimmed)
      if (m) {
        open = true
        fenceChar = m[1][0]
        fenceLen = m[1].length
      }
    } else {
      let n = 0
      while (n < trimmed.length && trimmed[n] === fenceChar) n++
      if (n >= fenceLen && trimmed.slice(n).trim() === "") open = false
    }
  }
  return open ? md + "\n" + fenceChar.repeat(fenceLen) : md
}

/* ── Component overrides for ReactMarkdown ── */

function buildComponents(isStreaming?: boolean): Components {
  return {
    code({ className, children, node, ...props }) {
      const match = /language-(\w+)/.exec(className || "")
      const lang = match?.[1]

      if (lang === "mermaid") {
        const text = extractText(children).replace(/\n$/, "")
        return <MermaidBlock code={text} isStreaming={isStreaming} />
      }

      if (lang || className) {
        const text = extractText(children).replace(/\n$/, "")
        return (
          <CodeBlock lang={lang || ""} code={text} isStreaming={isStreaming}>
            <code className={className} {...props}>
              {children}
            </code>
          </CodeBlock>
        )
      }

      return (
        <code {...props}>
          {children}
        </code>
      )
    },

    table({ children, node, ...props }) {
      return (
        <div className="md-table-wrap">
          <table {...props}>{children}</table>
        </div>
      )
    },

    a({ href, children, node, ...props }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      )
    },
  }
}

/* ── Markdown ── */

interface MarkdownProps {
  content: string
  className?: string
  isStreaming?: boolean
}

const remarkPluginsConst = [remarkGfm]
const rehypePluginsConst = [rehypeHighlight]
// While streaming, syntax highlighting is skipped: rehype-highlight re-tokenizes
// every code block on each delta, the single biggest per-frame cost on
// code-heavy replies. Blocks colorize once, when the message completes.
const rehypePluginsStreaming: typeof rehypePluginsConst = []

export const Markdown = memo(function Markdown({ content, className, isStreaming }: MarkdownProps) {
  const processed = isStreaming ? ensureClosedCodeFences(content) : content
  const components = useMemo(() => buildComponents(isStreaming), [isStreaming])
  return (
    <div className={cn("markdown-body text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPluginsConst}
        rehypePlugins={isStreaming ? rehypePluginsStreaming : rehypePluginsConst}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
})
