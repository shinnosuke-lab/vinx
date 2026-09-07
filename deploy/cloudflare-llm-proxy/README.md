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

Two things a fresh Cloudflare account runs into, both of which the first
deploy here did:

- **`wrangler login` needs the dashboard, and `dash.cloudflare.com` sits
  behind a bot challenge** that can spin forever on a shared proxy exit IP. The
  way around it is a token: once in the dashboard (try another exit, or a
  private window), *My Profile → API Tokens → Create Token → "Edit Cloudflare
  Workers"*, then `export CLOUDFLARE_API_TOKEN=…` and skip `login` entirely —
  `api.cloudflare.com`, which is all wrangler actually talks to, has no
  challenge. Non-interactive from then on (`CI=1` answers the prompts).
- **No `workers.dev` subdomain yet** — `deploy` stops and points at the
  dashboard again. The API does it without one:
  `curl -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  -H 'Content-Type: application/json' -d '{"subdomain":"<name>"}'
  https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/subdomain`
  (`wrangler whoami` prints the account id). The subdomain is account-wide
  and permanent; this repo's is `shinnosuke-lab`.

Wrangler prints a URL like `https://vinx-llm-proxy.<subdomain>.workers.dev`.
That is the model endpoint — the deployed one is
`https://vinx-llm-proxy.shinnosuke-lab.workers.dev`. Point the page at it in
Settings:

| field | value |
| --- | --- |
| base_url | `https://vinx-llm-proxy.<subdomain>.workers.dev` |
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

- **Origin lock** (`ALLOWED_ORIGINS`) — a request whose `Origin` is not on the
  list, **or that has no `Origin` at all** (curl, scripts, the crawlers that
  scan workers.dev for open OpenAI-style proxies), gets a 403 with no
  allow-origin header. The legitimate caller is always a browser page and
  always sends one, so refusing its absence costs nothing and turns away
  everyone who does not bother to forge it. Anyone who does bother gets
  through — an `Origin` is one header — so this is a doorstep, not
  authentication; the rate limits and the DeepSeek balance are what actually
  bound the damage. `*` widens the list to any browser origin; it still
  refuses requests without one. To test from a terminal, send the header:
  `curl -H 'Origin: https://shinnosuke-lab.github.io' …`.
- **Rate limits** (`RL_BURST`, `RL_SUSTAINED` per IP; `RL_GLOBAL` across all)
  — the platform's Rate Limiting binding, which is free and needs no storage.
  Two platform facts shape these: a period must be **10 or 60 seconds**, and
  counting is **per Cloudflare server, approximate** — not even per location.
  Measured on the deployed Worker: nine requests down one connection (so one
  server) were cut off at exactly the seventh, as configured; forty requests
  fired concurrently over fresh connections spread across the servers of one
  location and only two were refused. So a real user in one browser, which
  reuses its connections, is limited as the numbers say; a deliberate flood
  that opens many connections is only slowed. The numbers are a speed bump,
  not an accountant.
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
