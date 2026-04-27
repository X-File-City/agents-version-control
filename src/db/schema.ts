// D1 schema is managed via migrations/0001_init.sql (users + repos tables).
// This file defines the per-repo Durable Object SQLite schema and shared row types.

/** DDL for the per-repo RepoDO SQLite database (tables first, indexes last). */
export const REPO_DO_SCHEMA = `
CREATE TABLE IF NOT EXISTS repo_config (
	repo_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	artifacts_repo_name TEXT NOT NULL,
	worker_name TEXT NOT NULL,
	git_url TEXT NOT NULL,
	default_branch TEXT NOT NULL DEFAULT 'main'
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
CREATE TABLE IF NOT EXISTS pull_requests (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	head_branch TEXT NOT NULL,
	base_branch TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'open',
	requested_by_id TEXT NOT NULL,
	requested_by_name TEXT NOT NULL,
	approved_by_id TEXT,
	approved_by_name TEXT,
	approved_at INTEGER,
	merged_at INTEGER,
	merged_commit_sha TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_repo ON builds(repo_id);
CREATE INDEX IF NOT EXISTS idx_deploys_repo ON deployments(repo_id);
CREATE INDEX IF NOT EXISTS idx_pr_repo ON pull_requests(repo_id);
`;

// ── Row types ───────────────────────────────────────────────────────

/** Repo metadata stored in D1. */
export interface RepoRow {
	id: string;
	name: string;
	owner_id: string;
	artifacts_repo_id: string;
	artifacts_repo_name: string;
	worker_name: string;
	git_url: string;
	default_branch: string;
	created_at: number;
	state: 'ready' | 'archived';
}

/** Denormalized repo config stored in the RepoDO SQLite. */
export interface RepoConfigRow {
	repo_id: string;
	name: string;
	artifacts_repo_name: string;
	worker_name: string;
	git_url: string;
	default_branch: string;
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

export type PullRequestStatus = 'open' | 'approved' | 'merged' | 'closed';

export interface PullRequestRow {
	id: string;
	repo_id: string;
	head_branch: string;
	base_branch: string;
	title: string;
	description: string | null;
	status: PullRequestStatus;
	requested_by_id: string;
	requested_by_name: string;
	approved_by_id: string | null;
	approved_by_name: string | null;
	approved_at: number | null;
	merged_at: number | null;
	merged_commit_sha: string | null;
	created_at: number;
	updated_at: number;
}

/** D1 user row. */
export interface UserRow {
	id: string;
	name: string;
	created_at: number;
}
