/**
 * The runtime's tests are their own project.
 *
 * Without this, vitest walks up and finds the app's `vite.config.ts`, whose root
 * is `app/` — so it looks for tests there, finds none, and fails with "no test
 * files found" while the tests sit here untouched.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: import.meta.dirname,
	test: {
		include: ['test/**/*.test.ts'],
	},
});
