/**
 * The page's handle on the model's workspace, for the chat cards that need
 * one: `open_file` (open-file-tool.tsx) reads the offered file back through
 * here when the person clicks Open.
 *
 * A module-level holder rather than a prop: the tool renderers are handed to
 * `mount()` as a plain table, before the client exists, and both pages
 * (main.tsx, terminal-assistant.tsx) have one runtime each. Same shape as
 * `sharedVm()` in vm.ts.
 */

import type { AgentClient } from '../runtime/src/client';

let client: AgentClient | null = null;

/** Called once by the page after `mount()`; the cards read through it. */
export function attachWorkspace(c: AgentClient): void {
	client = c;
}

/**
 * The bytes behind a workspace path — a bare filename means a draft, as it
 * did for the model. Null when nothing is there (any more), or before the
 * runtime is up.
 */
export function readWorkspaceFile(path: string): Promise<Uint8Array | null> {
	if (!client) return Promise.resolve(null);
	return client.readWorkspaceFile(path);
}
