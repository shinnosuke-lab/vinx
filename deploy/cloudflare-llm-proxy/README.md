# vinx-llm-proxy — a DeepSeek endpoint on Cloudflare Workers

A ~170-line Worker so a visitor can try the published page without bringing
their own key. It holds one DeepSeek API key server-side and forwards
`POST /chat/completions` (streaming and all) to `api.deepseek.com`, with three
cheap guards in front of an endpoint that spends real money.

DeepSeek already sends CORS headers, so the browser *could* call it directly —
the only reason this exists is that a static bundle can hide no secret. So the
Worker's whole job is: **keep the key off the page, rate-limit, and clamp the
request.** It is stateless; there is no database.

## Deploy

```bash
cd deploy/cloudflare-llm-proxy
npx wrangler login                     # once
npx wrangler secret put DEEPSEEK_KEY   # paste the key from platform.deepseek.com
npx wrangler deploy
```

Wrangler prints a URL like `https://vinx-llm-proxy.<account>.workers.dev`. That
is the model endpoint. Point the page at it in Settings:

| field | value |
| --- | --- |
| base_url | `https://vinx-llm-proxy.<account>.workers.dev` |
| model | `deepseek-v4-flash` |
| api_key | anything non-empty (the page requires one; the proxy ignores it) |

The `base_url` is the Worker root: the engine appends `/chat/completions` to
it (and `/models`), exactly as it would to `https://api.deepseek.com`, and the
Worker forwards both regardless of a `/v1` prefix. **Keep "deepseek" in the
model name** — the engine picks its DeepSeek wire profile (the
`thinking`/reasoning fields DeepSeek expects) from the model name once the
request no longer goes to `api.deepseek.com` directly, so a name like
`deepseek-v4-flash` keeps it and a renamed alias would silently drop to plain
OpenAI-compatible behaviour.

To make it the page's **default** so first-time visitors need not touch
Settings, set `DEFAULT_BASE_URL` and `DEFAULT_MODEL` in `version.sh` to the
above and cut a release. Leave `DEFAULT_API_KEY` empty — the real key lives
only in the Worker secret, never in the bundle.

## The guards, and the one that matters most

Configured in [`wrangler.toml`](wrangler.toml) (`[vars]` + `[[ratelimits]]`);
the code is in [`worker.js`](worker.js).

- **Origin lock** (`ALLOWED_ORIGINS`) — a browser whose `Origin` is not on the
  list gets a 403 with no allow-origin header, so other people's web apps
  cannot embed your endpoint. An `Origin` header is trivially forged outside a
  browser, so this is an embedding guard, not authentication — do not mistake
  it for one. Non-browser callers (no `Origin`) are let through on purpose.
- **Rate limits** (`RL_BURST`, `RL_SUSTAINED` per IP; `RL_GLOBAL` across all)
  — the platform's Rate Limiting binding, which is free and needs no storage.
  Two platform facts shape these: a period must be **10 or 60 seconds**, and
  counting is **per Cloudflare location**, not global — the numbers are a
  speed bump, not an accountant.
- **Request shaping** — the model is pinned to the `MODELS` allowlist,
  `max_tokens` is clamped to `MAX_TOKENS`, `n` is forced to 1, and a body over
  `MAX_BODY_BYTES` is rejected. Messages, `tools`/`tool_choice` (the agent
  needs function calling), `temperature`, `stream` and `reasoning_effort` pass
  through untouched.

**The hard wallet ceiling is not in this code — it is your DeepSeek account
balance.** Rate limits slow a flood; only the balance stops it. Fund the
account small, and turn on a low-balance alert in the DeepSeek console. When it
runs dry the upstream returns HTTP 402 and the proxy passes that straight
through; the page then shows the provider's "insufficient balance" error, and
nothing here has overspent.

## Cost

`deepseek-v4-flash` is DeepSeek's cheapest current model; a rate-limited demo
is a few dollars of tokens, bounded by the balance you load. The Worker itself
is free: the plan allows 100,000 requests/day, and a streamed reply is one
request.

## Tests

```bash
node test.mjs      # the pure guards (origin lock, model pin, clamps); no network
```

## Note for the project

Running this means the hosted demo has an optional backend, which the root
README's "there is no backend of ours" line should acknowledge — the page and
the VM still have none; only the shared demo key is brokered here, and a fork
that leaves `DEFAULT_BASE_URL` empty keeps the original no-backend behaviour
(the page asks each visitor for their own endpoint and key).
