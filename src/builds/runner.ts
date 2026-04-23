// End-to-end build orchestration for a single preview build.
//
// Runs inside the McpAgent DO so it has access to SQL + environment bindings.
// Triggered from the agent via durable execution (`runFiber`). Detects project type, invokes the right install
// + build + upload commands inside a sandbox, and records progress in SQL.

import { mintAccess, gitUrlWithToken } from '../services/artifacts';
import {
	sandboxFor,
	sandboxIdForBuild,
	sandboxNamespace,
	sh,
	tailLogs,
	gitCheckout,
	type ShellResult,
} from '../services/sandbox';
import { parseVersionsUpload, parseWorkersScriptList } from '../services/wrangler';
import { CLOUDFLARE_ACCOUNT_ID } from '../config';
import { wrangler } from '../services/wrangler-run';
import { errorMessage } from '../util/errors';
import type { SqlRunner } from '../db/queries';
import type { BuildRow, BuildStatus, RepoRow } from '../db/schema';

interface RunBuildArgs {
	env: Cloudflare.Env;
	sql: SqlRunner;
	build: BuildRow;
	repo: RepoRow;
}

const WORKDIR = '/workspace/repo';
const WRANGLER_UPLOAD_TIMEOUT_MS = 900_000;

export async function runBuild({ env, sql, build, repo }: RunBuildArgs): Promise<void> {
	const sb = sandboxFor(sandboxNamespace(env), sandboxIdForBuild(build.id));
	const logPrefix = `[build:${build.id}]`;

	const logs: string[] = [];
	const isTimeoutLikeFailure = (r: ShellResult): boolean => {
		const detail = `${r.stderr}\n${r.stdout}`;
		return /command timeout|timed out|\/api\/execute 500/i.test(detail);
	};
	const summarizeFailure = (summary: string, r: ShellResult): string => {
		if (isTimeoutLikeFailure(r)) {
			const detail = (r.stderr || r.stdout).trim();
			if (!detail) return `${summary}: command timed out while waiting for sandbox exec`;
			return `${summary}: command timed out while waiting for sandbox exec (${tailLogs(detail, 400)})`;
		}
		const detail = (r.stderr || r.stdout).trim();
		if (!detail) return summary;
		return `${summary}: ${tailLogs(detail, 500)}`;
	};
	const recordStep = (step: string, r: ShellResult): void => {
		logs.push(`$ ${step}\n${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}\nexit=${r.exitCode}\n`);
		const level = r.success ? 'info' : 'warn';
		console[level](`${logPrefix} ${step} -> exit=${r.exitCode}`);
		if (r.stderr.trim()) {
			console.warn(`${logPrefix} ${step} stderr:\n${tailLogs(r.stderr)}`);
		}
	};

	const setStatus = (status: BuildStatus, extra?: Partial<BuildRow>): void => {
		const now = Date.now();
		const logTail = tailLogs(logs.join('\n'));
		console.info(`${logPrefix} status=${status}`, {
			repoId: repo.id,
			ref: build.ref,
			commitSha: extra?.commit_sha ?? build.commit_sha ?? null,
			workerVersionId: extra?.worker_version_id ?? null,
			previewUrl: extra?.preview_url ?? null,
			error: extra?.error ?? null,
		});
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
		const authedUrl = gitUrlWithToken(repo.git_url, access.token);
		const clearDir = await sh(sb, `rm -rf ${WORKDIR}`);
		recordStep(`rm -rf ${WORKDIR}`, clearDir);
		const nativeClone = await gitCheckout(sb, authedUrl, { targetDir: WORKDIR });
		recordStep(`sandbox gitCheckout <remote> ${WORKDIR}`, nativeClone);
		if (!nativeClone.success) {
			setStatus('failed', { error: summarizeFailure('clone failed via sandbox gitCheckout', nativeClone) });
			return;
		}
		const checkout = await sh(sb, `git checkout ${build.ref}`, { cwd: WORKDIR });
		recordStep(`git checkout ${build.ref}`, checkout);
		if (!checkout.success) {
			setStatus('failed', { error: summarizeFailure('checkout failed', checkout) });
			return;
		}

		const rev = await sh(sb, 'git rev-parse HEAD', { cwd: WORKDIR });
		recordStep('git rev-parse HEAD', rev);
		const commitSha = rev.stdout.trim() || null;

		// 2. Detect + install
		const detection = await detectProject(sb);
		logs.push(`[detected: ${detection.kind}]\n`);
		console.info(`${logPrefix} detected project`, detection);

		if (detection.kind === 'unknown') {
			setStatus('failed', { commit_sha: commitSha, error: 'no wrangler.jsonc/toml, package.json, or /bin/build found' });
			return;
		}

		setStatus('installing', { commit_sha: commitSha });
		if (detection.hasPackageJson) {
			const install = await sh(sb, 'npm install --no-audit --no-fund', { cwd: WORKDIR, timeoutMs: 300_000 });
			recordStep('npm install', install);
			if (!install.success) {
				setStatus('failed', { error: summarizeFailure('npm install failed', install) });
				return;
			}
		}

		// 3. Build (optional)
		setStatus('bundling');
		if (detection.kind === 'custom') {
			const buildRes = await sh(sb, '/bin/build', { cwd: WORKDIR, timeoutMs: 300_000 });
			recordStep('/bin/build', buildRes);
			if (!buildRes.success) {
				setStatus('failed', { error: summarizeFailure('/bin/build failed', buildRes) });
				return;
			}
		} else if (detection.hasPackageJson && detection.hasBuildScript) {
			const buildRes = await sh(sb, 'npm run build', { cwd: WORKDIR, timeoutMs: 300_000 });
			recordStep('npm run build', buildRes);
			if (!buildRes.success) {
				setStatus('failed', { error: summarizeFailure('npm run build failed', buildRes) });
				return;
			}
		}

		// 4. Upload preview version via wrangler using a real API token passed
		//    directly into the sandbox command environment.
		setStatus('uploading');
		const apiToken = env.API_TOKEN;
		if (!apiToken) {
			setStatus('failed', { error: 'missing API_TOKEN secret' });
			return;
		}
		const workerCheck = await ensureWorkerScriptExists({
			apiToken,
			workerName: repo.worker_name,
		});
		if (workerCheck.error) {
			setStatus('failed', { error: workerCheck.error });
			return;
		}
		if (!workerCheck.exists) {
			logs.push(`[bootstrap] worker "${repo.worker_name}" not found remotely; deploying once before preview upload\n`);
			const deploy = await wrangler(
				sb,
				'deploy',
				WORKDIR,
				apiToken,
				WRANGLER_UPLOAD_TIMEOUT_MS,
			);
			recordStep('wrangler deploy (bootstrap missing worker)', deploy);
			if (!deploy.success) {
				setStatus('failed', { error: summarizeFailure('wrangler deploy failed while bootstrapping worker', deploy) });
				return;
			}
		}
		const upload = await wrangler(
			sb,
			`versions upload --message "gh-for-agents build ${build.id}"`,
			WORKDIR,
			apiToken,
			WRANGLER_UPLOAD_TIMEOUT_MS,
		);
		recordStep('wrangler versions upload', upload);
		if (!upload.success) {
			setStatus('failed', { error: summarizeFailure('wrangler versions upload failed', upload) });
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
		console.error(`${logPrefix} uncaught error\n${msg}`);
		setStatus('failed', { error: 'uncaught error' });
	}
}

async function ensureWorkerScriptExists(args: {
	apiToken: string;
	workerName: string;
}): Promise<{ exists: boolean; error: string | null }> {
	let res: Response;
	try {
		res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
			{
				method: 'GET',
				headers: {
					Authorization: `Bearer ${args.apiToken}`,
				},
			},
		);
	} catch (err) {
		return {
			exists: false,
			error: `workers/scripts lookup failed: ${errorMessage(err)}`,
		};
	}
	if (!res.ok) {
		const detail = await res.text();
		const trimmed = detail.trim();
		const suffix = trimmed ? `: ${tailLogs(trimmed, 300)}` : '';
		return {
			exists: false,
			error: `workers/scripts lookup failed (${res.status} ${res.statusText})${suffix}`,
		};
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return {
			exists: false,
			error: 'workers/scripts lookup failed: response was not valid JSON',
		};
	}
	return parseWorkersScriptList(body, args.workerName);
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
