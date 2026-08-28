/**
 * Which machine this document is.
 *
 * The terminal page is a thin shell hosting one or two iframes; each iframe
 * carries `?pane=1` or `?pane=2` and is a complete, independent instance of
 * the terminal (its own VM, engine and panel). The chat page hosts a VM of
 * its own — a third machine. Everything machine-scoped — the /data mirror
 * above all — keys off `machineId()`: the chat page must NOT share a bucket
 * with pane 1, or two live VMs would fight over one mirror (each only reads
 * it at boot, so the other's files would appear on reload only, and their
 * snapshots would overwrite each other's).
 *
 * A document with no `pane` parameter is either the terminal shell (renders
 * frames, no VM), a direct open of the inner terminal page (behaves as pane
 * 1), or the chat page (machine `c`).
 */

export type PaneId = '1' | '2';

/** The pane this document plays; `1` when the inner page is opened directly. */
export function paneId(): PaneId {
	const p = new URLSearchParams(location.search).get('pane');
	return p === '2' ? '2' : '1';
}

/** True when this document is the shell (no `?pane=`): render frames, no VM. */
export function isShellDocument(): boolean {
	return new URLSearchParams(location.search).get('pane') === null;
}

/** True for any document under the terminal page (shell or pane iframe). */
function isTerminalDocument(): boolean {
	return /\/terminal(\/|$)/.test(location.pathname);
}

/**
 * The identity the /data mirror is keyed on: `c` for the chat page, the pane
 * id for terminal panes. Distinct per live VM on this origin.
 */
export function machineId(): string {
	return isTerminalDocument() ? paneId() : 'c';
}
