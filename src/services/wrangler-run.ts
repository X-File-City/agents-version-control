import { sh, type SandboxHandle, type ShellResult } from './sandbox';

// Run wrangler with the CF creds coming in via the Outbound Worker (not via
// env vars inside the sandbox). Wrangler still expects *some* auth hint to
// avoid prompting, so we set CLOUDFLARE_API_TOKEN to a placeholder that the
// Outbound Worker will replace with the real token at egress.
const PLACEHOLDER_TOKEN = 'placeholder-replaced-at-egress';

export async function wrangler(
	sb: SandboxHandle,
	args: string,
	cwd: string,
): Promise<ShellResult> {
	return sh(sb, `npx wrangler ${args}`, {
		cwd,
		env: {
			CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
			CI: 'true',
		},
		timeoutMs: 180_000,
	});
}
