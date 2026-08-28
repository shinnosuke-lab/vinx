/**
 * Which gateway this page is talking to.
 *
 * The page is served from the asset host rather than from the gateway itself: a
 * `Worker` script URL may not be cross-origin, and neither the asset host nor
 * the gateway sends CORS headers, so the heavy half has to be same-origin with
 * the document. The gateway keeps a small shell that redirects here carrying its
 * own address in `?gw=`, and this reads it back.
 *
 * That address arrives from the URL, so it is attacker-controllable: anyone who
 * can hand an operator a link chooses which host the agent fetches its tools and
 * system prompt from, and then calls tools on. A gateway is always on the local
 * network, so addresses that are not are refused rather than trusted.
 */

export interface Gateway {
	/** Where the device's API lives, absolute, no trailing slash. */
	api: string;
	/** Stable per-gateway key. Namespaces stored sessions. */
	key: string;
	/** The address as given, for display. */
	origin: string;
}

/** Rejected addresses come back as this rather than throwing into render. */
export class GatewayError extends Error {}

/**
 * Is this host on the local network?
 *
 * A gateway is reached over the LAN, so anything routable on the public
 * internet is not one, whatever the link says. Names are refused unless they are
 * mDNS: a hostname would need DNS to resolve before we could judge it, and by
 * then the request has already been made.
 */
export function isLocalHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

	// IPv6 loopback, and the v4-mapped form of anything below.
	if (h === '[::1]' || h === '::1') return true;

	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if (v4.slice(1).some((n) => Number(n) > 255)) return false;

	if (a === 127 || a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 169 && b === 254) return true; // link-local
	return false;
}

/**
 * Read `?gw=` into a gateway, or fall back to the page's own origin.
 *
 * No `gw` means the document is already being served by the device — the
 * development proxy, or a same-origin deployment — so its own origin is the
 * device. A page with neither simply has no tools, which `mount` reports.
 *
 * Accepts a bare `host:port` as well as a full URL, because that is what someone
 * types when they are debugging.
 */
export function resolveGateway(search: string, pageOrigin: string): Gateway {
	const given = new URLSearchParams(search).get('gw')?.trim();
	if (!given) return gateway(pageOrigin);

	// A bare host:port has no scheme; `new URL` would read `172.16.0.1:60000`
	// as the scheme `172.16.0.1`.
	const text = /^https?:\/\//i.test(given) ? given : `http://${given}`;

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new GatewayError(`not a gateway address: ${given}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new GatewayError(`a gateway is reached over http, not ${url.protocol}`);
	}
	if (!isLocalHost(url.hostname)) {
		throw new GatewayError(
			`${url.hostname} is not on the local network, so it is not a gateway. ` +
				`If this link came from someone else, do not trust it.`,
		);
	}
	return gateway(url.origin);
}

function gateway(origin: string): Gateway {
	const trimmed = origin.replace(/\/+$/, '');
	let host = trimmed;
	try {
		const url = new URL(trimmed);
		host = url.host;
	} catch {
		// A non-URL origin only happens in tests and in `file:` pages, where the
		// whole string is as good a key as any.
	}
	return { api: `${trimmed}/api`, key: host, origin: trimmed };
}

/**
 * What the device's `GET /api/config` answers: who it is, and nothing about
 * how to reach a model.
 *
 * It used to carry an `llm` block from a form in the gateway's console, which
 * seeded this page. It no longer does: the platform's form has no defaults to
 * offer, so it was empty on every gateway nobody had filled it in on, and the
 * page now ships an endpoint of its own. Fields are all optional — firmware
 * that answers less than this is not a broken gateway.
 */
export interface DeviceConfig {
	brand?: string;
	gateway?: { type?: string; mac?: string; firmware?: string };
}

/**
 * Ask the device who it is.
 *
 * Must run before the shim is installed, or the shim answers `/api/config` from
 * the browser's own storage instead. A device that cannot be reached is not
 * fatal — without one this is still a chat client — so this reports and returns
 * nothing.
 */
export async function fetchDeviceConfig(api: string): Promise<DeviceConfig | null> {
	try {
		const res = await fetch(`${api}/config`);
		if (!res.ok) {
			console.warn(`[agent-web] the gateway did not describe itself (HTTP ${res.status})`);
			return null;
		}
		return (await res.json()) as DeviceConfig;
	} catch (e) {
		console.warn(`[agent-web] could not reach the gateway at ${api}: ${e}`);
		return null;
	}
}
