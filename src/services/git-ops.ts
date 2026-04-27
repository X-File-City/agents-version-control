import { Volume, createFsFromVolume } from 'memfs';
import git, { TREE } from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { createTwoFilesPatch } from 'diff';

import { redactCredentials } from '../util/urls';
import { errorMessage } from '../util/errors';

const WORK_DIR = '/gitops';

export interface DiffResult {
	diff: string;
	stats: { files_changed: number; additions: number; deletions: number };
}

export async function generateDiff(
	gitUrl: string,
	baseBranch: string,
	headBranch: string,
): Promise<DiffResult> {
	const volume = new Volume();
	const fs = createFsFromVolume(volume);
	const gitFs = fs as unknown as Parameters<typeof git.clone>[0]['fs'];
	const auth = extractAuth(gitUrl);

	await git.clone({
		fs: gitFs,
		http,
		dir: WORK_DIR,
		url: gitUrl,
		noCheckout: true,
		singleBranch: false,
		onAuth: () => auth,
	});

	const baseOid = await git.resolveRef({ fs: gitFs, dir: WORK_DIR, ref: `origin/${baseBranch}` });
	const headOid = await git.resolveRef({ fs: gitFs, dir: WORK_DIR, ref: `origin/${headBranch}` });

	const patches: string[] = [];
	let filesChanged = 0;
	let totalAdditions = 0;
	let totalDeletions = 0;

	await git.walk({
		fs: gitFs,
		dir: WORK_DIR,
		trees: [TREE({ ref: baseOid }), TREE({ ref: headOid })],
		map: async (filepath, [baseEntry, headEntry]) => {
			if (filepath === '.') return;

			const baseType = baseEntry ? await baseEntry.type() : undefined;
			const headType = headEntry ? await headEntry.type() : undefined;

			// Skip directories — we only diff blobs
			if (baseType === 'tree' || headType === 'tree') return;

			const baseOidFile = baseEntry ? await baseEntry.oid() : undefined;
			const headOidFile = headEntry ? await headEntry.oid() : undefined;

			// No change
			if (baseOidFile === headOidFile) return;

			const baseContent = baseEntry ? uint8ToString(await baseEntry.content() as Uint8Array | undefined) : '';
			const headContent = headEntry ? uint8ToString(await headEntry.content() as Uint8Array | undefined) : '';

			const patch = createTwoFilesPatch(
				`a/${filepath}`,
				`b/${filepath}`,
				baseContent,
				headContent,
			);

			// Count additions/deletions from the patch lines
			for (const line of patch.split('\n')) {
				if (line.startsWith('+') && !line.startsWith('+++')) totalAdditions++;
				if (line.startsWith('-') && !line.startsWith('---')) totalDeletions++;
			}

			filesChanged++;
			patches.push(patch);
		},
	});

	return {
		diff: patches.join('\n'),
		stats: { files_changed: filesChanged, additions: totalAdditions, deletions: totalDeletions },
	};
}

export async function performMerge(
	gitUrl: string,
	baseBranch: string,
	headBranch: string,
	authorName: string,
): Promise<{ commitSha: string }> {
	const redacted = redactCredentials(gitUrl);
	console.info('[git-ops] starting merge', { baseBranch, headBranch, remote: redacted });

	const volume = new Volume();
	const fs = createFsFromVolume(volume);
	const gitFs = fs as unknown as Parameters<typeof git.clone>[0]['fs'];
	const auth = extractAuth(gitUrl);

	await git.clone({
		fs: gitFs,
		http,
		dir: WORK_DIR,
		url: gitUrl,
		ref: baseBranch,
		singleBranch: false,
		onAuth: () => auth,
	});

	await git.checkout({ fs: gitFs, dir: WORK_DIR, ref: baseBranch });

	// Fetch to ensure head branch refs are up to date
	await git.fetch({
		fs: gitFs,
		http,
		dir: WORK_DIR,
		ref: headBranch,
		onAuth: () => auth,
	});

	const author = {
		name: authorName,
		email: `${emailLocal(authorName)}@github-for-agents.local`,
	};

	try {
		await git.merge({
			fs: gitFs,
			dir: WORK_DIR,
			ours: baseBranch,
			theirs: `origin/${headBranch}`,
			author,
		});
	} catch (err) {
		const msg = errorMessage(err);
		if (msg.toLowerCase().includes('conflict')) {
			throw new Error(`Merge conflict between ${headBranch} and ${baseBranch}. Please resolve conflicts manually before merging.`);
		}
		throw new Error(`Merge failed: ${msg}`);
	}

	const commitSha = await git.resolveRef({ fs: gitFs, dir: WORK_DIR, ref: 'HEAD' });

	await git.push({
		fs: gitFs,
		http,
		dir: WORK_DIR,
		ref: baseBranch,
		onAuth: () => auth,
		onAuthFailure: (url) => {
			console.error('[git-ops] push auth failure', { remote: redactCredentials(String(url)) });
		},
	});

	console.info('[git-ops] merge complete', { commitSha, remote: redacted });
	return { commitSha };
}

function extractAuth(gitUrl: string): { username: string; password: string } {
	const parsed = new URL(gitUrl);
	if (!parsed.password) throw new Error('git URL is missing credentials');
	return {
		username: parsed.username || 'x-access-token',
		password: parsed.password,
	};
}

function uint8ToString(buf: Uint8Array | undefined): string {
	if (!buf) return '';
	return new TextDecoder().decode(buf);
}

function emailLocal(name: string): string {
	const local = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return local || 'agent';
}
