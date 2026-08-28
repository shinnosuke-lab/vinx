import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
// Adjust the relative path so it points at your sibling agent-core/ui dir.
import { createAgentViteConfig } from '../../agent-core/ui/integration/vite'

// Host-owned agent Copilot SPA, built from agent-core component *source*
// (so you can re-theme and plug custom tool renderers). Output: <web>/dist-agent,
// statically served by the `<your-app> agent` process. Customize brand/theme in
// agent/main.tsx via <CopilotApp brand theme/>.
export default defineConfig(
  createAgentViteConfig({
    webDir: __dirname,
    agentCoreUi: path.resolve(__dirname, '../../agent-core/ui'),
    plugins: [react(), tailwindcss()],
    // apiProxyTarget: 'http://localhost:8080', // dev: where the agent process listens
  }),
)
