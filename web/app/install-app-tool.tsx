/**
 * The chat card for the workspace `install_app` tool: the install's line and
 * an Open button that brings the app's window up right here. The model
 * installs; the person opens — the same posture as open-file-tool.tsx, and
 * a click is what a window deserves (an install that popped a window over
 * the conversation would be the model deciding what is on screen).
 *
 * Opening goes through the Apps page's own bridge (vm-apps.ts): the mirror
 * when the package is there — machine on or off — and the guest's app-run
 * otherwise. The card reads nothing back: the package is in the machine's
 * mirror, which is what the button opens, so a card in a re-opened session
 * works as long as the app is still installed; removed, the open says so.
 *
 * `data-testid="install-app-open"` on the button: the label is localized
 * and carries the title, so tests need a handle that is neither.
 */

import { useState } from 'react';
import type { ToolRenderProps } from '@vinx/agent-chat';

import { isTerminalDocument } from './pane-id';
import { tryParse } from './run-shell-tool';
import { sharedVm } from './vm';
import { vmAppsBridge } from './vm-apps';
import { t, tf } from './i18n';

/** lucide app-window, inlined like the app's other icons. */
const WINDOW_ICON = 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM10 4v4M2 8h20M6 4v4';

export function InstallAppTool({ args, result }: ToolRenderProps) {
	const parsed = tryParse(args);
	const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
	const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : id;
	// A refusal is plain text starting "Error" (the engine's word for the
	// page's rejection and for its own); the card shows it, no button.
	const refused = !!result && /^Error\b/.test(result);
	const installed = !!result && !refused && id !== '';
	const [note, setNote] = useState<string | null>(null);

	if (!result) return null;
	if (refused) {
		return (
			<pre data-testid="install-app-refused" className="mt-1 whitespace-pre-wrap text-[12px] text-destructive">
				{result}
			</pre>
		);
	}
	if (!installed) return null;

	const open = () => {
		setNote(null);
		// The bridge's `run` is optional in the shim's contract; this page's
		// (vm-apps.ts) always has one.
		const bridge = vmAppsBridge(sharedVm());
		if (!bridge.run) return;
		bridge.run(id).catch((e: unknown) => {
			const msg = e instanceof Error ? e.message : String(e);
			// Removed since the install (the bridge's words); anything
			// else — the machine off for a non-web fallback — verbatim.
			setNote(/^no such installed app/.test(msg) ? tf('iaGone', title) : msg);
		});
	};

	return (
		<div className="mt-1 space-y-1.5 pb-1">
			<div className="text-[12px] text-muted-foreground">
				{isTerminalDocument() ? tf('iaInstalledMachine', title) : tf('iaInstalled', title)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					data-testid="install-app-open"
					title={t('iaOpenTitle')}
					onClick={open}
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
						<path d={WINDOW_ICON} />
					</svg>
					{tf('iaOpen', title)}
				</button>
				{!isTerminalDocument() && (
					<a
						href="#/apps"
						data-testid="install-app-page"
						className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
					>
						{t('iaAppsPage')}
					</a>
				)}
			</div>
			{note && (
				<div data-testid="install-app-note" className="text-[12px] text-muted-foreground">
					{note}
				</div>
			)}
		</div>
	);
}
