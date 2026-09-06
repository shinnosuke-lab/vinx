/**
 * The desktop's app windows: the render side of window-manager.ts. Each
 * table entry becomes a DesktopWindow whose tenant matches the surface —
 * web windows hold the sandboxed app frame (app-frame.tsx) showing the
 * §10.3 bundle; tty windows hold an xterm wired to the guest PTY's mux
 * channel (§6.9). Mounted once per desktop document, beside the VGA
 * window, inside the same positioning parent.
 */

import { useEffect, useReducer } from 'react';
import type { Terminal } from '@xterm/xterm';

import { DesktopWindow } from './desktop-window';
import { AppFrame } from './app-frame';
import { ByteStreamTerm } from './byte-stream-term';
import { ICON_SPARK, ICON_TERMINAL } from './icons';
import { windowManager, type TtyWindowSpec } from './window-manager';
import { sharedVm } from './vm';

const encoder = new TextEncoder();

/** Subscribe this component to the window table; any change re-renders. */
export function useWindowTable() {
	const [, force] = useReducer((n: number) => n + 1, 0);
	useEffect(() => windowManager().subscribe(force), []);
	return windowManager();
}

/**
 * A terminal window's tenant: xterm over the stream's mux channel.
 * Keystrokes go down the channel, channel bytes paint the screen, every
 * fit pushes the grid as a stream.resize notification (rpcd TIOCSWINSZ's
 * it, the app hears SIGWINCH). Closing the window is not handled here:
 * DesktopWindow's X goes through windowManager.close, whose onClosed wire
 * stops the app; the dying app's PTY EOF then closes the stream.
 */
function TtyBody({ spec }: { spec: TtyWindowSpec }) {
	return (
		<ByteStreamTerm
			className={`tty-term tty-s${spec.streamId}`}
			onData={(data) => sharedVm().streamMux?.send(spec.streamId, encoder.encode(data))}
			onResize={(cols, rows) =>
				sharedVm().rpcLink?.notify('stream.resize', { id: spec.streamId, cols, rows })
			}
			attach={(term) => {
				const mux = sharedVm().streamMux;
				mux?.open(spec.streamId, spec.window, { data: (bytes) => term.write(bytes) });
				// Test gear, the serialProbe stance: xterm paints on canvas,
				// so the E2E suite reads a tty window's buffer through this.
				const g = globalThis as unknown as { __vinxTtyTerms?: Map<string, Terminal> };
				g.__vinxTtyTerms ??= new Map();
				g.__vinxTtyTerms.set(spec.appId ?? spec.id, term);
				return () => {
					mux?.close(spec.streamId);
					g.__vinxTtyTerms?.delete(spec.appId ?? spec.id);
				};
			}}
		/>
	);
}

export function WebWindows({ footer = 24 }: { footer?: number }) {
	const wm = useWindowTable();
	return (
		<>
			{wm.snapshot().map(({ spec, z }) => (
				<DesktopWindow
					key={spec.id}
					title={spec.title}
					icon={spec.surface === 'tty' ? ICON_TERMINAL : ICON_SPARK}
					onClose={() => wm.close(spec.id)}
					storageKey={`vinx.window.${spec.id}.rect`}
					footer={footer}
					zIndex={z}
					onRaise={() => wm.raise(spec.id)}
					handleRef={(h) => wm.setHandle(spec.id, h)}
					initial={spec.surface === 'tty' ? { w: 560, h: 380 } : { w: 420, h: 340 }}
				>
					{spec.surface === 'tty' ? (
						<TtyBody key={`tty:${spec.streamId}`} spec={spec} />
					) : (
						<AppFrame key={`${spec.id}:${spec.bundle.js.length}:${spec.bundle.html.length}`} spec={spec} />
					)}
				</DesktopWindow>
			))}
		</>
	);
}
