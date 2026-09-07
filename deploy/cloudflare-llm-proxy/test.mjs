// Unit tests for the proxy's pure guards — no network, no Worker runtime.
// Run: node test.mjs   (exit 0 = all passed)
import { allowedModels, isOriginAllowed, shapeBody, corsHeaders } from './worker.js';

let failed = 0;
const eq = (name, got, want) => {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	if (g !== w) {
		failed++;
		console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
	} else {
		console.log(`ok   ${name}`);
	}
};

const env = {
	ALLOWED_ORIGINS: 'https://shinnosuke-lab.github.io, https://example.test',
	MODELS: 'deepseek-v4-flash, deepseek-v4-pro',
	MAX_TOKENS: '4096',
};

// models allowlist
eq('models parsed', allowedModels(env), ['deepseek-v4-flash', 'deepseek-v4-pro']);
eq('models default', allowedModels({}), ['deepseek-v4-flash']);

// origin lock
eq('origin allowed', isOriginAllowed('https://shinnosuke-lab.github.io', env), true);
eq('origin allowed trailing slash', isOriginAllowed('https://shinnosuke-lab.github.io/', env), true);
eq('origin denied', isOriginAllowed('https://evil.test', env), false);
eq('no origin = not a browser page, refused', isOriginAllowed('', env), false);
eq('no origin refused even under wildcard', isOriginAllowed('', { ALLOWED_ORIGINS: '*' }), false);
eq('wildcard', isOriginAllowed('https://anything.test', { ALLOWED_ORIGINS: '*' }), true);

// CORS header only echoes the origin when allowed
eq('cors echoes allowed origin', corsHeaders('https://x.test', true)['Access-Control-Allow-Origin'], 'https://x.test');
eq('cors omits denied origin', corsHeaders('https://x.test', false)['Access-Control-Allow-Origin'], undefined);

// body shaping
eq('unknown model pinned to first', shapeBody({ model: 'gpt-4o', messages: [] }, env).model, 'deepseek-v4-flash');
eq('allowed model kept', shapeBody({ model: 'deepseek-v4-pro', messages: [] }, env).model, 'deepseek-v4-pro');
eq('max_tokens clamped', shapeBody({ model: 'x', max_tokens: 999999 }, env).max_tokens, 4096);
eq('max_tokens kept under cap', shapeBody({ model: 'x', max_tokens: 512 }, env).max_tokens, 512);
eq('max_tokens defaulted when absent', shapeBody({ model: 'x' }, env).max_tokens, 4096);
eq('n forced to 1', shapeBody({ model: 'x', n: 8 }, env).n, 1);
eq('tools passed through', shapeBody({ model: 'x', tools: [{ type: 'function' }], stream: true }, env).tools.length, 1);
eq('stream passed through', shapeBody({ model: 'x', stream: true }, env).stream, true);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
