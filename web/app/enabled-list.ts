/**
 * /data/apps/enabled — the autostart list, user policy, one app id per
 * line. The guest edits it with `grep -qx || echo >>` (enable) and a
 * filtering rewrite (disable); these are the same edits on the same
 * bytes, for the page to make in the machine's mirror while it is off.
 * For a service the list means "rund starts it after a boot"; for a pure
 * web app it means "the desktop opens it when the page loads" (§10.7) —
 * one list, two clocks, and the guest and the page must agree byte for
 * byte, or the mirror's replay at boot would flip the person's choice.
 *
 * No DOM, no store: pure functions over bytes, tested under node.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The ids in the list, in file order, blank lines dropped. An absent
 * file is an empty list. */
export function parseEnabled(bytes: Uint8Array | undefined): string[] {
	if (!bytes || bytes.byteLength === 0) return [];
	return decoder
		.decode(bytes)
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * The list with ID added (on) or removed (off). Adding keeps the order
 * and appends once, as `grep -qx || echo >>` does; removing drops every
 * line that is exactly ID and keeps the rest as they were. Always ends in
 * a newline when non-empty (the guest's echo), empty bytes when empty —
 * the guest's `app disable` of the last id leaves an empty file too.
 */
export function withEnabled(bytes: Uint8Array | undefined, id: string, on: boolean): Uint8Array {
	const ids = parseEnabled(bytes);
	const has = ids.includes(id);
	if (on && has) return bytes ?? encoder.encode(`${id}\n`);
	const next = on ? [...ids, id] : ids.filter((x) => x !== id);
	return encoder.encode(next.length ? `${next.join('\n')}\n` : '');
}
