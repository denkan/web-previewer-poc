import { getDomain } from 'tldts';
import codecJs from './client/codec.client.js';
import extPageHost from './client/ext-page.client.js';
import extShellHost from './client/ext-shell.client.js';
import runtimeSrc from './client/runtime.client.js';
import swSrc from './client/sw.client.js';
import { HttpCache } from './cache';
import type { Env } from './env';
import { bundle, extensionNames } from './extensions';
import { MAX_ITEM_BYTES } from './extstore';
import { b64url, type CookieJarDO, type SameSiteContext } from './jar';
import { labelHost, parseSubHost, type SubHost, subHost } from './origin';
import { Registry } from './registry';
import { Mapper, type Mode, modeKey, proxiedOrigin, rewriteCss, rewriteHtml, rewriteJsOrigins } from './rewrite';
import { UI_HTML } from './ui';
import { MAP_HTML } from './ui-map';

export { ExtStoreDO } from './extstore';
export { CookieJarDO } from './jar';

const runtimeJs = runtimeSrc.replace('/*@codec*/', codecJs);
const swJs = swSrc.replace('/*@codec*/', codecJs);
const extPageJs = bundle(extPageHost, 'page');
const extShellJs = bundle(extShellHost, 'shell');

/** Request headers worth forwarding upstream. Browser cookies never are: live mode uses the server-side jar. */
const FORWARD_REQ = [
	'user-agent',
	'accept',
	'accept-language',
	'content-type',
	'range',
	'x-requested-with',
	'upgrade-insecure-requests',
	'sec-ch-ua',
	'sec-ch-ua-mobile',
	'sec-ch-ua-platform',
	'sec-fetch-dest',
	'sec-fetch-mode',
	'sec-fetch-user',
];

/** Response headers passed back. Allowlist: CSP, X-Frame-Options, HSTS, COOP/COEP, Link and Set-Cookie all drop. */
const PASS_RES = ['content-type', 'content-language', 'content-disposition', 'content-range', 'accept-ranges', 'last-modified'];

/** Only permanent redirects are cached: 302/307 are typically geo / login / A-B decisions that must stay live. */
const CACHE_STATUS = new Set([200, 203, 301, 308, 404, 410]);
const NULL_BODY = new Set([101, 204, 205, 304]);
/** In live mode only these request destinations are cached; documents, fetch/XHR etc. depend on cookies. */
const STATIC_DEST = new Set(['image', 'script', 'style', 'font', 'track', 'manifest']);

/** Live-session cookie: "{sessionId}.{256-bit jar key}". The key never leaves the browser except to unlock the jar. */
const SID_COOKIE = '__px_sid';
const SID_RE = /(?:^|;\s*)__px_sid=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?:;|$)/;
const SID_MAX_AGE = 30 * 24 * 3600;

interface Session {
	sid: string;
	secret: string;
}

/** Per-request context. */
interface Ctx {
	self: URL;
	env: Env;
	reg: Registry;
	cache: HttpCache;
	root: string;
}

const modeFor = (c: Ctx, live: boolean): Mode => ({ root: c.root, protocol: c.self.protocol, live });
const rootHostname = (c: Ctx) => c.root.replace(/:\d+$/, '');

export default {
	async fetch(req, env, ctx): Promise<Response> {
		const url = new URL(req.url);
		const c: Ctx = { self: url, env, reg: new Registry(env.STORE), cache: new HttpCache(env.STORE), root: env.SUBDOMAIN_ROOT };
		const path = url.pathname;
		try {
			// www-bbc-com[.http][.live].{root}/... : the whole path belongs to the proxied origin.
			const sh = parseSubHost(url.host, c.root);
			if (sh) {
				if (path.startsWith('/__px/')) return withCors(req, await api(req, c, sh));
				if (req.method === 'OPTIONS') return preflight(req);
				const origin = await subOrigin(sh, c);
				if (!origin) return text(404, `Unknown proxy host ${url.host}`);
				return withCors(req, await proxy(req, ctx, c, origin, path + url.search, modeFor(c, sh.live)));
			}
			if (url.hostname.endsWith(`.${rootHostname(c)}`)) return text(404, 'Not a proxy host');

			// Root host: toolbar UI + API.
			if (path === '/go' || (path === '/' && url.searchParams.has('url'))) return await go(req, c);
			if (path === '/') return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
			if (path === '/map') return new Response(MAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
			if (path.startsWith('/__px/')) return await api(req, c, null);
			return text(404, 'Not found');
		} catch (err) {
			console.error(err instanceof Error ? err.message : 'error'); // never log request data: it can carry cookies
			return text(500, 'Internal error');
		}
	},
} satisfies ExportedHandler<Env>;

// --- addressing ------------------------------------------------------------------------------------

/** Subdomain label -> origin: readable labels decode directly; hyphen-less labels are dictionary hashes. */
async function subOrigin(sh: SubHost, c: Ctx): Promise<string | null> {
	const host = labelHost(sh.label);
	if (host) return `${sh.http ? 'http' : 'https'}://${host}`;
	return sh.http ? null : c.reg.lookup(sh.label);
}

async function proxiedOriginAsync(c: Ctx, mode: Mode, origin: string): Promise<string> {
	const hash = subHost(origin, mode.root, mode.live) ? '' : await c.reg.register(origin);
	return proxiedOrigin(mode, origin, () => hash);
}

/** Loop guard: anything shaped like one of our own hosts (with or without the port). */
function isOwnHost(target: URL, c: Ctx): boolean {
	return target.host === c.self.host || target.hostname === rootHostname(c) || target.hostname.endsWith(`.${rootHostname(c)}`);
}

/** Entry point: /go?url=https://site.com/a[&live=1] -> 307 to the proxied URL (creating a live session if needed). */
async function go(req: Request, c: Ctx): Promise<Response> {
	const q = c.self.searchParams;
	let raw = (q.get('url') || '').trim();
	if (!raw) return text(400, 'Missing ?url=');
	if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
	let target: URL;
	try {
		target = new URL(raw);
	} catch {
		return text(400, `Invalid URL: ${raw}`);
	}
	const live = q.get('live') === '1';
	const base = await proxiedOriginAsync(c, modeFor(c, live), target.origin);
	const res = new Response(null, { status: 307, headers: { location: `${base}${target.pathname}${target.search}${target.hash}` } });
	if (live && !readSession(req)) res.headers.append('set-cookie', sessionCookie(newSession(), c));
	return res;
}

// --- live sessions -----------------------------------------------------------------------------------

function readSession(req: Request): Session | null {
	const m = req.headers.get('cookie')?.match(SID_RE);
	return m ? { sid: m[1], secret: m[2] } : null;
}

function newSession(): Session {
	return { sid: b64url(crypto.getRandomValues(new Uint8Array(16))), secret: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

/** Domain={root}: one cookie covers the toolbar and every proxy host (all one site, like preview.example.com in prod). */
function sessionCookie(s: Session | null, c: Ctx): string {
	const value = s ? `${s.sid}.${s.secret}` : '';
	const maxAge = s ? SID_MAX_AGE : 0;
	return `${SID_COOKIE}=${value}; Domain=${rootHostname(c)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

const jarFor = (c: Ctx, s: Session): DurableObjectStub<CookieJarDO> => c.env.JARS.get(c.env.JARS.idFromName(s.sid));

const siteOf = (u: URL) => `${u.protocol}//${getDomain(u.hostname) ?? u.hostname}`;

/**
 * SameSite context for the *original* sites, decided by the server. Every proxy host is same-site to the browser
 * (all under {root}), so the browser can't enforce it: compare the requesting page's original site with the target's.
 */
async function sameSiteContext(req: Request, target: URL, c: Ctx): Promise<SameSiteContext> {
	const origin = req.headers.get('origin');
	if (origin === 'null') return 'none';
	const initiator = (await unproxy(origin, c)) ?? (await unproxy(req.headers.get('referer'), c));
	if (!initiator) return 'strict'; // opened from the toolbar / typed: a top-level user navigation
	if (siteOf(initiator) === siteOf(target)) return 'strict';
	const navigation = req.headers.get('sec-fetch-mode') === 'navigate' && (req.method === 'GET' || req.method === 'HEAD');
	return navigation ? 'lax' : 'none';
}

/** Live-mode request state: session (created if missing), its jar, and the SameSite context of this request. */
async function liveState(req: Request, target: URL, c: Ctx) {
	const existing = readSession(req);
	const session = existing ?? newSession();
	return {
		session,
		jar: jarFor(c, session),
		sameSite: await sameSiteContext(req, target, c),
		setSessionCookie: existing ? null : sessionCookie(session, c),
	};
}

// --- proxy -------------------------------------------------------------------------------------------

async function proxy(req: Request, ctx: ExecutionContext, c: Ctx, origin: string, rest: string, mode: Mode): Promise<Response> {
	// String concat, not new URL(rest, origin): a rest of "//evil.com/x" would otherwise switch host.
	const target = new URL(origin + rest);
	if (isOwnHost(target, c)) return text(508, `Refusing to proxy one of our own hosts: ${target.host}`);
	if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return proxyWebSocket(req, c, target, mode);
	await unproxyQuery(target, c); // e.g. ?href=<our proxy URL> sent by consent/analytics scripts reading location.href

	const cacheKey = `${modeKey(mode)} ${rest}`; // never includes cookies
	const cacheable =
		req.method === 'GET' &&
		!req.headers.has('range') &&
		!(req.headers.get('accept') ?? '').includes('text/event-stream') &&
		(!mode.live || STATIC_DEST.has(req.headers.get('sec-fetch-dest') ?? ''));
	if (cacheable) {
		const hit = await c.cache.get(origin, cacheKey);
		if (hit) return finish(hit, 'HIT', target);
	}

	const ref = await unproxy(req.headers.get('referer'), c);
	const headers = new Headers();
	for (const k of FORWARD_REQ) {
		const v = req.headers.get(k);
		if (v) headers.set(k, v);
	}
	if (ref) headers.set('referer', ref.href); // CDNs with hotlink protection check this
	headers.set('sec-fetch-site', !ref ? 'none' : ref.origin === target.origin ? 'same-origin' : siteOf(ref) === siteOf(target) ? 'same-site' : 'cross-site');
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	if (hasBody) headers.set('origin', (ref ?? target).origin);

	const live = mode.live ? await liveState(req, target, c) : null;
	let usedJarCookies = false;
	if (live) {
		const cookie = await live.jar.header(live.session.secret, target.href, live.sameSite).catch(() => '');
		if (cookie) {
			headers.set('cookie', cookie);
			usedJarCookies = true;
		}
	}

	let upstream: Response;
	try {
		upstream = await fetch(target.href, { method: req.method, headers, body: hasBody ? req.body : null, redirect: 'manual' });
	} catch {
		return text(502, `Upstream fetch failed: ${target.href}`);
	}

	// Live: Set-Cookie goes into the jar, never to the browser. Then snapshot document.cookie for the page.
	const setCookies = upstream.headers.getSetCookie();
	let documentCookie: string | null = null;
	if (live) {
		if (setCookies.length) await live.jar.absorb(live.session.secret, target.href, setCookies, live.sameSite).catch(() => {});
		if (/text\/html|xhtml/i.test(upstream.headers.get('content-type') ?? '')) {
			documentCookie = await live.jar.documentCookie(live.session.secret, target.href).catch(() => '');
		}
	}

	const out = await transform(upstream, new Mapper(c.reg, target, mode, documentCookie));
	const type = out.headers.get('content-type') ?? '';
	const uncacheable =
		!cacheable ||
		usedJarCookies || // never cache anything produced with jar cookies
		(mode.live && setCookies.length > 0) || // live: a response that sets cookies may be per-user. Snapshot drops them.
		!CACHE_STATUS.has(out.status) ||
		Number(upstream.headers.get('content-length') || 0) > 20e6 ||
		/^(video|audio)\/|text\/event-stream/i.test(type); // huge, or never-ending
	let res: Response;
	if (uncacheable) {
		res = finish(out, cacheable ? 'SKIP' : 'BYPASS', target);
	} else {
		// Stream to the browser while buffering a copy into R2 (R2 needs a known length, so buffer, don't pipe).
		const [toClient, toCache] = out.body ? out.body.tee() : [null, null];
		ctx.waitUntil(
			(async () => {
				const buf = toCache ? await new Response(toCache).arrayBuffer() : new ArrayBuffer(0);
				await c.cache.put(origin, cacheKey, out.status, out.headers, buf);
			})().catch(() => console.error('cache put failed', target.origin)),
		);
		res = finish(new Response(toClient, out), 'MISS', target);
	}
	if (live?.setSessionCookie) res.headers.append('set-cookie', live.setSessionCookie);
	return res;
}

/**
 * WebSockets are an upgraded HTTP request, so wss://site.com/x arrives as ws(s)://site-com.{root}/x with Upgrade.
 * Returning fetch()'s 101 response hands the upstream socket straight to the browser. Jar cookies ride the handshake.
 */
async function proxyWebSocket(req: Request, c: Ctx, target: URL, mode: Mode): Promise<Response> {
	const headers = new Headers({ upgrade: 'websocket' });
	for (const k of ['sec-websocket-protocol', 'user-agent', 'accept-language']) {
		const v = req.headers.get(k);
		if (v) headers.set(k, v);
	}
	// Servers check Origin on the handshake; send the page's original origin, not ours.
	const from = (await unproxy(req.headers.get('origin'), c)) ?? (await unproxy(req.headers.get('referer'), c)) ?? target;
	headers.set('origin', from.origin);
	if (mode.live) {
		const session = readSession(req);
		if (session) {
			const cookie = await jarFor(c, session)
				.header(session.secret, target.href, await sameSiteContext(req, target, c))
				.catch(() => '');
			if (cookie) headers.set('cookie', cookie);
		}
	}
	return fetch(target.href, { headers });
}

async function transform(up: Response, m: Mapper): Promise<Response> {
	const headers = new Headers();
	for (const k of PASS_RES) {
		const v = up.headers.get(k);
		if (v) headers.set(k, v);
	}
	const location = up.headers.get('location');
	if (location) {
		headers.set('location', m.map(location));
		await m.flush();
	}
	const init = { status: up.status, statusText: up.statusText, headers };
	if (NULL_BODY.has(up.status) || !up.body) return new Response(null, init);

	const type = (up.headers.get('content-type') ?? '').toLowerCase();
	if (type.includes('text/html') || type.includes('application/xhtml')) {
		return rewriteHtml(new Response(up.body, init), m);
	}
	if (type.includes('text/css')) {
		const css = rewriteCss(await up.text(), (u) => m.map(u));
		await m.flush();
		return new Response(css, init);
	}
	// JS only (see rewriteJsOrigins). JSON API responses are left alone: they may be signed (consent managers verify a
	// signature over their payload), and resource URLs in them are caught by the runtime / service worker.
	if (/javascript|ecmascript/.test(type)) {
		const code = rewriteJsOrigins(await up.text(), m.mapOrigin);
		await m.flush();
		return new Response(code, init);
	}
	// Workers transparently decodes gzip/br bodies, so only a non-encoded upstream length is still valid.
	const len = up.headers.get('content-length');
	if (len && !up.headers.get('content-encoding')) headers.set('content-length', len);
	return new Response(up.body, init); // streams (incl. text/event-stream)
}

function finish(res: Response, state: string, target: URL): Response {
	const r = new Response(res.body, res);
	r.headers.set('cache-control', 'no-store'); // R2 is the cache; keeps purges instant
	r.headers.set('server-timing', `px;desc="${state}"`); // readable from the page via PerformanceResourceTiming
	r.headers.set('timing-allow-origin', '*'); // ...also across proxy hosts
	r.headers.set('x-px-cache', state);
	r.headers.set('x-px-upstream', target.href);
	return r;
}

/** Fonts, module scripts and fetch() cross between proxy hosts, so everything is CORS-open (credentials included). */
function withCors(req: Request, res: Response): Response {
	const origin = req.headers.get('origin');
	if (!origin || res.status === 101 || res.webSocket) return res; // never rebuild a WebSocket upgrade
	const r = new Response(res.body, res);
	r.headers.set('access-control-allow-origin', origin);
	r.headers.set('access-control-allow-credentials', 'true');
	r.headers.set('access-control-expose-headers', '*');
	r.headers.append('vary', 'origin');
	return r;
}

function preflight(req: Request): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'access-control-allow-origin': req.headers.get('origin') ?? '*',
			'access-control-allow-credentials': 'true',
			'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
			'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? '*',
			'access-control-max-age': '86400',
		},
	});
}

// --- un-proxying ---------------------------------------------------------------------------------------

/** Parse a proxied URL into its original origin + path/query. */
async function parseProxied(raw: string, c: Ctx): Promise<{ origin: string; rest: string } | null> {
	let u: URL;
	try {
		u = new URL(raw, c.self);
	} catch {
		return null;
	}
	const sh = parseSubHost(u.host, c.root);
	const origin = sh && (await subOrigin(sh, c));
	return origin ? { origin, rest: u.pathname + u.search } : null;
}

/** Turn a proxied URL (e.g. our Referer) back into the original URL. */
async function unproxy(raw: string | null, c: Ctx): Promise<URL | null> {
	const p = raw ? await parseProxied(raw, c) : null;
	return p ? new URL(p.origin + p.rest) : null;
}

/** Proxy-origin-looking substrings in query values. */
const PROXY_CANDIDATE = /(?:https?:)?\/\/[a-z0-9.:[\]-]+/gi;

/**
 * Scripts that send location.href upstream (consent managers, analytics) would leak our proxy URL, sometimes
 * embedded in a JSON blob inside a query param. Swap every proxied origin in the query back to the original.
 */
async function unproxyQuery(target: URL, c: Ctx): Promise<void> {
	const marker = rootHostname(c);
	if (!target.search || !(target.search.includes(marker) || target.search.includes(encodeURIComponent(marker)))) return;
	let changed = false;
	for (const [k, v] of [...target.searchParams]) {
		let next = v;
		for (const m of v.matchAll(PROXY_CANDIDATE)) {
			const candidate = m[0].startsWith('//') ? c.self.protocol + m[0] : m[0];
			const p = await parseProxied(`${candidate}/`, c);
			if (p) next = next.replace(m[0], p.origin);
		}
		if (next !== v) {
			target.searchParams.set(k, next);
			changed = true;
		}
	}
	if (changed) target.search = target.searchParams.toString();
}

// --- API -------------------------------------------------------------------------------------------------

/** State-changing session endpoints only accept same-origin requests (no cross-site CSRF, no page-to-page writes). */
const sameOrigin = (req: Request) => req.headers.get('sec-fetch-site') === 'same-origin';

/** `sh` is set when the request hit a proxy host (runtime, SW, document.cookie writes); null on the root host. */
async function api(req: Request, c: Ctx, sh: SubHost | null): Promise<Response> {
	switch (c.self.pathname) {
		case '/__px/runtime.js':
			return js(runtimeJs);
		case '/__px/sw.js':
			return js(swJs, { 'service-worker-allowed': '/' });
		case '/__px/ext.js':
			return js(extPageJs); // loaded by the runtime, only when the page is framed by the toolbar
		case '/__px/register': {
			// Dictionary fallback only: origins that can't be one DNS label.
			if (req.method !== 'POST') return text(405, 'POST an origin');
			return text(200, await c.reg.register(new URL((await req.text()).trim()).origin));
		}
		case '/__px/cookie': {
			// document.cookie writes from a live page. The cookie is always scoped to *this* host's original origin
			// (only the path is taken from the body), and only same-origin pages may write, so site A can't set site B's cookies.
			if (!sh?.live || req.method !== 'POST' || !sameOrigin(req)) return text(403, 'Forbidden');
			const session = readSession(req);
			const origin = await subOrigin(sh, c);
			if (!session || !origin) return text(400, 'No live session');
			const body = await req.json<{ url?: string; cookie?: string }>().catch(() => ({}) as { url?: string; cookie?: string });
			if (typeof body.cookie !== 'string' || body.cookie.length > 8192) return text(400, 'Bad cookie');
			let path = '/';
			try {
				path = new URL(body.url ?? '/', c.self).pathname;
			} catch {}
			await jarFor(c, session).setFromDocument(session.secret, origin + path, body.cookie).catch(() => {});
			return new Response(null, { status: 204 });
		}
	}
	if (sh) return text(404, 'Unknown endpoint');

	// Root host only (the toolbar).
	if (c.self.pathname.startsWith('/__px/ext/')) return extStore(req, c);
	switch (c.self.pathname) {
		case '/__px/shell.js':
			return js(extShellJs);
		case '/__px/origins': {
			const stats = await c.cache.stats();
			return json(Object.entries(stats).map(([origin, s]) => ({ origin, ...s })).sort((a, b) => b.bytes - a.bytes));
		}
		case '/__px/purge': {
			if (req.method !== 'POST') return text(405, 'POST {all} | {origin} | {urls}');
			const body = await req.json<{ all?: boolean; origin?: string; urls?: string[] }>();
			let deleted = 0;
			if (body.all) deleted += await c.cache.purgeAll();
			if (body.origin) deleted += await c.cache.purgeOrigin(new URL(body.origin).origin);
			if (body.urls?.length) {
				const modes = [modeFor(c, false), modeFor(c, true)].map(modeKey);
				const entries: [string, string][] = [];
				for (const u of body.urls) {
					const e = await cacheEntry(u, c);
					if (e) for (const k of modes) entries.push([e.origin, `${k} ${e.rest}`]);
				}
				await c.cache.purgeEntries(entries);
				deleted += entries.length / modes.length;
			}
			return json({ deleted });
		}
		case '/__px/session': {
			// GET: cookie count + TTL (never names/values). POST {ttlSeconds}: shorten this session's idle lifetime.
			const session = readSession(req);
			if (!session) return json({ active: false });
			if (req.method === 'POST') {
				if (!sameOrigin(req)) return text(403, 'Forbidden');
				const { ttlSeconds } = await req.json<{ ttlSeconds?: number }>();
				if (typeof ttlSeconds === 'number') await jarFor(c, session).setIdleTtl(ttlSeconds);
			}
			const info = await jarFor(c, session)
				.info(session.secret)
				.catch(() => null);
			return json(info ? { active: true, ...info } : { active: false });
		}
		case '/__px/session/reset': {
			if (req.method !== 'POST' || !sameOrigin(req)) return text(403, 'Forbidden');
			const session = readSession(req);
			if (session) await jarFor(c, session).reset();
			return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(null, c) } });
		}
	}
	return text(404, 'Unknown endpoint');
}

/**
 * Extension storage, toolbar only (same-origin): /__px/ext/{ext}/items?scope=...[&page=...]
 *   GET list (one page, or the whole scope) · POST {page, data} create · PATCH .../items/{id} {data} merge · DELETE .../items/{id}
 * scope is an original site origin ("https://site.com": comments, page must be on that site) or "{kind}:{name}"
 * ("board:default": the map view's notes). `origin=` is accepted as an alias. One Durable Object per (ext, scope).
 * Proxied pages can't reach it: they're other origins (Sec-Fetch-Site: same-site), and nothing here sends CORS headers.
 */
async function extStore(req: Request, c: Ctx): Promise<Response> {
	const m = c.self.pathname.match(/^\/__px\/ext\/([a-z0-9-]+)\/items(?:\/([0-9a-f-]{36}))?$/);
	if (!m || !extensionNames.has(m[1])) return text(404, 'Unknown extension endpoint');
	if (!sameOrigin(req)) return text(403, 'Forbidden');
	const [, ext, id] = m;
	const scope = storeScope(c.self.searchParams.get('scope') ?? c.self.searchParams.get('origin'));
	if (!scope) return text(400, 'Bad ?scope=');
	const store = c.env.EXT_STORE.get(c.env.EXT_STORE.idFromName(`${ext}\n${scope}`));
	const site = /^https?:/.test(scope) ? scope : null;
	const page = (raw: unknown) => {
		if (typeof raw !== 'string' || raw.length > 4096) return null;
		if (site && !raw.startsWith(`${site}/`)) return null;
		return raw.replace(/#.*$/, '');
	};

	if (!id && req.method === 'GET') {
		const p = c.self.searchParams.get('page');
		if (p !== null && !page(p)) return text(400, 'Bad ?page=');
		return json(await store.list(p && page(p)));
	}
	const body = req.method === 'POST' || req.method === 'PATCH' ? await req.text() : '';
	if (body.length > MAX_ITEM_BYTES) return text(413, 'Item too large');
	let parsed: { page?: unknown; data?: unknown } = {};
	try {
		if (body) parsed = JSON.parse(body);
	} catch {
		return text(400, 'Bad JSON');
	}
	const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>) : null;
	if (!id && req.method === 'POST') {
		const p = page(parsed.page ?? '');
		if (p === null || (site && !p) || !data) return text(400, 'POST {page, data}');
		const item = await store.create(p, data);
		return item ? json(item) : text(507, 'Store full');
	}
	if (id && req.method === 'PATCH') {
		if (!data) return text(400, 'PATCH {data}');
		const item = await store.update(id, data);
		return item ? json(item) : text(404, 'No such item');
	}
	if (id && req.method === 'DELETE') return (await store.remove(id)) ? new Response(null, { status: 204 }) : text(404, 'No such item');
	return text(405, 'Method not allowed');
}

/** An original site origin, or "{kind}:{name}" with a conservative character set. */
function storeScope(raw: string | null): string | null {
	if (!raw) return null;
	if (/^https?:/.test(raw)) {
		try {
			return new URL(raw).origin === raw ? raw : null;
		} catch {
			return null;
		}
	}
	return /^[a-z]+:[A-Za-z0-9._~-]{1,100}$/.test(raw) ? raw : null;
}

/** Accepts a proxied URL, or an original absolute URL. */
async function cacheEntry(u: string, c: Ctx): Promise<{ origin: string; rest: string } | null> {
	const p = await parseProxied(u, c);
	if (p) return p;
	try {
		const x = new URL(u);
		if (x.protocol === 'http:' || x.protocol === 'https:') return { origin: x.origin, rest: x.pathname + x.search };
	} catch {}
	return null;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const js = (src: string, extra: Record<string, string> = {}) =>
	new Response(src, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', ...extra } });
