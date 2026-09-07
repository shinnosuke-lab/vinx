// A DeepSeek proxy on Cloudflare Workers — a hosted model endpoint for the
// published page, so a visitor can try vinx without bringing their own key.
//
// DeepSeek already sends CORS headers, so the browser could call it directly;
// the only reason this Worker exists is to keep the API key server-side (a
// static bundle can hide nothing) and to put three cheap guards in front of
// an endpoint that spends real money:
//
//   1. Origin lock — only the configured site may use it *from a browser*
//      (an Origin header is trivially forged outside one, so this stops other
//      people's web apps embedding your endpoint, nothing more).
//   2. Rate limits — per-IP burst + sustained, and a coarse global ceiling,
//      via the platform's Rate Limiting binding (free, no storage).
//   3. Request shaping — the model is pinned to an allowlist, `max_tokens` is
//      clamped, `n` forced to 1, oversized bodies rejected.
//
// The hard wallet ceiling is NOT here: it is the balance on the DeepSeek
// account whose key this holds. Fund it small; when it runs out the upstream
// returns 402 and this proxy passes that straight through. See README.
//
// Everything else about the request — messages, tools/tool_choice (the agent
// needs function calling), temperature, reasoning_effort, stream — is passed
// through untouched, and the streamed SSE response is piped back as-is.

const UPSTREAM = 'https://api.deepseek.com/chat/completions';
const UPSTREAM_MODELS = 'https://api.deepseek.com/models';

export default {
	async fetch(request, env) {
		const origin = request.headers.get('Origin') || '';
		const allowed = isOriginAllowed(origin, env);
		const cors = corsHeaders(origin, allowed);

		// Preflight: answer before any auth/rate work.
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: allowed ? 204 : 403, headers: cors });
		}
		// A browser whose origin is not on the list gets a plain 403 with no
		// allow-origin header, so fetch() rejects and the page shows nothing of
		// ours. (curl and other non-browser callers send no Origin and are let
		// through — the origin lock is a browser-embedding guard, not security.)
		if (origin && !allowed) {
			return json(403, { error: { message: 'origin not allowed', type: 'proxy_forbidden' } }, cors);
		}

		const path = new URL(request.url).pathname.replace(/\/+$/, '');

		// A minimal models list, answered locally so probing it costs nothing.
		if (request.method === 'GET' && path.endsWith('/models')) {
			const data = allowedModels(env).map((id) => ({ id, object: 'model', owned_by: 'deepseek' }));
			return json(200, { object: 'list', data }, cors);
		}
		if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
			return json(404, { error: { message: 'not found; POST /chat/completions', type: 'proxy_not_found' } }, cors);
		}

		// Rate limits: burst and sustained per client IP, plus a coarse global
		// ceiling. Each binding is optional so the Worker still runs if one is
		// not configured. Counting is per Cloudflare location (see README).
		const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
		const limiters = [
			[env.RL_BURST, `ip:${ip}`],
			[env.RL_SUSTAINED, `ip:${ip}`],
			[env.RL_GLOBAL, 'global'],
		];
		for (const [binding, key] of limiters) {
			if (binding && !(await binding.limit({ key })).success) {
				return json(429, { error: { message: 'rate limit exceeded, slow down', type: 'proxy_rate_limited' } }, cors, {
					'Retry-After': '10',
				});
			}
		}

		// Reject oversized bodies before reading them into a string.
		const maxBody = intEnv(env.MAX_BODY_BYTES, 1_048_576);
		const declared = Number(request.headers.get('Content-Length') || 0);
		if (declared > maxBody) {
			return json(413, { error: { message: 'request body too large', type: 'proxy_too_large' } }, cors);
		}
		const raw = await request.text();
		if (raw.length > maxBody) {
			return json(413, { error: { message: 'request body too large', type: 'proxy_too_large' } }, cors);
		}
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return json(400, { error: { message: 'body is not JSON', type: 'proxy_bad_request' } }, cors);
		}

		const shaped = shapeBody(body, env);

		let upstream;
		try {
			upstream = await fetch(UPSTREAM, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_KEY}` },
				body: JSON.stringify(shaped),
			});
		} catch (e) {
			return json(502, { error: { message: `upstream unreachable: ${e}`, type: 'proxy_upstream_error' } }, cors);
		}

		// Pass the upstream response straight back, streaming and all. Only the
		// CORS headers and a debug hint are added; the status (including 402 when
		// the balance is gone) is upstream's.
		const headers = new Headers(cors);
		headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
		headers.set('X-Proxy-Model', shaped.model);
		return new Response(upstream.body, { status: upstream.status, headers });
	},
};

// ── helpers (exported for the unit test in test.mjs) ──

export function allowedModels(env) {
	const list = String(env.MODELS || 'deepseek-v4-flash')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : ['deepseek-v4-flash'];
}

export function isOriginAllowed(origin, env) {
	if (!origin) return true; // non-browser caller (no Origin header)
	const list = String(env.ALLOWED_ORIGINS || '')
		.split(',')
		.map((s) => s.trim().replace(/\/+$/, ''))
		.filter(Boolean);
	if (list.includes('*')) return true;
	return list.includes(origin.replace(/\/+$/, ''));
}

export function corsHeaders(origin, allowed) {
	const h = {
		Vary: 'Origin',
		'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400',
	};
	if (allowed && origin) h['Access-Control-Allow-Origin'] = origin;
	return h;
}

// Pin the model to the allowlist, clamp max_tokens, force n=1. Everything the
// agent depends on (messages, tools, tool_choice, temperature, stream,
// reasoning_effort/thinking) is left as the caller sent it.
export function shapeBody(body, env) {
	const out = { ...body };
	const models = allowedModels(env);
	if (!models.includes(out.model)) out.model = models[0];
	const cap = intEnv(env.MAX_TOKENS, 4096);
	const asked = Number(out.max_tokens);
	out.max_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(asked, cap) : cap;
	out.n = 1;
	return out;
}

function intEnv(v, fallback) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(status, obj, cors, extra = {}) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { ...cors, ...extra, 'Content-Type': 'application/json' },
	});
}
