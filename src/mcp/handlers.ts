// Handler functions extracted from McpAgent for multi-step workflows.
// Today this file intentionally contains only create_repo because it spans
// D1 writes, Artifacts provisioning, repo seeding, and RepoDO initialization.

import type { RepoRow, RepoConfigRow } from '../db/schema';
import { repoExistsInD1 } from '../db/queries';
import { ulid } from '../util/ids';
import { errorMessage } from '../util/errors';
import { redactCredentials } from '../util/urls';
import {
	deleteRepo,
	provisionRepo,
	gitUrlWithToken,
} from '../services/artifacts';
import { seedRepoInMemory } from '../services/repo-seed';
import type { RepoDO } from '../do/repo';

export interface McpHandlerContext {
	env: Cloudflare.Env;
	db: D1Database;
	userId: string;
	displayName: string;
	getRepoDO: (repoId: string) => DurableObjectStub<RepoDO>;
}

export async function handleCreateRepo(
	ctx: McpHandlerContext,
	name: string,
	workerName: string,
	description?: string,
): Promise<{ repo_id: string; git_url: string; worker_name: string; default_branch: string }> {
	const existing = await repoExistsInD1(ctx.db, ctx.userId, name);
	if (existing) throw new Error(`repo ${name} already exists`);

	const provisioned = await provisionRepo(ctx.env.ARTIFACTS, ctx.userId, name, description);

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
			displayName: ctx.displayName,
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

	// Insert repo into D1
	const now = Date.now();
	await ctx.db.prepare(
		`INSERT INTO repos
			(id, name, owner_id, artifacts_repo_id, artifacts_repo_name, worker_name, git_url, default_branch, created_at, state)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
	).bind(
		repoId, name, ctx.userId, provisioned.artifactsRepoId, provisioned.artifactsRepoName,
		workerName, provisioned.remote, provisioned.defaultBranch, now,
	).run();

	// Initialize the per-repo DO with config
	const repoConfig: RepoConfigRow = {
		repo_id: repoId,
		name,
		artifacts_repo_name: provisioned.artifactsRepoName,
		worker_name: workerName,
		git_url: provisioned.remote,
		default_branch: provisioned.defaultBranch,
	};
	const repoDO = ctx.getRepoDO(repoId);
	await repoDO.initialize(repoConfig);

	return {
		repo_id: repoId,
		git_url: provisioned.remote,
		worker_name: workerName,
		default_branch: provisioned.defaultBranch,
	};
}
