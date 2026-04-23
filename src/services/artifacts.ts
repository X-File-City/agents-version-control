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
): Promise<{ token: string; expiresAt: string }> {
	const repo = await artifacts.get(repoName);
	const tok = await repo.createToken(scope, ttlSeconds);
	return { token: tok.plaintext, expiresAt: tok.expiresAt };
}

export function deleteRepo(artifacts: Artifacts, repoName: string): Promise<boolean> {
	return artifacts.delete(repoName);
}

// Produce an HTTPS git remote with inline credentials. Used inside the sandbox
// so `git clone`/`git push` work without any interactive auth.
export function gitUrlWithToken(remote: string, token: string): string {
	const url = coerceRemoteToHttpUrl(remote);
	// Artifacts URL auth expects the token secret in the password slot.
	// The `?expires=` suffix belongs to bearer-token usage, not URL basic auth.
	url.username = 'x';
	url.password = tokenSecret(token);
	return url.toString();
}

function tokenSecret(token: string): string {
	const trimmed = token.trim();
	if (!trimmed) throw new TypeError('invalid empty token');
	return trimmed.replace(/\?expires=\d+$/, '');
}

function coerceRemoteToHttpUrl(remote: string): URL {
	const trimmed = remote.trim();
	if (!trimmed) {
		throw new TypeError('invalid empty git remote');
	}

	const parsed = tryParseUrl(trimmed);
	if (parsed) {
		// We can only inject user/password into HTTP(S) remotes for non-interactive git auth.
		if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed;
		if (parsed.protocol === 'ssh:') {
			return new URL(`https://${parsed.host}${parsed.pathname}`);
		}
		throw new TypeError(`unsupported git remote protocol: ${parsed.protocol}`);
	}

	// Handle scp-like remotes (`git@host:owner/repo.git`) by coercing to HTTPS.
	const scpLike = trimmed.match(/^(?:[^@]+@)?([^:/\s]+):(.+)$/);
	if (scpLike) {
		const host = scpLike[1];
		const path = scpLike[2];
		if (host && path) {
			return new URL(`https://${host}/${path.replace(/^\/+/, '')}`);
		}
	}

	// Handle host/path style remotes (`git.example.com/owner/repo.git`).
	if (/^[^/\s]+\.[^/\s]+\/.+$/.test(trimmed)) {
		return new URL(`https://${trimmed}`);
	}

	throw new TypeError(`invalid git remote URL: ${remote}`);
}

function tryParseUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}
