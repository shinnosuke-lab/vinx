/**
 * The chat card for the workspace `open_file` tool: an Open button that hands
 * the file to the browser in a new tab. The model offers; the person opens.
 *
 * A button, not an automatic tab: `window.open` outside a click is a pop-up
 * and the blocker eats it (opener.ts) — the click is the gesture. The bytes
 * are read back through the runtime when the card mounts, not shipped in the
 * tool result: the result goes into the model's context, and a card in a
 * re-opened session would have nothing to open. Reading back keeps old cards
 * working and shows the file as it is now, edits included.
 *
 * Trust posture: a blob: URL runs at this page's origin — the same as the
 * guest's open(1) (opener.ts), and the file is the model's own writing.
 *
 * `data-testid="open-file"` on the button: the label is localized and carries
 * the filename, so tests need a handle that is neither.
 */

import { useEffect, useState } from 'react';
import type { ToolRenderProps } from '@vinx/agent-chat';

import { fileOpener } from './opener';
import { readWorkspaceFile } from './workspace-files';
import { tryParse } from './run-shell-tool';
import { t, tf } from './i18n';

/** lucide external-link, inlined like the app's other icons. */
const OPEN_ICON = 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6';

type State =
	| { kind: 'loading' }
	| { kind: 'ready'; bytes: Uint8Array }
	| { kind: 'gone' }
	| { kind: 'blocked'; bytes: Uint8Array };

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const i = trimmed.lastIndexOf('/');
	return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export function OpenFileTool({ args, result }: ToolRenderProps) {
	const rawPath = tryParse(args)?.path;
	const path = typeof rawPath === 'string' ? rawPath : '';
	// The tool vets the path; a refusal is plain text starting "Error", and
	// the card shows it rather than a button that would fetch nothing.
	const refused = !!result && /^Error\b/.test(result);
	const offered = !!result && !refused && path !== '';
	const [state, setState] = useState<State>({ kind: 'loading' });

	useEffect(() => {
		if (!offered) return;
		let alive = true;
		setState({ kind: 'loading' });
		readWorkspaceFile(path).then(
			(bytes) => {
				if (!alive) return;
				setState(bytes ? { kind: 'ready', bytes } : { kind: 'gone' });
			},
			() => alive && setState({ kind: 'gone' }),
		);
		return () => {
			alive = false;
		};
	}, [offered, path]);

	if (!result) return null;
	if (refused) return <pre className="mt-1 whitespace-pre-wrap text-[12px] text-destructive">{result}</pre>;
	if (!offered) return null;

	const name = basename(path);
	const open = (bytes: Uint8Array) => {
		// A fresh blob URL per click: opener.ts revokes its URL after a few
		// minutes, and this card may sit for an hour before the click.
		if (!fileOpener(name, bytes).open()) setState({ kind: 'blocked', bytes });
	};

	return (
		<div className="mt-1 space-y-1.5 pb-1">
			{state.kind === 'loading' && <div className="text-[12px] text-muted-foreground">{tf('ofLoading', name)}</div>}
			{state.kind === 'gone' && (
				<div data-testid="open-file-gone" className="text-[12px] text-muted-foreground">
					{tf('ofGone', name)}
				</div>
			)}
			{(state.kind === 'ready' || state.kind === 'blocked') && (
				<button
					type="button"
					data-testid="open-file"
					title={t('ofOpenTitle')}
					onClick={() => open(state.bytes)}
					className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
						className="shrink-0"
					>
						<path d={OPEN_ICON} />
					</svg>
					{tf('ofOpen', name)}
				</button>
			)}
			{state.kind === 'blocked' && <div className="text-[12px] text-muted-foreground">{t('ofBlocked')}</div>}
		</div>
	);
}
