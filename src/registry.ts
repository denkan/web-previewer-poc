/**
 * Origin dictionary: short hash <-> origin ("https://cdn.example.com").
 * Persisted in R2 under o/{hash} (strongly consistent), memoized per isolate.
 */

const byHash = new Map<string, string>();
const byOrigin = new Map<string, string>();

/** cyrb53: fast, synchronous 53-bit hash, base36 encoded (~11 chars). Plenty for a dictionary of origins. */
export function hashOrigin(origin: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < origin.length; i++) {
		const ch = origin.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class Registry {
	constructor(private store: R2Bucket) {}

	isKnown(origin: string): boolean {
		return byOrigin.has(origin);
	}

	/** Synchronous: the hash is deterministic, so rewriting never waits on storage to compute it. */
	hashOf(origin: string): string {
		return byOrigin.get(origin) ?? hashOrigin(origin);
	}

	/** Persist origin -> hash. Awaited before a rewritten URL is emitted, so the browser can never request an unknown hash. */
	async register(origin: string): Promise<string> {
		const known = byOrigin.get(origin);
		if (known) return known;
		const hash = hashOrigin(origin);
		const key = `o/${hash}`;
		const existing = await this.store.head(key);
		if (existing) {
			if (existing.customMetadata?.origin !== origin) {
				throw new Error(`Hash collision on ${hash}: ${existing.customMetadata?.origin} vs ${origin}`);
			}
		} else {
			await this.store.put(key, origin, { customMetadata: { origin, created: new Date().toISOString() } });
		}
		byHash.set(hash, origin);
		byOrigin.set(origin, hash);
		return hash;
	}

	async lookup(hash: string): Promise<string | null> {
		const mem = byHash.get(hash);
		if (mem) return mem;
		const obj = await this.store.head(`o/${hash}`);
		const origin = obj?.customMetadata?.origin;
		if (!origin) return null;
		byHash.set(hash, origin);
		byOrigin.set(origin, hash);
		return origin;
	}

	async list(): Promise<{ hash: string; origin: string; created: string }[]> {
		const out: { hash: string; origin: string; created: string }[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.store.list({ prefix: 'o/', cursor, include: ['customMetadata'] });
			for (const o of page.objects) {
				out.push({ hash: o.key.slice(2), origin: o.customMetadata?.origin ?? '?', created: o.customMetadata?.created ?? '' });
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		return out;
	}
}
