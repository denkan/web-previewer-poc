/**
 * Server-side cookie jar for live mode: one Durable Object per preview session.
 *
 * - Cookie semantics come from tough-cookie (RFC 6265: Domain/Path matching, Secure, __Host-/__Secure- prefixes,
 *   Public Suffix List via tldts, SameSite contexts, Expires/Max-Age). On top: Chrome's defaults/limits
 *   (SameSite=Lax when unspecified, 4096-byte cookies, 180 per domain, 3000 total).
 * - Storage only ever holds AES-GCM ciphertext. The AES key is derived (HKDF) from a 256-bit secret that lives only in
 *   the user's HttpOnly __px_sid cookie, salted with an optional server master key. A storage dump alone is useless.
 *   The decrypted jar exists in this object's memory only while the session is active.
 * - Sliding idle TTL: every access pushes the alarm forward; when it fires, deleteAll().
 * - Nothing here logs or rethrows anything that could contain a cookie.
 */
import { DurableObject } from 'cloudflare:workers';
import { getPublicSuffix } from 'tldts';
import { CookieJar } from 'tough-cookie';
import type { Env } from './env';

export type SameSiteContext = 'strict' | 'lax' | 'none';

const MAX_COOKIE_BYTES = 4096; // name + value
const MAX_PER_DOMAIN = 180;
const MAX_TOTAL = 3000;
const JAR_OPTIONS = { rejectPublicSuffixes: true, prefixSecurity: 'silent' as const };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64(s: string): Uint8Array {
	const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export class InvalidSessionKey extends Error {}

export class CookieJarDO extends DurableObject<Env> {
	private jar: CookieJar | null = null;
	private keyId: string | null = null; // fingerprint of the secret that decrypted `jar`
	private aes: CryptoKey | null = null;
	private ttlSeconds: number | null = null;

	/** Cookie header for an upstream request to `url`. */
	async header(secret: string, url: string, sameSite: SameSiteContext): Promise<string> {
		const jar = await this.open(secret);
		return jar.getCookieStringSync(url, { http: true, sameSiteContext: sameSite });
	}

	/** Absorb upstream Set-Cookie headers (they never reach the browser). */
	async absorb(secret: string, url: string, setCookies: string[], sameSite: SameSiteContext): Promise<void> {
		const jar = await this.open(secret);
		let changed = false;
		for (const sc of setCookies) changed = this.setOne(jar, sc, url, { http: true, sameSiteContext: sameSite }) || changed;
		if (changed) await this.persist();
	}

	/** What document.cookie should read for a page at `url` (no HttpOnly cookies). */
	async documentCookie(secret: string, url: string): Promise<string> {
		const jar = await this.open(secret);
		return jar.getCookieStringSync(url, { http: false, sameSiteContext: 'strict' });
	}

	/** A `document.cookie = "..."` write from a page at `url`. HttpOnly is refused, as in a browser. */
	async setFromDocument(secret: string, url: string, cookie: string): Promise<void> {
		const jar = await this.open(secret);
		if (this.setOne(jar, cookie, url, { http: false, sameSiteContext: 'strict' })) await this.persist();
	}

	/** Cookie count only — never names or values. */
	async info(secret: string): Promise<{ cookies: number; stored: boolean; ttlSeconds: number }> {
		const jar = await this.open(secret);
		return { cookies: jar.serializeSync()?.cookies.length ?? 0, stored: !!(await this.ctx.storage.get('jar')), ttlSeconds: await this.ttl() };
	}

	async setIdleTtl(seconds: number): Promise<void> {
		this.ttlSeconds = Math.max(1, Math.min(seconds, this.defaultTtl()));
		await this.ctx.storage.put('ttl', this.ttlSeconds);
		await this.touch();
	}

	async reset(): Promise<void> {
		await this.wipe();
	}

	async alarm(): Promise<void> {
		await this.wipe();
	}

	// --- internals ---------------------------------------------------------------------------------

	private async wipe(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.jar = null;
		this.keyId = null;
		this.aes = null;
		this.ttlSeconds = null;
	}

	private defaultTtl(): number {
		return Number(this.env.JAR_IDLE_TTL_SECONDS) || 86400;
	}

	private async ttl(): Promise<number> {
		this.ttlSeconds ??= (await this.ctx.storage.get<number>('ttl')) ?? this.defaultTtl();
		return this.ttlSeconds;
	}

	/** Sliding idle expiry. */
	private async touch(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + (await this.ttl()) * 1000);
	}

	private aad(): Uint8Array {
		return enc.encode(this.ctx.id.toString()); // binds ciphertext to this jar: can't be swapped into another session
	}

	private async open(secret: string): Promise<CookieJar> {
		let raw: Uint8Array;
		try {
			raw = fromB64(secret);
		} catch {
			throw new InvalidSessionKey('bad key');
		}
		if (raw.length !== 32) throw new InvalidSessionKey('bad key');
		const keyId = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
		// Never hand the in-memory plaintext to a caller holding a different key.
		if (this.jar && this.keyId === keyId) {
			await this.touch();
			return this.jar;
		}
		const aes = await deriveKey(raw, this.env.JAR_MASTER_KEY);
		const stored = await this.ctx.storage.get<{ iv: Uint8Array; ct: ArrayBuffer }>('jar');
		let jar: CookieJar;
		if (stored) {
			let plain: ArrayBuffer;
			try {
				plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: this.aad() }, aes, stored.ct);
			} catch {
				throw new InvalidSessionKey('wrong key'); // GCM auth failure: wrong user key or master key
			}
			jar = CookieJar.deserializeSync(JSON.parse(dec.decode(plain)));
		} else {
			jar = new CookieJar(undefined, JAR_OPTIONS);
		}
		this.jar = jar;
		this.keyId = keyId;
		this.aes = aes;
		await this.touch();
		return jar;
	}

	private async persist(): Promise<void> {
		if (!this.jar || !this.aes) return;
		this.enforceLimits();
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad() }, this.aes, enc.encode(JSON.stringify(this.jar.serializeSync())));
		await this.ctx.storage.put('jar', { iv, ct });
	}

	private setOne(jar: CookieJar, cookie: string, url: string, opts: { http: boolean; sameSiteContext: SameSiteContext }): boolean {
		const pair = cookie.split(';', 1)[0] ?? '';
		if (enc.encode(pair).length > MAX_COOKIE_BYTES) return false;
		cookie = publicSuffixHostOnly(cookie, new URL(url).hostname);
		const withDefault = /;\s*samesite\s*=/i.test(cookie) ? cookie : `${cookie}; SameSite=Lax`; // Chrome's default
		try {
			return !!jar.setCookieSync(withDefault, url, opts);
		} catch {
			return false; // rejected (public suffix, domain mismatch, SameSite, HttpOnly from JS...). Error text may contain the cookie: drop it.
		}
	}

	/** Chrome-like caps: evict the oldest cookies per domain, then overall. */
	private enforceLimits(): void {
		const s = this.jar?.serializeSync();
		if (!s || s.cookies.length <= MAX_PER_DOMAIN) return;
		const byAge = [...s.cookies].sort((a, b) => String(b.creation).localeCompare(String(a.creation)));
		const perDomain = new Map<string, number>();
		const kept = byAge.filter((c) => {
			const n = (perDomain.get(String(c.domain)) ?? 0) + 1;
			perDomain.set(String(c.domain), n);
			return n <= MAX_PER_DOMAIN;
		});
		if (kept.length === s.cookies.length && kept.length <= MAX_TOTAL) return;
		s.cookies = kept.slice(0, MAX_TOTAL);
		this.jar = CookieJar.deserializeSync(s);
	}
}

/**
 * RFC 6265 §5.3 step 5: a Domain attribute that is a public suffix is ignored (cookie becomes host-only) when it equals
 * the request host, and rejected otherwise. tough-cookie only does the rejecting, so httpbin.org (on the PSL's private
 * section, like github.io) couldn't set `Domain=httpbin.org` on itself at all. Browsers store it host-only.
 */
function publicSuffixHostOnly(cookie: string, hostname: string): string {
	const m = cookie.match(/;\s*domain\s*=\s*\.?([^;\s]+)/i);
	if (!m) return cookie;
	const domain = m[1].toLowerCase();
	const isSuffix = getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;
	return isSuffix && domain === hostname ? cookie.replace(m[0], '') : cookie;
}

async function deriveKey(secret: Uint8Array, master?: string): Promise<CryptoKey> {
	const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
	const salt = master ? fromB64(master) : new Uint8Array(32);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('px-cookie-jar/v1') },
		ikm,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}
