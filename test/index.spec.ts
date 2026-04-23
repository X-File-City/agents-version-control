import { describe, it, expect } from 'vitest';

import { artifactsRepoName, gitUrlWithToken } from '../src/services/artifacts';
import {
	initialPackageJson,
	initialWorkerSource,
	initialWranglerConfig,
	parseVersionsUpload,
} from '../src/services/wrangler';
import { ulid } from '../src/util/ids';

// These are pure-unit tests over the helper modules. The full end-to-end flow
// (OAuth + DO + Artifacts + Sandbox) isn't exercisable in the current
// vitest-pool-workers setup because it doesn't yet understand the `artifacts`
// binding — run those checks against a deployed instance.

describe('artifacts helpers', () => {
	it('builds deterministic namespaced repo names', () => {
		const a = artifactsRepoName('abc123', 'my-worker');
		const b = artifactsRepoName('abc123', 'my-worker');
		expect(a).toBe(b);
		expect(a).toContain('abc123');
		expect(a).toContain('my-worker');
	});

	it('scrubs non-safe characters from repo names', () => {
		const name = artifactsRepoName('abc', 'weird/name with spaces!');
		expect(name).toMatch(/^[a-zA-Z0-9._-]+$/);
	});

	it('injects credentials into a git URL', () => {
		const url = gitUrlWithToken('https://git.example.com/owner/repo.git', 'sekret');
		expect(url).toBe('https://x-access-token:sekret@git.example.com/owner/repo.git');
	});
});

describe('wrangler helpers', () => {
	it('produces a valid wrangler.jsonc', () => {
		const config = JSON.parse(initialWranglerConfig('demo-worker'));
		expect(config.name).toBe('demo-worker');
		expect(config.main).toBe('src/index.ts');
	});

	it('produces a wrangler-compatible package.json', () => {
		const pkg = JSON.parse(initialPackageJson('demo-worker'));
		expect(pkg.scripts.deploy).toBe('wrangler deploy');
	});

	it('produces compilable initial Worker source', () => {
		const src = initialWorkerSource();
		expect(src).toContain('export default');
		expect(src).toContain('fetch');
	});

	it('parses worker version id + preview URL from wrangler stdout', () => {
		const stdout = [
			'Uploading...',
			'Worker Version ID: 01J1-abc-def',
			'Preview URL: https://01j1-abc-def-demo-worker.example.workers.dev',
		].join('\n');
		const parsed = parseVersionsUpload(stdout);
		expect(parsed?.versionId).toBe('01J1-abc-def');
		expect(parsed?.previewUrl).toMatch(/workers\.dev/);
	});

	it('returns null when no version id is present', () => {
		expect(parseVersionsUpload('nothing useful here')).toBeNull();
	});
});

describe('ulid', () => {
	it('is sortable and unique', async () => {
		const a = ulid();
		await new Promise((r) => setTimeout(r, 2));
		const b = ulid();
		expect(b > a).toBe(true);
		expect(a).not.toBe(b);
		expect(a).toHaveLength(26);
	});
});
