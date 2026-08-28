/**
 * sessionStorage-backed list of live terminal SIDs.
 *
 * On reload the app drains this list and reattaches to the same shells
 * (POST /api/terminal with `reuse_sid`), so a browser refresh doesn't kill
 * the user's running sessions.
 */

const STORAGE_KEY = 'agent-terminal-sids'

function getSids(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function setSids(sids: string[]) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sids))
}

export function storeTerminalSid(sid: string) {
  const sids = getSids()
  if (!sids.includes(sid)) {
    sids.push(sid)
    setSids(sids)
  }
}

export function removeTerminalSid(sid: string) {
  setSids(getSids().filter((s) => s !== sid))
}

export function drainTerminalSids(): string[] {
  const sids = getSids()
  sessionStorage.removeItem(STORAGE_KEY)
  return sids
}
