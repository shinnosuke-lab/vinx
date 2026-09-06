/**
 * The run_shell tool call, drawn as a command and its output instead of JSON.
 *
 * Without this the call falls to the stock UI's GenericTool, which
 * pretty-prints the arguments object — so the command arrives as a quoted JSON
 * string, the copy button copies the quotes, and the VM's reply is wrapped in
 * `{"ok":true,...}` noise. This card undoes that: the command is shown as a
 * shell line, copied as one, and the result is split into the output and the
 * error the VM reported (see runtime/src/device-vm.ts for the `{ok, output,
 * error?, exit_code?, duration_ms?}` shape). Long outputs collapse to their
 * first lines — run_shell carries up to 64 KiB and nobody wants that in a panel.
 *
 * Wired in through `<CopilotApp toolRenderers>`, the extension point upstream
 * built for host-specific tools — the vendored UI stays verbatim. The smaller
 * cards for the other VM tools share these pieces; see vm-tool-cards.tsx.
 */

import { useState } from 'react';
import { copyToClipboard, type ToolRenderProps } from '@vinx/agent-chat';

import { bootStatusLine, useVmStatus } from './vm-status';
import './run-shell-tool.css';

export function tryParse(text?: string): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' ? value : null;
	} catch {
		return null;
	}
}

/** Feathers borrowed from lucide's copy/check, inlined: two icons are not
 * worth a dependency the vendored UI already paid for on its own side. */
function Icon({ d }: { d: string }) {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={d} />
		</svg>
	);
}
const COPY = 'M8 8m0 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2zM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2';
const CHECK = 'M20 6L9 17l-5-5';

/**
 * The library's helper, not `navigator.clipboard`: this page may be served
 * over plain HTTP or from a file, where that object is absent, and reaching
 * for it throws before it can copy anything. The tick is tied to the reported
 * result so a copy that did not happen does not claim it did.
 */
export function CopyBtn({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="rp-btn"
			title={copied ? 'Copied' : 'Copy'}
			onClick={() => {
				void copyToClipboard(text).then((ok) => {
					if (!ok) return;
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			<Icon d={copied ? CHECK : COPY} />
		</button>
	);
}

/** `exit 1 · 3.2s`, from the result body; nothing when it all went normally. */
export function outcomeMeta(res: Record<string, unknown> | null): React.ReactNode {
	if (!res) return null;
	const exit = typeof res.exit_code === 'number' ? res.exit_code : null;
	const ms = typeof res.duration_ms === 'number' ? res.duration_ms : null;
	if (exit === null && ms === null) return null;
	return (
		<>
			{exit !== null && exit !== 0 && <span className="rp-exit"> · exit {exit}</span>}
			{ms !== null && <span className="rp-dim"> · {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>}
		</>
	);
}

const FOLD_LINES = 30;

/** A <pre> that folds past FOLD_LINES; copy still carries the whole text. */
export function FoldedPre({ text, className }: { text: string; className: string }) {
	const [expanded, setExpanded] = useState(false);
	const lines = text.split('\n');
	if (expanded || lines.length <= FOLD_LINES) return <pre className={className}>{text}</pre>;
	return (
		<>
			<pre className={className}>{lines.slice(0, FOLD_LINES).join('\n')}</pre>
			<button type="button" className="rp-more" onClick={() => setExpanded(true)}>
				⌄ {lines.length - FOLD_LINES} more lines
			</button>
		</>
	);
}

/**
 * The "still running" line under a tool card, honest about what the wait
 * is: a call made while the machine boots (or after a failed boot, which
 * the adapter retries) waits for the boot first, and "running on the VM…"
 * over a twenty-second boot read as a hung command. Booting shows the
 * boot's own status line and percent; failed shows the reason; otherwise
 * the tool's own note.
 */
export function RunningNote({ note }: { note: string }) {
	const vm = useVmStatus();
	const line = vm.state === 'booting' || vm.state === 'failed' ? bootStatusLine(vm) : '';
	return (
		<div className={`rp-note${vm.state === 'failed' ? ' rp-note-err' : ''}`} data-vm-state={vm.state}>
			{line || note}
		</div>
	);
}

export function RunShellTool({ args, result, isRunning }: ToolRenderProps) {
	const parsed = tryParse(args);
	// While the call is still streaming in, `args` is a JSON prefix that does
	// not parse yet; showing it raw beats showing nothing, and it resolves into
	// the command line on the next delta.
	const command = typeof parsed?.command === 'string' ? parsed.command : null;
	const timeout = parsed?.timeout;

	const res = tryParse(result);
	const output = typeof res?.output === 'string' ? res.output : null;
	const error = res && res.ok !== true && typeof res.error === 'string' ? res.error : null;

	return (
		<div className="rp-tool">
			<div className="rp-block">
				<div className="rp-head">
					<span className="rp-title">
						shell
						{typeof timeout === 'number' && <span className="rp-dim"> · {timeout}s</span>}
						{outcomeMeta(res)}
					</span>
					{command !== null && (
						<span className="rp-actions">
							<CopyBtn text={command} />
						</span>
					)}
				</div>
				<pre className="rp-code">
					<span className="rp-prompt">$ </span>
					{command ?? args ?? ''}
				</pre>
			</div>

			{output !== null && output !== '' && (
				<div className="rp-block">
					<div className="rp-head">
						<span className="rp-title rp-dim">output</span>
						<span className="rp-actions">
							<CopyBtn text={output} />
						</span>
					</div>
					<FoldedPre className="rp-out" text={output} />
				</div>
			)}

			{error !== null && (
				<div className="rp-block">
					<div className="rp-head">
						<span className="rp-title rp-err-title">error</span>
						<span className="rp-actions">
							<CopyBtn text={error} />
						</span>
					</div>
					<pre className="rp-err">{error}</pre>
				</div>
			)}

			{/* A result that is not the VM's shape (a refusal, a transport
			    failure) still has to be seen to be debugged. */}
			{result && !res && <pre className="rp-out">{result}</pre>}

			{isRunning && !result && <RunningNote note="running on the VM…" />}
		</div>
	);
}
