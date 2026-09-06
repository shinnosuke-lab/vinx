/**
 * agent-core's engine in a browser tab.
 *
 * Start the worker, put the shim over `fetch`, and mount the stock chat UI — it
 * cannot tell the difference between this and the real server.
 *
 *     const agent = await mount({ baseUrl, apiKey, model })
 *     createRoot(el).render(<AgentChat />)
 *
 * Nothing here is required: `AgentClient` can be driven directly by a UI that
 * would rather call it than pretend to make HTTP requests.
 */

export { serveAttachments } from './attachments';
export { AgentClient } from './client';
export type { ClientOptions, HostStatus, Outcome, Upload } from './client';
export { createHandler, installFetchShim } from './shim';
export type { ShimOptions } from './shim';
export { ConfigStore } from './config';
export type { AgentWebConfig } from './config';
export { fetchDeviceConfig, GatewayError, isLocalHost, resolveGateway } from './device';
export type { DeviceConfig, Gateway } from './device';
export { VM_ENDPOINT, vmCallHandler, vmDeviceConfig, vmToolsPayload } from './device-vm';
export type { ShellDevice, TerminalReader, VmExtras } from './device-vm';
export { PROTOCOL_VERSION } from './protocol';
export type { Frame, Method, Ready, Reply, Request, WebAppSource } from './protocol';

import { serveAttachments } from './attachments';
import { AgentClient, type ClientOptions, type HostStatus } from './client';
import { ConfigStore } from './config';
import { type DeviceConfig, fetchDeviceConfig } from './device';
import {
	NO_MACHINE_PAYLOAD,
	type ShellDevice,
	type TerminalReader,
	VM_ENDPOINT,
	vmCallHandler,
	vmDeviceConfig,
	vmToolsPayload,
} from './device-vm';
import { installFetchShim, type ShimOptions } from './shim';
import type { WebAppSource } from './protocol';

export interface MountOptions extends ClientOptions, ShimOptions {
	/**
	 * Model endpoint for a browser that has none yet. Used once, to seed the
	 * settings panel; after that the panel is the authority.
	 *
	 * Whatever is here is readable by anyone who opens the bundle, so a real key
	 * belongs here only in a deployment where that is acceptable. This one bakes
	 * one in from `version.sh` — see the warning there.
	 */
	defaults?: { baseUrl?: string; apiKey?: string; model?: string };
	/**
	 * Where a networked device publishes its tools — an `/api` base whose host
	 * serves `GET /api/tools` and `POST /api/tools/call`. Kept for gateways
	 * reached over HTTP; the normal device for this page is `vm` below.
	 *
	 * With neither set there is no device, and the agent can only talk.
	 */
	device?: string;
	/**
	 * The in-page Linux VM, as the device. Its tools are installed from a
	 * local payload (no HTTP anywhere) and its calls are answered on the main
	 * thread — see device-vm.ts. Wins over `device` when both are set.
	 */
	vm?: ShellDevice;
	/**
	 * The machine's power, when the person decides it (the chat page asks
	 * before booting; a machine left off costs nothing). Given, the VM's
	 * tools follow the state: installed as the machine comes up, taken back
	 * when it is off or failed — so a model working beside a powered-off
	 * machine is not offered a shell it cannot have, and is briefed to say
	 * so instead. The engine re-reads its tools and briefing every turn, so
	 * a change lands on the next message. Without this the tools are
	 * installed once, at mount (the terminal page: its machine is always
	 * on while the page is).
	 *
	 * `listener` is called with the current state at once, then on change;
	 * the return value unsubscribes.
	 */
	onPower?: (listener: (up: boolean) => void) => () => void;
	/**
	 * This engine sits beside the terminal page's console — the same machine
	 * the person is typing into. Briefs the model that the console shares the
	 * VM's filesystem and processes.
	 */
	console?: boolean;
	/**
	 * The user's terminal screen, offered to the model as `read_terminal`.
	 * Only the terminal page has one; without it the tool is not declared.
	 */
	terminal?: TerminalReader;
	/**
	 * How `download_file` hands bytes to the person — a browser download,
	 * which only page code can trigger. Serves both halves of the tool: the
	 * machine's (a guest file, while it is up) and the workspace's (a draft
	 * the model wrote, machine or not). Without it the machine's variant is
	 * not declared and the workspace's reports that the page cannot deliver.
	 */
	download?: (filename: string, bytes: Uint8Array) => void;
	/**
	 * How the workspace's `install_app` puts a pure web app on the Apps page —
	 * the app layer owns the machine's mirror and the package format, so the
	 * runtime only carries the parts across. Resolves with the line the model
	 * reads, rejects with the refusal (the machine's finding codes). Without
	 * it the tool reports that this page cannot install apps.
	 */
	installApp?: (app: WebAppSource) => Promise<string>;
	/**
	 * The page-side JavaScript executor behind the `run_js` tool (the app's
	 * hostcall.ts). Without it the tool is not declared.
	 */
	runJs?: (code: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
	/**
	 * Called after `share_local` lands a file in /data/share/local, so the
	 * page can mirror-and-announce right away instead of on the next
	 * 15-second snapshot (share-store's requestSnapshot).
	 */
	onShared?: () => void;
}

export interface Mounted {
	client: AgentClient;
	/** What the worker reported at startup — notably whether storage survives. */
	status: HostStatus;
	/** Is there an endpoint to talk to? If not, the UI should open settings. */
	configured: boolean;
	/** Device tools registered, empty when there is no device. */
	tools: string[];
	/** What the device said about itself, when there is one that answered. */
	device: DeviceConfig | null;
	/** Remove the shim and stop the worker. */
	close(): void;
}

/**
 * Ask the device what it can do, before the shim starts answering `/api/*`.
 *
 * Order matters: the shim owns `/api/tools` once installed, so fetching the
 * device's own list afterwards would return the shim's answer instead. A device
 * that is missing or broken is not fatal — the agent is still a chat client —
 * so this reports and moves on.
 *
 * Exported for its tests; `mount` is the caller.
 */
export async function deviceTools(
	client: Pick<AgentClient, 'installTools'>,
	base: string,
	forConsole = false,
): Promise<{ names: string[]; descriptors: unknown[] }> {
	const none = { names: [], descriptors: [] };
	// The terminal's assistant announces itself on both endpoints: the fetch
	// gets the console-mode briefing, and every call the engine later makes
	// runs in the console's namespace. See MountOptions.console.
	const suffix = forConsole ? '?console=1' : '';
	try {
		const res = await fetch(`${base}/tools${suffix}`);
		if (!res.ok) {
			console.warn(`[agent-web] the device has no tools to offer (HTTP ${res.status})`);
			return none;
		}
		const payload = await res.json();
		const names = await client.installTools(payload, `${base}/tools/call${suffix}`);

		const offered: unknown[] = Array.isArray(payload?.tools) ? payload.tools : [];
		if (names.length !== offered.length) {
			// A tool the registry refused is otherwise invisible: it just never
			// gets called, and the gateway looks broken rather than misconfigured.
			console.warn(
				`[agent-web] the device offered ${offered.length} tools but only ${names.length} registered`,
			);
		}
		return { names, descriptors: offered };
	} catch (e) {
		console.warn(`[agent-web] could not reach the device's tools: ${e}`);
		return none;
	}
}

/**
 * Keep the engine's toolbox in step with the machine's power (see
 * MountOptions.onPower). Installs and removals are serialised behind one
 * promise: the state can flip faster than the worker answers (a boot
 * cancelled at once), and the registry must end in the state of the LAST
 * event, not of the last reply to land. Down, the machine's tools are
 * replaced by the no-machine briefing (a payload of no tools and one
 * paragraph), so the model is told why the shell is not there.
 *
 * Exported for its tests; `mount` is the caller.
 */
export function followPower(
	client: Pick<AgentClient, 'installTools' | 'uninstallTools'>,
	payload: unknown,
	onPower: (listener: (up: boolean) => void) => () => void,
): {
	unwatch: () => void;
	/** Resolves once every event so far has reached the engine. */
	settled: () => Promise<void>;
	/** The names the engine holds now (empty while down). */
	names: () => string[];
	/** Whether the machine's tools are in. */
	up: () => boolean;
} {
	const offered = ((payload as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
	let queue: Promise<void> = Promise.resolve();
	let installed = false; // the machine's tools are in the registry
	let briefed = false; // the no-machine briefing is in place instead
	let names: string[] = [];
	const unwatch = onPower((up) => {
		queue = queue.then(async () => {
			if (up && !installed) {
				installed = true;
				briefed = false;
				names = await client.installTools(payload, VM_ENDPOINT);
			} else if (!up && !briefed) {
				if (installed) {
					installed = false;
					await client.uninstallTools(offered);
				}
				briefed = true;
				names = [];
				await client.installTools(NO_MACHINE_PAYLOAD, VM_ENDPOINT);
			}
		});
	});
	return {
		unwatch,
		settled: () => queue,
		names: () => names,
		up: () => installed,
	};
}

/**
 * Bring up the worker, apply the stored configuration, and route `/api/*` to it.
 *
 * Resolves once the engine has loaded and been configured, so a caller that
 * renders immediately afterwards will not have its first request answered by a
 * worker that is not there yet, or a first turn refused as unconfigured.
 */
export async function mount(options: MountOptions = {}): Promise<Mounted> {
	// The workspace's download_file and install_app need the page whether or
	// not there is a machine; the machine's tools need the VM bridge on top.
	const base = { ...options, onDownload: options.download, onInstallApp: options.installApp };
	const client = new AgentClient(
		options.vm
			? {
					...base,
					onVmCall: vmCallHandler(options.vm, {
						terminal: options.terminal,
						download: options.download,
						runJs: options.runJs,
						onShared: options.onShared,
					}),
				}
			: base,
	);
	const status = await client.whenReady();

	// The VM is a local device: its payload is a constant and its endpoint a
	// routing tag, so there is nothing to fetch and no shim-ordering concern.
	let device: DeviceConfig | null = null;
	let names: string[] = [];
	let descriptors: unknown[] = [];
	let unwatchPower = () => {};
	// What /api/tools answers: fixed once installed, or live for a device
	// whose tools follow its power.
	let toolsNow: () => unknown[] = () => descriptors;
	if (options.vm) {
		device = vmDeviceConfig();
		const payload = vmToolsPayload({
			console: options.console === true,
			terminal: options.terminal != null,
			download: options.download != null,
			runJs: options.runJs != null,
		});
		const offered = (payload as { tools: { name: string }[] }).tools;
		if (options.onPower) {
			const follower = followPower(client, payload, options.onPower);
			unwatchPower = follower.unwatch;
			// Whatever the first event said, the registry reflects it before
			// the UI renders — a first turn must not race the install.
			await follower.settled();
			names = follower.names();
			descriptors = offered;
			// Kept live for the shim's /api/tools: the list below is a getter.
			toolsNow = () => (follower.up() ? offered : []);
		} else {
			names = await client.installTools(payload, VM_ENDPOINT);
			descriptors = offered;
		}
	} else if (options.device) {
		// Both of these run before the shim, deliberately — see `deviceTools`.
		device = await fetchDeviceConfig(options.device);
		({ names, descriptors } = await deviceTools(
			client,
			options.device,
			options.console === true,
		));
	}

	const config = options.config ?? new ConfigStore();
	// Seeded, not overridden: what is in the settings panel is the more recent
	// statement of intent, and replacing it on every load would make the panel
	// look broken. So the build's endpoint is only used by a browser that has
	// never been configured.
	const seed = options.defaults;
	if (seed && !config.usable()) {
		config.save({
			base_url: seed.baseUrl ?? '',
			model: seed.model ?? '',
			api_key: seed.apiKey ?? '',
		});
	}

	const current = config.load();
	if (config.usable(current)) {
		await client.configure(current.base_url, current.api_key, current.model);
		await client.setReasoningEffort(
			current.reasoning_effort ?? '',
			current.subagent_reasoning_effort ?? '',
		);
	}

	// The tool list is read per request: with `onPower` it changes under
	// the shim, and /api/tools must say what the model holds right now.
	const uninstall = installFetchShim(client, { ...options, config, tools: toolsNow });
	// Attachments in the transcript are `<img>` and `<a>`, which never reach
	// the shim; see `serveAttachments`. Skipped where there is no document, as
	// in the tests that drive the client directly.
	const unwatch = typeof document === 'undefined' ? () => {} : serveAttachments();

	return {
		client,
		status,
		configured: config.usable(current),
		tools: names,
		device,
		close() {
			unwatchPower();
			unwatch();
			uninstall();
			client.close();
		},
	};
}