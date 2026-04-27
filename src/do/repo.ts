// Per-repo Durable Object. Stores builds, deployments, PRs, and audit log in
// its embedded SQLite. One instance per repo, keyed by repo ID.

import { Agent } from 'agents';

import { REPO_DO_SCHEMA } from '../db/schema';
import type { BuildRow, RepoConfigRow, DeploymentRow, PullRequestRow } from '../db/schema';
import { findBuild, getBuild, getDeployment, getPullRequest, listPullRequests } from '../db/queries';
import type { SqlRunner } from '../db/queries';
import { ulid } from '../util/ids';
import { errorMessage } from '../util/errors';
import { mintAccess, gitUrlWithToken } from '../services/artifacts';
import { runBuild } from '../builds/runner';
import type { BuildRepoInfo } from '../builds/runner';
import { generateDiff, performMerge } from '../services/git-ops';
import { sandboxFor, sandboxIdForBuild, sandboxNamespace, sh } from '../services/sandbox';
import { wrangler } from '../services/wrangler-run';

const DEPLOY_WORKDIR = '/workspace/deploy';

export class RepoDO extends Agent<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(REPO_DO_SCHEMA);
		});
	}

	private get sqlRunner(): SqlRunner {
		return (strings, ...values) => this.sql(strings, ...values);
	}

	private getConfig(): RepoConfigRow {
		const rows = this.sql<RepoConfigRow>`SELECT * FROM repo_config LIMIT 1`;
		if (rows.length === 0) throw new Error('RepoDO not initialized — call initialize() first');
		return rows[0];
	}

	private toBuildRepoInfo(config: RepoConfigRow): BuildRepoInfo {
		return {
			id: config.repo_id,
			artifacts_repo_name: config.artifacts_repo_name,
			git_url: config.git_url,
			worker_name: config.worker_name,
		};
	}

	private audit(action: string, targetType: string, targetId: string, metadata: unknown): void {
		this.sql`
			INSERT INTO audit_log (action, target_type, target_id, metadata, ts)
			VALUES (${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}, ${Date.now()})
		`;
	}

	// ── RPC methods (called by AgentsMcpServer via DO stub) ─────────

	async initialize(config: RepoConfigRow): Promise<void> {
		this.sql`
			INSERT INTO repo_config (repo_id, name, artifacts_repo_name, worker_name, git_url, default_branch)
			VALUES (${config.repo_id}, ${config.name}, ${config.artifacts_repo_name},
					${config.worker_name}, ${config.git_url}, ${config.default_branch})
			ON CONFLICT(repo_id) DO UPDATE SET
				name = excluded.name,
				artifacts_repo_name = excluded.artifacts_repo_name,
				worker_name = excluded.worker_name,
				git_url = excluded.git_url,
				default_branch = excluded.default_branch
		`;
	}

	async createBuild(ref: string): Promise<{ build_id: string; status: string }> {
		const config = this.getConfig();
		const buildId = ulid();
		const now = Date.now();
		this.sql`
			INSERT INTO builds (id, repo_id, ref, status, created_at, updated_at)
			VALUES (${buildId}, ${config.repo_id}, ${ref}, 'queued', ${now}, ${now})
		`;
		await this.schedule(1, 'runPreviewBuild', { buildId }, { retry: { maxAttempts: 1 } });
		return { build_id: buildId, status: 'queued' };
	}

	async getBuildStatus(buildId: string): Promise<BuildRow> {
		return getBuild(this.sqlRunner, buildId);
	}

	async promote(buildId: string, callerName: string): Promise<{ deployment_id: string; status: string; worker_version_id: string }> {
		const build = getBuild(this.sqlRunner, buildId);
		if (build.status !== 'complete' || !build.worker_version_id) {
			throw new Error(`build ${buildId} is not complete (status=${build.status})`);
		}
		const deploymentId = ulid();
		const now = Date.now();
		this.sql`
			INSERT INTO deployments (id, repo_id, worker_version_id, environment, status, created_at)
			VALUES (${deploymentId}, ${build.repo_id}, ${build.worker_version_id}, 'production', 'pending', ${now})
		`;
		this.audit('promote_preview', 'deployment', deploymentId, { build_id: buildId, caller: callerName });
		await this.schedule(1, 'runPromotePreview', { buildId, deploymentId }, { retry: { maxAttempts: 1 } });
		return { deployment_id: deploymentId, status: 'pending', worker_version_id: build.worker_version_id };
	}

	async getDeploymentStatus(deploymentId: string): Promise<DeploymentRow> {
		return getDeployment(this.sqlRunner, deploymentId);
	}

	async createPullRequest(args: {
		headBranch: string;
		baseBranch?: string;
		title: string;
		description?: string;
		requesterId: string;
		requesterName: string;
	}): Promise<PullRequestRow> {
		const config = this.getConfig();
		const base = args.baseBranch ?? config.default_branch;

		if (args.headBranch === base) {
			throw new Error('head_branch and base_branch must be different');
		}

		const existing = this.sql<PullRequestRow>`
			SELECT id FROM pull_requests
			WHERE repo_id = ${config.repo_id}
				AND head_branch = ${args.headBranch}
				AND base_branch = ${base}
				AND status IN ('open', 'approved')
		`;
		if (existing.length > 0) {
			throw new Error(`An open pull request already exists for ${args.headBranch} → ${base}`);
		}

		const prId = ulid();
		const now = Date.now();
		this.sql`
			INSERT INTO pull_requests
				(id, repo_id, head_branch, base_branch, title, description, status,
				 requested_by_id, requested_by_name, created_at, updated_at)
			VALUES
				(${prId}, ${config.repo_id}, ${args.headBranch}, ${base}, ${args.title},
				 ${args.description ?? null}, 'open',
				 ${args.requesterId}, ${args.requesterName}, ${now}, ${now})
		`;

		this.audit('create_pull_request', 'pull_request', prId, {
			repo_id: config.repo_id,
			head_branch: args.headBranch,
			base_branch: base,
			title: args.title,
		});

		return getPullRequest(this.sqlRunner, prId);
	}

	async listRepoPullRequests(): Promise<PullRequestRow[]> {
		const config = this.getConfig();
		return listPullRequests(this.sqlRunner, config.repo_id);
	}

	async getRepoPullRequest(prId: string): Promise<{
		pull_request: PullRequestRow;
		diff: string;
		stats: { files_changed: number; additions: number; deletions: number };
	}> {
		const pr = getPullRequest(this.sqlRunner, prId);
		const config = this.getConfig();

		const access = await mintAccess(this.env.ARTIFACTS, config.artifacts_repo_name, 'read', 300);
		const authedUrl = gitUrlWithToken(config.git_url, access.token);
		const { diff, stats } = await generateDiff(authedUrl, pr.base_branch, pr.head_branch);

		return { pull_request: pr, diff, stats };
	}

	async approvePullRequest(prId: string, approverId: string, approverName: string): Promise<PullRequestRow> {
		const pr = getPullRequest(this.sqlRunner, prId);

		if (pr.status !== 'open') {
			throw new Error(`Cannot approve pull request with status '${pr.status}' (must be 'open')`);
		}

		const now = Date.now();
		this.sql`
			UPDATE pull_requests SET
				status = 'approved',
				approved_by_id = ${approverId},
				approved_by_name = ${approverName},
				approved_at = ${now},
				updated_at = ${now}
			WHERE id = ${prId}
		`;

		this.audit('approve_pull_request', 'pull_request', prId, { approved_by: approverName });
		return getPullRequest(this.sqlRunner, prId);
	}

	async mergePullRequest(
		prId: string,
		callerId: string,
		deploy: boolean,
	): Promise<{ pull_request: PullRequestRow; build_id?: string }> {
		const pr = getPullRequest(this.sqlRunner, prId);

		if (pr.status !== 'approved') {
			throw new Error(`Cannot merge pull request with status '${pr.status}' (must be 'approved')`);
		}
		if (callerId !== pr.requested_by_id) {
			throw new Error('Only the pull request requester can merge');
		}

		const config = this.getConfig();
		const access = await mintAccess(this.env.ARTIFACTS, config.artifacts_repo_name, 'write', 600);
		const authedUrl = gitUrlWithToken(config.git_url, access.token);
		const { commitSha } = await performMerge(authedUrl, pr.base_branch, pr.head_branch, pr.requested_by_name);

		const now = Date.now();
		this.sql`
			UPDATE pull_requests SET
				status = 'merged',
				merged_at = ${now},
				merged_commit_sha = ${commitSha},
				updated_at = ${now}
			WHERE id = ${prId}
		`;

		this.audit('merge_pull_request', 'pull_request', prId, { commit_sha: commitSha, deploy });
		const merged = getPullRequest(this.sqlRunner, prId);

		if (!deploy) {
			return { pull_request: merged };
		}

		const buildId = ulid();
		this.sql`
			INSERT INTO builds (id, repo_id, ref, status, created_at, updated_at)
			VALUES (${buildId}, ${config.repo_id}, ${pr.base_branch}, 'queued', ${now}, ${now})
		`;
		await this.schedule(1, 'runMergeDeploy', { buildId }, { retry: { maxAttempts: 1 } });

		return { pull_request: merged, build_id: buildId };
	}

	// ── Scheduled entry points ──────────────────────────────────────

	async runPreviewBuild(payload: { buildId: string }): Promise<void> {
		const build = findBuild(this.sqlRunner, payload.buildId);
		if (!build) return;

		const config = this.getConfig();

		await this.runFiber('preview-build', async () => {
			await runBuild({
				env: this.env,
				sql: this.sqlRunner,
				build,
				repo: this.toBuildRepoInfo(config),
			});
		});
	}

	async runPromotePreview(payload: { buildId: string; deploymentId: string }): Promise<void> {
		await this.runFiber('promote-preview', async () => {
			await this.executePromote(payload.buildId, payload.deploymentId);
		});
	}

	async runMergeDeploy(payload: { buildId: string }): Promise<void> {
		const build = findBuild(this.sqlRunner, payload.buildId);
		if (!build) return;

		const config = this.getConfig();

		await this.runFiber('merge-deploy', async () => {
			await runBuild({
				env: this.env,
				sql: this.sqlRunner,
				build,
				repo: this.toBuildRepoInfo(config),
			});

			// If build succeeded, auto-promote
			const built = getBuild(this.sqlRunner, payload.buildId);
			if (built.status !== 'complete' || !built.worker_version_id) return;

			const deploymentId = ulid();
			const now = Date.now();
			this.sql`
				INSERT INTO deployments (id, repo_id, worker_version_id, environment, status, created_at)
				VALUES (${deploymentId}, ${config.repo_id}, ${built.worker_version_id}, 'production', 'pending', ${now})
			`;

			await this.executePromote(payload.buildId, deploymentId);
		});
	}

	// ── Private helpers ─────────────────────────────────────────────

	private async executePromote(buildId: string, deploymentId: string): Promise<void> {
		const logPrefix = `[deploy:${deploymentId}]`;
		if (!this.getDeploymentForPromotion(deploymentId)) {
			console.info(`${logPrefix} skipping promote; deployment not pending`);
			return;
		}

		const build = findBuild(this.sqlRunner, buildId);
		if (!build) {
			this.markDeploymentFailed(deploymentId, logPrefix, `build ${buildId} not found`);
			return;
		}
		if (build.status !== 'complete' || !build.worker_version_id) {
			this.markDeploymentFailed(
				deploymentId,
				logPrefix,
				`build ${buildId} not promotable (status=${build.status}, hasVersion=${Boolean(build.worker_version_id)})`,
			);
			return;
		}

		try {
			const config = this.getConfig();
			const prepared = await this.prepareDeploymentWorkspace(config, build, logPrefix);
			if (!prepared) {
				this.markDeploymentFailed(deploymentId, logPrefix, 'checkout or install failed');
				return;
			}

			const promoted = await this.deployBuildVersion(build, prepared.sb, logPrefix);
			if (!promoted) {
				this.markDeploymentFailed(deploymentId, logPrefix, 'wrangler version deploy failed');
				return;
			}

			this.markDeploymentActive(config.repo_id, deploymentId, buildId, logPrefix);
		} catch (err) {
			this.markDeploymentFailed(deploymentId, logPrefix, `uncaught promote error: ${errorMessage(err)}`);
		}
	}

	private getDeploymentForPromotion(deploymentId: string): boolean {
		const deployments = this.sql<{ status: string }>`SELECT status FROM deployments WHERE id = ${deploymentId}`;
		if (deployments.length === 0) return false;
		return deployments[0].status === 'pending';
	}

	private markDeploymentFailed(deploymentId: string, logPrefix: string, reason: string): void {
		console.warn(`${logPrefix} failed: ${reason}`);
		this.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
	}

	private markDeploymentActive(repoId: string, deploymentId: string, buildId: string, logPrefix: string): void {
		console.info(`${logPrefix} promoted build ${buildId} to active`);
		this.sql`UPDATE deployments SET status = 'active' WHERE id = ${deploymentId}`;
		this.sql`UPDATE deployments SET status = 'superseded' WHERE repo_id = ${repoId} AND id != ${deploymentId} AND status = 'active'`;
		this.audit('promote_preview', 'deployment', deploymentId, { build_id: buildId });
	}

	private async prepareDeploymentWorkspace(
		config: RepoConfigRow,
		build: BuildRow,
		logPrefix: string,
	): Promise<{ sb: ReturnType<typeof sandboxFor> } | null> {
		const sb = sandboxFor(sandboxNamespace(this.env), sandboxIdForBuild(build.id));
		const access = await mintAccess(this.env.ARTIFACTS, config.artifacts_repo_name, 'read', 600);
		const authedUrl = gitUrlWithToken(config.git_url, access.token);
		const checkout = `rm -rf ${DEPLOY_WORKDIR} && git clone --quiet ${authedUrl} ${DEPLOY_WORKDIR} && cd ${DEPLOY_WORKDIR} && git checkout ${build.commit_sha ?? 'HEAD'}`;
		const checkedOut = await sh(sb, checkout, { timeoutMs: 120_000 });
		if (!checkedOut.success) {
			console.warn(`${logPrefix} checkout failed (exit=${checkedOut.exitCode})`);
			return null;
		}

		const install = await sh(sb, 'npm install --no-audit --no-fund', { cwd: DEPLOY_WORKDIR, timeoutMs: 300_000 });
		if (!install.success) {
			console.warn(`${logPrefix} npm install failed (exit=${install.exitCode})`);
			return null;
		}

		return { sb };
	}

	private async deployBuildVersion(
		build: BuildRow,
		sb: ReturnType<typeof sandboxFor>,
		logPrefix: string,
	): Promise<boolean> {
		const apiToken = this.env.API_TOKEN;
		if (!apiToken) {
			console.warn(`${logPrefix} missing API_TOKEN`);
			return false;
		}

		const deploy = await wrangler(
			sb,
			`versions deploy ${build.worker_version_id}@100% --message "promote build ${build.id}" --yes`,
			DEPLOY_WORKDIR,
			apiToken,
		);
		if (!deploy.success) {
			console.warn(`${logPrefix} wrangler deploy failed (exit=${deploy.exitCode})`);
			return false;
		}
		return true;
	}
}
