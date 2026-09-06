/**
 * Where the model endpoint is configured, when there is no config file.
 *
 * agent-core reads `agent.json` and serves it at `/api/config` so its settings
 * panel can edit it. There is no file in a browser tab, so this keeps the same
 * shape in `localStorage` and answers the same routes — which means the stock
 * settings panel is how a user enters their key, rather than something bespoke
 * built here, and the key never has to be baked into the page.
 *
 * Two behaviours are copied deliberately because the UI depends on them:
 *
 *  - `GET` blanks `api_key`. A settings form that round-tripped the secret would
 *    put it in the DOM and in every screenshot of it.
 *  - `PUT` with a blank `api_key` keeps the stored one, so saving an unrelated
 *    field does not wipe the key the user cannot see.
 */

/** The subset of agent-core's `AiConfig` that means anything in a browser. */
export interface AgentWebConfig {
	enabled: boolean;
	base_url: string;
	model: string;
	api_key: string;
	temperature?: number | null;
	context_size?: number;
	/** Default reasoning-effort level (empty = the provider's default). */
	reasoning_effort?: string;
	/** Default effort for `task` sub-agents (empty = inherit the parent's). */
	subagent_reasoning_effort?: string;
	/**
	 * New sessions start in FULL-AUTO (tool confirmations skipped; questions
	 * still prompt). Reported to the UI through `/api/chat/meta` as
	 * `config.default_full_auto`, which seeds the composer's badge on a fresh
	 * chat; each session can still be switched off via its badge.
	 */
	default_full_auto?: boolean;
	meta?: Record<string, unknown>;
}

/**
 * What `GET /api/config` answers: the config with the secret blanked, plus
 * whether one is stored at all. The form cannot tell "no key" from "key
 * withheld" by looking at the empty field, and a user who set one weeks ago
 * has no other way to check — `api_key_set` is that answer without the key.
 */
export type SanitizedConfig = AgentWebConfig & { api_key_set: boolean };

const KEY = 'vinx.web.config';

const DEFAULTS: AgentWebConfig = {
	enabled: true,
	base_url: '',
	model: '',
	api_key: '',
};

/** Storage that works when `localStorage` does not — private windows, quota. */
interface Storage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
	};
}

function defaultStorage(): Storage {
	try {
		// Touching `localStorage` is itself what throws in a blocked context, so
		// the probe has to be a real write.
		const probe = '__vinx_probe__';
		globalThis.localStorage.setItem(probe, '1');
		globalThis.localStorage.removeItem(probe);
		return globalThis.localStorage;
	} catch {
		return memoryStorage();
	}
}

export class ConfigStore {
	private storage: Storage;

	constructor(storage: Storage = defaultStorage()) {
		this.storage = storage;
	}

	/** The stored config, including the key. For configuring the engine. */
	load(): AgentWebConfig {
		const raw = this.storage.getItem(KEY);
		if (!raw) return { ...DEFAULTS };
		try {
			return { ...DEFAULTS, ...JSON.parse(raw) };
		} catch {
			// Corrupt storage should not brick the page; the user can just set it
			// again.
			return { ...DEFAULTS };
		}
	}

	/** The config as the settings form should see it: no secret, only whether
	 *  one is stored. */
	sanitized(): SanitizedConfig {
		const current = this.load();
		return { ...current, api_key: '', api_key_set: current.api_key.trim().length > 0 };
	}

	/**
	 * Save a submitted config. A blank `api_key` keeps the stored one, matching
	 * what the form's placeholder promises.
	 */
	save(submitted: Partial<AgentWebConfig>): AgentWebConfig {
		const current = this.load();
		// `api_key_set` is a GET-only annotation; a form that round-trips the
		// whole object must not persist it as if it were a setting.
		const { api_key_set: _ignored, ...fields } = submitted as Partial<SanitizedConfig>;
		const next: AgentWebConfig = {
			...current,
			...fields,
			api_key: fields.api_key?.trim() ? fields.api_key : current.api_key,
		};
		this.storage.setItem(KEY, JSON.stringify(next));
		return next;
	}

	/** Is there enough here to run a turn? */
	usable(config = this.load()): boolean {
		return config.enabled && !!config.base_url.trim() && !!config.model.trim();
	}
}
