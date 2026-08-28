import { resolve } from 'node:path'
import type { PluginOption, UserConfig } from 'vite'

export interface AgentViteOptions {
  /** Host `web/` directory (holds the `agent/` entry, `src/`, `dist-agent/`). Pass `__dirname`. */
  webDir: string
  /** Path to agent-core's `ui/` directory (the chat component source package). */
  agentCoreUi: string
  /**
   * Vite plugins, created by the host so React / Tailwind resolve from the
   * host's own node_modules (single instance). Typically `[react(), tailwindcss()]`.
   */
  plugins: PluginOption[]
  /** SPA entry root (holds `index.html` + `main.tsx`). Default `<webDir>/agent`. */
  agentRoot?: string
  /** Build output dir (statically served by the agent process). Default `<webDir>/dist-agent`. */
  outDir?: string
  /** Target of the `@` alias (the host's own src, kept free for host customization). Default `<webDir>/src`. */
  hostSrc?: string
  /** Extra dirs the dev server may read. Default `[<webDir>/.., agentCoreUi]`. */
  fsAllow?: string[]
  /** Dev `/api` proxy target (the running agent process). Default `http://localhost:8080`. Pass `false` to disable. */
  apiProxyTarget?: string | false
}

/**
 * Build a Vite config for a host-owned agent Copilot SPA that consumes
 * agent-core's chat components *from source* (`@vinx/agent-chat`), so the host
 * can re-theme and plug custom tool renderers.
 *
 * Mechanism lives here; policy (which plugins, paths, proxy target) is supplied
 * by the host. Components self-import via the namespaced `@agentchat/*` prefix so
 * the host keeps `@` for its own `src/`.
 *
 * @example
 * ```ts
 * // ontrakbridge/web/vite.agent.config.ts
 * import { defineConfig } from 'vite'
 * import react from '@vitejs/plugin-react'
 * import tailwindcss from '@tailwindcss/vite'
 * import path from 'node:path'
 * import { createAgentViteConfig } from '../../agent-core/ui/integration/vite'
 *
 * export default defineConfig(
 *   createAgentViteConfig({
 *     webDir: __dirname,
 *     agentCoreUi: path.resolve(__dirname, '../../agent-core/ui'),
 *     plugins: [react(), tailwindcss()],
 *   }),
 * )
 * ```
 */
export function createAgentViteConfig(opts: AgentViteOptions): UserConfig {
  const agentChatSrc = resolve(opts.agentCoreUi, 'src')
  const agentRoot = opts.agentRoot ?? resolve(opts.webDir, 'agent')
  const outDir = opts.outDir ?? resolve(opts.webDir, 'dist-agent')
  const hostSrc = opts.hostSrc ?? resolve(opts.webDir, 'src')
  const fsAllow = opts.fsAllow ?? [resolve(opts.webDir, '..'), opts.agentCoreUi]
  const apiProxyTarget = opts.apiProxyTarget ?? 'http://localhost:8080'

  return {
    plugins: opts.plugins,
    base: './',
    resolve: {
      alias: {
        // Component entry (public API).
        '@vinx/agent-chat': agentChatSrc,
        // Component-internal self-import prefix (namespaced, leaves `@` free for the host).
        '@agentchat': agentChatSrc,
        // `@` stays with the host's own src: reuse host components / i18n / theme in agent/.
        '@': hostSrc,
      },
      dedupe: ['react', 'react-dom'],
    },
    root: agentRoot,
    server: {
      // Let the dev server read the adjacent agent-core repo's component source.
      fs: { allow: fsAllow },
      ...(apiProxyTarget
        ? { proxy: { '/api': { target: apiProxyTarget, changeOrigin: true } } }
        : {}),
    },
    build: { outDir, emptyOutDir: true },
  }
}
