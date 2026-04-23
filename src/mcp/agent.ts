import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Sandbox as SandboxType } from '@cloudflare/sandbox';

import { SCHEMA } from '../db/schema';
import type { BuildRow, DeploymentRow, RepoRow } from '../db/schema';
import { ulid } from '../util/ids';
import {
	deleteRepo,
	mintAccess,
	provisionRepo,
	gitUrlWithToken,
} from '../services/artifacts';
import { sandboxFor, sh } from '../services/sandbox';
import { wrangler } from '../services/wrangler-run';
import { runBuild } from '../builds/runner';
import { seedRepoInMemory } from '../services/repo-seed';

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

		// Ensure we have a self row — useful for debugging and audit.
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
				return { content: [{ type: 'text', text: JSON.stringify(await this.handleCreateRepo(name, worker_name, description), null, 2) }] };
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
				const rows = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${repo_id}`;
				if (rows.length === 0) throw new Error(`repo ${repo_id} not found`);
				const repo = rows[0];
				const access = await mintAccess(this.env.ARTIFACTS, repo.artifacts_repo_name, scope, ttl_seconds);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(
								{
									git_url: gitUrlWithToken(repo.git_url, access.token),
									remote: repo.git_url,
									username: 'x-access-token',
									token: access.token,
									expires_at: access.expiresAt,
									scope,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		server.tool(
			'delete_repo',
			'Archive and delete a repo.',
			{ repo_id: z.string() },
			async ({ repo_id }) => {
				const rows = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${repo_id}`;
				if (rows.length === 0) throw new Error(`repo ${repo_id} not found`);
				const repo = rows[0];
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
				const rows = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${repo_id}`;
				if (rows.length === 0) throw new Error(`repo ${repo_id} not found`);
				const repo = rows[0];

				const buildId = ulid();
				const now = Date.now();
				this.sql`
					INSERT INTO builds (id, repo_id, ref, status, created_at, updated_at)
					VALUES (${buildId}, ${repo_id}, ${ref}, 'queued', ${now}, ${now})
				`;

				// Queue build execution onto the agent scheduler so request lifetime
				// is decoupled from long-running build work.
				await this.schedule(1, 'runPreviewBuild', { buildId, repoId: repo.id });

				return { content: [{ type: 'text', text: JSON.stringify({ build_id: buildId, status: 'queued' }) }] };
			},
		);

		server.tool(
			'get_preview_status',
			'Get the current status of a build, including logs tail and preview_url when ready.',
			{ build_id: z.string() },
			async ({ build_id }) => {
				const rows = this.sql<BuildRow>`SELECT * FROM builds WHERE id = ${build_id}`;
				if (rows.length === 0) throw new Error(`build ${build_id} not found`);
				return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] };
			},
		);

		server.tool(
			'promote_preview',
			'Promote a completed build to production by deploying its Worker version at 100% traffic.',
			{ build_id: z.string() },
			async ({ build_id }) => {
				return { content: [{ type: 'text', text: JSON.stringify(await this.handlePromote(build_id), null, 2) }] };
			},
		);

		server.tool(
			'get_deploy_status',
			'Look up a deployment record.',
			{ deployment_id: z.string() },
			async ({ deployment_id }) => {
				const rows = this.sql<DeploymentRow>`SELECT * FROM deployments WHERE id = ${deployment_id}`;
				if (rows.length === 0) throw new Error(`deployment ${deployment_id} not found`);
				return { content: [{ type: 'text', text: JSON.stringify(rows[0], null, 2) }] };
			},
		);
	}

	// ── Complex tool bodies extracted for readability ─────────────────────

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

	private async handleCreateRepo(
		name: string,
		workerName: string,
		description?: string,
	): Promise<{ repo_id: string; git_url: string; worker_name: string; default_branch: string }> {
		const agentId = this.props?.userId ?? 'anonymous';
		const displayName = this.props?.displayName ?? 'agent';

		// Uniqueness is enforced by the DB (repos.name UNIQUE per agent).
		const existing = this.sql<RepoRow>`SELECT id FROM repos WHERE name = ${name}`;
		if (existing.length > 0) throw new Error(`repo ${name} already exists`);

		const provisioned = await provisionRepo(this.env.ARTIFACTS, agentId, name, description);

		const repoId = ulid();
		const seedGitUrl = gitUrlWithToken(provisioned.remote, provisioned.writeToken);
		console.info('[create_repo] provisioned artifacts repo', {
			repoId,
			repoName: name,
			workerName,
			remote: this.redactCredentials(seedGitUrl),
		});
		try {
			// Seed the repo with a minimal Worker scaffold so `wrangler versions upload`
			// works immediately.
			await this.seedRepo({
				gitUrl: seedGitUrl,
				workerName,
				displayName,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error('[create_repo] seed failed', {
				repoId,
				repoName: name,
				workerName,
				remote: this.redactCredentials(seedGitUrl),
				error: reason,
			});
			try {
				await deleteRepo(this.env.ARTIFACTS, provisioned.artifactsRepoName);
				console.warn('[create_repo] cleaned up provisioned repo after seed failure', {
					repoId,
					artifactsRepoName: provisioned.artifactsRepoName,
				});
			} catch (cleanupErr) {
				console.error('[create_repo] cleanup failed after seed failure', {
					repoId,
					artifactsRepoName: provisioned.artifactsRepoName,
					error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
				});
			}
			throw new Error(`seed failed: ${reason}`);
		}

		const now = Date.now();
		this.sql`
			INSERT INTO repos
				(id, name, artifacts_repo_id, artifacts_repo_name, worker_name, git_url, default_branch, created_at, state)
			VALUES
				(${repoId}, ${name}, ${provisioned.artifactsRepoId}, ${provisioned.artifactsRepoName},
				 ${workerName}, ${provisioned.remote}, ${provisioned.defaultBranch}, ${now}, 'ready')
		`;
		this.audit('create_repo', 'repo', repoId, { name, worker_name: workerName });

		return {
			repo_id: repoId,
			git_url: provisioned.remote,
			worker_name: workerName,
			default_branch: provisioned.defaultBranch,
		};
	}

	private async seedRepo(args: {
		gitUrl: string;
		workerName: string;
		displayName: string;
	}): Promise<void> {
		console.info('[seed] start', {
			workerName: args.workerName,
			displayName: args.displayName,
			remote: this.redactCredentials(args.gitUrl),
		});
		await seedRepoInMemory({
			gitUrl: args.gitUrl,
			workerName: args.workerName,
			displayName: args.displayName,
		});
		console.info('[seed] complete', {
			workerName: args.workerName,
		});
	}

	private async handlePromote(buildId: string): Promise<{ deployment_id: string; status: string; worker_version_id: string }> {
		const builds = this.sql<BuildRow>`SELECT * FROM builds WHERE id = ${buildId}`;
		if (builds.length === 0) throw new Error(`build ${buildId} not found`);
		const build = builds[0];
		if (build.status !== 'complete' || !build.worker_version_id) {
			throw new Error(`build ${buildId} is not complete (status=${build.status})`);
		}
		const repos = this.sql<RepoRow>`SELECT * FROM repos WHERE id = ${build.repo_id}`;
		if (repos.length === 0) throw new Error(`repo ${build.repo_id} not found`);
		const repo = repos[0];

		const deploymentId = ulid();
		const now = Date.now();
		this.sql`
			INSERT INTO deployments (id, repo_id, worker_version_id, environment, status, created_at)
			VALUES (${deploymentId}, ${repo.id}, ${build.worker_version_id}, 'production', 'pending', ${now})
		`;

		const sb = sandboxFor(
			this.env.SANDBOX as unknown as DurableObjectNamespace<SandboxType>,
			`deploy-${deploymentId}`,
		);
		// Fresh checkout of the deployed ref so wrangler has the config.
		const access = await mintAccess(this.env.ARTIFACTS, repo.artifacts_repo_name, 'read', 600);
		const authedUrl = gitUrlWithToken(repo.git_url, access.token);
		const dir = '/workspace/deploy';
		const checkout = `rm -rf ${dir} && git clone --quiet ${authedUrl} ${dir} && cd ${dir} && git checkout ${build.commit_sha ?? 'HEAD'}`;
		await sh(sb, checkout, { timeoutMs: 120_000 });

		const install = await sh(sb, 'npm install --no-audit --no-fund', { cwd: dir, timeoutMs: 300_000 });
		if (!install.success) {
			this.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			throw new Error(`install failed during promote: ${install.stderr}`);
		}

		// Deploy the specific version at 100%. This keeps promote a pure
		// traffic-shift action — no rebuild.
		const apiToken = (this.env as Cloudflare.Env & { API_TOKEN?: string }).API_TOKEN;
		if (!apiToken) {
			this.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			throw new Error('missing API_TOKEN secret for wrangler deploy');
		}
		const deploy = await wrangler(
			sb,
			`versions deploy ${build.worker_version_id}@100% --message "promote build ${buildId}" --yes`,
			dir,
			apiToken,
		);
		if (!deploy.success) {
			this.sql`UPDATE deployments SET status = 'failed' WHERE id = ${deploymentId}`;
			throw new Error(`wrangler versions deploy failed: ${deploy.stderr}`);
		}

		this.sql`UPDATE deployments SET status = 'active' WHERE id = ${deploymentId}`;
		this.sql`UPDATE deployments SET status = 'superseded' WHERE repo_id = ${repo.id} AND id != ${deploymentId} AND status = 'active'`;
		this.audit('promote_preview', 'deployment', deploymentId, { build_id: buildId });

		return { deployment_id: deploymentId, status: 'active', worker_version_id: build.worker_version_id };
	}

	private audit(action: string, targetType: string, targetId: string, metadata: unknown): void {
		this.sql`
			INSERT INTO audit_log (action, target_type, target_id, metadata, ts)
			VALUES (${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}, ${Date.now()})
		`;
	}

	private redactCredentials(url: string): string {
		try {
			const parsed = new URL(url);
			if (parsed.username || parsed.password) {
				parsed.username = parsed.username ? 'x-access-token' : '';
				parsed.password = parsed.password ? '***' : '';
			}
			return parsed.toString();
		} catch {
			return '<invalid-url>';
		}
	}
}

