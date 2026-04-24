import type { RepoRow, BuildRow, DeploymentRow, PullRequestRow } from './schema';

// Tagged-template SQL API exposed by McpAgent's `this.sql`.
export interface SqlRunner {
	<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
}

export function getRepo(sql: SqlRunner, repoId: string): RepoRow {
	const rows = sql<RepoRow>`SELECT * FROM repos WHERE id = ${repoId}`;
	if (rows.length === 0) throw new Error(`repo ${repoId} not found`);
	return rows[0];
}

export function getBuild(sql: SqlRunner, buildId: string): BuildRow {
	const rows = sql<BuildRow>`SELECT * FROM builds WHERE id = ${buildId}`;
	if (rows.length === 0) throw new Error(`build ${buildId} not found`);
	return rows[0];
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
