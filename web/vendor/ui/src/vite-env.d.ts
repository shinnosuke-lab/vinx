/// <reference types="vite/client" />

// Injected by `vite.app.config.ts` (SPA build only). Absent in the library
// build, so always guard reads with `typeof __BUILD_TIME__ !== "undefined"`.
declare const __BUILD_TIME__: string
