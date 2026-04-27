import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';

import { AgentsMcpServer } from './mcp/agent';
import { RepoDO } from './do/repo';
import { defaultHandler } from './oauth';

export { AgentsMcpServer, RepoDO };
export class Sandbox extends BaseSandbox {}

type HandlerWithFetch = ExportedHandler<Cloudflare.Env> & {
	fetch: NonNullable<ExportedHandler<Cloudflare.Env>['fetch']>;
};

// The OAuth provider handles /authorize, /token, /register, and /.well-known/*.
// Routes:
// - OAuthProvider-owned endpoints: /mcp, /token, /register, /.well-known/*
// - App-owned endpoints via default handler: / and /authorize
// Everything under /mcp requires a valid access token and is dispatched to the
// per-agent McpAgent DO (keyed by OAuth userId from the token props).
const apiHandler = AgentsMcpServer.serve('/mcp') as unknown as HandlerWithFetch;

export default new OAuthProvider({
	apiRoute: '/mcp',
	apiHandler,
	defaultHandler,
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/token',
	clientRegistrationEndpoint: '/register',
});
