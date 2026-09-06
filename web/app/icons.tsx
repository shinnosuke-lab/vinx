/**
 * The terminal page's icons. Feathers borrowed from lucide, inlined: a
 * handful of icons is not worth a dependency.
 */

/** 14 suits the header buttons, 12 the footer chips. */
export function Icon({ d, size = 14 }: { d: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	);
}

/** lucide upload, its subpaths merged into one d (like ICON_SPLIT_*). */
export const ICON_UPLOAD = 'M12 3v12M17 8l-5-5-5 5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4';
/** lucide plug — the footer's "wire a real serial device in" affordance. */
export const ICON_PLUG = 'M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z';
/** lucide monitor — the machine's VGA screen. */
export const ICON_MONITOR =
	'M8 21h8M12 17v4M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z';
/** lucide folder — a real directory mounted at /data/host. */
export const ICON_FOLDER =
	'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
/** lucide x — the screen window's close button. */
export const ICON_X = 'M18 6 6 18M6 6l12 12';
/** lucide maximize-2 / minimize-2 — the screen window's other title button. */
export const ICON_MAX = 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7';
export const ICON_RESTORE = 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7';
/** lucide power — the machine capsule's on/off switch. */
export const ICON_POWER = 'M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04';
/** lucide droplet — the window's background-opacity cycler. */
export const ICON_DROPLET =
	'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z';
/** lucide square-terminal — a PTY window (§6.9). */
export const ICON_TERMINAL =
	'm7 11 2-2-2-2M11 13h4M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
/** lucide sparkles — the voice of "ask the assistant". */
export const ICON_SPARK =
	'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z';
/** lucide bluetooth — the rune. */
export const ICON_BLUETOOTH = 'm7 7 10 10-5 5V2l5 5L7 17';
/** lucide volume-2 / volume-x — the footer's page-side volume knob. */
export const ICON_VOLUME =
	'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5zM16 9a5 5 0 0 1 0 6M19.4 18.4a9 9 0 0 0 0-12.7';
export const ICON_VOLUME_OFF =
	'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5zM22 9l-6 6M16 9l6 6';
/** lucide square-split-* — the shell header's split buttons. */
export const ICON_SPLIT_H =
	'M12 3v18M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
export const ICON_SPLIT_V =
	'M3 12h18M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
