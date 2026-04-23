import { defineConfig } from 'vitest/config';

// Pure-Node config. The current @cloudflare/vitest-pool-workers release
// doesn't understand the `artifacts` binding or remote service bindings in
// wrangler.jsonc, so miniflare refuses to boot. The helper-level tests don't
// need the Workers runtime — standard Node is fine.
export default defineConfig({
	test: {
		include: ['test/**/*.spec.ts'],
		environment: 'node',
	},
});
