-- D1 schema: shared state for users and repo metadata.
-- Keep column names aligned with UserRow and RepoRow in src/db/schema.ts.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    artifacts_repo_id TEXT NOT NULL,
    artifacts_repo_name TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    git_url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready',
    UNIQUE(owner_id, name)
);
