import { describe, expect, it } from 'vitest';
import { parseEnabled, withEnabled } from '../../app/enabled-list';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * /data/apps/enabled is edited by the guest (`grep -qx || echo >>`, a
 * filtering rewrite) and by the page in the machine's mirror while it is
 * off. Same bytes, same edits — or the replay at boot would undo one side.
 */
describe('enabled-list', () => {
	it('reads the list as the guest writes it: one id per line, blanks ignored', () => {
		expect(parseEnabled(undefined)).toEqual([]);
		expect(parseEnabled(enc(''))).toEqual([]);
		expect(parseEnabled(enc('clock\n'))).toEqual(['clock']);
		expect(parseEnabled(enc('clock\n\nnotes\r\n  \n'))).toEqual(['clock', 'notes']);
	});

	it('enable appends once, in order, newline-terminated', () => {
		expect(dec(withEnabled(undefined, 'tick', true))).toBe('tick\n');
		expect(dec(withEnabled(enc('clock\n'), 'tick', true))).toBe('clock\ntick\n');
		// Already there: the bytes come back untouched (grep -qx says so).
		const same = enc('clock\ntick\n');
		expect(withEnabled(same, 'tick', true)).toBe(same);
		// A file the guest left without its final newline still reads as a list.
		expect(dec(withEnabled(enc('clock'), 'tick', true))).toBe('clock\ntick\n');
	});

	it('disable drops exactly that id and leaves the rest as they were', () => {
		expect(dec(withEnabled(enc('clock\ntick\nnotes\n'), 'tick', false))).toBe('clock\nnotes\n');
		expect(dec(withEnabled(enc('tick\n'), 'tick', false))).toBe('');
		expect(dec(withEnabled(enc('clock\n'), 'tick', false))).toBe('clock\n');
		// Prefixes and suffixes are other apps.
		expect(dec(withEnabled(enc('tick-tock\ntick\nticker\n'), 'tick', false))).toBe('tick-tock\nticker\n');
		expect(dec(withEnabled(undefined, 'tick', false))).toBe('');
	});
});
