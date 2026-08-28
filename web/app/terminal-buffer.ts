/**
 * The console's screen, readable by the assistant.
 *
 * The xterm instance lives inside the Console component; the engine mounts
 * long after it and in another module. This tiny registry is the seam: the
 * console registers a reader over its live buffer, `read_terminal` (see
 * device-vm.ts) consumes it. One document has exactly one console, so a
 * single slot is the honest shape — no ids, no lists.
 */

let reader: ((lines: number) => string) | null = null;

/** The Console calls this with a serializer over its xterm buffer. */
export function setTerminalReader(r: ((lines: number) => string) | null): void {
	reader = r;
}

/** The last `lines` lines of the screen, scrollback included, ANSI resolved. */
export function readTerminal(lines: number): string {
	return reader ? reader(lines) : '';
}
