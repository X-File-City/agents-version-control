// Schema + typed helpers for the per-agent McpAgent Durable Object SQLite.
// Every table is implicitly scoped to "this agent" because the DO is per-agent.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_self (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	artifacts_repo_id TEXT NOT NULL,
	artifacts_repo_name TEXT NOT NULL,
	worker_name TEXT NOT NULL,
	git_url TEXT NOT NULL,
	default_branch TEXT NOT NULL DEFAULT 'main',
	created_at INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS builds (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	ref TEXT NOT NULL,
	commit_sha TEXT,
	sandbox_id TEXT,
	status TEXT NOT NULL,
	worker_version_id TEXT,
	preview_url TEXT,
	logs TEXT,
	error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	worker_version_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	action TEXT NOT NULL,
	target_type TEXT,
	target_id TEXT,
	metadata TEXT,
	ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_repo ON builds(repo_id);
CREATE INDEX IF NOT EXISTS idx_deploys_repo ON deployments(repo_id);
`;

// Row types — these reflect the SQL columns above.

export interface AgentSelfRow {
	id: string;
	name: string;
	created_at: number;
}

export interface RepoRow {
	id: string;
	name: string;
	artifacts_repo_id: string;
	artifacts_repo_name: string;
	worker_name: string;
	git_url: string;
	default_branch: string;
	created_at: number;
	state: 'ready' | 'archived';
}

export type BuildStatus =
	| 'queued'
	| 'cloning'
	| 'installing'
	| 'bundling'
	| 'uploading'
	| 'complete'
	| 'failed';

export interface BuildRow {
	id: string;
	repo_id: string;
	ref: string;
	commit_sha: string | null;
	sandbox_id: string | null;
	status: BuildStatus;
	worker_version_id: string | null;
	preview_url: string | null;
	logs: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}

export type DeploymentStatus = 'pending' | 'active' | 'failed' | 'superseded';

export interface DeploymentRow {
	id: string;
	repo_id: string;
	worker_version_id: string;
	environment: string;
	status: DeploymentStatus;
	created_at: number;
}
