import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { RepoRow } from '../db/schema';
import { getRepoFromD1, listReposFromD1 } from '../db/queries';
import { deleteRepo, mintAccess, gitUrlWithToken } from '../services/artifacts';
import { handleCreateRepo, type McpHandlerContext } from './handlers';
import type { RepoDO } from '../do/repo';

export interface AgentProps extends Record<string, unknown> {
	userId: string;       // OAuth subject
	displayName: string;
}

const repoNameSchema = z
	.string()
	.min(1)
	.max(48)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'letters, digits, ., _, - only (must not start with separator)');

const workerNameSchema = z
	.string()
	.min(3)
	.max(58)
	.regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits, hyphens, must start with letter');

export class AgentsMcpServer extends McpAgent<Cloudflare.Env, unknown, AgentProps> {
	server = new McpServer({
		name: 'github-for-agents',
		version: '0.1.0',
	});

	async init(): Promise<void> {
		this.registerTools();
	}

	private get userId(): string {
		return this.props?.userId ?? 'unknown';
	}

	private get displayName(): string {
		return this.props?.displayName ?? 'agent';
	}

	private get db(): D1Database {
		return this.env.DB;
	}

	private getRepoDO(repoId: string): DurableObjectStub<RepoDO> {
		const stub = this.env.REPO_OBJECT.get(
			this.env.REPO_OBJECT.idFromName(repoId),
		) as DurableObjectStub<RepoDO>;

		// The Agents SDK can read stub.name internally; set it eagerly to avoid
		// "Attempting to read .name ... before it was set" warnings/errors.
		const namedStub = stub as DurableObjectStub<RepoDO> & { setName?: (name: string) => void };
		namedStub.setName?.(repoId);
		return stub;
	}

	private get handlerCtx(): McpHandlerContext {
		return {
			env: this.env,
			db: this.db,
			userId: this.userId,
			displayName: this.displayName,
			getRepoDO: (repoId) => this.getRepoDO(repoId),
		};
	}

	private asToolResult(value: unknown, pretty = true): { content: [{ type: 'text'; text: string }] } {
		return {
			content: [{
				type: 'text',
				text: pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value),
			}],
		};
	}

	/**
	 * Validate the caller owns the repo and return the D1 row.
	 * Wrong owner intentionally maps to "not found" to avoid disclosing ownership.
	 */
	private async ownedRepo(repoId: string): Promise<RepoRow> {
		const repo = await getRepoFromD1(this.db, repoId);
		if (repo.owner_id !== this.userId) {
			console.warn('[mcp] ownedRepo denied', { repoId, actor: this.userId, ownerId: repo.owner_id });
			throw new Error(`repo ${repoId} not found`);
		}
		return repo;
	}

	private registerTools(): void {
		const { server } = this;

		// ── Repo CRUD (D1) ──────────────────────────────────────────

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
				return this.asToolResult(result);
			},
		);

		server.tool(
			'list_repos',
			'List all repos owned by this agent.',
			{},
			async () => {
				const rows = await listReposFromD1(this.db, this.userId);
				return this.asToolResult(rows);
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
				const repo = await this.ownedRepo(repo_id);
				const access = await mintAccess(this.env.ARTIFACTS, repo.artifacts_repo_name, scope, ttl_seconds);
				return this.asToolResult({
					git_url: gitUrlWithToken(repo.git_url, access.token),
					remote: repo.git_url,
					username: 'x-access-token',
					token: access.token,
					expires_at: access.expiresAt,
					scope,
				});
			},
		);

		server.tool(
			'delete_repo',
			'Archive and delete a repo.',
			{ repo_id: z.string() },
			async ({ repo_id }) => {
				const repo = await this.ownedRepo(repo_id);
				const ok = await deleteRepo(this.env.ARTIFACTS, repo.artifacts_repo_name);
				await this.db.prepare("UPDATE repos SET state = 'archived' WHERE id = ?").bind(repo_id).run();
				return this.asToolResult({ ok }, false);
			},
		);

		// ── Build & Deploy (delegated to RepoDO) ────────────────────

		server.tool(
			'create_preview',
			'Start a preview build for a repo ref (branch/tag/sha). Returns a build_id; poll get_preview_status until status=complete.',
			{
				repo_id: z.string(),
				ref: z.string().default('main'),
			},
			async ({ repo_id, ref }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.createBuild(ref);
				return this.asToolResult(result, false);
			},
		);

		server.tool(
			'get_preview_status',
			'Get the current status of a build, including logs tail and preview_url when ready.',
			{ build_id: z.string(), repo_id: z.string() },
			async ({ build_id, repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const build = await repoDO.getBuildStatus(build_id);
				return this.asToolResult(build);
			},
		);

		server.tool(
			'promote_preview',
			'Promote a completed build to production by deploying its Worker version at 100% traffic.',
			{ build_id: z.string(), repo_id: z.string() },
			async ({ build_id, repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.promote(build_id, this.displayName);
				return this.asToolResult(result);
			},
		);

		server.tool(
			'get_deploy_status',
			'Look up a deployment record.',
			{ deployment_id: z.string(), repo_id: z.string() },
			async ({ deployment_id, repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const deployment = await repoDO.getDeploymentStatus(deployment_id);
				return this.asToolResult(deployment);
			},
		);

		// ── Pull Request tools (delegated to RepoDO) ────────────────

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
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.createPullRequest({
					headBranch: head_branch,
					baseBranch: base_branch,
					title,
					description,
					requesterId: this.userId,
					requesterName: this.displayName,
				});
				return this.asToolResult(result);
			},
		);

		server.tool(
			'list_pull_requests',
			'List pull requests for a repo, newest first (max 10).',
			{ repo_id: z.string() },
			async ({ repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const rows = await repoDO.listRepoPullRequests();
				return this.asToolResult(rows);
			},
		);

		server.tool(
			'get_pull_request',
			'Get a pull request with a unified diff between head and base branches.',
			{ pull_request_id: z.string(), repo_id: z.string() },
			async ({ pull_request_id, repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.getRepoPullRequest(pull_request_id);
				return this.asToolResult(result);
			},
		);

		server.tool(
			'approve_pull_request',
			'Approve a pull request. Only open PRs can be approved.',
			{ pull_request_id: z.string(), repo_id: z.string() },
			async ({ pull_request_id, repo_id }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.approvePullRequest(pull_request_id, this.userId, this.displayName);
				return this.asToolResult(result);
			},
		);

		server.tool(
			'merge_pull_request',
			'Merge an approved pull request. Only the original requester can merge. Optionally triggers a build and deploy of the base branch.',
			{
				pull_request_id: z.string(),
				repo_id: z.string(),
				deploy: z.boolean().default(false),
			},
			async ({ pull_request_id, repo_id, deploy }) => {
				await this.ownedRepo(repo_id);
				const repoDO = this.getRepoDO(repo_id);
				const result = await repoDO.mergePullRequest(pull_request_id, this.userId, deploy);
				return this.asToolResult(result);
			},
		);
	}
}
