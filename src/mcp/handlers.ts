// Extracted handler bodies for complex MCP tool operations.
// These are standalone functions that receive a context object
// rather than being methods on the agent class.

import type { BuildRow, RepoRow } from '../db/schema';
import type { SqlRunner } from '../db/queries';
import { getBuild, getRepo } from '../db/queries';
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
