/**
 * LLM-authored CSS/JS injection for the `set_chat_style` easter egg.
 *
 * The backend forwards the model's payload as an SSE `style` event; this
 * module owns the singleton `<style>` tag the CSS lands in and the lifecycle
 * of the model's effect script. Deliberately not persisted anywhere: a page
 * refresh restores the default look, which doubles as the always-available
 * escape hatch.
 *
 * Streaming: the tool renderer live-applies partial CSS while the arguments
 * are still streaming (browsers ignore the trailing incomplete rule); the
 * final `style` event applies the definitive CSS and is the ONLY place the
 * script runs.
 */

const STYLE_TAG_ID = "acc-llm-style"

/** Cleanup callbacks registered by the currently-running effect script. */
let scriptCleanups: (() => void)[] = []

/**
 * The RAW (pre-sanitize) css/js currently reflected on the page. Tracked
 * independently: `lastCss` updates on every `applyLlmStyle` (including
 * streaming previews, which never run js); `lastJs` updates only when
 * `runLlmScript` actually executes. Two consumers read them:
 *   1. the idempotency guard in `AgentChat` (skip a re-apply whose payload is
 *      already live) — compared against the raw input, never `tag.textContent`
 *      which holds the sanitized output and would never match; and
 *   2. the "save this theme" button, which persists exactly what is on screen
 *      without a model round-trip.
 */
let lastCss = ""
let lastJs = ""

/** Strip external references: no cross-origin fetches from an easter egg.
 *  `@import` rules and every `url(...)` are removed EXCEPT the two same-origin
 *  forms a theme owns: a `data:` URI, and `/theme/assets/…` — the mount point
 *  serving the current look's own assets (see `releases::resolve_theme_asset`).
 *  `http(s)://` and protocol-relative `//host/…` stay blocked, and so does the
 *  rest of the origin (`/public/…`, `/api/…`, `/theme/../…`): a look ships its
 *  images inside its own package. Gradients, emoji content and box-shadow art
 *  are untouched.
 *
 *  The lookahead sits immediately after `url(` and consumes the whitespace
 *  itself: with `url\(\s*(?!…)` the `\s*` backtracks one space and satisfies
 *  the negative lookahead trivially, which strips even legitimate URLs written
 *  with padding. */
function sanitize(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\((?!\s*['"]?(?:data:|\/theme\/assets\/))[^)]*\)/gi, "none")
}

function fxLayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-acc="fx-layer"]')
}

/** Inject (or replace) the LLM stylesheet. Empty/whitespace CSS removes it
 *  (styling only — the script lifecycle is managed by `runLlmScript`). */
export function applyLlmStyle(css: string): void {
  lastCss = css
  if (!css.trim()) {
    document.getElementById(STYLE_TAG_ID)?.remove()
    return
  }
  const out = sanitize(css)
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
  if (!tag) {
    tag = document.createElement("style")
    tag.id = STYLE_TAG_ID
    document.head.appendChild(tag)
  }
  tag.textContent = out
}

/** Tear down the current effect script: run its registered cleanups and clear
 *  everything it parked in the fx-layer. Idempotent. */
export function disposeLlmScript(): void {
  const pending = scriptCleanups
  scriptCleanups = []
  for (const fn of pending) {
    try {
      fn()
    } catch (e) {
      console.error("[set_chat_style] cleanup failed:", e)
    }
  }
  const layer = fxLayer()
  if (layer) layer.replaceChildren()
}

/**
 * Run an LLM effect script in page context, replacing the previous one.
 * The script receives an `egg` handle: the app root, the fx-layer (cleared on
 * every replace/reset) and an `onCleanup` registrar.
 *
 * `prefers-reduced-motion` is deliberately NOT consulted here (nor for the CSS
 * in `applyLlmStyle`): a skin only exists because the user asked for one, so
 * the request itself is the consent. Gating on it also killed the whole script
 * rather than just its choreography, which silently swallowed static widgets
 * on machines where the OS flag is set for unrelated reasons — Windows turns
 * it on for "adjust for best performance" and remote desktop. The app's own
 * chrome still honours the setting via `theme.css`.
 */
export function runLlmScript(js: string): void {
  disposeLlmScript()
  lastJs = js.trim() ? js : ""
  if (!js.trim()) return
  const egg = {
    root: document.querySelector<HTMLElement>(".acc-root"),
    layer: fxLayer(),
    onCleanup: (fn: () => void) => {
      if (typeof fn === "function") scriptCleanups.push(fn)
    },
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("egg", js)(egg)
  } catch (e) {
    console.error("[set_chat_style] effect script failed:", e)
  }
}

/** Remove the injected stylesheet and stop the effect script, restoring the
 *  default look. */
export function clearLlmStyle(): void {
  document.getElementById(STYLE_TAG_ID)?.remove()
  disposeLlmScript()
  lastCss = ""
  lastJs = ""
}

/** Whether an LLM stylesheet is currently active. */
export function isLlmStyleActive(): boolean {
  return document.getElementById(STYLE_TAG_ID) !== null
}

/** Raw css currently applied to the page (last `applyLlmStyle` input). */
export function currentLlmCss(): string {
  return lastCss
}

/** Raw js currently running on the page (last `runLlmScript` that executed). */
export function currentLlmJs(): string {
  return lastJs
}
