import { Volume, createFsFromVolume } from 'memfs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

import {
	initialPackageJson,
	initialWorkerSource,
	initialWranglerConfig,
} from './wrangler';

const SEED_DIR = '/seed';

export interface SeedRepoArgs {
	gitUrl: string;
	workerName: string;
	displayName: string;
}

export async function seedRepoInMemory(args: SeedRepoArgs): Promise<void> {
	const redactedRemote = redactCredentials(args.gitUrl);
	console.info('[seed] starting in-memory repo seed', {
		workerName: args.workerName,
		displayName: args.displayName,
		remote: redactedRemote,
	});

	const volume = new Volume();
	const fs = createFsFromVolume(volume);
	const gitFs = fs as unknown as Parameters<typeof git.clone>[0]['fs'];
	const remote = toRemoteWithAuth(args.gitUrl);

	console.info('[seed] cloning remote', { remote: redactedRemote });
	try {
		await git.clone({
			fs: gitFs,
			http,
			dir: SEED_DIR,
			url: args.gitUrl,
			noCheckout: false,
			singleBranch: false,
			onAuth: () => ({ username: remote.username, password: remote.password }),
			onAuthFailure: (url) => {
				console.error('[seed] clone auth failure', {
					remote: redactCredentials(String(url)),
				});
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[seed] clone failed', {
			remote: redactedRemote,
			error: message,
		});
		throw err;
	}

	await ensureMainBranch(gitFs);

	await fs.promises.mkdir(`${SEED_DIR}/src`, { recursive: true });
	await fs.promises.writeFile(
		`${SEED_DIR}/wrangler.jsonc`,
		initialWranglerConfig(args.workerName),
		{ encoding: 'utf8' },
	);
	await fs.promises.writeFile(`${SEED_DIR}/src/index.ts`, initialWorkerSource(), {
		encoding: 'utf8',
	});
	await fs.promises.writeFile(
		`${SEED_DIR}/package.json`,
		initialPackageJson(args.workerName),
		{ encoding: 'utf8' },
	);
	await fs.promises.writeFile(`${SEED_DIR}/.gitignore`, 'node_modules\n.wrangler\n', {
		encoding: 'utf8',
	});

	await git.init({
		fs: gitFs,
		dir: SEED_DIR,
		defaultBranch: 'main',
	});

	await git.add({
		fs: gitFs,
		dir: SEED_DIR,
		filepath: 'wrangler.jsonc',
	});
	await git.add({
		fs: gitFs,
		dir: SEED_DIR,
		filepath: 'src/index.ts',
	});
	await git.add({
		fs: gitFs,
		dir: SEED_DIR,
		filepath: 'package.json',
	});
	await git.add({
		fs: gitFs,
		dir: SEED_DIR,
		filepath: '.gitignore',
	});

	const author = {
		name: args.displayName,
		email: `${emailLocalPart(args.displayName)}@github-for-agents.local`,
	};

	await git.commit({
		fs: gitFs,
		dir: SEED_DIR,
		author,
		message: 'initial commit (seeded by github-for-agents)',
	});

	try {
		await git.push({
			fs: gitFs,
			http,
			dir: SEED_DIR,
			remote: 'origin',
			ref: 'main',
			onAuth: () => ({ username: remote.username, password: remote.password }),
			onAuthFailure: (url) => {
				console.error('[seed] push auth failure', {
					remote: redactCredentials(String(url)),
				});
			},
		});
		console.info('[seed] push complete', { remote: redactedRemote });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[seed] push failed', {
			remote: redactedRemote,
			error: message,
		});
		throw err;
	}
}

interface RemoteWithAuth {
	username: string;
	password: string;
}

function toRemoteWithAuth(gitUrl: string): RemoteWithAuth {
	const parsed = new URL(gitUrl);
	const password = parsed.password;
	if (!password) {
		throw new Error('seed git URL is missing credentials');
	}
	const username = parsed.username || 'x-access-token';
	parsed.username = '';
	parsed.password = '';
	return {
		username,
		password,
	};
}

function emailLocalPart(displayName: string): string {
	const local = displayName
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return local || 'agent';
}

async function ensureMainBranch(fs: Parameters<typeof git.clone>[0]['fs']): Promise<void> {
	const current = await git.currentBranch({
		fs,
		dir: SEED_DIR,
		fullname: false,
	});
	if (current === 'main') return;
	await git.branch({
		fs,
		dir: SEED_DIR,
		ref: 'main',
		checkout: true,
		force: true,
	});
}

function redactCredentials(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = parsed.username ? 'x-access-token' : '';
			parsed.password = parsed.password ? '***' : '';
		}
		return parsed.toString();
	} catch {
		return '<invalid-url>';
	}
}
