/**
 * What the About popover says about this build, shared by the chat page and
 * the terminal's assistant panel so the two never disagree.
 *
 * Brand and version come from version.sh through vite.config.ts. The links
 * exist only when the build declared a repository (REPO_URL): "Source" is the
 * repository itself, "Check for updates" its releases page — the tarballs and
 * VM images of every tagged version live there, so that is where a newer
 * build would be found.
 */
export const APP_META = {
	brand: 'Vinx Agent',
	version: __APP_VERSION__,
	...(__REPO_URL__
		? { sourceUrl: __REPO_URL__, updateUrl: `${__REPO_URL__.replace(/\/$/, '')}/releases` }
		: {}),
};
