# Host-owned agent SPA (frontend integration)

This folder helps a host app build its **own** agent Copilot SPA from
agent-core's chat components, distributed as **source** (`@vinx/agent-chat`).
The host gets full control over branding, theme, layout and (later) per-tool
rendering, while agent-core owns the chat mechanics (SSE streaming, tool-call
rendering, confirm/ask flows, session history).

This is the recommended path when the host already has a frontend stack. If you
just want a turnkey SPA with no host frontend, use agent-core's reference app
(`ui/app` + the `app` reference binary) instead.

## Whole-app integration at a glance

The agent runs as a separate process (`<your-app> agent`) the host supervises.
End to end, an integration is **FE: 4 copied files + BE: one `agent.rs` + a few
1-line wires**:

| layer | what you add | source / template |
| --- | --- | --- |
| FE (4 files) | `web/vite.agent.config.ts`, `web/tsconfig.agent.json`, `web/agent/index.html`, `web/agent/main.tsx` | copy from `templates/` (below) |
| FE build | one `#[path]` include + one call in `build.rs` | `agent-core/integration/build_agent_spa.rs` |
| BE (1 file) | `src/agent.rs`: domain tool(s) + `register` + `run_subcommand` + `supervisor()` | uses `agent_core::run` / `Supervisor` / `AiConfig` |
| BE wires | subcommand dispatch in `main`, supervisor `start/stop`, `pub ai: agent_core::AiConfig` in config | 1 line each |

`build.rs` (debug profile), after building your own UI:

```rust
#[path = "../agent-core/integration/build_agent_spa.rs"]
mod agent_spa;
// ...
agent_spa::build_agent_spa(std::path::Path::new("web"), std::path::Path::new("../agent-core/ui"));
```

The backend of `src/agent.rs` is essentially:

```rust
// subcommand body (main.rs: `if arg == "agent" { return agent::run_subcommand().await; }`)
pub async fn run_subcommand() -> Result<(), Box<dyn std::error::Error>> {
    let app = AppConfig::load(...).await?;            // your config, with `pub ai: agent_core::AiConfig`
    agent_core::run(&app.ai, env.agent_static_path,   // enabled-gate + validate + serve
        |b| register(b, &env, &app.ai, &events)).await?;  // your `module_init`
    Ok(())
}
```

The sections below detail the FE pieces.

## Model

- Components ship as source. The host consumes them through a Vite alias
  (`@vinx/agent-chat` -> `agent-core/ui/src`), not an npm `file:` dependency
  (that hoists into the parent dir and breaks sandboxed/CI installs).
- Components self-import via the namespaced `@agentchat/*` prefix, so the host
  keeps `@` for its own `src/`.
- Component runtime deps (`react-markdown`, `dompurify`, `highlight.js`, ...)
  resolve from `agent-core/ui/node_modules`, so run `npm install` in
  `agent-core/ui` once (CI does this). `react` / `react-dom` are de-duped to a
  single instance.
- The host's Tailwind v4 plugin scans the component source (`@source` in the
  component theme) and emits the utility classes the components use.

```mermaid
flowchart LR
  hostMain["web/agent/main.tsx<br/>(brand + theme + tool renderers)"]
  comp["@vinx/agent-chat<br/>(agent-core/ui/src, source)"]
  vite["vite.agent.config.ts<br/>createAgentViteConfig()"]
  out["web/dist-agent/<br/>(static bundle)"]
  proc["`<app> agent` process<br/>(serves dist-agent + /api)"]
  hostMain --> comp
  comp --> vite
  vite --> out
  out --> proc
```

## Setup (copy the templates)

Copy the files from `templates/` into your host `web/` dir:

| template | copy to | purpose |
| --- | --- | --- |
| `vite.agent.config.ts` | `web/vite.agent.config.ts` | build config (calls `createAgentViteConfig`) |
| `tsconfig.agent.json` | `web/tsconfig.agent.json` | editor / typecheck for `web/agent` |
| `index.html` | `web/agent/index.html` | SPA shell |
| `main.tsx` | `web/agent/main.tsx` | entry: renders `<CopilotApp>` with your brand/theme |

Adjust the relative path to `agent-core/ui` in both `vite.agent.config.ts`
(the `createAgentViteConfig` import + `agentCoreUi`) and `tsconfig.agent.json`
(the `paths` entries) to match your layout.

Add scripts to `web/package.json`:

```json
{
  "scripts": {
    "build:agent": "vite build -c vite.agent.config.ts",
    "dev:agent": "vite -c vite.agent.config.ts"
  }
}
```

## `createAgentViteConfig(opts)`

Mechanism (alias / dedupe / root / outDir / fs.allow / dev proxy) lives in
agent-core; the host supplies policy (plugins + paths). Options:

| option | required | default | notes |
| --- | --- | --- | --- |
| `webDir` | yes | - | host `web/` dir; pass `__dirname` |
| `agentCoreUi` | yes | - | path to `agent-core/ui` |
| `plugins` | yes | - | created by the host, e.g. `[react(), tailwindcss()]` (single React instance) |
| `agentRoot` | no | `<webDir>/agent` | SPA entry root (`index.html` + `main.tsx`) |
| `outDir` | no | `<webDir>/dist-agent` | served by the agent process |
| `hostSrc` | no | `<webDir>/src` | target of the `@` alias |
| `fsAllow` | no | `[<webDir>/.., agentCoreUi]` | dev-server readable dirs |
| `apiProxyTarget` | no | `http://localhost:8080` | dev `/api` proxy; `false` to disable |

## Customization

- Brand / theme: props on `<CopilotApp brand theme/>` in `agent/main.tsx`.
- Host components / i18n inside `agent/`: import via `@/...` (resolves to your
  `web/src`).
- Per-tool rendering: pass custom renderers through `CopilotApp` props (see the
  component's `CopilotAppProps`).

## Build output

`web/dist-agent/` is a static bundle. Point the agent process at it via the
host's `agent_static_path` (see deployment templates in
`agent-core/integration/deploy`).
