/// <reference types="vite/client" />

// The globals vite.config.ts `define`s into the bundle (values from the
// repo's version.sh; see the config for what each one means).
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __SKILLS_REPO__: string;
declare const __APPS_REPO__: string;
declare const __APP_FRAME_URL__: string;
declare const __DEFAULTS__: { baseUrl: string; model: string; apiKey: string };
declare const __REPO_URL__: string;
