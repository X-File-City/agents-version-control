import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { SCHEMA } from '../db/schema';
import type { BuildRow, DeploymentRow, PullRequestRow, RepoRow } from '../db/schema';
import { getRepo, getBuild, getDeployment, getPullRequest, listPullRequests } from '../db/queries';
import type { SqlRunner } from '../db/queries';
import { ulid } from '../util/ids';
import { deleteRepo, mintAccess, gitUrlWithToken } from '../services/artifacts';
import { runBuild } from '../builds/runner';
import {
	handleCreateRepo,
	handlePromote,
	handleCreatePullRequest,
	handleGetPullRequest,
	handleApprovePullRequest,
	handleMergePullRequest,
	runPromote,
	type HandlerContext,
} from './handlers';

export interface AgentProps extends Record<string, unknown> {
	userId: string;       // OAuth subject — also the DO id
	displayName: string;
}

const repoNameSchema = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'letters, digits, ., _, - only (must not start with separator)');

// workerName determines the deployed Worker's subdomain on *.workers.dev.
// Cloudflare allows lowercase + digits + hyphens.
const workerNameSchema = z
	.string()
	.min(3)
	.max(58)
	.regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits, hyphens, must start with letter');

// State type unused — this agent persists via SQL only.
export class AgentsMcpServer extends McpAgent<Cloudflare.Env, unknown, AgentProps> {
	server = new McpServer({
		name: 'github-for-agents',
		version: '0.1.0',
	});

	async init(): Promise<void> {
		// Idempotent schema bootstrap. Goes through the raw DO SQL API because
		// `this.sql` turns every `${}` into a bound parameter, whereas DDL is
		// purely a static string with multiple statements.
		this.ctx.storage.sql.exec(SCHEMA);

		const subject = this.props?.userId ?? 'unknown';
		const displayName = this.props?.displayName ?? 'agent';
		const now = Date.now();
		this.sql`
			INSERT INTO agent_self (id, name, created_at)
			VALUES (${subject}, ${displayName}, ${now})
			ON CONFLICT(id) DO UPDATE SET name = excluded.name
		`;

		this.registerTools();
	}

	private get handlerCtx(): HandlerContext {
		return {
			env: this.env,
			sql: (strings, ...values) => this.sql(strings, ...values),
			props: this.props,
			audit: (action, targetType, targetId, metadata) => this.audit(action, targetType, targetId, metadata),
		};
	}

	private registerTools(): void {
		const { server } = this;

		server.tool(
			'create_repo',
			'Create a new Artifacts repo for this agent. Writes an initial wrangler.jsonc + src/index.ts + package.json as the first commit so it is deploy-ready.',
			{
				name: repoNameSchema,
				worker_name: workerNameSchema,
				description: z.string().max(200).optional(),
			},
			async ({ name, worker_name, description }) => {
				const result = await handleCreateRepo(this.handlerCtx, name, worker_name, description);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);

		server.tool(
			'list_repos',
			'List all repos owned by this agent.',
			{},
			async () => {
				const rows = this.sql<RepoRow>`SELECT * FROM repos WHERE state != 'archived' ORDER BY created_at DESC`;
				return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
			},
		);

		server.tool(
			'get_repo_access',
			'Mint short-lived Git credentials for one of this agent\'s repos. Use the returned git_url directly with `git clone`.',
			{
				repo_id: z.string(),
				scope: z.enum(['read', 'write']).default('write'),
				ttl_seconds: z.number().int().min(60).max(86_400).default(3600),
			},
			async ({ repo_id, scope, ttl_seconds }) => {
				const repo = getRepo(this.sqlRunner, repo_id);
				const access = await mintAccess(this.env.ARTIFACTS, repo.artifacts_repo_name, scope, ttl_seconds);
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							git_url: gitUrlWithToken(repo.git_url, access.token),
							remote: repo.git_url,
							username: 'x-access-token',
							token: access.token,
							expires_at: access.expiresAt,
							scope,
						}, null, 2),
					}],
				};
			},
		);

		server.tool(
			'delete_repo',
			'Archive and delete a repo.',
			{ repo_id: z.string() },
			async ({ repo_id }) => {
				const repo = getRepo(this.sqlRunner, repo_id);
				const ok = await deleteRepo(this.env.ARTIFACTS, repo.artifacts_repo_name);
				this.sql`UPDATE repos SET state = 'archived' WHERE id = ${repo_id}`;
				return { content: [{ type: 'text', text: JSON.stringify({ ok }) }] };
			},
		);

		server.tool(
			'create_preview',
			'Start a preview build for a repo ref (branch/tag/sha). Returns a build_id; poll get_preview_status until status=complete.',
			{
				repo_id: z.string(),
				ref: z.string().default('main'),
			},
			async ({ repo_id, ref }) => {
				const repo = getRepo(this.sqlRunner, repo_id);
				const buildId = ulid();
				const now = Date.now();
				this.sql`
					INSERT INTO builds (id, repo_id, ref, status, created_at, updated_at)
					VALUES (${buildId}, ${repo_id}, ${ref}, 'queued', ${now}, ${now})
				`;
				await this.schedule(1, 'runPreviewBuild', { buildId, repoId: repo.id });
				return { content: [{ type: 'text', text: JSON.stringify({ build_id: buildId, status: 'queued' }) }] };
			},
		);

		server.tool(
			'get_preview_status',
			'Get the current status of a build, including logs tail and preview_url when ready.',
			{ build_id: z.string() },
			async ({ build_id }) => {
				const build = getBuild(this.sqlRunner, build_id);
				return { content: [{ type: 'text', text: JSON.stringify(build, null, 2) }] };
			},
		);

		server.tool(
			'promote_preview',
			'Promote a completed build to production by deploying its Worker version at 100% traffic.',
			{ build_id: z.string() },
			async ({ build_id }) => {
				const result = await handlePromote(this.handlerCtx, build_id);
				await this.schedule(1, 'runPromotePreview', {
					buildId: build_id,
					deploymentId: result.deployment_id,
				});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);

		server.tool(
			'get_deploy_status',
			'Look up a deployment record.',
			{ deployment_id: z.string() },
			async ({ deployment_id }) => {
				const deployment = getDeployment(this.sqlRunner, deployment_id);
				return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
			},
		);

		// ── Pull Request tools ──────────────────────────────────────────

		server.tool(
			'create_pull_request',
			'Create a pull request to merge changes from head_branch into base_branch.',
			{
				repo_id: z.string(),
				head_branch: z.string(),
				base_branch: z.string().optional(),
				title: z.string().min(1).max(200),
				description: z.string().max(2000).optional(),
			},
			async ({ repo_id, head_branch, base_branch, title, description }) => {
				const result = await handleCreatePullRequest(this.handlerCtx, repo_id, head_branch, base_branch, title, description);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);

		server.tool(
			'list_pull_requests',
			'List pull requests for a repo, newest first (max 10).',
			{ repo_id: z.string() },
			async ({ repo_id }) => {
				getRepo(this.sqlRunner, repo_id);
				const rows = listPullRequests(this.sqlRunner, repo_id);
				return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
			},
		);

		server.tool(
			'get_pull_request',
			'Get a pull request with a unified diff between head and base branches.',
			{ pull_request_id: z.string() },
			async ({ pull_request_id }) => {
				const result = await handleGetPullRequest(this.handlerCtx, pull_request_id);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);

		server.tool(
			'approve_pull_request',
			'Approve a pull request. Only open PRs can be approved.',
			{ pull_request_id: z.string() },
			async ({ pull_request_id }) => {
				const result = await handleApprovePullRequest(this.handlerCtx, pull_request_id);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);

		server.tool(
			'merge_pull_request',
			'Merge an approved pull request. Only the original requester can merge. Optionally triggers a build and deploy of the base branch.',
			{
				pull_request_id: z.string(),
				deploy: z.boolean().default(false),
			},
			async ({ pull_request_id, deploy }) => {
				const result = await handleMergePullRequest(this.handlerCtx, pull_request_id, deploy);
				if (result.build_id) {
					const pr = result.pull_request;
					await this.schedule(1, 'runMergeDeploy', {
						buildId: result.build_id,
						repoId: pr.repo_id,
					});
				}
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		);
	}

	// ── Scheduled entry points ──────────────────────────────────────────

	async runPreviewBuild(payload: { buildId: string; repoId: string }): Promise<void> {
		const buildRows = this.sql<BuildRow>`SELECT * FROM builds WHERE id = ${payload.buildId}`;
		if (buildRows.length === 0) return;
		const repoRows = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${payload.repoId}`;
		if (repoRows.length === 0) {
			const now = Date.now();
			this.sql`
				UPDATE builds SET
					status = 'failed',
					error = 'repo not found',
					updated_at = ${now}
				WHERE id = ${payload.buildId}
			`;
			return;
		}

		await this.runFiber('preview-build', async () => {
			await runBuild({
				env: this.env,
				sql: (strings, ...values) => this.sql(strings, ...values),
				build: buildRows[0],
				repo: repoRows[0],
			});
		});
	}

	async runPromotePreview(payload: { buildId: string; deploymentId: string }): Promise<void> {
		await this.runFiber('promote-preview', async () => {
			await runPromote(this.handlerCtx, payload.buildId, payload.deploymentId);
		});
	}

	async runMergeDeploy(payload: { buildId: string; repoId: string }): Promise<void> {
		const buildRows = this.sql<BuildRow>`SELECT * FROM builds WHERE id = ${payload.buildId}`;
		if (buildRows.length === 0) return;
		const repoRows = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${payload.repoId}`;
		if (repoRows.length === 0) {
			const now = Date.now();
			this.sql`UPDATE builds SET status = 'failed', error = 'repo not found', updated_at = ${now} WHERE id = ${payload.buildId}`;
			return;
		}

		await this.runFiber('merge-deploy', async () => {
			// Run the build
			await runBuild({
				env: this.env,
				sql: (strings, ...values) => this.sql(strings, ...values),
				build: buildRows[0],
				repo: repoRows[0],
			});

			// If build succeeded, auto-promote
			const built = getBuild(this.sqlRunner, payload.buildId);
			if (built.status !== 'complete' || !built.worker_version_id) return;

			const result = await handlePromote(this.handlerCtx, payload.buildId);
			await runPromote(this.handlerCtx, payload.buildId, result.deployment_id);
		});
	}

	// ── Private helpers ─────────────────────────────────────────────────

	private get sqlRunner(): SqlRunner {
		return (strings, ...values) => this.sql(strings, ...values);
	}

	private audit(action: string, targetType: string, targetId: string, metadata: unknown): void {
		this.sql`
			INSERT INTO audit_log (action, target_type, target_id, metadata, ts)
			VALUES (${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}, ${Date.now()})
		`;
	}
}
