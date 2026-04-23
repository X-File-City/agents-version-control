import OAuthProvider from '@cloudflare/workers-oauth-provider';
import {
	proxyToSandbox,
	Sandbox as BaseSandbox,
	type Sandbox as SandboxType,
} from '@cloudflare/sandbox';

import { AgentsMcpServer } from './mcp/agent';
import { defaultHandler } from './oauth';

export { AgentsMcpServer };
export class Sandbox extends BaseSandbox {}

// The OAuth provider handles /authorize, /token, /register, and /.well-known/*.
// Everything under /mcp requires a valid access token and is dispatched to the
// per-agent McpAgent DO (keyed by OAuth userId from the token's props).
// `AgentsMcpServer.serve(path)` returns `{ fetch }` which is exactly the
// `apiHandler` shape the OAuthProvider wants, but typescript sees `fetch` as
// optional on the generic ExportedHandler. Cast once here.
const apiHandler = AgentsMcpServer.serve('/mcp') as unknown as ExportedHandler<Cloudflare.Env> & {
	fetch: NonNullable<ExportedHandler<Cloudflare.Env>['fetch']>;
};

const oauth = new OAuthProvider({
	apiRoute: '/mcp',
	apiHandler,
	defaultHandler: defaultHandler as unknown as ExportedHandler<Cloudflare.Env> & {
		fetch: NonNullable<ExportedHandler<Cloudflare.Env>['fetch']>;
	},
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/token',
	clientRegistrationEndpoint: '/register',
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Sandbox preview URLs (unused in v1 but cheap to wire up).
		const proxied = await proxyToSandbox(
			request,
			{ Sandbox: env.SANDBOX } as { Sandbox: DurableObjectNamespace<SandboxType> },
		);
		if (proxied) return proxied;

		return oauth.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
