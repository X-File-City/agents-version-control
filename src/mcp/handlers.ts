// Extracted handler bodies for complex MCP tool operations.
// These are standalone functions that receive a context object
// rather than being methods on the agent class.

import type { BuildRow, PullRequestRow, RepoRow } from '../db/schema';
import type { SqlRunner } from '../db/queries';
import { getBuild, getPullRequest, getRepo } from '../db/queries';
import { ulid } from '../util/ids';
import { errorMessage } from '../util/errors';
import { redactCredentials } from '../util/urls';
import {
	deleteRepo,
	mintAccess,
	provisionRepo,
	gitUrlWithToken,
} from '../services/artifacts';
import { sandboxFor, sandboxIdForBuild, sandboxNamespace, sh } from '../services/sandbox';
import { wrangler } from '../services/wrangler-run';
import { seedRepoInMemory } from '../services/repo-seed';
import { generateDiff, performMerge } from '../services/git-ops';
import type { AgentProps } from './agent';

export interface HandlerContext {
	env: Cloudflare.Env;
	sql: SqlRunner;
	props: AgentProps | undefined;
	audit: (action: string, targetType: string, targetId: string, metadata: unknown) => void;
}

export async function handleCreateRepo(
	ctx: HandlerContext,
	name: string,
	workerName: string,
	description?: string,
): Promise<{ repo_id: string; git_url: string; worker_name: string; default_branch: string }> {
	const agentId = ctx.props?.userId ?? 'anonymous';
	const displayName = ctx.props?.displayName ?? 'agent';

	const existing = ctx.sql<RepoRow>`SELECT id FROM repos WHERE name = ${name}`;
	if (existing.length > 0) throw new Error(`repo ${name} already exists`);

	const provisioned = await provisionRepo(ctx.env.ARTIFACTS, agentId, name, description);

	const repoId = ulid();
	const seedGitUrl = gitUrlWithToken(provisioned.remote, provisioned.writeToken);
	console.info('[create_repo] provisioned artifacts repo', {
		repoId,
		repoName: name,
		workerName,
		remote: redactCredentials(seedGitUrl),
	});
	try {
		await seedRepoInMemory({
			gitUrl: seedGitUrl,
			workerName,
			displayName,
		});
	} catch (err) {
		const reason = errorMessage(err);
		console.error('[create_repo] seed failed', {
			repoId,
			repoName: name,
			workerName,
			remote: redactCredentials(seedGitUrl),
			error: reason,
		});
		try {
			await deleteRepo(ctx.env.ARTIFACTS, provisioned.artifactsRepoName);
			console.warn('[create_repo] cleaned up provisioned repo after seed failure', {
				repoId,
				artifactsRepoName: provisioned.artifactsRepoName,
			});
		} catch (cleanupErr) {
			console.error('[create_repo] cleanup failed after seed failure', {
				repoId,
				artifactsRepoName: provisioned.artifactsRepoName,
				error: errorMessage(cleanupErr),
			});
		}
		throw new Error(`seed failed: ${reason}`);
	}

	const now = Date.now();
	ctx.sql`
		INSERT INTO repos
			(id, name, artifacts_repo_id, artifacts_repo_name, worker_name, git_url, default_branch, created_at, state)
		VALUES
			(${repoId}, ${name}, ${provisioned.artifactsRepoId}, ${provisioned.artifactsRepoName},
			 ${workerName}, ${provisioned.remote}, ${provisioned.defaultBranch}, ${now}, 'ready')
	`;
	ctx.audit('create_repo', 'repo', repoId, { name, worker_name: workerName });

	return {
		repo_id: repoId,
		git_url: provisioned.remote,
		worker_name: workerName,
		default_branch: provisioned.defaultBranch,
	};
}

export async function handlePromote(
	ctx: HandlerContext,
	buildId: string,
): Promise<{ deployment_id: string; status: string; worker_version_id: string }> {
	const build = getBuild(ctx.sql, buildId);
	if (build.status !== 'complete' || !build.worker_version_id) {
		throw new Error(`build ${buildId} is not complete (status=${build.status})`);
	}
	const deploymentId = ulid();
	const now = Date.now();
	ctx.sql`
		INSERT INTO deployments (id, repo_id, worker_version_id, environment, status, created_at)
		VALUES (${deploymentId}, ${build.repo_id}, ${build.worker_version_id}, 'production', 'pending', ${now})
	`;

	return { deployment_id: deploymentId, status: 'pending', worker_version_id: build.worker_version_id };
}

export async function runPromote(
	ctx: HandlerContext,
	buildId: string,
	deploymentId: string,
): Promise<void> {
	const deployments = ctx.sql<{ status: string }>`
		SELECT * FROM deployments WHERE id = ${deploymentId}
	`;
	if (deployments.length === 0) return;
	if (deployments[0].status !== 'pending') return;

	let build: BuildRow;
	try {
		build = getBuild(ctx.sql, buildId);
	} catch {
		ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
		return;
	}
	if (build.status !== 'complete' || !build.worker_version_id) {
		ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
		return;
	}

	try {
		const repo = getRepo(ctx.sql, build.repo_id);
		const sb = sandboxFor(sandboxNamespace(ctx.env), sandboxIdForBuild(buildId));
		const access = await mintAccess(ctx.env.ARTIFACTS, repo.artifacts_repo_name, 'read', 600);
		const authedUrl = gitUrlWithToken(repo.git_url, access.token);
		const dir = '/workspace/deploy';
		const checkout = `rm -rf ${dir} && git clone --quiet ${authedUrl} ${dir} && cd ${dir} && git checkout ${build.commit_sha ?? 'HEAD'}`;
		const checkedOut = await sh(sb, checkout, { timeoutMs: 120_000 });
		if (!checkedOut.success) {
			ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			return;
		}

		const install = await sh(sb, 'npm install --no-audit --no-fund', { cwd: dir, timeoutMs: 300_000 });
		if (!install.success) {
			ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			return;
		}

		const apiToken = ctx.env.API_TOKEN;
		if (!apiToken) {
			ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			return;
		}
		const deploy = await wrangler(
			sb,
			`versions deploy ${build.worker_version_id}@100% --message "promote build ${buildId}" --yes`,
			dir,
			apiToken,
		);
		if (!deploy.success) {
			ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			return;
		}

		ctx.sql`UPDATE deployments SET status = 'active' WHERE id = ${deploymentId}`;
		ctx.sql`UPDATE deployments SET status = 'superseded' WHERE repo_id = ${repo.id} AND id != ${deploymentId} AND status = 'active'`;
		ctx.audit('promote_preview', 'deployment', deploymentId, { build_id: buildId });
	} catch {
		ctx.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
	}
}

// ── Pull Request handlers ──────────────────────────────────────────

export async function handleCreatePullRequest(
	ctx: HandlerContext,
	repoId: string,
	headBranch: string,
	baseBranch: string | undefined,
	title: string,
	description?: string,
): Promise<PullRequestRow> {
	const repo = getRepo(ctx.sql, repoId);
	const base = baseBranch ?? repo.default_branch;

	if (headBranch === base) {
		throw new Error('head_branch and base_branch must be different');
	}

	const existing = ctx.sql<PullRequestRow>`
		SELECT id FROM pull_requests
		WHERE repo_id = ${repoId}
			AND head_branch = ${headBranch}
			AND base_branch = ${base}
			AND status IN ('open', 'approved')
	`;
	if (existing.length > 0) {
		throw new Error(`An open pull request already exists for ${headBranch} → ${base}`);
	}

	const requesterId = ctx.props?.userId ?? 'anonymous';
	const requesterName = ctx.props?.displayName ?? 'agent';
	const prId = ulid();
	const now = Date.now();

	ctx.sql`
		INSERT INTO pull_requests
			(id, repo_id, head_branch, base_branch, title, description, status,
			 requested_by_id, requested_by_name, created_at, updated_at)
		VALUES
			(${prId}, ${repoId}, ${headBranch}, ${base}, ${title}, ${description ?? null}, 'open',
			 ${requesterId}, ${requesterName}, ${now}, ${now})
	`;

	ctx.audit('create_pull_request', 'pull_request', prId, {
		repo_id: repoId,
		head_branch: headBranch,
		base_branch: base,
		title,
	});

	return getPullRequest(ctx.sql, prId);
}

export async function handleGetPullRequest(
	ctx: HandlerContext,
	prId: string,
): Promise<{ pull_request: PullRequestRow; diff: string; stats: { files_changed: number; additions: number; deletions: number } }> {
	const pr = getPullRequest(ctx.sql, prId);
	const repo = getRepo(ctx.sql, pr.repo_id);

	const access = await mintAccess(ctx.env.ARTIFACTS, repo.artifacts_repo_name, 'read', 300);
	const authedUrl = gitUrlWithToken(repo.git_url, access.token);

	const { diff, stats } = await generateDiff(authedUrl, pr.base_branch, pr.head_branch);

	return { pull_request: pr, diff, stats };
}

export async function handleApprovePullRequest(
	ctx: HandlerContext,
	prId: string,
): Promise<PullRequestRow> {
	const pr = getPullRequest(ctx.sql, prId);

	if (pr.status !== 'open') {
		throw new Error(`Cannot approve pull request with status '${pr.status}' (must be 'open')`);
	}

	const approverId = ctx.props?.userId ?? 'anonymous';
	const approverName = ctx.props?.displayName ?? 'agent';
	const now = Date.now();

	ctx.sql`
		UPDATE pull_requests SET
			status = 'approved',
			approved_by_id = ${approverId},
			approved_by_name = ${approverName},
			approved_at = ${now},
			updated_at = ${now}
		WHERE id = ${prId}
	`;

	ctx.audit('approve_pull_request', 'pull_request', prId, {
		approved_by: approverName,
	});

	return getPullRequest(ctx.sql, prId);
}

export interface MergeResult {
	pull_request: PullRequestRow;
	build_id?: string;
}

export async function handleMergePullRequest(
	ctx: HandlerContext,
	prId: string,
	deploy: boolean,
): Promise<MergeResult> {
	const pr = getPullRequest(ctx.sql, prId);

	if (pr.status !== 'approved') {
		throw new Error(`Cannot merge pull request with status '${pr.status}' (must be 'approved')`);
	}

	const callerId = ctx.props?.userId ?? 'anonymous';
	if (callerId !== pr.requested_by_id) {
		throw new Error('Only the pull request requester can merge');
	}

	const repo = getRepo(ctx.sql, pr.repo_id);
	const access = await mintAccess(ctx.env.ARTIFACTS, repo.artifacts_repo_name, 'write', 600);
	const authedUrl = gitUrlWithToken(repo.git_url, access.token);

	const { commitSha } = await performMerge(authedUrl, pr.base_branch, pr.head_branch, pr.requested_by_name);

	const now = Date.now();
	ctx.sql`
		UPDATE pull_requests SET
			status = 'merged',
			merged_at = ${now},
			merged_commit_sha = ${commitSha},
			updated_at = ${now}
		WHERE id = ${prId}
	`;

	ctx.audit('merge_pull_request', 'pull_request', prId, {
		commit_sha: commitSha,
		deploy,
	});

	const merged = getPullRequest(ctx.sql, prId);

	if (!deploy) {
		return { pull_request: merged };
	}

	// Create a build targeting the base branch (which now contains the merge)
	const buildId = ulid();
	ctx.sql`
		INSERT INTO builds (id, repo_id, ref, status, created_at, updated_at)
		VALUES (${buildId}, ${repo.id}, ${pr.base_branch}, 'queued', ${now}, ${now})
	`;

	return { pull_request: merged, build_id: buildId };
}
