import type { RepoRow, BuildRow, DeploymentRow, PullRequestRow, RepoConfigRow, UserRow } from './schema';

// Tagged-template SQL API exposed by Agent's `this.sql`.
export interface SqlRunner {
	<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
}

// ── DO SQL helpers (used inside RepoDO) ─────────────────────────────

export function getRepoConfig(sql: SqlRunner, repoId: string): RepoConfigRow {
	const rows = sql<RepoConfigRow>`SELECT * FROM repo_config WHERE repo_id = ${repoId}`;
	if (rows.length === 0) throw new Error(`repo config for ${repoId} not found in DO`);
	return rows[0];
}

export function getBuild(sql: SqlRunner, buildId: string): BuildRow {
	const rows = sql<BuildRow>`SELECT * FROM builds WHERE id = ${buildId}`;
	if (rows.length === 0) throw new Error(`build ${buildId} not found`);
	return rows[0];
}

/** Optional build lookup used by scheduled jobs that can no-op on stale ids. */
export function findBuild(sql: SqlRunner, buildId: string): BuildRow | null {
	const rows = sql<BuildRow>`SELECT * FROM builds WHERE id = ${buildId}`;
	return rows[0] ?? null;
}

export function getDeployment(sql: SqlRunner, deploymentId: string): DeploymentRow {
	const rows = sql<DeploymentRow>`SELECT * FROM deployments WHERE id = ${deploymentId}`;
	if (rows.length === 0) throw new Error(`deployment ${deploymentId} not found`);
	return rows[0];
}

export function getPullRequest(sql: SqlRunner, prId: string): PullRequestRow {
	const rows = sql<PullRequestRow>`SELECT * FROM pull_requests WHERE id = ${prId}`;
	if (rows.length === 0) throw new Error(`pull request ${prId} not found`);
	return rows[0];
}

export function listPullRequests(sql: SqlRunner, repoId: string): PullRequestRow[] {
	return sql<PullRequestRow>`SELECT * FROM pull_requests WHERE repo_id = ${repoId} AND status != 'closed' ORDER BY created_at DESC LIMIT 10`;
}

// ── D1 helpers (async — used from McpAgent and OAuth handler) ───────

export async function getRepoFromD1(db: D1Database, repoId: string): Promise<RepoRow> {
	const row = await db.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId).first<RepoRow>();
	if (!row) throw new Error(`repo ${repoId} not found`);
	return row;
}

export async function listReposFromD1(db: D1Database, ownerId: string): Promise<RepoRow[]> {
	const result = await db.prepare(
		"SELECT * FROM repos WHERE owner_id = ? AND state != 'archived' ORDER BY created_at DESC",
	).bind(ownerId).all<RepoRow>();
	return result.results;
}

export async function repoExistsInD1(db: D1Database, ownerId: string, name: string): Promise<boolean> {
	const row = await db.prepare(
		'SELECT id FROM repos WHERE owner_id = ? AND name = ?',
	).bind(ownerId, name).first();
	return row !== null;
}

export async function getUserFromD1(db: D1Database, userId: string): Promise<UserRow | null> {
	return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
}

export async function getUserByNameFromD1(db: D1Database, name: string): Promise<UserRow | null> {
	return db.prepare('SELECT * FROM users WHERE name = ?').bind(name).first<UserRow>();
}

export async function createUserInD1(db: D1Database, id: string, name: string): Promise<void> {
	await db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, Date.now()).run();
}
