import OAuthProvider from '@cloudflare/workers-oauth-provider';
import {
	//ContainerProxy,
	proxyToSandbox,
	Sandbox as BaseSandbox,
	type Sandbox as SandboxType,
} from '@cloudflare/sandbox';

import { AgentsMcpServer } from './mcp/agent';
import { defaultHandler } from './oauth';

// Re-export DO classes so Wrangler can instantiate them by name.
export { AgentsMcpServer };
// Required for sandbox outbound interception to work.
//export { ContainerProxy };
export class Sandbox extends BaseSandbox {}

// Disabled outbound interception. Wrangler auth now uses direct
// CLOUDFLARE_API_TOKEN env injection in sandbox commands.
// Sandbox.outbound = (request: Request, env: OutboundEnv): Response | Promise<Response> => {
// 	const url = new URL(request.url);
// 	if (url.hostname === CF_API_HOST) {
// 		if (!env.API_TOKEN) {
// 			return new Response('sandbox outbound missing API_TOKEN secret', { status: 500 });
// 		}
//
// 		url.protocol = 'https:';
// 		const headers = new Headers(request.headers);
// 		headers.set('Authorization', `Bearer ${env.API_TOKEN}`);
//
// 		return fetch(url.toString(), {
// 			method: request.method,
// 			headers,
// 			body: request.body,
// 			redirect: 'manual',
// 		});
// 	}
//
// 	return fetch(request);
// };

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
