# RepoMint - GitHub for Agents (Demo)

> **Demo project:** this repository is a proof-of-concept for running an MCP server on Cloudflare to manage agent-owned repos and Worker preview/deploy flows. It is intentionally not production-hardened.

## What this demo does

This Worker exposes MCP tools that let an authenticated agent:

- create and manage Git repositories
- seed new repos with deploy-ready Worker starter files
- create preview builds and promote them to production
- create and merge pull requests

## Cloudflare technology used

- **Cloudflare Workers** (runtime and deployment): [Workers docs](https://developers.cloudflare.com/workers/)
- **Agents SDK** (`agents` / `agents/mcp`): [Agents docs](https://developers.cloudflare.com/agents/)
- **Durable Objects** (stateful per-agent/per-repo coordination): [Durable Objects docs](https://developers.cloudflare.com/durable-objects/)
- **D1** (metadata and control-plane persistence): [D1 docs](https://developers.cloudflare.com/d1/)
- **Workers KV** (OAuth/session-related key-value state): [KV docs](https://developers.cloudflare.com/kv/)
- **Wrangler** (local dev, deploy, types generation): [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/)
- **Node.js compatibility in Workers** (`nodejs_compat`): [Node.js compatibility docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- **Cloudflare MCP docs** (protocol and integration reference): [MCP docs](https://docs.mcp.cloudflare.com/mcp)
- **Cloudflare Sandbox SDK** (`@cloudflare/sandbox`): [SDK package](https://www.npmjs.com/package/@cloudflare/sandbox)
- **Workers OAuth Provider** (`@cloudflare/workers-oauth-provider`): [SDK package](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider)

## Quick start

### Prerequisites

- Node.js 20+
- A Cloudflare account
- Artifacts beta access (at the time of writing, Artifacts is not public)
- Wrangler authenticated (`npx wrangler login`)

### Install and run locally

```bash
npm install
npm run dev
```

### Deploy

```bash
npm run deploy
```

### Regenerate Worker types

Run this when bindings in `wrangler.jsonc` change:

```bash
npm run cf-typegen
```

## Demo caveats

- Some values (for example account identifiers in scripts) are demo-oriented and should be parameterized for real environments.
- Security, tenancy, and operational controls are simplified to keep the demo focused.
- Error handling and observability are good enough for exploration, not full production reliability targets.
- The OAuth flow is deliberately simple, real use cases would need a more robust auth flow
