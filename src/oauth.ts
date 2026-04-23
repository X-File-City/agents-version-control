// Default handler for the OAuthProvider.
//
// Serves the /authorize consent page and a tiny landing page. Real deployments
// would authenticate the human behind the agent here (password, SSO, passkey,
// etc.); for the demo we accept a name and treat that as the agent identity.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

interface OAuthEnv extends Cloudflare.Env {
	OAUTH_PROVIDER: OAuthHelpers;
}

export const defaultHandler: ExportedHandler<OAuthEnv> = {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/' && request.method === 'GET') {
			return htmlResponse(landingPage());
		}

		if (url.pathname === '/authorize' && request.method === 'GET') {
			const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
			const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
			return htmlResponse(authorizePage(parsed, client?.clientName));
		}

		if (url.pathname === '/authorize' && request.method === 'POST') {
			const form = await request.formData();
			const agentName = String(form.get('agent_name') ?? '').trim();
			if (!agentName) return htmlResponse('agent_name is required', 400);

			// Re-parse the auth request — its params are carried through as
			// hidden form fields by our consent page.
			const params = new URLSearchParams();
			for (const [k, v] of form.entries()) {
				if (k.startsWith('oauth_')) params.set(k.slice(6), String(v));
			}
			const upstream = new Request(`${url.origin}/authorize?${params.toString()}`);
			const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(upstream);

			// A stable subject per agent name. In production we'd mint a UUID on
			// first sign-up and look it up by name thereafter; for the demo this
			// is good enough.
			// workers-oauth-provider serializes codes/tokens as `${userId}:${grantId}:${secret}`;
			// userId must therefore avoid ":" to keep that format unambiguous.
			const userId = `agent_${hashName(agentName)}`;

			const result = await env.OAUTH_PROVIDER.completeAuthorization({
				request: parsed,
				userId,
				metadata: { agentName },
				scope: parsed.scope,
				props: { userId, displayName: agentName },
			});
			return Response.redirect(result.redirectTo, 302);
		}

		return new Response('Not found', { status: 404 });
	},
};

function hashName(name: string): string {
	// Tiny non-cryptographic hash — we only need stability per session.
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

function landingPage(): string {
	return `<!doctype html><meta charset="utf-8"><title>github-for-agents</title>
<style>body{font:14px/1.5 system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f4f4f5;padding:.1em .3em;border-radius:.2em}</style>
<h1>github-for-agents</h1>
<p>This is a Model Context Protocol server for autonomous agents. Point an MCP client at <code>/mcp</code> and complete the OAuth flow to receive tools for managing Artifacts repos, previews, and deployments.</p>
`;
}

interface ParsedAuthReq {
	clientId: string;
	redirectUri: string;
	scope: string[];
	state: string;
	responseType: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
	resource?: string | string[];
}

function authorizePage(req: ParsedAuthReq, clientName?: string): string {
	const passthrough = (
		[
			['response_type', req.responseType],
			['client_id', req.clientId],
			['redirect_uri', req.redirectUri],
			['state', req.state],
			['scope', req.scope.join(' ')],
			['code_challenge', req.codeChallenge ?? ''],
			['code_challenge_method', req.codeChallengeMethod ?? ''],
			['resource', Array.isArray(req.resource) ? req.resource.join(' ') : (req.resource ?? '')],
		] as const
	)
		.filter(([, v]) => v !== '')
		.map(([k, v]) => `<input type="hidden" name="oauth_${k}" value="${escapeHtml(String(v))}">`) // NB: prefix so we can separate in POST
		.join('\n');

	return `<!doctype html><meta charset="utf-8"><title>Authorize</title>
<style>body{font:14px/1.5 system-ui;max-width:520px;margin:3rem auto;padding:0 1rem;color:#222}label{display:block;margin:1rem 0 .25rem}input[type=text]{width:100%;padding:.5rem;border:1px solid #bbb;border-radius:.25rem}button{padding:.5rem 1rem;margin-top:1rem}</style>
<h1>Authorize ${escapeHtml(clientName ?? req.clientId)}</h1>
<p>This will create a new agent identity on the github-for-agents control plane. Pick a display name — it also seeds a stable agent id.</p>
<form method="post" action="/authorize">
<label>Agent name<input type="text" name="agent_name" required autofocus pattern="[A-Za-z0-9 _\\-]{1,40}"></label>
${passthrough}
<button type="submit">Authorize</button>
</form>
`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[c]!));
}
