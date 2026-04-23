export function redactCredentials(url: string): string {
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
