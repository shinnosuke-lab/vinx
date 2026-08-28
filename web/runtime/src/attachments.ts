/**
 * The half of the illusion that `fetch` cannot cover.
 *
 * Some of what the UI asks for is not a request it makes but a URL it puts in
 * the document: an attachment is an `<img src>` when it is an image and an
 * `<a href>` when it is not, and a skill's icon is an `<img src>` too. None of
 * those go through `fetch`, so none of them reach the shim: the browser asks
 * the network directly, the gateway has never heard of the path, and the user
 * gets a broken thumbnail and a 404 page that also loses the SPA.
 *
 * A service worker is the ordinary answer to this and is not available: it
 * requires a secure context, and the page is served over plain HTTP from a
 * gateway on the local network. So the references are resolved in the document
 * instead — the same kind of substitution the fetch shim performs, one layer
 * further out. The request still goes through the shim, via `fetch` here, so
 * there is one route serving uploads and not two.
 *
 * Blob URLs are cached per id and never revoked. An id is a fresh uuid whose
 * bytes never change, the count is bounded by what one person attached in one
 * sitting, and revoking on a React re-render would break the very image it was
 * meant to tidy up after.
 */

/**
 * The paths the stock UI builds rather than fetches: see its `uploadUrl` and
 * `skillIconUrl`.
 */
const SERVED = [/^\/api\/chat\/upload\/./, /^\/api\/skills\/.+\/icon$/];

const resolved = new Map<string, string>();

function isServed(raw: string | null): raw is string {
	if (!raw) return false;
	// Relative in the deployment, absolute when something rewrote it; only the
	// path matters either way.
	const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0];
	return SERVED.some((p) => p.test(path));
}

/** Fetch one — through the shim — and hold on to the blob URL. */
async function objectUrl(href: string): Promise<string> {
	const cached = resolved.get(href);
	if (cached) return cached;

	const res = await fetch(href);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const url = URL.createObjectURL(await res.blob());
	resolved.set(href, url);
	return url;
}

function repoint(img: HTMLImageElement) {
	const href = img.getAttribute('src');
	if (!isServed(href)) return;
	objectUrl(href).then(
		(url) => {
			// Guard against the element having been reused for another
			// attachment while the read was in flight.
			if (img.getAttribute('src') === href) img.src = url;
		},
		(e) => console.warn(`[agent-web] could not load attachment ${href}: ${e}`),
	);
}

/**
 * Resolve attachment references in `root`, and in whatever is added to it.
 *
 * Returns a function that stops watching. Safe to call more than once; each
 * call owns its observer.
 */
export function serveAttachments(root: ParentNode & Node = document): () => void {
	for (const img of root.querySelectorAll('img')) repoint(img);

	const observer = new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === 'attributes') {
				repoint(record.target as HTMLImageElement);
				continue;
			}
			for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (node instanceof HTMLImageElement) repoint(node);
				for (const img of node.querySelectorAll('img')) repoint(img);
			}
		}
	});
	observer.observe(root, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['src'],
	});

	// Downloads are a navigation rather than a load, so they are caught at the
	// click instead. Capturing, and only when the UI has not already handled
	// it, so this never overrides an intentional modifier-click.
	const onClick = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
		const anchor = (event.target as Element | null)?.closest?.('a');
		const href = anchor?.getAttribute('href') ?? null;
		if (!isServed(href)) return;

		event.preventDefault();
		objectUrl(href).then(
			(url) => {
				const link = document.createElement('a');
				link.href = url;
				// `download` on a blob URL is what names the saved file; the
				// original name is in the query the UI put there.
				link.download = new URL(href, location.href).searchParams.get('name') || '';
				link.click();
			},
			(e) => console.warn(`[agent-web] could not download attachment ${href}: ${e}`),
		);
	};
	document.addEventListener('click', onClick, true);

	return () => {
		observer.disconnect();
		document.removeEventListener('click', onClick, true);
	};
}
