/**
 * Attachment helpers shared by the transcript, the composer chips and the
 * queue strip: what an upload id says about its content, and whether the
 * in-app preview can show a file as text.
 */

import type { AttachmentView } from "@agentchat/types"

/** Upload ids are `<uuid>.<ext>` and the upload endpoint reserves these
 *  extensions for image bodies, so the id alone tells thumbnail from chip. */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"])

/** Extensions the text preview accepts when a row predates the server-side
 *  `lines` measurement (legacy rows carry no better signal). Anything not
 *  listed is offered for download only. Extension-less text files
 *  (`Dockerfile`, `.env`) are covered by `lines` on every current upload. */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml",
  "xml", "log", "ini", "cfg", "conf", "env", "properties", "lock", "tex",
  "diff", "patch", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte", "html", "htm", "css", "scss", "less",
  "py", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "lua",
  "pl", "r", "scala", "dart", "ex", "exs", "erl", "hs", "clj", "svg",
])

/** Lower-cased extension of a file name / upload id (`""` when none). */
export function fileExt(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase()
}

/** `<uuid>.<ext>` upload id → is it an image (thumbnail vs file chip)? */
export function isImageUploadId(id: string): boolean {
  return IMAGE_EXTS.has(fileExt(id))
}

/** Whether the in-app preview can show this attachment as text. The server
 *  counts lines only for text-like bodies (no NUL byte in the first 8 KB),
 *  so a line count is the authoritative signal; rows without one fall back
 *  to the original name's extension. Images never qualify — they get the
 *  lightbox. */
export function isTextLikeAttachment(a: AttachmentView): boolean {
  if (isImageUploadId(a.id)) return false
  if (typeof a.lines === "number") return true
  return TEXT_EXTS.has(fileExt(a.name ?? "") || fileExt(a.id))
}

/** Short type tag for a file chip (`PDF`, `CSV`); empty when the extension
 *  is missing or too long to read as a badge. */
export function fileTypeTag(a: AttachmentView): string {
  const ext = fileExt(a.name ?? "") || fileExt(a.id)
  return ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : ""
}
