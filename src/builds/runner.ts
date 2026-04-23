// End-to-end build orchestration for a single preview build.
//
// Runs inside the McpAgent DO so it has access to `this.sql`, `this.env`,
// and `this.ctx.waitUntil`. Detects project type, invokes the right install
// + build + upload commands inside a sandbox, and records progress in SQL.

import type { Sandbox as SandboxType } from '@cloudflare/sandbox';
import { mintAccess, gitUrlWithToken } from '../services/artifacts';
import { sandboxFor, sh, tailLogs, type ShellResult } from '../services/sandbox';
import { parseVersionsUpload } from '../services/wrangler';
import { wrangler } from '../services/wrangler-run';
import type { BuildRow, BuildStatus, RepoRow } from '../db/schema';

export interface SqlRunner {
	// Tagged-template SQL API exposed by McpAgent.
	<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
}

interface RunBuildArgs {
	env: Cloudflare.Env;
	sql: SqlRunner;
	build: BuildRow;
	repo: RepoRow;
}

const WORKDIR = '/workspace/repo';

export async function runBuild({ env, sql, build, repo }: RunBuildArgs): Promise<void> {
	const sb = sandboxFor(
		env.SANDBOX as unknown as DurableObjectNamespace<SandboxType>,
		build.id,
	);

	const logs: string[] = [];
	const recordStep = (step: string, r: ShellResult): void => {
		logs.push(`$ ${step}\n${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}\nexit=${r.exitCode}\n`);
	};

	const setStatus = (status: BuildStatus, extra?: Partial<BuildRow>): void => {
		const now = Date.now();
		const logTail = tailLogs(logs.join('\n'));
		sql`
			UPDATE builds SET
				status = ${status},
				updated_at = ${now},
				logs = ${logTail},
				commit_sha = COALESCE(${extra?.commit_sha ?? null}, commit_sha),
				worker_version_id = COALESCE(${extra?.worker_version_id ?? null}, worker_version_id),
				preview_url = COALESCE(${extra?.preview_url ?? null}, preview_url),
				error = ${extra?.error ?? null}
			WHERE id = ${build.id}
		`;
	};

	try {
		// 1. Clone
		setStatus('cloning');
		const access = await mintAccess(env.ARTIFACTS, repo.artifacts_repo_name, 'write', 900);
		const authedUrl = gitUrlWithToken(access.remote, access.token);
		const cloneCmd = `rm -rf ${WORKDIR} && git clone --quiet ${authedUrl} ${WORKDIR} && cd ${WORKDIR} && git checkout ${build.ref}`;
		const clone = await sh(sb, cloneCmd);
		recordStep(`git clone <remote> ${WORKDIR} && git checkout ${build.ref}`, clone);
		if (!clone.success) {
			setStatus('failed', { error: 'clone failed' });
			return;
		}

		const rev = await sh(sb, 'git rev-parse HEAD', { cwd: WORKDIR });
		recordStep('git rev-parse HEAD', rev);
		const commitSha = rev.stdout.trim() || null;

		// 2. Detect + install
		const detection = await detectProject(sb);
		logs.push(`[detected: ${detection.kind}]\n`);

		if (detection.kind === 'unknown') {
			setStatus('failed', { commit_sha: commitSha, error: 'no wrangler.jsonc/toml, package.json, or /bin/build found' });
			return;
		}

		setStatus('installing', { commit_sha: commitSha });
		if (detection.hasPackageJson) {
			const install = await sh(sb, 'npm install --no-audit --no-fund', { cwd: WORKDIR, timeoutMs: 180_000 });
			recordStep('npm install', install);
			if (!install.success) {
				setStatus('failed', { error: 'npm install failed' });
				return;
			}
		}

		// 3. Build (optional)
		setStatus('bundling');
		if (detection.kind === 'custom') {
			const buildRes = await sh(sb, '/bin/build', { cwd: WORKDIR, timeoutMs: 300_000 });
			recordStep('/bin/build', buildRes);
			if (!buildRes.success) {
				setStatus('failed', { error: '/bin/build failed' });
				return;
			}
		} else if (detection.hasPackageJson && detection.hasBuildScript) {
			const buildRes = await sh(sb, 'npm run build', { cwd: WORKDIR, timeoutMs: 300_000 });
			recordStep('npm run build', buildRes);
			if (!buildRes.success) {
				setStatus('failed', { error: 'npm run build failed' });
				return;
			}
		}

		// 4. Upload preview version via wrangler (egress goes through the
		//    Outbound Worker which injects the real CF API token).
		setStatus('uploading');
		const upload = await wrangler(sb, `versions upload --message "gh-for-agents build ${build.id}"`, WORKDIR);
		recordStep('wrangler versions upload', upload);
		if (!upload.success) {
			setStatus('failed', { error: 'wrangler versions upload failed' });
			return;
		}

		const parsed = parseVersionsUpload(upload.stdout);
		if (!parsed) {
			setStatus('failed', { error: 'could not parse wrangler output' });
			return;
		}

		setStatus('complete', {
			worker_version_id: parsed.versionId,
			preview_url: parsed.previewUrl,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.stack ?? err.message : String(err);
		logs.push(`[uncaught]\n${msg}\n`);
		setStatus('failed', { error: 'uncaught error' });
	}
}

interface Detection {
	kind: 'wrangler' | 'npm' | 'custom' | 'unknown';
	hasPackageJson: boolean;
	hasBuildScript: boolean;
}

async function detectProject(sb: ReturnType<typeof sandboxFor>): Promise<Detection> {
	const test = async (path: string): Promise<boolean> => {
		const r = await sh(sb, `test -e ${WORKDIR}/${path} && echo yes || echo no`);
		return r.stdout.trim() === 'yes';
	};

	const hasWrangler = (await test('wrangler.jsonc')) || (await test('wrangler.json')) || (await test('wrangler.toml'));
	const hasPackageJson = await test('package.json');
	const hasBinBuild = await test('bin/build');

	let hasBuildScript = false;
	if (hasPackageJson) {
		const r = await sh(sb, `node -e "const p=require('./package.json'); console.log(p.scripts && p.scripts.build ? 'yes' : 'no')"`, { cwd: WORKDIR });
		hasBuildScript = r.stdout.trim() === 'yes';
	}

	if (hasWrangler) return { kind: 'wrangler', hasPackageJson, hasBuildScript };
	if (hasBinBuild) return { kind: 'custom', hasPackageJson, hasBuildScript };
	if (hasPackageJson) return { kind: 'npm', hasPackageJson, hasBuildScript };
	return { kind: 'unknown', hasPackageJson: false, hasBuildScript: false };
}
