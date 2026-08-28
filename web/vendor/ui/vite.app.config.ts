import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// App-mode build (React bundled) for the `app` reference binary. Multi-page:
// the Copilot SPA (`index.html`) and the Web SSH terminal SPA (`terminal.html`)
// build together so they SHARE one vendor chunk (React, mermaid, highlight,
// react-devicons) instead of each shipping its own copy — a big win for the
// single embedded armv7 binary. The two pages stay independent documents
// (separate CSS/DOM), so the terminal's global dark styles never touch Copilot.
//
// Both entry HTMLs sit at the project root so they emit to `dist-app/` side by
// side and share `dist-app/assets/`; with `base: './'` each page's `./assets/x`
// resolves to `/assets/x`. Served at `/` and `/terminal` (see src/web/serve.rs).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // Stamp the SPA build time so the About popover can show it (upstream parity).
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')),
  },
  resolve: {
    // 组件内部以 `@agentchat/*` 自引 (命名空间化, 不占用 `@` —— 便于集成方把 `@` 留给自己的 src)
    alias: { '@agentchat': resolve(__dirname, 'src') },
  },
  root: resolve(__dirname),
  server: {
    proxy: { '/api': 'http://localhost:655' },
  },
  build: {
    // es2021 是硬要求: @xterm/xterm@6.0 发布的是预压缩 ESM, 默认 target(含
    // es2020)会让 esbuild 把其中的 `let t; (t ||= {})` 降级成 `void 0 || (t = {})`
    // 而丢掉声明 —— vim/htop 等 TUI 启动时发 DECRQM, requestMode 抛
    // ReferenceError, xterm 解析器死掉, 终端画面永久冻结 (仅生产构建复现)。
    // 见 https://github.com/xtermjs/xterm.js/issues/5800
    target: 'es2021',
    outDir: resolve(__dirname, 'dist-app'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        terminal: resolve(__dirname, 'terminal.html'),
      },
    },
  },
})
