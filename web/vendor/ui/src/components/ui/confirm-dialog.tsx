/**
 * Design-system replacement for `window.confirm` / `window.prompt`: a small
 * centered dialog with a promise-based imperative API so call sites stay
 * one-liners:
 *
 *   if (!(await confirmDialog(t("deleteConfirm")))) return
 *   const name = await promptDialog(t("nameThis"), suggested) // null = cancel
 *
 * `<ConfirmDialogHost />` is mounted once by the app shell.
 */

import * as React from "react"
import { t } from "@agentchat/lib/i18n"
import { Button } from "./button"

/** Confirm request: resolves `true`/`false`. */
interface PendingConfirm {
  kind: "confirm"
  message: string
  resolve: (ok: boolean) => void
}

/** Prompt request: resolves the entered text, or `null` when cancelled. */
interface PendingPrompt {
  kind: "prompt"
  message: string
  defaultValue: string
  resolve: (value: string | null) => void
}

type Pending = PendingConfirm | PendingPrompt
type Listener = (pending: Pending | null) => void

let current: Pending | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l(current)
}

/** Cancel-resolve whatever is open (a second request supersedes the first —
 *  shouldn't happen in practice; all are user-initiated). */
function cancelCurrent() {
  if (current?.kind === "prompt") current.resolve(null)
  else current?.resolve(false)
}

/** Ask the user to confirm; resolves `true` on confirm, `false` otherwise. */
export function confirmDialog(message: string): Promise<boolean> {
  cancelCurrent()
  return new Promise<boolean>((resolve) => {
    current = { kind: "confirm", message, resolve }
    emit()
  })
}

/** Ask the user for a line of text; resolves the value (possibly empty — the
 *  caller decides how to treat that), or `null` when cancelled. */
export function promptDialog(message: string, defaultValue = ""): Promise<string | null> {
  cancelCurrent()
  return new Promise<string | null>((resolve) => {
    current = { kind: "prompt", message, defaultValue, resolve }
    emit()
  })
}

/** Dismiss with the negative outcome (false / null) and clear. */
function cancel() {
  cancelCurrent()
  current = null
  emit()
}

/** Confirm-resolve a confirm dialog with `true`. */
function settleConfirm() {
  if (current?.kind === "confirm") current.resolve(true)
  current = null
  emit()
}

/** Resolve a prompt dialog with the entered value. */
function settlePrompt(value: string) {
  if (current?.kind === "prompt") current.resolve(value)
  current = null
  emit()
}

/** Mount once in the app shell. */
export function ConfirmDialogHost() {
  const [pending, setPending] = React.useState<Pending | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const listener: Listener = (p) => setPending(p)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const isPrompt = pending?.kind === "prompt"

  // Prompt submits the entered value; confirm resolves true.
  const accept = React.useCallback(() => {
    if (current?.kind === "prompt") settlePrompt(inputRef.current?.value ?? "")
    else settleConfirm()
  }, [])

  React.useEffect(() => {
    if (!pending) return
    // Focus the input (and select the suggested name for quick overwrite) on a
    // prompt; otherwise focus the confirm button.
    if (pending.kind === "prompt") {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      confirmRef.current?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel()
      // Enter is handled by the input's own onKeyDown when a prompt is open, so
      // only drive confirm dialogs from the global listener here.
      if (e.key === "Enter" && pending.kind === "confirm") settleConfirm()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pending])

  if (!pending) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-4"
      onClick={cancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-md border border-border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-foreground">{pending.message}</div>
        {isPrompt && (
          <input
            ref={inputRef}
            type="text"
            defaultValue={(pending as PendingPrompt).defaultValue}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                accept()
              }
            }}
            className="mt-3 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            {t("cancel")}
          </Button>
          <Button
            ref={confirmRef}
            variant={isPrompt ? "default" : "destructive"}
            size="sm"
            onClick={accept}
          >
            {t("confirm")}
          </Button>
        </div>
      </div>
    </div>
  )
}
