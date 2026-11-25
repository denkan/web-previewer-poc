/**
 * Response cache in R2: c/{hashOrigin(origin)}/{sha256(modeKey + path + query)}.
 * Stores the *rewritten* bytes, so a cache hit is a straight R2 read with no parsing.
 * The per-origin prefix makes "purge this origin" a prefix delete; the origin itself is kept in metadata.
 */
import { hashOrigin } from './registry';

const KEEP_HEADERS = ['content-type', 'content-language', 'content-disposition', 'location', 'last-modified'];
const NULL_BODY = new Set([101, 204, 205, 304]);

const prefix = (origin: string) => `c/${hashOrigin(origin)}/`;

async function key(origin: string, path: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${prefix(origin)}${hex.slice(0, 40)}`;
}

export class HttpCache {
	constructor(private store: R2Bucket) {}

	async get(origin: string, path: string): Promise<Response | null> {
		const obj = await this.store.get(await key(origin, path));
		if (!obj) return null;
		const meta = obj.customMetadata ?? {};
		const status = Number(meta.status || 200);
		const headers = new Headers(JSON.parse(meta.headers || '[]'));
		return new Response(NULL_BODY.has(status) ? null : obj.body, { status, headers });
	}

	/** Set-Cookie is never stored (it isn't in KEEP_HEADERS): a cached response is shared by every viewer. */
	async put(origin: string, path: string, status: number, headers: Headers, body: ArrayBuffer): Promise<void> {
		const kept = KEEP_HEADERS.flatMap((k) => {
			const v = headers.get(k);
			return v ? [[k, v]] : [];
		});
		await this.store.put(await key(origin, path), body, {
			customMetadata: { origin, status: String(status), headers: JSON.stringify(kept), url: path.slice(0, 256) },
		});
	}

	/** entries: [origin, cache path] pairs. R2 delete is idempotent. */
	async purgeEntries(entries: [string, string][]): Promise<void> {
		const keys = await Promise.all(entries.map(([o, p]) => key(o, p)));
		for (let i = 0; i < keys.length; i += 1000) await this.store.delete(keys.slice(i, i + 1000));
	}

	purgeOrigin(origin: string): Promise<number> {
		return this.purgePrefix(prefix(origin));
	}

	purgeAll(): Promise<number> {
		return this.purgePrefix('c/');
	}

	private async purgePrefix(p: string): Promise<number> {
		let n = 0;
		let cursor: string | undefined;
		do {
			const page = await this.store.list({ prefix: p, cursor, limit: 1000 });
			if (page.objects.length) {
				await this.store.delete(page.objects.map((o) => o.key));
				n += page.objects.length;
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		return n;
	}

	async stats(): Promise<Record<string, { objects: number; bytes: number }>> {
		const out: Record<string, { objects: number; bytes: number }> = {};
		let cursor: string | undefined;
		do {
			const page = await this.store.list({ prefix: 'c/', cursor, limit: 1000, include: ['customMetadata'] });
			for (const o of page.objects) {
				const origin = o.customMetadata?.origin ?? `? ${o.key.split('/')[1]}`;
				const s = (out[origin] ??= { objects: 0, bytes: 0 });
				s.objects++;
				s.bytes += o.size;
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		return out;
	}
}
