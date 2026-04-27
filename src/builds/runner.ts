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
import type { BuildRow, BuildStatus } from '../db/schema';

/** Minimal repo info required by the build runner. */
export interface BuildRepoInfo {
	id: string;
	artifacts_repo_name: string;
	git_url: string;
	worker_name: string;
}

interface RunBuildArgs {
	env: Cloudflare.Env;
	sql: SqlRunner;
	build: BuildRow;
	repo: BuildRepoInfo;
}

const WORKDIR = '/workspace/repo';
const WRANGLER_UPLOAD_TIMEOUT_MS = 900_000;

interface BuildRunContext {
	env: Cloudflare.Env;
	sql: SqlRunner;
	build: BuildRow;
	repo: BuildRepoInfo;
	sb: ReturnType<typeof sandboxFor>;
	logPrefix: string;
	logs: string[];
	recordStep: (step: string, result: ShellResult) => void;
	setStatus: (status: BuildStatus, extra?: Partial<BuildRow>) => void;
	summarizeFailure: (summary: string, result: ShellResult) => string;
}

export async function runBuild(args: RunBuildArgs): Promise<void> {
	const ctx = createBuildRunContext(args);

	try {
		const cloneResult = await runClonePhase(ctx);
		if (!cloneResult.ok) return;

		const detection = await runDetectAndInstallPhase(ctx, cloneResult.commitSha);
		if (!detection) return;

		const built = await runBuildPhase(ctx, detection);
		if (!built) return;

		const uploaded = await runUploadPhase(ctx);
		if (!uploaded) return;

		ctx.setStatus('complete', {
			worker_version_id: uploaded.versionId,
			preview_url: uploaded.previewUrl,
		});
	} catch (err) {
		const debugDetail = err instanceof Error ? err.stack ?? err.message : String(err);
		ctx.logs.push(`[uncaught]\n${debugDetail}\n`);
		console.error(`${ctx.logPrefix} uncaught error\n${debugDetail}`);
		ctx.setStatus('failed', { error: formatUncaughtClientError(err) });
	}
}

function createBuildRunContext({ env, sql, build, repo }: RunBuildArgs): BuildRunContext {
	const sb = sandboxFor(sandboxNamespace(env), sandboxIdForBuild(build.id));
	const logPrefix = `[build:${build.id}]`;
	const logs: string[] = [];

	const isTimeoutLikeFailure = (result: ShellResult): boolean => {
		const detail = `${result.stderr}\n${result.stdout}`;
		return /command timeout|timed out|\/api\/execute 500/i.test(detail);
	};

	const summarizeFailure = (summary: string, result: ShellResult): string => {
		if (isTimeoutLikeFailure(result)) {
			const detail = (result.stderr || result.stdout).trim();
			if (!detail) return `${summary}: command timed out while waiting for sandbox exec`;
			return `${summary}: command timed out while waiting for sandbox exec (${tailLogs(detail, 400)})`;
		}
		const detail = (result.stderr || result.stdout).trim();
		if (!detail) return summary;
		return `${summary}: ${tailLogs(detail, 500)}`;
	};

	const recordStep = (step: string, result: ShellResult): void => {
		logs.push(`$ ${step}\n${result.stdout}${result.stderr ? '\n[stderr]\n' + result.stderr : ''}\nexit=${result.exitCode}\n`);
		const level = result.success ? 'info' : 'warn';
		console[level](`${logPrefix} ${step} -> exit=${result.exitCode}`);
		if (result.stderr.trim()) {
			console.warn(`${logPrefix} ${step} stderr:\n${tailLogs(result.stderr)}`);
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

	return {
		env,
		sql,
		build,
		repo,
		sb,
		logPrefix,
		logs,
		recordStep,
		setStatus,
		summarizeFailure,
	};
}

function failBuild(ctx: BuildRunContext, error: string, extra?: Partial<BuildRow>): false {
	ctx.setStatus('failed', { ...extra, error });
	return false;
}

async function runClonePhase(ctx: BuildRunContext): Promise<{ ok: true; commitSha: string | null } | { ok: false }> {
	ctx.setStatus('cloning');
	const access = await mintAccess(ctx.env.ARTIFACTS, ctx.repo.artifacts_repo_name, 'write', 900);
	const authedUrl = gitUrlWithToken(ctx.repo.git_url, access.token);
	const clearDir = await sh(ctx.sb, `rm -rf ${WORKDIR}`);
	ctx.recordStep(`rm -rf ${WORKDIR}`, clearDir);
	const nativeClone = await gitCheckout(ctx.sb, authedUrl, { targetDir: WORKDIR });
	ctx.recordStep(`sandbox gitCheckout <remote> ${WORKDIR}`, nativeClone);
	if (!nativeClone.success) {
		return { ok: failBuild(ctx, ctx.summarizeFailure('clone failed via sandbox gitCheckout', nativeClone)) };
	}

	const checkout = await sh(ctx.sb, `git checkout ${ctx.build.ref}`, { cwd: WORKDIR });
	ctx.recordStep(`git checkout ${ctx.build.ref}`, checkout);
	if (!checkout.success) {
		return { ok: failBuild(ctx, ctx.summarizeFailure('checkout failed', checkout)) };
	}

	const rev = await sh(ctx.sb, 'git rev-parse HEAD', { cwd: WORKDIR });
	ctx.recordStep('git rev-parse HEAD', rev);
	return { ok: true, commitSha: rev.stdout.trim() || null };
}

async function runDetectAndInstallPhase(ctx: BuildRunContext, commitSha: string | null): Promise<Detection | null> {
	const detection = await detectProject(ctx.sb);
	ctx.logs.push(`[detected: ${detection.kind}]\n`);
	console.info(`${ctx.logPrefix} detected project`, detection);

	if (detection.kind === 'unknown') {
		failBuild(ctx, 'no wrangler.jsonc/toml, package.json, or /bin/build found', { commit_sha: commitSha });
		return null;
	}

	ctx.setStatus('installing', { commit_sha: commitSha });
	if (!detection.hasPackageJson) return detection;

	const install = await sh(ctx.sb, 'npm install --no-audit --no-fund', { cwd: WORKDIR, timeoutMs: 300_000 });
	ctx.recordStep('npm install', install);
	if (!install.success) {
		failBuild(ctx, ctx.summarizeFailure('npm install failed', install));
		return null;
	}

	return detection;
}

async function runBuildPhase(ctx: BuildRunContext, detection: Detection): Promise<boolean> {
	ctx.setStatus('bundling');
	if (detection.kind === 'custom') {
		const buildResult = await sh(ctx.sb, '/bin/build', { cwd: WORKDIR, timeoutMs: 300_000 });
		ctx.recordStep('/bin/build', buildResult);
		if (!buildResult.success) {
			return failBuild(ctx, ctx.summarizeFailure('/bin/build failed', buildResult));
		}
		return true;
	}

	if (!detection.hasPackageJson || !detection.hasBuildScript) return true;

	const buildResult = await sh(ctx.sb, 'npm run build', { cwd: WORKDIR, timeoutMs: 300_000 });
	ctx.recordStep('npm run build', buildResult);
	if (!buildResult.success) {
		return failBuild(ctx, ctx.summarizeFailure('npm run build failed', buildResult));
	}
	return true;
}

async function runUploadPhase(
	ctx: BuildRunContext,
): Promise<{ versionId: string; previewUrl: string | null } | null> {
	// Upload preview version via wrangler with the API token passed into sandbox env.
	ctx.setStatus('uploading');
	const apiToken = ctx.env.API_TOKEN;
	if (!apiToken) {
		failBuild(ctx, 'missing API_TOKEN secret');
		return null;
	}

	const workerCheck = await ensureWorkerScriptExists({
		apiToken,
		workerName: ctx.repo.worker_name,
	});
	if (workerCheck.error) {
		failBuild(ctx, workerCheck.error);
		return null;
	}

	if (!workerCheck.exists) {
		ctx.logs.push(`[bootstrap] worker "${ctx.repo.worker_name}" not found remotely; deploying once before preview upload\n`);
		const deploy = await wrangler(
			ctx.sb,
			'deploy',
			WORKDIR,
			apiToken,
			WRANGLER_UPLOAD_TIMEOUT_MS,
		);
		ctx.recordStep('wrangler deploy (bootstrap missing worker)', deploy);
		if (!deploy.success) {
			failBuild(ctx, ctx.summarizeFailure('wrangler deploy failed while bootstrapping worker', deploy));
			return null;
		}
	}

	const upload = await wrangler(
		ctx.sb,
		`versions upload --message "gh-for-agents build ${ctx.build.id}"`,
		WORKDIR,
		apiToken,
		WRANGLER_UPLOAD_TIMEOUT_MS,
	);
	ctx.recordStep('wrangler versions upload', upload);
	if (!upload.success) {
		failBuild(ctx, ctx.summarizeFailure('wrangler versions upload failed', upload));
		return null;
	}

	const parsed = parseVersionsUpload(upload.stdout);
	if (!parsed) {
		failBuild(ctx, 'could not parse wrangler output');
		return null;
	}

	return parsed;
}

function formatUncaughtClientError(err: unknown): string {
	const reason = errorMessage(err);
	return reason ? `uncaught error: ${tailLogs(reason, 200)}` : 'uncaught error';
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
