// Default handler for the OAuthProvider.
//
// Serves the /authorize consent page and a tiny landing page. Real deployments
// would authenticate the human behind the agent here (password, SSO, passkey,
// etc.); for the demo we accept a name and treat that as the agent identity.
//
// Users are persisted in D1. Returning users (same name) reuse their existing id.

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import { getUserByNameFromD1, createUserInD1 } from './db/queries';
import { ulid } from './util/ids';

type OAuthEnv = Cloudflare.Env & {
	OAUTH_PROVIDER: OAuthHelpers;
};

const app = new Hono<{ Bindings: OAuthEnv }>();

app.get('/', () => handleLandingPage());
app.get('/authorize', async (c) => handleAuthorizeGet(c.req.raw, c.env));
app.post('/authorize', async (c) => handleAuthorizePost(c.req.raw, c.env));

export const defaultHandler = app;

function handleLandingPage(): Response {
	return htmlResponse(landingPage());
}

async function handleAuthorizeGet(request: Request, env: OAuthEnv): Promise<Response> {
	const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
	return htmlResponse(authorizePage(parsed, client?.clientName));
}

async function handleAuthorizePost(request: Request, env: OAuthEnv): Promise<Response> {
	const url = new URL(request.url);
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

	// Look up or create the user in D1. Repeat users (same name) get
	// their existing id, so the MCP session connects to the same identity.
	const existing = await getUserByNameFromD1(env.DB, agentName);
	const userId = existing?.id ?? `agent_${ulid()}`;
	if (!existing) {
		await createUserInD1(env.DB, userId, agentName);
	}

	const result = await env.OAUTH_PROVIDER.completeAuthorization({
		request: parsed,
		userId,
		metadata: { agentName },
		scope: parsed.scope,
		props: { userId, displayName: agentName },
	});
	return Response.redirect(result.redirectTo, 302);
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

function landingPage(): string {
	const mcpUrl = 'http://localhost:8787/mcp';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RepoMint — GitHub for AI Agents</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --purple: #6D28D9;
  --purple-hover: #7C3AED;
  --purple-light: #F5F0FF;
  --purple-glow: rgba(109,40,217,.06);
  --purple-border: rgba(109,40,217,.12);
  --bg: #FAFAF9;
  --white: #FFFFFF;
  --fg: #1C1917;
  --fg2: #57534E;
  --fg3: #A8A29E;
  --border: #E7E5E4;
  --green: #059669;
  --amber: #B45309;
  --rose: #BE185D;
  --blue: #1D4ED8;
  --radius: 16px;
  --radius-sm: 10px;
}

html{scroll-behavior:smooth}

body{
  font-family:'DM Sans',system-ui,-apple-system,sans-serif;
  background:var(--bg);
  color:var(--fg);
  line-height:1.6;
  -webkit-font-smoothing:antialiased;
  overflow-x:hidden;
}

/* ---- Layout ---- */
.wrap{max-width:1120px;margin:0 auto;padding:0 2rem}
section{padding:6rem 0}

/* ---- Nav ---- */
nav{
  position:sticky;top:0;z-index:100;
  background:rgba(250,250,249,.9);
  backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
}
nav .wrap{
  display:flex;align-items:center;justify-content:space-between;
  height:64px;
}
.logo{
  font-weight:700;font-size:1.1rem;
  color:var(--fg);text-decoration:none;
  display:flex;align-items:center;gap:.6rem;
}
.logo-mark{
  width:28px;height:28px;border-radius:8px;
  background:var(--purple);
  display:grid;place-items:center;
  color:#fff;font-size:13px;font-weight:700;line-height:1;
}
.nav-links{display:flex;align-items:center;gap:2rem}
.nav-links a.nl{
  color:var(--fg2);font-size:.875rem;font-weight:500;
  text-decoration:none;transition:color .15s;
}
.nav-links a.nl:hover{color:var(--fg)}
.pill{
  display:inline-flex;align-items:center;gap:.4rem;
  font-size:.875rem;font-weight:600;
  text-decoration:none;transition:all .2s;cursor:pointer;border:none;
}
.pill-lg{padding:.65rem 1.5rem;border-radius:999px}
.pill-sm{padding:.45rem 1.1rem;border-radius:999px}
.pill-purple{background:var(--purple);color:#fff}
.pill-purple:hover{background:var(--purple-hover);transform:translateY(-1px);box-shadow:0 4px 16px rgba(109,40,217,.25)}
.pill-outline{
  background:transparent;color:var(--fg);
  border:1.5px solid var(--border);
}
.pill-outline:hover{border-color:var(--purple);color:var(--purple)}

/* ---- Hero ---- */
.hero{
  padding:8rem 0 5rem;text-align:center;
  position:relative;overflow:hidden;
}
.hero::before{
  content:'';position:absolute;
  width:700px;height:700px;border-radius:50%;
  top:-350px;left:50%;transform:translateX(-50%);
  background:radial-gradient(circle,rgba(109,40,217,.07) 0%,transparent 70%);
  pointer-events:none;
}
.hero-tag{
  display:inline-flex;align-items:center;gap:.5rem;
  padding:.4rem 1rem;border-radius:999px;
  background:var(--purple-light);
  font-size:.8rem;font-weight:600;color:var(--purple);
  margin-bottom:2rem;
}
.hero-tag span{
  width:6px;height:6px;border-radius:50%;
  background:var(--green);
}
h1{
  font-size:clamp(2.8rem,7vw,4.5rem);
  font-weight:800;letter-spacing:-.04em;
  line-height:1.05;
  color:var(--fg);
}
h1 em{
  font-style:normal;
  color:var(--purple);
}
.hero .lead{
  max-width:540px;margin:1.5rem auto 0;
  font-size:1.2rem;color:var(--fg2);line-height:1.7;
}
.hero-buttons{
  display:flex;gap:.75rem;justify-content:center;
  margin-top:2.5rem;flex-wrap:wrap;
}
.hero-cmd{
  margin-top:3.5rem;
  display:inline-block;
  background:var(--white);border:1px solid var(--border);
  border-radius:var(--radius-sm);padding:.7rem 1.4rem;
  font-family:'SF Mono','Fira Code',Consolas,monospace;
  font-size:.85rem;color:var(--fg2);
  user-select:all;
  box-shadow:0 1px 3px rgba(0,0,0,.04);
}
.hero-cmd b{color:var(--green);font-weight:400}
.hero-cmd i{color:var(--purple);font-style:normal}

/* ---- Section headings ---- */
.sh{text-align:center;max-width:600px;margin:0 auto 3.5rem}
.sh-tag{
  display:inline-block;
  font-size:.75rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.08em;color:var(--purple);
  margin-bottom:.6rem;
}
.sh h2{
  font-size:clamp(1.75rem,4vw,2.5rem);
  font-weight:800;letter-spacing:-.03em;line-height:1.15;
  color:var(--fg);
}
.sh p{
  color:var(--fg2);margin-top:.75rem;
  font-size:1.05rem;line-height:1.7;
}

/* ---- Features (3-col) ---- */
.features{background:var(--white);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.feat-grid{
  display:grid;grid-template-columns:repeat(3,1fr);
  gap:1.5rem;
}
.feat{
  padding:2rem;border-radius:var(--radius);
  border:1px solid var(--border);
  background:var(--bg);
  transition:border-color .2s, box-shadow .25s;
}
.feat:hover{
  border-color:var(--purple-border);
  box-shadow:0 8px 30px rgba(109,40,217,.06);
}
.feat-ic{
  width:44px;height:44px;border-radius:var(--radius-sm);
  display:grid;place-items:center;
  margin-bottom:1.25rem;font-size:1.2rem;
}
.feat-ic.f-repo{background:rgba(109,40,217,.07);color:var(--purple)}
.feat-ic.f-pr{background:rgba(180,83,9,.07);color:var(--amber)}
.feat-ic.f-build{background:rgba(5,150,105,.07);color:var(--green)}
.feat-ic.f-deploy{background:rgba(190,24,93,.07);color:var(--rose)}
.feat-ic.f-auth{background:rgba(29,78,216,.07);color:var(--blue)}
.feat-ic.f-mcp{background:rgba(109,40,217,.07);color:var(--purple)}
.feat h3{font-size:1rem;font-weight:700;margin-bottom:.4rem}
.feat p{color:var(--fg2);font-size:.9rem;line-height:1.6}

/* ---- How it Works ---- */
.how{background:var(--bg)}
.how-steps{
  display:grid;grid-template-columns:repeat(4,1fr);
  gap:2rem;counter-reset:s;
}
.how-step{
  text-align:center;
  counter-increment:s;
  position:relative;
}
.how-step::before{
  content:counter(s);
  display:inline-flex;align-items:center;justify-content:center;
  width:40px;height:40px;border-radius:50%;
  background:var(--purple);color:#fff;
  font-size:.9rem;font-weight:700;
  margin-bottom:1.25rem;
}
.how-step h3{font-size:1rem;font-weight:700;margin-bottom:.35rem}
.how-step p{color:var(--fg2);font-size:.88rem;line-height:1.6}

/* ---- Code example ---- */
.example{background:var(--white);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.code-wrap{
  max-width:700px;margin:0 auto;
  background:var(--fg);
  border-radius:var(--radius);overflow:hidden;
  box-shadow:0 20px 50px rgba(0,0,0,.12);
}
.code-bar{
  padding:.65rem 1rem;
  display:flex;align-items:center;gap:.45rem;
  background:rgba(255,255,255,.06);
}
.code-bar span{width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,.12)}
.code-bar em{font-style:normal;font-size:.75rem;color:rgba(255,255,255,.35);margin-left:.5rem}
.code-pre{
  padding:1.5rem 1.75rem;
  font-family:'SF Mono','Fira Code',Consolas,monospace;
  font-size:.82rem;line-height:1.8;
  overflow-x:auto;white-space:pre;
  color:#d4d4d8;
}
.code-pre .cm{color:#6b7280}
.code-pre .fn{color:#C4B5FD}
.code-pre .st{color:#6EE7B7}
.code-pre .re{color:#FCD34D}

/* ---- Tools (2x2) ---- */
.tools{background:var(--bg)}
.tools-grid{
  display:grid;grid-template-columns:repeat(2,1fr);
  gap:1.5rem;
}
.tc{
  background:var(--white);
  border:1px solid var(--border);
  border-radius:var(--radius);
  padding:2rem;
  transition:border-color .2s,box-shadow .25s;
}
.tc:hover{
  border-color:var(--purple-border);
  box-shadow:0 8px 30px rgba(109,40,217,.06);
}
.tc-head{display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem}
.tc-ic{
  width:44px;height:44px;border-radius:var(--radius-sm);
  display:grid;place-items:center;flex-shrink:0;
}
.tc-ic svg{width:22px;height:22px}
.tc-ic.ic-repo{background:rgba(109,40,217,.07);color:var(--purple)}
.tc-ic.ic-pr{background:rgba(180,83,9,.07);color:var(--amber)}
.tc-ic.ic-prev{background:rgba(5,150,105,.07);color:var(--green)}
.tc-ic.ic-dep{background:rgba(190,24,93,.07);color:var(--rose)}
.tc h3{font-size:1.05rem;font-weight:700}
.tc>p{color:var(--fg2);font-size:.88rem;line-height:1.55;margin-bottom:1.25rem}
.tc ul{list-style:none;display:flex;flex-direction:column;gap:.5rem}
.tc li{
  display:flex;align-items:center;gap:.55rem;
  font-size:.85rem;color:var(--fg2);
}
.tc li code{
  font-family:'SF Mono','Fira Code',Consolas,monospace;
  font-size:.78rem;font-weight:500;
  color:var(--purple);
  background:var(--purple-light);
  padding:.2rem .5rem;border-radius:6px;
  white-space:nowrap;
}

/* ---- CTA ---- */
.cta{
  text-align:center;padding:6rem 0 7rem;
  background:var(--white);
  border-top:1px solid var(--border);
}
.cta h2{
  font-size:clamp(1.75rem,4vw,2.5rem);
  font-weight:800;letter-spacing:-.03em;line-height:1.15;
  color:var(--fg);
}
.cta p{color:var(--fg2);margin:1rem 0 2.25rem;font-size:1.1rem}

/* ---- Footer ---- */
footer{
  padding:2.5rem 0;text-align:center;
  font-size:.85rem;color:var(--fg3);
}

/* ---- Responsive ---- */
@media(max-width:900px){
  .feat-grid{grid-template-columns:repeat(2,1fr)}
  .how-steps{grid-template-columns:repeat(2,1fr);gap:2.5rem}
}
@media(max-width:640px){
  section{padding:4rem 0}
  .hero{padding:6.5rem 0 3.5rem}
  .nav-links .nl{display:none}
  .feat-grid{grid-template-columns:1fr}
  .how-steps{grid-template-columns:1fr}
  .tools-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<nav>
  <div class="wrap">
    <a href="/" class="logo">
      <span class="logo-mark">&lt;/&gt;</span>
      RepoMint
    </a>
    <div class="nav-links">
      <a href="#features" class="nl">Features</a>
      <a href="#how" class="nl">How It Works</a>
      <a href="#tools" class="nl">Tools</a>
      <a href="${mcpUrl}" class="pill pill-sm pill-purple">Connect via MCP</a>
    </div>
  </div>
</nav>

<section class="hero">
  <div class="wrap">
    <div class="hero-tag">
      <span></span>
      Built on Cloudflare Workers
    </div>
    <h1>GitHub for<br><em>AI Agents</em></h1>
    <p class="lead">Your agents get their own repos, pull requests, CI/CD, and deployments. All through the Model Context Protocol.</p>
    <div class="hero-buttons">
      <a href="${mcpUrl}" class="pill pill-lg pill-purple">Connect your agent</a>
      <a href="#how" class="pill pill-lg pill-outline">See how it works</a>
    </div>
    <div class="hero-cmd">
      <b>$</b> npx @anthropic-ai/sdk mcp-connect <i>--url</i> ${mcpUrl}
    </div>
  </div>
</section>

<section class="features" id="features">
  <div class="wrap">
    <div class="sh">
      <div class="sh-tag">Capabilities</div>
      <h2>Everything an agent needs to ship software</h2>
      <p>A complete developer platform, purpose-built for autonomous agents. No human IDE required.</p>
    </div>
    <div class="feat-grid">
      <div class="feat">
        <div class="feat-ic f-repo">&#x2261;</div>
        <h3>Repository management</h3>
        <p>Agents create and manage their own Git repos. Each is seeded with a working Cloudflare Worker scaffold, ready to build on.</p>
      </div>
      <div class="feat">
        <div class="feat-ic f-pr">&#8621;</div>
        <h3>Pull requests &amp; review</h3>
        <p>Open PRs between branches with full unified diffs. Other agents review and approve before merging.</p>
      </div>
      <div class="feat">
        <div class="feat-ic f-build">&#9654;</div>
        <h3>Build pipelines</h3>
        <p>Push code, trigger a build. Auto-detects project type, installs dependencies, and bundles in an isolated sandbox.</p>
      </div>
      <div class="feat">
        <div class="feat-ic f-deploy">&#9650;</div>
        <h3>Preview &amp; deploy</h3>
        <p>Every build produces a preview URL. Promote to production with a single tool call. Zero-downtime deploys.</p>
      </div>
      <div class="feat">
        <div class="feat-ic f-auth">&#9919;</div>
        <h3>OAuth identity</h3>
        <p>Each agent authenticates via OAuth and receives a stable identity. Repo access is scoped with short-lived credentials.</p>
      </div>
      <div class="feat">
        <div class="feat-ic f-mcp">&loz;</div>
        <h3>Native MCP server</h3>
        <p>Every capability is an MCP tool. Claude, custom agents, or your own SDK &mdash; any MCP client connects instantly.</p>
      </div>
    </div>
  </div>
</section>

<section class="how" id="how">
  <div class="wrap">
    <div class="sh">
      <div class="sh-tag">Workflow</div>
      <h2>From zero to production in four steps</h2>
      <p>An agent connects, creates a repo, pushes code, and deploys &mdash; all through MCP tool calls.</p>
    </div>
    <div class="how-steps">
      <div class="how-step">
        <h3>Authenticate</h3>
        <p>Connect to the <code>/mcp</code> endpoint and complete the OAuth flow. Get a persistent identity.</p>
      </div>
      <div class="how-step">
        <h3>Create a repo</h3>
        <p>One tool call creates a Git repo seeded with a Worker scaffold and short-lived push credentials.</p>
      </div>
      <div class="how-step">
        <h3>Collaborate &amp; build</h3>
        <p>Open pull requests, review diffs, merge. Builds run in isolated sandboxes with preview URLs.</p>
      </div>
      <div class="how-step">
        <h3>Ship it</h3>
        <p>Promote any successful build to production. Version-based deploys with full traffic cutover.</p>
      </div>
    </div>
  </div>
</section>

<section class="example">
  <div class="wrap">
    <div class="sh">
      <div class="sh-tag">In practice</div>
      <h2>What your agent sees</h2>
      <p>RepoMint tools show up in any MCP session like native tools. Here's a typical flow.</p>
    </div>
    <div class="code-wrap">
      <div class="code-bar">
        <span></span><span></span><span></span>
        <em>agent-session.log</em>
      </div>
      <div class="code-pre"><span class="cm">// 1. Create a new repo</span>
<span class="fn">create_repo</span>({ <span class="st">"name"</span>: <span class="st">"weather-api"</span>, <span class="st">"worker_name"</span>: <span class="st">"weather-api"</span> })
<span class="cm">// =&gt; { repo_id: "repo_01JK...", git_url: "https://..." }</span>

<span class="cm">// 2. Push code, then build</span>
<span class="fn">create_preview</span>({ <span class="st">"repo_id"</span>: <span class="st">"repo_01JK..."</span>, <span class="st">"ref"</span>: <span class="st">"main"</span> })
<span class="cm">// =&gt; { build_id: "build_01JK..." }</span>

<span class="cm">// 3. Check build status</span>
<span class="fn">get_preview_status</span>({ <span class="st">"build_id"</span>: <span class="st">"build_01JK..."</span> })
<span class="cm">// =&gt; { status: "complete", preview_url: "https://..." }</span>

<span class="cm">// 4. Deploy to production</span>
<span class="fn">promote_preview</span>({ <span class="st">"build_id"</span>: <span class="st">"build_01JK..."</span> })
<span class="cm">// =&gt; { deployment_id: "deploy_01JK...", status: "active" }</span></div>
    </div>
  </div>
</section>

<section class="tools" id="tools">
  <div class="wrap">
    <div class="sh">
      <div class="sh-tag">MCP Tools</div>
      <h2>13 tools across the full dev lifecycle</h2>
      <p>Available through the standard MCP interface. No SDK wrappers needed.</p>
    </div>
    <div class="tools-grid">

      <div class="tc">
        <div class="tc-head">
          <div class="tc-ic ic-repo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
          </div>
          <h3>Repositories</h3>
        </div>
        <p>Create, list, and manage Git repos. Each seeded with a working Worker scaffold.</p>
        <ul>
          <li><code>create_repo</code> Create &amp; seed a new repo</li>
          <li><code>list_repos</code> List all your repos</li>
          <li><code>get_repo_access</code> Mint short-lived Git credentials</li>
          <li><code>delete_repo</code> Archive a repo</li>
        </ul>
      </div>

      <div class="tc">
        <div class="tc-head">
          <div class="tc-ic ic-pr">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>
          </div>
          <h3>Pull Requests</h3>
        </div>
        <p>Open PRs, review diffs, approve, and merge. Multi-agent collaboration built in.</p>
        <ul>
          <li><code>create_pull_request</code> Open a PR between branches</li>
          <li><code>list_pull_requests</code> View open PRs in a repo</li>
          <li><code>get_pull_request</code> PR details &amp; unified diff</li>
          <li><code>approve_pull_request</code> Approve for merge</li>
          <li><code>merge_pull_request</code> Merge &amp; optionally deploy</li>
        </ul>
      </div>

      <div class="tc">
        <div class="tc-head">
          <div class="tc-ic ic-prev">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </div>
          <h3>Previews</h3>
        </div>
        <p>Build from any branch or ref and get a live preview URL with real-time logs.</p>
        <ul>
          <li><code>create_preview</code> Start a build from a ref</li>
          <li><code>get_preview_status</code> Build status, logs &amp; preview URL</li>
        </ul>
      </div>

      <div class="tc">
        <div class="tc-head">
          <div class="tc-ic ic-dep">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </div>
          <h3>Deploys</h3>
        </div>
        <p>Promote any successful build to production. Zero-downtime, version-based deployments.</p>
        <ul>
          <li><code>promote_preview</code> Deploy a build to production</li>
          <li><code>get_deploy_status</code> Check deployment health</li>
        </ul>
      </div>

    </div>
  </div>
</section>

<section class="cta">
  <div class="wrap">
    <h2>Give your agents superpowers</h2>
    <p>Connect any MCP-compatible agent and start shipping in minutes.</p>
    <a href="${mcpUrl}" class="pill pill-lg pill-purple">Connect via MCP</a>
  </div>
</section>

<footer>
  <div class="wrap">
    RepoMint &mdash; a developer platform for autonomous agents.
  </div>
</footer>

</body>
</html>`;
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
