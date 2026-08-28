/**
 * Minimal File System Access declarations — Chromium-only surface that
 * TypeScript's DOM lib does not fully carry. Only what host-mount.ts and the
 * mount control touch: the directory picker, permission (re)requests, and
 * async iteration over directory entries. Everything optional, so feature
 * detection stays honest.
 */

interface FileSystemDirectoryHandle {
	entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
	/** Absent on OPFS handles, which need no permission. */
	queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
	requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface Window {
	showDirectoryPicker?(options?: {
		mode?: 'read' | 'readwrite';
		id?: string;
	}): Promise<FileSystemDirectoryHandle>;
}
