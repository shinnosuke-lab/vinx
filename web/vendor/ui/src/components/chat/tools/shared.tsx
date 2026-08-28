import { useEffect, useRef, useState } from "react"
import type { RefObject } from "react"
import { Check, Copy, Loader2 } from "lucide-react"
import { copyToClipboard } from "@agentchat/lib/utils"
import { t } from "@agentchat/lib/i18n"

export function CopyButton({ text, dark }: { text: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await copyToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      className={
        dark
          ? "shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
          : "shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
      }
      title={copied ? t("copied") : t("copy")}
    >
      {copied ? (
        <Check className={`h-3 w-3 ${dark ? "text-emerald-400" : "text-success"}`} />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  )
}

export function RunningIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground/50">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t("executing")}
    </div>
  )
}

export function tryParseJson(str?: string): Record<string, unknown> | null {
  if (!str) return null
  try {
    const parsed = JSON.parse(str)
    return typeof parsed === "object" && parsed !== null ? parsed : null
  } catch {
    const repaired = repairPartialJson(str)
    if (repaired == null) return null
    try {
      const parsed = JSON.parse(repaired)
      return typeof parsed === "object" && parsed !== null ? parsed : null
    } catch {
      return null
    }
  }
}

/**
 * Best-effort repair for partial JSON emitted during LLM streaming.
 *
 * Walks the buffer with a tiny state machine tracking container nesting and
 * string/escape state. At EOF it closes any dangling string, drops
 * trailing commas, fills missing values, discards incomplete keys, and
 * appends the missing container closers so the result is parseable.
 * Returns null if the prefix is not recognisably JSON-ish.
 */
function repairPartialJson(input: string): string | null {
  const src = input.trimStart()
  if (!src) return null
  if (src[0] !== "{" && src[0] !== "[") return null

  type Expect = "key" | "colon" | "value" | "comma"
  interface Frame { close: "}" | "]"; expect: Expect }

  const stack: Frame[] = []
  let inString = false
  let escape = false
  // Whether the currently-open string is a key or a value context,
  // so we know how to repair if the buffer ends mid-string.
  let stringRole: "key" | "value" = "value"
  // Index of the opening quote of the currently-open string (so we can
  // drop an incomplete key together with its preceding comma).
  let stringStart = -1

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
        const top = stack[stack.length - 1]
        if (top) {
          if (top.close === "}") {
            top.expect = stringRole === "key" ? "colon" : "comma"
          } else {
            top.expect = "comma"
          }
        }
      }
      continue
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue

    if (ch === '"') {
      inString = true
      stringStart = i
      const top = stack[stack.length - 1]
      stringRole = top && top.close === "}" && top.expect === "key" ? "key" : "value"
      continue
    }

    if (ch === "{") {
      stack.push({ close: "}", expect: "key" })
      continue
    }
    if (ch === "[") {
      stack.push({ close: "]", expect: "value" })
      continue
    }
    if (ch === "}" || ch === "]") {
      stack.pop()
      const top = stack[stack.length - 1]
      if (top) top.expect = "comma"
      continue
    }
    if (ch === ":") {
      const top = stack[stack.length - 1]
      if (top) top.expect = "value"
      continue
    }
    if (ch === ",") {
      const top = stack[stack.length - 1]
      if (top) top.expect = top.close === "}" ? "key" : "value"
      continue
    }

    // Primitive literal: number / true / false / null
    let j = i + 1
    while (j < src.length && !/[\s,}\]]/.test(src[j])) j++
    if (j === src.length) {
      // Incomplete primitive — drop it, we'll fill below.
      const top = stack[stack.length - 1]
      if (top && top.expect === "value") {
        return repairAssemble(src.slice(0, i), stack, /*fillValue*/ true, /*dropKey*/ false, -1)
      }
      return null
    }
    const top = stack[stack.length - 1]
    if (top) top.expect = "comma"
    i = j - 1
  }

  if (inString) {
    if (stringRole === "value") {
      // Close the value string and containers — preserves partial content.
      const tail = escape ? src.slice(0, -1) : src
      return repairAssemble(tail + '"', stack, /*fillValue*/ false, /*dropKey*/ false, -1)
    }
    // Incomplete key — drop it along with the preceding comma (if any).
    return repairAssemble(src, stack, /*fillValue*/ false, /*dropKey*/ true, stringStart)
  }

  const top = stack[stack.length - 1]
  if (top?.expect === "colon") {
    // Key finished but ":" not seen yet — drop the key.
    // Find the index of the last " which closed the key.
    const keyClose = src.lastIndexOf('"')
    const keyOpen = src.lastIndexOf('"', keyClose - 1)
    return repairAssemble(src, stack, /*fillValue*/ false, /*dropKey*/ true, keyOpen)
  }
  if (top?.expect === "value") {
    return repairAssemble(src, stack, /*fillValue*/ true, /*dropKey*/ false, -1)
  }
  // Expect 'key' or 'comma': trailing commas need trimming.
  const lastNonSpace = lastNonSpaceIndex(src)
  if (lastNonSpace >= 0 && src[lastNonSpace] === ",") {
    return repairAssemble(
      src.slice(0, lastNonSpace) + src.slice(lastNonSpace + 1),
      stack,
      false,
      false,
      -1,
    )
  }
  return repairAssemble(src, stack, false, false, -1)
}

function repairAssemble(
  body: string,
  stack: { close: "}" | "]" }[],
  fillValue: boolean,
  dropKey: boolean,
  keyStart: number,
): string {
  let out = body
  if (dropKey && keyStart >= 0) {
    let cut = keyStart
    // Swallow whitespace before the key
    while (cut > 0 && /\s/.test(out[cut - 1])) cut--
    // Swallow preceding comma so the object remains valid.
    if (cut > 0 && out[cut - 1] === ",") cut--
    out = out.slice(0, cut)
  }
  if (fillValue) out += "null"
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i].close
  }
  return out
}

function lastNonSpaceIndex(src: string): number {
  for (let i = src.length - 1; i >= 0; i--) {
    if (!/\s/.test(src[i])) return i
  }
  return -1
}

export function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

export function getFileExtension(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1 || dot === path.length - 1) return ""
  return path.slice(dot + 1).toLowerCase()
}

export function getFileName(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? path : path.slice(slash + 1)
}

// Sticky scroll-to-bottom for inner streaming containers (file-write
// content pre, diff pre, etc.). On each `dep` change we pin the element
// to the bottom only if the user was already there; once they scroll up
// to read history we stop yanking them down. Mirrors the pattern in
// `Markdown`'s CodeBlock so streaming UIs feel consistent across the
// chat surface.
export function useStickyScrollToBottom<E extends HTMLElement>(
  ref: RefObject<E | null>,
  dep: unknown,
  active: boolean = true,
) {
  const pinnedRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!active) return
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [ref, dep, active])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const threshold = 24
    const onScroll = () => {
      pinnedRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener("scroll", onScroll)
  }, [ref])

  return pinnedRef
}
