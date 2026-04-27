import { sh, type SandboxHandle, type ShellResult } from './sandbox';
import { CLOUDFLARE_ACCOUNT_ID } from '../config';

// Run wrangler with CF creds passed directly into sandbox command env.

export async function wrangler(
	sb: SandboxHandle,
	args: string,
	cwd: string,
	apiToken: string,
	timeoutMs = 300_000,
): Promise<ShellResult> {
	// `npx --yes` avoids interactive install prompts when wrangler isn't
	// present in the target repo yet.
	return sh(sb, `npx --yes wrangler ${args}`, {
		cwd,
		env: {
			CLOUDFLARE_API_TOKEN: apiToken,
			CLOUDFLARE_ACCOUNT_ID,
			CI: 'true',
		},
		timeoutMs,
	});
}
