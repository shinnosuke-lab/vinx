import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

// Library mode: externalize React, ship a self-contained Tailwind CSS bundle
// (dist/styles.css) plus per-file .d.ts (vite-plugin-dts).
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    dts({ rollupTypes: false, include: ['src'] }),
  ],
  resolve: {
    // `@agentchat/*` is how the components self-reference (see vite.app.config.ts);
    // without it the library build breaks on the first internal import.
    alias: { '@': resolve(__dirname, 'src'), '@agentchat': resolve(__dirname, 'src') },
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'mermaid'],
      output: { assetFileNames: 'styles.css' },
    },
    cssCodeSplit: false,
  },
})
