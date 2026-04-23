import { getSandbox, type Sandbox as SandboxType } from '@cloudflare/sandbox';

export type SandboxHandle = ReturnType<typeof getSandbox<SandboxType>>;

export function sandboxFor(
	namespace: DurableObjectNamespace<SandboxType>,
	id: string,
): SandboxHandle {
	return getSandbox(namespace, id);
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	success: boolean;
	command: string;
}

interface GitCheckoutOptions {
	branch?: string;
	depth?: number;
	targetDir?: string;
}

// Small wrapper that narrows the shape we care about and never throws on
// non-zero exit — the caller decides what a failed step means.
export async function sh(
	sb: SandboxHandle,
	command: string,
	opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ShellResult> {
	try {
		const res = await sb.exec(command, {
			cwd: opts?.cwd,
			env: opts?.env,
			timeout: opts?.timeoutMs,
		} as Parameters<SandboxHandle['exec']>[1]);
		return {
			stdout: res.stdout ?? '',
			stderr: res.stderr ?? '',
			exitCode: res.exitCode ?? (res.success ? 0 : 1),
			success: res.success ?? (res.exitCode === 0),
			command,
		};
	} catch (err) {
		return {
			stdout: '',
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: -1,
			success: false,
			command,
		};
	}
}

// Prefer the Sandbox SDK's native Git API when available. We keep the same
// shell-like return shape for consistent logging at call sites.
export async function gitCheckout(
	sb: SandboxHandle,
	repoUrl: string,
	opts?: GitCheckoutOptions,
): Promise<ShellResult> {
	try {
		const maybeGit = sb as unknown as {
			gitCheckout?: (url: string, options?: GitCheckoutOptions) => Promise<unknown>;
		};
		if (typeof maybeGit.gitCheckout !== 'function') {
			return {
				stdout: '',
				stderr: 'sandbox gitCheckout API not available',
				exitCode: -1,
				success: false,
				command: 'gitCheckout',
			};
		}
		await maybeGit.gitCheckout(repoUrl, opts);
		return {
			stdout: '',
			stderr: '',
			exitCode: 0,
			success: true,
			command: 'gitCheckout',
		};
	} catch (err) {
		return {
			stdout: '',
			stderr: err instanceof Error ? err.message : String(err),
			exitCode: -1,
			success: false,
			command: 'gitCheckout',
		};
	}
}

// Keeps only the last N characters of a potentially large log blob so it fits
// comfortably in SQLite rows without special-casing.
export function tailLogs(text: string, maxBytes = 8_000): string {
	if (text.length <= maxBytes) return text;
	return '…(truncated)…\n' + text.slice(text.length - maxBytes);
}
