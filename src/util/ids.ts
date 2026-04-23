// Minimal ULID generator (Crockford base32, time + randomness).
// Good enough for per-agent ids where cross-agent uniqueness is not required,
// and still sortable by creation time.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, len = 10): string {
	let out = '';
	for (let i = len - 1; i >= 0; i--) {
		const mod = now % 32;
		out = ENCODING[mod] + out;
		now = (now - mod) / 32;
	}
	return out;
}

function encodeRandom(len = 16): string {
	const bytes = new Uint8Array(len);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < len; i++) out += ENCODING[bytes[i] % 32];
	return out;
}

export function ulid(): string {
	return encodeTime(Date.now()) + encodeRandom();
}
