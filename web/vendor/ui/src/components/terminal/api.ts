/**
 * REST + WebSocket endpoints for the local-shell terminal (Web SSH).
 *
 * The terminal SPA is served under `/terminal/` but the API lives at the
 * origin root (`/api/terminal…`), so all paths here are absolute. An optional
 * `window.__AGENT_BASE__` prefix mirrors the Copilot SPA for cross-origin dev.
 */

export const BASE: string = (window as unknown as { __AGENT_BASE__?: string }).__AGENT_BASE__ ?? ''

export interface CreateTerminalResp {
  sid: string
}

/** Spawn (or reattach to) a shell; returns its session id. */
export async function createTerminal(reuseSid?: string): Promise<CreateTerminalResp> {
  const payload: Record<string, unknown> = {}
  if (reuseSid) payload.reuse_sid = reuseSid

  const resp = await fetch(`${BASE}/api/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ message: `HTTP ${resp.status}` }))
    throw new Error(body.message ?? body.error ?? `HTTP ${resp.status}`)
  }
  return resp.json()
}

/** Best-effort teardown of a session (also used from `beforeunload`). */
export function closeTerminal(sid: string): void {
  const url = `${BASE}/api/terminal/${sid}/close`
  // sendBeacon (POST) survives page unload; the DELETE fallback covers
  // browsers where the beacon is unavailable.
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url)
  }
  fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {})
}

/** Absolute WebSocket URL for a session's PTY stream. */
export function terminalWsUrl(sid: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${BASE}/api/terminal/${sid}/ws`
}
