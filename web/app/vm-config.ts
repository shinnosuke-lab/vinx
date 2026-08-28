/**
 * Which network the VM gets, resolved once per page load.
 *
 * Stored/read here and translated for v86's `net_device.relay_url`. The
 * tokens sort by *who can see whom*:
 *
 *   host       the default. A browser-internal L2 hub (BroadcastChannel): VMs
 *              in the same origin — several tabs — see each other and can talk
 *              TCP, but there is no way out to the internet. No server, no
 *              risk. This is what makes "open two terminals and network them"
 *              work out of the box.
 *   bridge     the same hub, plus the network panel unfolds "Bridge to
 *              friends" (WebRTC to other people's hubs). Purely a panel
 *              disclosure choice: the VM backend is identical to `host`, so
 *              switching between the two never needs a reload.
 *   ws(s)://   a wsproxy server: an L2 ethernet-frame relay. Everyone
 *              connected to the same server shares one segment — nodes see
 *              each other — and the server NATs them out to the internet.
 *              v86's own public relay, WSPROXY_DEFAULT_RELAY below, works
 *              with zero setup (mind that strangers share that segment).
 *   wisp(s):// a Wisp server: carries only TCP/UDP payloads, client to
 *              server. Pure outbound internet — peers on the same relay
 *              never see each other. Run one yourself: web/deploy/relay.sh
 *              or deploy/cloudflare-wisp/.
 *   fetch      the emulator replays the guest's outbound plain HTTP as browser
 *              fetch() calls. No server either, but only reaches http endpoints
 *              that send permissive CORS headers, and never TLS. Kept for
 *              compatibility; not offered as a default.
 *
 * Resolution order: `?relay=` in the URL (persisted for later visits) >
 * localStorage > `host`. Persisting matters because the terminal is
 * reached through links that carry no query string (the apps page card); set
 * it once on either page and both keep it.
 *
 *   ?relay=host                            the default LAN-only hub
 *   ?relay=bridge                          the hub with bridging unfolded
 *   ?relay=wss://relay.widgetry.org/       v86's public wsproxy relay
 *   ?relay=wisp://127.0.0.1:5001/          a local wisp relay (see relay.sh)
 *   ?relay=wisps://xxx.trycloudflare.com/  a public one
 *   ?relay=fetch                           the CORS-bound HTTP mode
 *
 * The scheme picks the v86 backend; `host` and `bridge` both become v86's
 * `inbrowser` keyword.
 */

const KEY = 'vinx.vm.relay';
const DEFAULT = 'host';

/** v86's own public wsproxy relay (docs/networking.md) — the one relay that
 * works without running anything. The panel prefills it; the terminal's
 * first-run prompt offers it as the one-click way online. */
export const WSPROXY_DEFAULT_RELAY = 'wss://relay.widgetry.org/';

/** A relay URL v86 understands (wisp or wsproxy transport). */
function isRelayUrl(v: string): boolean {
	return /^(wss?|wisps?):\/\//i.test(v);
}

/** A stored/param token is a usable value if it is a known mode or a URL. */
function normalize(v: string | null | undefined): string | null {
	if (!v) return null;
	if (v === 'host' || v === 'bridge' || v === 'fetch') return v;
	if (isRelayUrl(v)) return v;
	return null;
}

/** The token as v86 sees it: both LAN flavors are the `inbrowser` hub. */
function toBackend(token: string): string {
	return token === 'host' || token === 'bridge' ? 'inbrowser' : token;
}

/**
 * What `VinxVm`'s `networkRelay` option should be: `inbrowser`, `fetch`, or a
 * relay URL. Reads `?relay=` (and persists it) then storage.
 */
export function resolveRelay(search = location.search): string {
	const given = new URLSearchParams(search).get('relay')?.trim();
	if (given) {
		const value = normalize(given);
		if (value) {
			store(value);
			return toBackend(value);
		}
		console.warn(
			`[vm] ignoring ?relay=${given}: expected host, bridge, fetch, or a ws(s)/wisp(s):// URL`,
		);
	}
	return toBackend(normalize(readStore()) ?? DEFAULT);
}

/** The stored choice as a token (`host`/`bridge`/`fetch`/URL), for the panel. */
export function currentRelay(): string {
	return normalize(readStore()) ?? DEFAULT;
}

/** Persist a choice from the network panel. `null` restores the default. */
export function setRelay(value: string | null): void {
	const v = value === null ? null : normalize(value);
	store(v);
}

/** A short word for the status strip: which way packets leave the tab.
 * Takes tokens and the resolved backend value alike. */
export function relayLabel(relay: string): string {
	if (relay === 'host' || relay === 'bridge' || relay === 'inbrowser') return 'lan';
	if (relay === 'fetch') return 'fetch';
	return /^wisps?:\/\//i.test(relay) ? 'wisp' : 'wsproxy';
}

function readStore(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

function store(value: string | null) {
	try {
		if (value === null || value === DEFAULT) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, value);
	} catch {
		/* a private window still gets the value for this load */
	}
}
