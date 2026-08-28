# @vinx/agent-chat

Reusable React chat UI for the `agent-core` web layer. Source-distributed so
hosts can fully customize it: SSE streaming, tool-call rendering (pluggable per
tool), confirm / ask-user flows, markdown + code + mermaid, and session history.

This is the L2 presentation layer. The Rust engine (L1, `agent-core`) only
serves the API (`/api/chat*`, `/api/sessions*`, `/api/chat/meta`).

## Install (host app)

`npm` does not support git-subdirectory deps, so for delivery the package is
carried at the `agent-core` repo root (see repo docs). For local dev, point at
the source directly:

```jsonc
// host web/package.json
"dependencies": {
  "@vinx/agent-chat": "file:../../agent-core/ui"
}
```

## Usage

```tsx
import { AgentChat } from '@vinx/agent-chat'
import '@vinx/agent-chat/styles.css'

export default function Chat() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <AgentChat basePath="" theme={{ accent: 'hsl(var(--primary))' }} />
    </div>
  )
}
```

### Custom tool renderers (the main extension point)

```tsx
import type { ToolRenderer } from '@vinx/agent-chat'

const BridgeStatus: ToolRenderer = ({ result, status }) => {
  if (status === 'running') return <div className="text-xs">reading…</div>
  let data: any = {}
  try { data = JSON.parse(result ?? '{}') } catch {}
  return <div className="rounded-md border p-2 text-xs">gateway: {data.gateway_id}</div>
}

<AgentChat toolRenderers={{ bridge_status: BridgeStatus }} />
```

Unmatched tools fall back to a generic input/output card. Built-in renderers
cover agent-core's OS tools (`run_shell`, `read_file`, `write_file`,
`edit_file`, `list_files`, `search_files`).

### Props

| prop | default | description |
| --- | --- | --- |
| `basePath` | `''` | API origin prefix (`''` = same-origin). |
| `toolRenderers` | `{}` | Override/extend tool renderers, keyed by tool name. |
| `theme` | – | `{ accent, background, foreground, scheme }` → CSS vars. |
| `labels` | en | i18n overrides. |
| `enableHistory` | `true` | Session sidebar (auto-hidden if backend persistence is off). |
| `enableExport` | `true` | Export-transcript action. |
| `modelName` | meta | Composer model badge; falls back to `/api/chat/meta`. |
| `onSessionChange` | – | Called with the active session id on create/switch. |

`enableHistory` is gated by the backend: `/api/chat/meta` reports
`history: bool`, and the sidebar hides itself when persistence is disabled.

## Styling

Styles are self-contained: the library compiles its own Tailwind 4 utilities
(no preflight, so it never resets host styles) plus semantic CSS variables.
Import `@vinx/agent-chat/styles.css` once. Theme by setting `--acc-*` via the
`theme` prop. Dark mode keys off a `.dark` ancestor.

`mermaid` is an optional dependency, lazy-loaded on first diagram; if absent,
diagrams degrade to a code block.

## Build

```bash
npm install
npm run build            # dist/index.js + dist/index.d.ts + dist/styles.css
npm run typecheck
```

## Reference app (clients without a frontend stack)

The `app/` entry is a thin mount of the exported `CopilotApp` component — the
reference SPA agent-core's `app` binary serves. Hosts that want to customize
(theme / custom tool renderers) write their own equivalent thin entry against
`@vinx/agent-chat` instead of forking this one.

```bash
npm run build:app     # → dist-app/ (static SPA, React bundled)
npx serve dist-app    # serve statically; reverse-proxy /api/* to the agent,
                      # or set window.__AGENT_BASE__ to the API origin
```
