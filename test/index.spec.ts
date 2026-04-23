import { describe, it, expect } from 'vitest';

import { artifactsRepoName, gitUrlWithToken } from '../src/services/artifacts';
import {
	initialPackageJson,
	initialWorkerSource,
	initialWranglerConfig,
	parseWorkersScriptList,
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
		expect(url).toBe('https://x:sekret@git.example.com/owner/repo.git');
	});

	it('replaces existing credentials in an artifacts HTTPS remote', () => {
		const url = gitUrlWithToken(
			'https://x:old-token@d32e32cb20387d14c4f45965620063cc.artifacts.cloudflare.net/git/github-for-agents/aagentbx1byf--test-repo.git',
			'new-token',
		);
		expect(url).toBe(
			'https://x:new-token@d32e32cb20387d14c4f45965620063cc.artifacts.cloudflare.net/git/github-for-agents/aagentbx1byf--test-repo.git',
		);
	});

	it('strips the expires suffix for URL basic-auth remotes', () => {
		const url = gitUrlWithToken(
			'https://d32e32cb20387d14c4f45965620063cc.artifacts.cloudflare.net/git/github-for-agents/demo.git',
			'art_v1_0123456789abcdef0123456789abcdef01234567?expires=1767225600',
		);
		expect(url).toBe(
			'https://x:art_v1_0123456789abcdef0123456789abcdef01234567@d32e32cb20387d14c4f45965620063cc.artifacts.cloudflare.net/git/github-for-agents/demo.git',
		);
	});

	it('coerces ssh-style remotes before injecting credentials', () => {
		const url = gitUrlWithToken('git@git.example.com:owner/repo.git', 'sekret');
		expect(url).toBe('https://x:sekret@git.example.com/owner/repo.git');
	});

	it('coerces host/path remotes before injecting credentials', () => {
		const url = gitUrlWithToken('git.example.com/owner/repo.git', 'sekret');
		expect(url).toBe('https://x:sekret@git.example.com/owner/repo.git');
	});

	it('throws a clear error for malformed scp-like remotes', () => {
		expect(() => gitUrlWithToken('git.example.com:', 'sekret')).toThrow(/unsupported git remote protocol/i);
	});
});

describe('wrangler helpers', () => {
	it('produces a valid wrangler.jsonc', () => {
		const config = JSON.parse(initialWranglerConfig('demo-worker'));
		expect(config.name).toBe('demo-worker');
		expect(config.account_id).toBe('d32e32cb20387d14c4f45965620063cc');
		expect(config.main).toBe('src/index.ts');
	});

	it('produces a wrangler-compatible package.json', () => {
		const pkg = JSON.parse(initialPackageJson('demo-worker'));
		expect(pkg.scripts.deploy).toContain('CLOUDFLARE_ACCOUNT_ID=d32e32cb20387d14c4f45965620063cc');
		expect(pkg.scripts.deploy).toContain('wrangler deploy');
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

	it('detects worker existence from workers/scripts API response', () => {
		const parsed = parseWorkersScriptList(
			{
				success: true,
				result: [{ id: 'demo-worker' }, { id: 'other-worker' }],
			},
			'demo-worker',
		);
		expect(parsed).toEqual({ exists: true, error: null });
	});

	it('surfaces workers/scripts API errors', () => {
		const parsed = parseWorkersScriptList(
			{
				success: false,
				errors: [{ message: 'unauthorized' }],
			},
			'demo-worker',
		);
		expect(parsed.exists).toBe(false);
		expect(parsed.error).toContain('unauthorized');
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
