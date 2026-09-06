/**
 * Compact cards for the VM's file and terminal tools.
 *
 * run_shell gets the full treatment in run-shell-tool.tsx; these tools are
 * quieter — a read, a write, a listing — and their cards say what happened in
 * one header line (path, size, outcome, wall-clock) with the payload folded
 * underneath. They share the rp-* styling and pieces with the shell card.
 */

import type { ToolRenderProps } from '@vinx/agent-chat';

import { CopyBtn, FoldedPre, outcomeMeta, RunningNote, tryParse } from './run-shell-tool';
import './run-shell-tool.css';

function asString(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

/** The card shell every quiet tool shares: `title · path · meta` over a body. */
function QuietCard({
	title,
	subject,
	res,
	body,
	bodyClass = 'rp-out',
	isRunning,
	runningNote,
}: {
	title: string;
	subject: string | null;
	res: Record<string, unknown> | null;
	body: string | null;
	bodyClass?: string;
	isRunning: boolean;
	runningNote: string;
}) {
	const error = res && res.ok !== true && typeof res.error === 'string' ? (res.error as string) : null;
	return (
		<div className="rp-tool">
			<div className="rp-block">
				<div className="rp-head">
					<span className="rp-title">
						{title}
						{subject && <span className="rp-dim rp-subject"> · {subject}</span>}
						{outcomeMeta(res)}
					</span>
					{body && (
						<span className="rp-actions">
							<CopyBtn text={body} />
						</span>
					)}
				</div>
				{body && <FoldedPre className={bodyClass} text={body} />}
				{error && <pre className="rp-err">{error}</pre>}
				{isRunning && !res && <RunningNote note={runningNote} />}
			</div>
		</div>
	);
}

export function ReadFileTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	return (
		<QuietCard
			title="read"
			subject={asString(a?.path)}
			res={res}
			body={asString(res?.output)}
			isRunning={isRunning}
			runningNote="reading…"
		/>
	);
}

export function ListDirTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	return (
		<QuietCard
			title="ls"
			subject={asString(a?.path)}
			res={res}
			body={asString(res?.output)}
			isRunning={isRunning}
			runningNote="listing…"
		/>
	);
}

export function WriteFileTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	const content = asString(a?.content);
	const size = content != null ? new TextEncoder().encode(content).byteLength : null;
	const subject =
		asString(a?.path) && size != null ? `${a!.path} · ${size} bytes` : asString(a?.path);
	return (
		<QuietCard
			title="write"
			subject={subject}
			res={res}
			body={content}
			bodyClass="rp-code"
			isRunning={isRunning}
			runningNote="writing…"
		/>
	);
}

export function EditFileTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	const oldStr = asString(a?.old_string);
	const newStr = asString(a?.new_string);
	const error = res && res.ok !== true && typeof res.error === 'string' ? (res.error as string) : null;
	const outcome = asString(res?.output);
	return (
		<div className="rp-tool">
			<div className="rp-block">
				<div className="rp-head">
					<span className="rp-title">
						edit
						{asString(a?.path) && <span className="rp-dim rp-subject"> · {a!.path as string}</span>}
						{outcomeMeta(res)}
					</span>
				</div>
				{oldStr != null && <FoldedPre className="rp-diff-old" text={oldStr} />}
				{newStr != null && <FoldedPre className="rp-diff-new" text={newStr} />}
				{outcome && <div className="rp-note">{outcome}</div>}
				{error && <pre className="rp-err">{error}</pre>}
				{isRunning && !res && <div className="rp-note">editing…</div>}
			</div>
		</div>
	);
}

export function DownloadFileTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	return (
		<QuietCard
			title="download"
			subject={asString(a?.path)}
			res={res}
			body={asString(res?.output)}
			isRunning={isRunning}
			runningNote="staging the file…"
		/>
	);
}

/** Not the vendored `publish` card: that one's semantics are "returned a
 * public URL", while share_local never leaves the browser — the body line
 * from the guest's share(1) says exactly that. */
export function ShareLocalTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	return (
		<QuietCard
			title="share"
			subject={asString(a?.path)}
			res={res}
			body={asString(res?.output)}
			isRunning={isRunning}
			runningNote="copying into /data/share/local…"
		/>
	);
}

/** Like the shell card — the script, then what it printed and returned —
 * because run_js is run_shell's page-side sibling, not a quiet read. */
export function RunJsTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const code = asString(a?.code);
	const res = tryParse(result);
	const output = asString(res?.output);
	const error = res && res.ok !== true && typeof res.error === 'string' ? (res.error as string) : null;
	return (
		<div className="rp-tool">
			<div className="rp-block">
				<div className="rp-head">
					<span className="rp-title">
						js<span className="rp-dim rp-subject"> · on the page</span>
						{outcomeMeta(res)}
					</span>
					{code !== null && (
						<span className="rp-actions">
							<CopyBtn text={code} />
						</span>
					)}
				</div>
				<FoldedPre className="rp-code" text={code ?? args ?? ''} />
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
			{error && <pre className="rp-err">{error}</pre>}
			{isRunning && !result && <div className="rp-note">running on the page…</div>}
		</div>
	);
}

export function ReadTerminalTool({ args, result, isRunning }: ToolRenderProps) {
	const a = tryParse(args);
	const res = tryParse(result);
	const lines = typeof a?.lines === 'number' ? a.lines : 200;
	return (
		<QuietCard
			title="screen"
			subject={`last ${lines} lines`}
			res={res}
			body={asString(res?.output)}
			isRunning={isRunning}
			runningNote="reading the screen…"
		/>
	);
}

/** Everything the VM offers, keyed the way `toolRenderers` expects. */
export const VM_TOOL_CARDS = {
	read_file: ReadFileTool,
	list_dir: ListDirTool,
	write_file: WriteFileTool,
	edit_file: EditFileTool,
	share_local: ShareLocalTool,
	download_file: DownloadFileTool,
	run_js: RunJsTool,
	read_terminal: ReadTerminalTool,
};
