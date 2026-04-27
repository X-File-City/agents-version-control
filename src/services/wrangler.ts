// Pure helpers for wrangler-related strings and output parsing.
//
// Kept free of Workers/Sandbox imports so these can be unit-tested in plain
// Node. The sandbox-invocation wrapper lives in `./wrangler-run.ts`.

import { CLOUDFLARE_ACCOUNT_ID } from '../config';

// A minimal wrangler.jsonc we commit as the initial repo payload so that
// `wrangler versions upload` works out-of-the-box. The agent is free to
// replace it with anything valid.

export function initialWranglerConfig(workerName: string): string {
	const config = {
		$schema: 'node_modules/wrangler/config-schema.json',
		name: workerName,
		account_id: CLOUDFLARE_ACCOUNT_ID,
		main: 'src/index.ts',
		compatibility_date: '2026-04-23',
		compatibility_flags: ['nodejs_compat'],
		observability: { enabled: true },
	};
	return JSON.stringify(config, null, '\t') + '\n';
}

export function initialWorkerSource(): string {
	return (
		'export default {\n' +
		"\tasync fetch(_request: Request): Promise<Response> {\n" +
		"\t\treturn new Response('hello from a fresh github-for-agents worker');\n" +
		'\t},\n' +
		'};\n'
	);
}

export function initialPackageJson(workerName: string): string {
	const pkg = {
		name: workerName,
		private: true,
		version: '0.0.0',
		scripts: {
			deploy: `CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID} wrangler deploy`,
			dev: `CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID} wrangler dev`,
		},
		devDependencies: {
			wrangler: '^4.84.1',
		},
	};
	return JSON.stringify(pkg, null, '\t') + '\n';
}

export interface UploadedVersion {
	versionId: string;
	previewUrl: string | null;
	raw: string;
}

interface CloudflareApiError {
	code?: number;
	message?: string;
}

interface WorkersScriptSummary {
	id?: string;
}

interface WorkersScriptsListResponse {
	success?: boolean;
	result?: WorkersScriptSummary[];
	errors?: CloudflareApiError[];
}

// `wrangler versions upload` prints a human-readable block. The exact JSON
// flag varies between wrangler releases, so we parse defensively from stdout.
export function parseVersionsUpload(stdout: string): UploadedVersion | null {
	const idMatch =
		stdout.match(/Worker Version ID:\s*([\w-]+)/i) ||
		stdout.match(/Version ID:\s*([\w-]+)/i);
	if (!idMatch) return null;
	const previewMatch = stdout.match(/https?:\/\/[\w.-]+\.workers\.dev\S*/);
	return {
		versionId: idMatch[1],
		previewUrl: previewMatch ? previewMatch[0] : null,
		raw: stdout,
	};
}

export function parseWorkersScriptList(
	payload: unknown,
	workerName: string,
): { exists: boolean; error: string | null } {
	const body = payload as WorkersScriptsListResponse | null;
	if (!body || typeof body !== 'object') {
		return { exists: false, error: 'workers/scripts returned a non-object response' };
	}

	if (body.success !== true) {
		const firstError = body.errors?.[0];
		const detail = firstError?.message?.trim();
		return {
			exists: false,
			error: detail ? `workers/scripts API reported an error: ${detail}` : 'workers/scripts API reported an error',
		};
	}

	const scripts = Array.isArray(body.result) ? body.result : [];
	const exists = scripts.some((script) => script?.id === workerName);
	return { exists, error: null };
}
