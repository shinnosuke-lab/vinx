import { useSyncExternalStore } from "react"

/**
 * Attention signals for a tab you are NOT looking at.
 *
 * A user with several sessions open walks away; each tab follows its own
 * session, so each tab is responsible for saying "this one needs you" when
 * a decision point arrives (`signalAttention`). Two channels, both gated on
 * the tab being in the background — while you are watching, the UI itself
 * is the signal and a chime would only be noise:
 *
 * - a title badge (`● <session> · <brand>`, read via `useAttention`) that
 *   tells the tabs apart at a glance and clears the moment the tab is
 *   focused again;
 * - a short synthesized chime (Web Audio, no asset): a different motif for
 *   "done", "waiting for your decision" and "error", so the ear knows the
 *   urgency before the eye finds the tab. Off switch in the ⋮ menu; the
 *   preference is per browser (this device), hence localStorage.
 *
 * Browsers only let audio start after a user gesture: `installAlerts` warms
 * the AudioContext on the first pointer/key event in the tab, which always
 * precedes a turn the user started here. A freshly reloaded tab that was
 * never touched stays silent (the badge still works).
 */

export type AlertKind = "done" | "attention" | "error"

const SOUND_KEY = "agentchat.alerts.sound"

// ── one tiny external store: the badge flag + the sound preference ──

let attention = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** True while this tab has an unseen decision point / finished turn. */
export function useAttention(): boolean {
  return useSyncExternalStore(subscribe, () => attention, () => false)
}

export function clearAttention(): void {
  if (!attention) return
  attention = false
  emit()
}

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "0"
  } catch {
    return true
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SOUND_KEY)
    else localStorage.setItem(SOUND_KEY, "0")
  } catch {
    // private mode / quota: the toggle simply does not persist
  }
  emit()
}

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribe, soundEnabled, () => true)
}

// ── background detection ──

/** Hidden tab, or a visible one whose window is not the active window. */
export function tabInBackground(): boolean {
  if (typeof document === "undefined") return false
  return document.hidden || !document.hasFocus()
}

// ── the chime ──

/** `[frequency Hz, start ms, duration ms]` per note. Sine, low gain, fast
 *  decay: a notification, not a jingle. The three motifs share a family so
 *  they read as one voice with three moods. */
const MOTIF: Record<AlertKind, Array<[number, number, number]>> = {
  // G5 → D6: a soft rising "ding" — done, your move when you get to it.
  done: [
    [784, 0, 140],
    [1175, 120, 240],
  ],
  // Two knocks then a lift — it is waiting on a decision.
  attention: [
    [988, 0, 110],
    [988, 170, 110],
    [1319, 340, 280],
  ],
  // One low tone — something went wrong.
  error: [[330, 0, 340]],
}

const MIN_GAP_MS = 1500

let ctx: AudioContext | null = null
let lastPlayedAt = 0

function playChime(kind: AlertKind): void {
  const c = ctx
  if (!c || c.state !== "running") return
  const now = performance.now()
  if (now - lastPlayedAt < MIN_GAP_MS) return
  lastPlayedAt = now

  const base = c.currentTime + 0.01
  for (const [freq, at, dur] of MOTIF[kind]) {
    const t0 = base + at / 1000
    const t1 = t0 + dur / 1000
    const osc = c.createOscillator()
    osc.type = "sine"
    osc.frequency.value = freq
    const gain = c.createGain()
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t1)
    osc.connect(gain).connect(c.destination)
    osc.start(t0)
    osc.stop(t1 + 0.02)
  }
}

/** Create/resume the context from inside a user gesture (the only place a
 *  browser lets it start). Idempotent. */
function unlockAudio(): void {
  if (typeof AudioContext === "undefined") return
  ctx ??= new AudioContext()
  if (ctx.state === "suspended") void ctx.resume()
}

// ── public entry points ──

/**
 * A moment that may need the user: turn finished (`done`), blocked on a
 * confirmation / question (`attention`), or failed (`error`). No-op while the
 * tab is in the foreground — the transcript is already showing it.
 */
export function signalAttention(kind: AlertKind): void {
  if (!tabInBackground()) return
  if (!attention) {
    attention = true
    emit()
  }
  if (soundEnabled()) playChime(kind)
}

/**
 * Wire the document-level listeners: warm the audio on the first gesture,
 * drop the badge when the tab is looked at again. Returns the cleanup.
 */
export function installAlerts(): () => void {
  if (typeof document === "undefined") return () => {}
  const opts = { capture: true, passive: true } as const
  const onSeen = () => {
    if (!tabInBackground()) clearAttention()
  }
  document.addEventListener("pointerdown", unlockAudio, opts)
  document.addEventListener("keydown", unlockAudio, opts)
  window.addEventListener("focus", onSeen)
  document.addEventListener("visibilitychange", onSeen)
  return () => {
    document.removeEventListener("pointerdown", unlockAudio, opts)
    document.removeEventListener("keydown", unlockAudio, opts)
    window.removeEventListener("focus", onSeen)
    document.removeEventListener("visibilitychange", onSeen)
  }
}
