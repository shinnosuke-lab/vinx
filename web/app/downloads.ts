/**
 * How `download_file` reaches the person's disk: a Blob URL and a synthetic
 * click on an <a download>. Page-side by necessity — only a document can
 * start a browser download — which is why the runtime takes it as a callback.
 */

export function triggerDownload(filename: string, bytes: Uint8Array): void {
	// An explicit MIME type, or Chromium sniffs the content and "helpfully"
	// appends an extension of its own choosing to the filename.
	const url = URL.createObjectURL(
		new Blob([bytes.slice().buffer], { type: 'application/octet-stream' }),
	);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	// The click has consumed the URL by now; a delay covers slow starts.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
