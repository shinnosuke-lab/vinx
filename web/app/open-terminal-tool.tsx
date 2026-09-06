/**
 * The chat page's `open_terminal` card: the button opens *this machine's*
 * console (the vm-console panel) in place.
 *
 * The vendored default navigates to /terminal/ in a new tab — which is a
 * different computer entirely (every document is one machine, see
 * pane-id.ts), exactly the machine the agent is NOT running commands on.
 * Overriding the renderer through `<CopilotApp toolRenderers>` fixes the
 * destination without touching the vendored UI or the wasm engine; the
 * /terminal page remains reachable by URL as its own workbench.
 *
 * Keeps the vendored card's `data-testid="open-terminal"`: the card header
 * also reads "Open Terminal" and the label is localized, so tests need a
 * handle that is neither.
 */

import type { ToolRenderProps } from '@vinx/agent-chat';

import { openVmConsole } from './vm-console';
import { t } from './i18n';

/** lucide square-terminal, inlined like the app's other icons. */
const TERMINAL_ICON =
	'm7 11 2-2-2-2M11 13h4M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

export function OpenTerminalTool({ result }: ToolRenderProps) {
	if (!result) return null;
	return (
		<div className="mt-1 space-y-1.5 pb-1">
			<button
				type="button"
				data-testid="open-terminal"
				onClick={openVmConsole}
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
					<path d={TERMINAL_ICON} />
				</svg>
				{t('vmcOpenBtn')}
			</button>
		</div>
	);
}
