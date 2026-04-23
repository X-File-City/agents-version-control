// Egress gateway for Sandbox containers.
//
// The Sandbox SDK forwards every outbound fetch() from inside a container to
// this Worker. We rewrite requests headed for api.cloudflare.com to include
// the platform's Cloudflare API token, and forward everything else verbatim.

interface Env {
	CF_API_TOKEN: string;
}

const CF_API_HOST = 'api.cloudflare.com';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.hostname === CF_API_HOST) {
			if (!env.CF_API_TOKEN) {
				return new Response('outbound worker missing CF_API_TOKEN secret', { status: 500 });
			}
			const headers = new Headers(request.headers);
			// Overwrite any sandbox-provided placeholder so the real token is
			// the only thing that leaves this Worker.
			headers.set('Authorization', `Bearer ${env.CF_API_TOKEN}`);
			return fetch(url.toString(), {
				method: request.method,
				headers,
				body: request.body,
				redirect: 'manual',
			});
		}

		// Pass-through for everything else. In a hardened deployment we'd
		// whitelist the npm registry, GitHub, etc., and block the rest.
		return fetch(request);
	},
} satisfies ExportedHandler<Env>;
