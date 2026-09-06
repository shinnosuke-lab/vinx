/**
 * Composer draft persistence (localStorage).
 *
 * What the user has typed but not sent — the text, the `/skill` chip staged
 * for the next message and the attachments staged with it — survives a
 * reload, a killed tab or a crashed browser. One record per session under
 * `agent.draft.<session id>`; the fresh chat (no session yet) uses
 * `agent.draft.new`. Drafts are per session on purpose: the URL routes by
 * session (`#/chat/<id>`), so a reload lands on the same composer, and two
 * tabs on different sessions never overwrite each other.
 *
 * Attachments are stored as REFERENCES only. The composer uploads eagerly, so
 * the bytes already live on the server (`runtime/uploads/<id>`) and a chip is
 * rebuilt from `{id, name, kind, size, lines}` with its preview pointing at
 * `GET /api/chat/upload/<id>`. A chip whose upload is still in flight has no
 * id yet and is not recorded — its `File` cannot outlive the page anyway.
 *
 * Everything is best-effort: private mode / quota errors are swallowed (a
 * failed write also drops the previous record, so nothing outdated is ever
 * restored), corrupt or empty records read as "no draft", and `sweepDrafts`
 * clears records untouched for `DRAFT_MAX_AGE_MS`. Two tabs on the SAME
 * session write last-wins; the draft is loaded on open, not synced live.
 */

const DRAFT_KEY_PREFIX = "agent.draft."

/** Draft id of the fresh chat (no server session yet). Session ids are
 *  UUIDs, so this can never collide with a real one. */
export const NEW_CHAT_DRAFT_ID = "new"

/** Records untouched for this long are dropped by `sweepDrafts`. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** One staged attachment, by upload reference (see module docs). */
export interface DraftAttachment {
  id: string
  name: string
  kind: "image" | "file"
  size: number
  lines?: number | null
}

export interface ComposerDraft {
  text: string
  attachments: DraftAttachment[]
  /** Name of the `/skill` chip staged for the next message. */
  skill?: string
  /** Last write (ms since epoch); drives the age sweep. */
  updatedAt: number
}

/** Upload ids as the server mints them: `<uuid-simple>.<ext>`. Anything else
 *  in a stored record is corrupt (or tampered) and is dropped on read. */
const UPLOAD_ID_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/

function draftKey(id: string): string {
  return `${DRAFT_KEY_PREFIX}${id}`
}

function isDraftAttachment(v: unknown): v is DraftAttachment {
  if (!v || typeof v !== "object") return false
  const a = v as Record<string, unknown>
  return (
    typeof a.id === "string" &&
    UPLOAD_ID_RE.test(a.id) &&
    typeof a.name === "string" &&
    (a.kind === "image" || a.kind === "file") &&
    typeof a.size === "number" &&
    a.size >= 0 &&
    (a.lines === undefined || a.lines === null || typeof a.lines === "number")
  )
}

/** Parse one stored record; `null` for anything unusable or empty. */
function parseDraft(raw: string | null): ComposerDraft | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null
    if (!v || typeof v !== "object") return null
    const text = typeof v.text === "string" ? v.text : ""
    const attachments = Array.isArray(v.attachments)
      ? v.attachments.filter(isDraftAttachment)
      : []
    const skill = typeof v.skill === "string" && v.skill ? v.skill : undefined
    const updatedAt = typeof v.updatedAt === "number" ? v.updatedAt : 0
    if (!text.trim() && attachments.length === 0 && !skill) return null
    return { text, attachments, skill, updatedAt }
  } catch {
    return null
  }
}

/** The stored draft for a session (or `NEW_CHAT_DRAFT_ID`); `null` = none.
 *  Records past `DRAFT_MAX_AGE_MS` read as none too (the sweep removes them). */
export function readDraft(id: string, now = Date.now()): ComposerDraft | null {
  try {
    const draft = parseDraft(localStorage.getItem(draftKey(id)))
    if (!draft || now - draft.updatedAt > DRAFT_MAX_AGE_MS) return null
    return draft
  } catch {
    /* private mode: nothing to restore */
    return null
  }
}

/** Store a draft. An empty draft (no text, attachments or skill) removes the
 *  record instead, so a sent or cleared composer leaves nothing behind. */
export function writeDraft(id: string, draft: ComposerDraft): void {
  const empty = !draft.text.trim() && draft.attachments.length === 0 && !draft.skill
  if (empty) {
    clearDraft(id)
    return
  }
  const key = draftKey(id)
  try {
    localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Quota / private mode: better no draft than a stale one.
    try {
      localStorage.removeItem(key)
    } catch {
      /* nothing more to do */
    }
  }
}

export function clearDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id))
  } catch {
    /* private mode: nothing stored anyway */
  }
}

/** Drop drafts older than `maxAgeMs` plus any unparsable record. Meant to
 *  run once per page load; cheap (a handful of small keys). */
export function sweepDrafts(maxAgeMs = DRAFT_MAX_AGE_MS, now = Date.now()): void {
  try {
    const dead: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue
      const draft = parseDraft(localStorage.getItem(key))
      if (!draft || now - draft.updatedAt > maxAgeMs) dead.push(key)
    }
    // Remove after the scan: deleting while iterating shifts the indices.
    for (const key of dead) localStorage.removeItem(key)
  } catch {
    /* private mode */
  }
}
