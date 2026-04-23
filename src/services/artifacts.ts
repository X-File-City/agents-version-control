// Thin wrapper around the Artifacts Workers binding.
// Centralises naming conventions and the "URL with inline credentials" helper
// that agents actually need in order to `git clone`.

export interface ProvisionedRepo {
	artifactsRepoId: string;
	artifactsRepoName: string;
	remote: string;
	defaultBranch: string;
	writeToken: string;
	tokenExpiresAt: string;
}

// Artifacts repo names are namespaced per agent so a user-facing "my-worker"
// from agent A doesn't clash with the same name from agent B.
export function artifactsRepoName(agentId: string, displayName: string): string {
	const cleanAgent = agentId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
	const cleanName = displayName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48);
	return `a${cleanAgent}--${cleanName}`;
}

export async function provisionRepo(
	artifacts: Artifacts,
	agentId: string,
	displayName: string,
	description?: string,
): Promise<ProvisionedRepo> {
	const fullName = artifactsRepoName(agentId, displayName);
	const result = await artifacts.create(fullName, {
		description: description ?? `Repo ${displayName} for agent ${agentId}`,
	});
	return {
		artifactsRepoId: result.id,
		artifactsRepoName: result.name,
		remote: result.remote,
		defaultBranch: result.defaultBranch,
		writeToken: result.token,
		tokenExpiresAt: result.tokenExpiresAt,
	};
}

export async function mintAccess(
	artifacts: Artifacts,
	repoName: string,
	scope: 'read' | 'write' = 'write',
	ttlSeconds = 3600,
): Promise<{ token: string; expiresAt: string; remote: string }> {
	const repo = await artifacts.get(repoName);
	const tok = await repo.createToken(scope, ttlSeconds);
	return { token: tok.plaintext, expiresAt: tok.expiresAt, remote: repo.remote };
}

export function deleteRepo(artifacts: Artifacts, repoName: string): Promise<boolean> {
	return artifacts.delete(repoName);
}

// Produce an HTTPS git remote with inline credentials. Used inside the sandbox
// so `git clone`/`git push` work without any interactive auth.
export function gitUrlWithToken(remote: string, token: string): string {
	const url = new URL(remote);
	url.username = 'x-access-token';
	url.password = token;
	return url.toString();
}
