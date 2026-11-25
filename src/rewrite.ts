import { subHost } from './origin';
import type { Registry } from './registry';

const SKIP_SCHEME = /^(data|blob|javascript|mailto|tel|sms|about):/i;

/**
 * How proxied URLs are addressed (see src/origin.ts):
 *   snapshot: //www-bbc-com.{root}/news       no cookies, shared cache
 *   live:     //www-bbc-com.live.{root}/news  server-side cookie jar (src/jar.ts), documents not cached
 */
export type Mode = { root: string; protocol: string; live: boolean };

/** Distinguishes cached rewrites: output differs per mode and embeds our own host. */
export const modeKey = (m: Mode) => `${m.live ? 'live' : 'sub'}@${m.protocol}//${m.root}`;

const rootHostname = (m: Mode) => m.root.replace(/:\d+$/, '');
const isOurHost = (m: Mode, hostname: string) => hostname === rootHostname(m) || hostname.endsWith(`.${rootHostname(m)}`);

/**
 * Absolute proxied origin ("http://www-bbc-com.px.localhost:8787"). `fallback` handles the rare origin that can't be
 * one DNS label (ports, single-label hosts): it returns a dictionary hash.
 */
export function proxiedOrigin(mode: Mode, origin: string, fallback: (origin: string) => string): string {
	const host = subHost(origin, mode.root, mode.live) ?? `${fallback(origin)}${mode.live ? '.live' : ''}.${mode.root}`;
	return `${mode.protocol}//${host}`;
}

/**
 * Maps any URL found in content to its proxied form. Encoding is sync and stateless; only origins that need the
 * dictionary fallback are queued in `pending` and persisted by flush() *before* the markup is released to the browser.
 */
export class Mapper {
	pending = new Set<string>();
	/** Dictionary-fallback origins this document referenced -> hash (shipped to the client runtime). */
	hashes = new Map<string, string>();

	constructor(
		private reg: Registry,
		public base: URL,
		public mode: Mode,
		/** Live mode: what document.cookie reads on this page (non-HttpOnly jar cookies). Never cached: live documents aren't. */
		public documentCookie: string | null = null,
	) {
		this.docOrigin = base.origin;
	}

	/** The document's own origin (stays fixed even if a <base> tag later changes `base`). */
	private docOrigin: string;

	/**
	 * Only the origin is rewritten; the shape of the string is kept: absolute stays absolute, protocol-relative stays
	 * protocol-relative. Page code that matches URLs as strings (script[src="https://..."] lookups by bundler runtimes)
	 * then still lines up with origin literals rewritten in JS. In subdomain mode same-origin relative URLs aren't touched.
	 */
	map = (raw: string, base: URL = this.base): string => {
		const s = raw.trim();
		if (!s || s[0] === '#' || SKIP_SCHEME.test(s)) return raw;
		let u: URL;
		try {
			u = new URL(s, base);
		} catch {
			return raw;
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
		const absolute = /^[a-z][a-z0-9+.-]*:/i.test(s);
		const protoRelative = !absolute && s.startsWith('//');
		if (!absolute && !protoRelative && u.origin === this.docOrigin) return raw;
		const origin = this.mapOrigin(u.origin);
		if (!origin) return raw; // already one of ours
		const tail = `${u.pathname}${u.search}${u.hash}`;
		return protoRelative ? origin.replace(/^https?:/, '') + tail : origin + tail;
	};

	/**
	 * Absolute proxied origin for an origin literal found in JS/JSON ("https://cdn.site.com" -> "http://{h}.localhost:8787").
	 * In subdomain mode this equals the proxied page's real location.origin, so origin comparisons in page code keep working.
	 */
	mapOrigin = (origin: string): string | null => {
		let u: URL;
		try {
			u = new URL(origin);
		} catch {
			return null;
		}
		if (isOurHost(this.mode, u.hostname)) return null;
		return proxiedOrigin(this.mode, u.origin, (o) => {
			const h = this.reg.hashOf(o);
			this.hashes.set(o, h);
			if (!this.reg.isKnown(o)) this.pending.add(o);
			return h;
		});
	};

	/** Returns undefined when nothing is pending, so HTMLRewriter handlers stay synchronous on the hot path. */
	flush(): Promise<void> | undefined {
		if (!this.pending.size) return;
		const origins = [...this.pending];
		this.pending.clear();
		return Promise.all(origins.map((o) => this.reg.register(o))).then(() => undefined);
	}
}

/**
 * Absolute origin literals in JS, incl. JSON-escaped slashes (https:\/\/host). Two reasons they must follow the proxy:
 *  - bundlers hardcode their asset prefix (Turbopack: `let t="https://cdn.site.com/_next/"`) and match
 *    document.currentScript.src against it — BBC never hydrates otherwise;
 *  - postMessage origin checks (`e.origin === "https://cdn.privacy-mgmt.com"`) — consent dialogs / payment
 *    iframes silently ignore every message otherwise.
 */
const JS_ORIGIN = /\b(https?):((?:\\?\/){2})((?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?)(?![a-z0-9.-])/gi;
/** XML namespaces and similar identifiers that must stay byte-identical (createElementNS etc.). */
const KEEP_HOSTS = /(^|\.)(w3\.org|xmlns\.com|purl\.org|schema\.org|schemas\.xmlsoap\.org|schemas\.microsoft\.com|ns\.adobe\.com)$/i;

/**
 * A URL in HTML-attribute position inside a JS string (html`<a href="https://...">`) is markup, not a comparison.
 * It must stay byte-identical: Lit SSR stamps a digest of each template's static strings into the HTML and refuses
 * to hydrate when it changes (MDN's language switcher). Loading it still goes through the runtime / service worker.
 */
const ATTR_CONTEXT = /\b(?:href|src|srcset|action|formaction|poster|background|cite)\s*=\s*\\?["']?$/i;

export function rewriteJsOrigins(src: string, mapOrigin: (origin: string) => string | null): string {
	return src.replace(JS_ORIGIN, (whole, scheme: string, slashes: string, host: string, offset: number) => {
		if (KEEP_HOSTS.test(host)) return whole;
		if (ATTR_CONTEXT.test(src.slice(Math.max(0, offset - 24), offset))) return whole;
		const target = mapOrigin(`${scheme.toLowerCase()}://${host.toLowerCase()}`);
		if (!target) return whole;
		return slashes === '//' ? target : target.replace(/\//g, '\\/');
	});
}

function rewriteImportMap(src: string, m: Mapper): string {
	try {
		const map = JSON.parse(src);
		const fix = (o?: Record<string, unknown>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? m.map(v) : v]));
		if (map.imports) map.imports = fix(map.imports);
		if (map.scopes) map.scopes = Object.fromEntries(Object.entries(map.scopes).map(([k, v]) => [m.map(k), fix(v as Record<string, unknown>)]));
		return JSON.stringify(map);
	} catch {
		return src;
	}
}

/** url(...) in any quoting style, plus bare-string @import. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(["'])([^"']+)\1/gi;

export function rewriteCss(css: string, map: (u: string) => string): string {
	return css
		.replace(CSS_URL, (whole, dq, sq, bare) => {
			const u = dq ?? sq ?? bare ?? '';
			if (!u || /^data:/i.test(u.trim())) return whole;
			const q = dq != null ? '"' : sq != null ? "'" : '';
			return `url(${q}${map(u)}${q})`;
		})
		.replace(CSS_IMPORT, (_w, q, u) => `@import ${q}${map(u)}${q}`);
}

/** srcset per the HTML spec's candidate grammar: URLs may contain commas (Cloudinary etc.), descriptors may not. */
export function rewriteSrcset(value: string, map: (u: string) => string): string {
	const out: string[] = [];
	let i = 0;
	const n = value.length;
	while (i < n) {
		while (i < n && /[\s,]/.test(value[i])) i++;
		if (i >= n) break;
		const start = i;
		while (i < n && !/\s/.test(value[i])) i++;
		let url = value.slice(start, i);
		let descriptor = '';
		if (url.endsWith(',')) {
			url = url.replace(/,+$/, '');
		} else {
			const d0 = i;
			let depth = 0;
			while (i < n) {
				const c = value[i];
				if (c === '(') depth++;
				else if (c === ')') depth--;
				else if (c === ',' && depth <= 0) break;
				i++;
			}
			descriptor = value.slice(d0, i).trim();
			i++;
		}
		out.push(descriptor ? `${map(url)} ${descriptor}` : map(url));
	}
	return out.join(', ');
}

/** Element -> attributes holding a single URL. Includes common lazy-load attributes. */
const URL_ATTRS: Record<string, string[]> = {
	a: ['href'],
	area: ['href'],
	link: ['href'],
	img: ['src', 'data-src', 'data-lazy-src', 'data-original', 'lowsrc'],
	script: ['src'],
	iframe: ['src', 'data-src'],
	frame: ['src'],
	embed: ['src'],
	object: ['data'],
	source: ['src', 'data-src'],
	video: ['src', 'poster', 'data-src'],
	audio: ['src'],
	track: ['src'],
	input: ['src', 'formaction'],
	button: ['formaction'],
	form: ['action'],
	use: ['href', 'xlink:href'],
	image: ['href', 'xlink:href'],
	body: ['background'],
	table: ['background'],
	td: ['background'],
	th: ['background'],
};

const SRCSET_ATTRS: Record<string, string[]> = {
	img: ['srcset', 'data-srcset'],
	source: ['srcset', 'data-srcset'],
	link: ['imagesrcset'],
};

const safeJson = (v: unknown) =>
	JSON.stringify(v).replace(/[<\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/**
 * Streaming HTML rewrite. Besides URLs it:
 *  - injects the client runtime first thing in the document (before any page script runs)
 *  - drops CSP/referrer <meta>, SRI integrity (rewritten CSS would fail it), preconnects, speculation rules
 *  - rewrites inline <style>, style="", import maps and <meta refresh>
 */
export function rewriteHtml(res: Response, m: Mapper): Response {
	let injected = false;
	let styleBuf = '';
	let scriptBuf = '';
	let scriptKind: 'code' | 'importmap' | 'skip' = 'skip';

	const bootstrap = () =>
		`<script>window.__PX__=${safeJson({
			base: m.base.href,
			origin: m.base.origin,
			root: m.mode.root,
			live: m.mode.live,
			cookies: m.documentCookie,
			hashes: {},
		})}</script>` +
		`<script src="/__px/runtime.js"></script>`;
	const inject = {
		element(el: Element) {
			if (injected) return;
			injected = true;
			el.prepend(bootstrap(), { html: true });
		},
	};

	const rw = new HTMLRewriter().on('html', inject).on('head', inject).on('body', inject);

	const tags = new Set([...Object.keys(URL_ATTRS), ...Object.keys(SRCSET_ATTRS)]);
	for (const tag of tags) {
		const urlAttrs = URL_ATTRS[tag] ?? [];
		const setAttrs = SRCSET_ATTRS[tag] ?? [];
		rw.on(tag, {
			element(el) {
				for (const a of urlAttrs) {
					const v = el.getAttribute(a);
					if (v != null) el.setAttribute(a, m.map(v));
				}
				for (const a of setAttrs) {
					const v = el.getAttribute(a);
					if (v != null) el.setAttribute(a, rewriteSrcset(v, m.map));
				}
				return m.flush();
			},
		});
	}

	rw.on('base[href]', {
		element(el) {
			try {
				const next = new URL(el.getAttribute('href')!, m.base);
				el.setAttribute('href', m.map(next.href));
				m.base = next; // later relative URLs resolve against the document's <base>
			} catch {}
			return m.flush();
		},
	})
		.on('[style]', {
			element(el) {
				el.setAttribute('style', rewriteCss(el.getAttribute('style')!, (u) => m.map(u)));
				return m.flush();
			},
		})
		.on('style', {
			text(t) {
				styleBuf += t.text;
				if (!t.lastInTextNode) {
					t.remove();
					return;
				}
				t.replace(rewriteCss(styleBuf, (u) => m.map(u)), { html: true });
				styleBuf = '';
				return m.flush();
			},
		})
		.on('link', {
			element(el) {
				el.removeAttribute('integrity');
				if (/\b(preconnect|dns-prefetch)\b/i.test(el.getAttribute('rel') ?? '')) el.remove();
			},
		})
		.on('script', {
			element(el) {
				el.removeAttribute('integrity');
				const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
				if (type === 'speculationrules') {
					el.remove();
					scriptKind = 'skip';
					return;
				}
				const isCode = !type || type === 'module' || /javascript|ecmascript|json/.test(type);
				scriptKind = el.hasAttribute('src') ? 'skip' : type === 'importmap' ? 'importmap' : isCode && type !== 'application/ld+json' ? 'code' : 'skip';
			},
			// Inline scripts (incl. __NEXT_DATA__ / RSC payloads): rewrite origin literals; import maps: rewrite targets.
			text(t) {
				if (scriptKind === 'skip') return;
				scriptBuf += t.text;
				if (!t.lastInTextNode) {
					t.remove();
					return;
				}
				const src = scriptBuf;
				scriptBuf = '';
				// A rewritten origin literal is a real origin (= location.origin of the proxied page), so origin checks line up.
				const out = scriptKind === 'importmap' ? rewriteImportMap(src, m) : rewriteJsOrigins(src, m.mapOrigin);
				t.replace(out, { html: true });
				return m.flush();
			},
		})
		.on('meta', {
			element(el) {
				const equiv = (el.getAttribute('http-equiv') ?? '').toLowerCase();
				const name = (el.getAttribute('name') ?? '').toLowerCase();
				if (equiv.startsWith('content-security-policy') || equiv === 'x-frame-options' || name === 'referrer') {
					el.remove();
					return;
				}
				if (equiv === 'refresh') {
					const c = el.getAttribute('content') ?? '';
					const mm = c.match(/^(\s*\d+\s*[;,]\s*url\s*=\s*)(['"]?)(.+?)\2\s*$/i);
					if (mm) el.setAttribute('content', mm[1] + m.map(mm[3]));
					return m.flush();
				}
			},
		})
		.onDocument({
			end(end) {
				if (!injected) end.append(bootstrap(), { html: true });
				if (m.hashes.size) end.append(`<script>Object.assign(__PX__.hashes,${safeJson(Object.fromEntries(m.hashes))})</script>`, { html: true });
			},
		});

	return rw.transform(res);
}
