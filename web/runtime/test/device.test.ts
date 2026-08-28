/**
 * Which gateway the page talks to.
 *
 * `?gw=` is the only input to this application that comes from outside it:
 * whoever hands the operator a link chooses it. These pin the rules that decide
 * what is accepted.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchDeviceConfig, GatewayError, isLocalHost, resolveGateway } from '../src/device';
import { deviceTools } from '../src/index';

const PAGE = 'http://assets.example.com';

describe('resolveGateway', () => {
	it('falls back to the page origin when no gateway is named', () => {
		const gw = resolveGateway('', 'http://192.168.1.104:60000');
		expect(gw.api).toBe('http://192.168.1.104:60000/api');
		expect(gw.key).toBe('192.168.1.104:60000');
	});

	it('takes the gateway from the query string', () => {
		const gw = resolveGateway('?gw=http://192.168.1.104:60000', PAGE);
		expect(gw.api).toBe('http://192.168.1.104:60000/api');
		expect(gw.origin).toBe('http://192.168.1.104:60000');
	});

	it('accepts a bare host:port, which is what people type', () => {
		expect(resolveGateway('?gw=192.168.1.104:60000', PAGE).api).toBe(
			'http://192.168.1.104:60000/api',
		);
	});

	it('gives each gateway its own key, so histories stay apart', () => {
		const a = resolveGateway('?gw=192.168.1.104:60000', PAGE);
		const b = resolveGateway('?gw=192.168.1.105:60000', PAGE);
		expect(a.key).not.toBe(b.key);
	});

	it('ignores a path or query on the address', () => {
		const gw = resolveGateway(`?gw=${encodeURIComponent('http://10.0.0.5/x?y=1')}`, PAGE);
		expect(gw.api).toBe('http://10.0.0.5/api');
	});

	// The refusals below are the point of the function.
	it('refuses an address off the local network', () => {
		expect(() => resolveGateway('?gw=http://evil.example.com', PAGE)).toThrow(GatewayError);
		expect(() => resolveGateway('?gw=http://8.8.8.8', PAGE)).toThrow(GatewayError);
	});

	it('refuses a scheme that is not http', () => {
		expect(() => resolveGateway(`?gw=${encodeURIComponent('javascript:alert(1)')}`, PAGE)).toThrow(
			GatewayError,
		);
		expect(() => resolveGateway(`?gw=${encodeURIComponent('file:///etc/passwd')}`, PAGE)).toThrow(
			GatewayError,
		);
	});

	it('refuses something that is not an address at all', () => {
		expect(() => resolveGateway('?gw=%20%20%3A%3A', PAGE)).toThrow(GatewayError);
	});
});

describe('isLocalHost', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'192.168.1.1',
		'192.168.1.104',
		'172.31.255.255',
		'169.254.1.1',
		'localhost',
		'gateway.local',
		'::1',
	])('accepts %s', (host) => expect(isLocalHost(host)).toBe(true));

	it.each([
		'8.8.8.8',
		'1.1.1.1',
		// Just outside the private range on either side, which is where an
		// off-by-one would hide.
		'172.15.0.1',
		'172.32.0.1',
		'192.169.0.1',
		'11.0.0.1',
		'assets.example.com',
		'evil.example.com',
		// Not a dotted quad at all, and not a name we accept.
		'999.999.999.999',
	])('refuses %s', (host) => expect(isLocalHost(host)).toBe(false));
});

describe('fetchDeviceConfig', () => {
	it('reads what the device says about itself', async () => {
		// Identity only. The gateway used to describe a model endpoint here and
		// seed the page from it; it no longer does, and the page carries its own
		// default instead (DEFAULT_BASE_URL in version.sh).
		const body = {
			brand: 'Vinx',
			gateway: { type: 'v86', mac: '02:00:00:E4:C8:94', firmware: '2.2' },
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
		);
		await expect(fetchDeviceConfig('http://10.0.0.5/api')).resolves.toEqual(body);
		vi.unstubAllGlobals();
	});

	it('is not fatal when there is no device: this is still a chat client', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			}),
		);
		await expect(fetchDeviceConfig('http://10.0.0.5/api')).resolves.toBeNull();
		vi.unstubAllGlobals();
	});

	it('is not fatal when the device answers an error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 404 })),
		);
		await expect(fetchDeviceConfig('http://10.0.0.5/api')).resolves.toBeNull();
		vi.unstubAllGlobals();
	});
});

describe('deviceTools', () => {
	const payload = { tools: [{ name: 'run_python' }] };
	const harness = () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				fetched.push(String(url));
				return new Response(JSON.stringify(payload), { status: 200 });
			}),
		);
		const installed: string[] = [];
		const client = {
			installTools: async (_: unknown, endpoint: string) => {
				installed.push(endpoint);
				return ['run_python'];
			},
		};
		return { fetched, installed, client };
	};

	it('asks and calls the plain endpoints for the main chat', async () => {
		const { fetched, installed, client } = harness();
		await deviceTools(client, 'http://10.0.0.5/api');
		expect(fetched).toEqual(['http://10.0.0.5/api/tools']);
		expect(installed).toEqual(['http://10.0.0.5/api/tools/call']);
		vi.unstubAllGlobals();
	});

	// The terminal's assistant announces itself with ?console=1 on both
	// endpoints: the gateway briefs the model about the console and forces
	// its run_python into the console's namespace. The flag is the mount
	// option, not anything the model controls.
	it('tags both endpoints when the engine sits beside the console', async () => {
		const { fetched, installed, client } = harness();
		await deviceTools(client, 'http://10.0.0.5/api', true);
		expect(fetched).toEqual(['http://10.0.0.5/api/tools?console=1']);
		expect(installed).toEqual(['http://10.0.0.5/api/tools/call?console=1']);
		vi.unstubAllGlobals();
	});
});
