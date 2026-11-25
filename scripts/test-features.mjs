// Feature checks against live public endpoints (needs `npm run dev`). Usage: node scripts/test-features.mjs
// Uses echo.websocket.org, httpbin.org / www.httpbin.org and Wikimedia EventStreams, so a red line can also mean one
// of those is down. Cross-subdomain cookie sharing uses a local echo server on a.jartest.localhost / b.jartest.localhost
// (no public pair of same-site cookie-echo hosts exists: httpbin.org and postman-echo.com are on the Public Suffix List).
// Live-mode checks inspect the Durable Object's on-disk storage under .wrangler/state.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.PX_BASE || 'http://px.localhost:8787';
const ROOT = new URL(BASE).host;
const STATE = new URL('../.wrangler/state/v3/', import.meta.url).pathname;
const TOKEN = `pxsecret${randomBytes(6).toString('hex')}`; // every jar cookie value contains this; must never hit disk in plaintext
const isLocal = (u) => {
	const h = new URL(u).host;
	return h === ROOT || h.endsWith(`.${ROOT}`);
};
const go = (url, live) => `${BASE}/go?url=${encodeURIComponent(url)}${live ? '&live=1' : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failures++;
	console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 110)}` : ''}`);
};

/** Node can't resolve *.px.localhost to the IPv4 wrangler listens on, so talk to 127.0.0.1 with a Host header. */
function raw(url, { method = 'GET', headers = {}, body, maxMs = 15000 } = {}) {
	const u = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: u.port || 80, path: u.pathname + u.search, method, headers: { host: u.host, ...headers } }, (res) => {
			let data = '';
			const done = () => resolve({ status: res.statusCode, headers: res.headers, body: data });
			const t = setTimeout(() => (res.destroy(), done()), maxMs);
			res.on('data', (c) => {
				data += c;
				if (headers.accept === 'text/event-stream' && data.includes('data:')) (clearTimeout(t), res.destroy(), done());
			});
			res.on('end', () => (clearTimeout(t), done()));
			res.on('error', () => (clearTimeout(t), done()));
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

const textOf = (page) => page.evaluate(() => document.body.innerText);
const cookiesSeenUpstream = async (page, url) => {
	await page.goto(go(url, true), { waitUntil: 'load' });
	try {
		return JSON.parse(await textOf(page)).cookies ?? {};
	} catch {
		return {};
	}
};
const setViaHeaders = (page, url, setCookie) => page.goto(go(`${url}/response-headers?Set-Cookie=${encodeURIComponent(setCookie)}`, true), { waitUntil: 'load' });
const filesUnder = (dir) => {
	try {
		return readdirSync(dir).flatMap((f) => {
			const p = join(dir, f);
			return statSync(p).isDirectory() ? filesUnder(p) : [p];
		});
	} catch {
		return [];
	}
};

// Local upstream on two hosts of one (non-PSL) site: /set?c=<Set-Cookie> sets it, /echo returns the cookies received.
const ECHO_PORT = 8791;
const echoHandler = (req, res) => {
	const u = new URL(req.url, `http://${req.headers.host}`);
	if (u.pathname === '/set') res.setHeader('set-cookie', u.searchParams.get('c') ?? '');
	const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ host: req.headers.host, cookies }));
};
const echoServers = ['127.0.0.1', '::1'].map((h) => http.createServer(echoHandler).listen(ECHO_PORT, h));

const browser = await chromium.launch();
await raw(`${BASE}/__px/purge`, { method: 'POST', body: JSON.stringify({ all: true }) });

// --- snapshot mode ---------------------------------------------------------------------------------
{
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const sockets = [];
	page.on('websocket', (ws) => sockets.push(ws.url()));
	await page.goto(go('https://example.com/'), { waitUntil: 'load' });
	check('[snapshot] readable URL', page.url().startsWith(`http://example-com.${ROOT}/`), page.url());

	const ws = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = new WebSocket('wss://echo.websocket.org/');
				const t = setTimeout(() => resolve({ ok: false, why: 'timeout' }), 10000);
				s.onopen = () => s.send('px-ping');
				s.onmessage = (e) => e.data === 'px-ping' && (clearTimeout(t), s.close(), resolve({ ok: true }));
				s.onerror = () => (clearTimeout(t), resolve({ ok: false, why: 'error' }));
			}),
	);
	check('[snapshot] WebSocket echo round trip', ws.ok, ws.why);
	check('[snapshot] WebSocket went through the proxy', sockets.length > 0 && sockets.every(isLocal), sockets.join(', '));

	await Promise.all([page.waitForURL(/iana/, { timeout: 15000 }).catch(() => {}), page.evaluate(() => (location.href = 'https://www.iana.org/help/example-domains'))]);
	check('[snapshot] location.href stays in preview', isLocal(page.url()) && page.url().includes('iana'), page.url());
	await Promise.all([page.waitForURL(/replaced/, { timeout: 15000 }).catch(() => {}), page.evaluate(() => location.replace('https://example.com/?replaced'))]);
	check('[snapshot] location.replace stays in preview', isLocal(page.url()) && page.url().includes('replaced'), page.url());

	const jsCookie = await page.evaluate(() => {
		document.cookie = 'jsx=1; domain=.example.com; path=/';
		return document.cookie;
	});
	check('[snapshot] document.cookie with Domain=.example.com sticks', jsCookie.includes('jsx=1'), jsCookie);

	await page.goto(go('https://httpbin.org/cookies/set?px=1'), { waitUntil: 'load' });
	check('[snapshot] upstream never receives cookies', !/"px"/.test(await textOf(page)), await textOf(page));
	await ctx.close();
}

// --- protocol & cache policy -------------------------------------------------------------------------
{
	const sse = await raw(`http://stream-wikimedia-org.${ROOT}/v2/stream/recentchange`, { headers: { accept: 'text/event-stream', 'user-agent': 'web-previewer-poc-test/1.0' }, maxMs: 8000 });
	check('SSE events stream through', sse.body.includes('data:'), sse.body.slice(0, 60));
	check('SSE response not cached', !['MISS', 'HIT'].includes(sse.headers['x-px-cache']), `x-px-cache: ${sse.headers['x-px-cache']}`);
	for (const [status, expect] of [
		[301, 'HIT'],
		[302, 'SKIP'],
	]) {
		const u = `http://httpbin-org.${ROOT}/redirect-to?url=%2Fget&status_code=${status}`;
		await raw(u);
		const second = (await raw(u)).headers['x-px-cache'];
		check(`${status} redirect → 2nd request ${expect}`, second === expect, `got ${second}`);
	}
	// Snapshot sends no cookies and drops Set-Cookie, so a response that sets one is still shareable (CDNs like
	// upload.wikimedia.org set analytics cookies on every image). Live mode must not cache it.
	const sc = `/response-headers?Set-Cookie=${encodeURIComponent('cdn=1; Path=/')}`;
	await raw(`http://httpbin-org.${ROOT}${sc}`);
	const snapSecond = (await raw(`http://httpbin-org.${ROOT}${sc}`)).headers['x-px-cache'];
	check('[snapshot] response with Set-Cookie is cached', snapSecond === 'HIT', `2nd request ${snapSecond}`);
	const liveHeaders = { 'sec-fetch-dest': 'image' }; // static destination: cacheable in live mode unless it sets cookies
	await raw(`http://httpbin-org.live.${ROOT}${sc}`, { headers: liveHeaders });
	const liveSecond = (await raw(`http://httpbin-org.live.${ROOT}${sc}`, { headers: liveHeaders })).headers['x-px-cache'];
	check('[live] response with Set-Cookie is not cached', liveSecond !== 'HIT', `2nd request ${liveSecond}`);
}

// --- live mode: server-side cookie jar ------------------------------------------------------------------
{
	const ctx = await browser.newContext();
	const page = await ctx.newPage();

	// Jar round trip: httpbin sets px, redirects to /cookies, which echoes what it received.
	await page.goto(go(`https://httpbin.org/cookies/set?px=${TOKEN}a`, true), { waitUntil: 'load' });
	check('[live] upstream receives the cookie it set', (await textOf(page)).includes(`${TOKEN}a`), await textOf(page));
	const browserCookies = (await ctx.cookies()).map((c) => c.name);
	check('[live] browser holds only the session cookie', browserCookies.length === 1 && browserCookies[0] === '__px_sid', browserCookies.join(', '));

	// Cross-subdomain: a Domain=jartest.localhost cookie set by a.jartest.localhost reaches b.jartest.localhost (each its
	// own proxy host); a host-only cookie set by a. does not.
	const A = `http://a.jartest.localhost:${ECHO_PORT}`;
	const B = `http://b.jartest.localhost:${ECHO_PORT}`;
	await page.goto(go(`${A}/set?c=${encodeURIComponent(`shared=${TOKEN}b; Domain=jartest.localhost; Path=/`)}`, true), { waitUntil: 'load' });
	await page.goto(go(`${A}/set?c=${encodeURIComponent('hostonly=1; Path=/')}`, true), { waitUntil: 'load' });
	const onB = await cookiesSeenUpstream(page, `${B}/echo`);
	check('[live] Domain cookie shared across subdomains (a.jartest ↔ b.jartest)', onB.shared === `${TOKEN}b`, JSON.stringify(onB));
	check('[live] host-only cookie stays on its host', onB.hostonly === undefined, JSON.stringify(onB));

	// Public Suffix List: Domain=org is rejected outright; Domain=httpbin.org (PSL private section, like github.io) set by
	// httpbin.org itself is stored host-only (RFC 6265 §5.3), so www.httpbin.org, a different site, doesn't get it.
	// Domain=org goes in via document.cookie: httpbin refuses to *send* a Set-Cookie for another domain, which made an
	// earlier version of this check vacuous. It's checked at the storage layer too: tough-cookie also skips suffix
	// domains on lookup, so "never sent" alone can't tell whether the jar stored it.
	const api = await ctx.newPage();
	await api.goto(`${BASE}/`, { waitUntil: 'load' });
	const jarCount = async () => (await api.evaluate(() => fetch('/__px/session').then((r) => r.json()))).cookies;
	await page.goto(go('https://httpbin.org/', true), { waitUntil: 'load' });
	const beforePsl = await jarCount();
	await page.evaluate(() => (document.cookie = 'psl=1; domain=org; path=/'));
	await sleep(500);
	const afterPslCount = await jarCount();
	await setViaHeaders(page, 'https://httpbin.org', 'privpsl=1; Domain=httpbin.org; Path=/');
	const onApex = await cookiesSeenUpstream(page, 'https://httpbin.org/cookies');
	const onWww = await cookiesSeenUpstream(page, 'https://www.httpbin.org/cookies');
	check('[live] Domain=org (public suffix) not stored', afterPslCount === beforePsl, `jar cookies ${beforePsl} -> ${afterPslCount}`);
	check('[live] Domain=org (public suffix) not sent', onApex.psl === undefined && onApex.px === `${TOKEN}a`, JSON.stringify(onApex));
	check('[live] Domain=httpbin.org (private PSL) kept host-only', onApex.privpsl === '1' && onWww.privpsl === undefined, `apex ${JSON.stringify(onApex)} www ${JSON.stringify(onWww)}`);

	// document.cookie: non-HttpOnly jar cookies readable, HttpOnly not; writes reach the jar.
	await setViaHeaders(page, 'https://httpbin.org', `ho=${TOKEN}c; HttpOnly; Path=/`);
	await page.goto(go('https://httpbin.org/', true), { waitUntil: 'load' });
	const docCookie = await page.evaluate(() => document.cookie);
	check('[live] document.cookie reads non-HttpOnly jar cookies', docCookie.includes(`px=${TOKEN}a`), docCookie);
	check('[live] document.cookie hides HttpOnly cookies', !docCookie.includes('ho='), docCookie);
	const afterWrite = await page.evaluate((t) => {
		document.cookie = `jsw=${t}d; path=/`;
		return document.cookie;
	}, TOKEN);
	check('[live] document.cookie write is readable at once', afterWrite.includes(`jsw=${TOKEN}d`), afterWrite);
	await sleep(500);
	const afterJsWrite = await cookiesSeenUpstream(page, 'https://httpbin.org/cookies');
	check('[live] document.cookie write reaches the jar (sent upstream)', afterJsWrite.jsw === `${TOKEN}d`, JSON.stringify(afterJsWrite));

	// SameSite: a cross-site credentialed fetch (example.com page -> httpbin.org) gets SameSite=None cookies only.
	await setViaHeaders(page, 'https://httpbin.org', 'laxc=1; SameSite=Lax; Path=/');
	await setViaHeaders(page, 'https://httpbin.org', 'nonec=1; SameSite=None; Secure; Path=/');
	const fetchCookies = async (from) => {
		await page.goto(go(from, true), { waitUntil: 'load' });
		return page.evaluate(() =>
			fetch('https://httpbin.org/cookies', { credentials: 'include' })
				.then((r) => r.json())
				.then((j) => j.cookies)
				.catch((e) => ({ error: String(e) })),
		);
	};
	const cross = await fetchCookies('https://example.com/');
	check('[live] cross-site fetch: SameSite=None sent, Lax withheld', cross.nonec === '1' && cross.laxc === undefined, JSON.stringify(cross));
	const same = await fetchCookies('https://httpbin.org/');
	check('[live] same-site fetch: Lax cookie sent', same.laxc === '1', JSON.stringify(same));

	// WebSocket handshake works in live mode too.
	await page.goto(go('https://example.com/', true), { waitUntil: 'load' });
	const ws = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = new WebSocket('wss://echo.websocket.org/');
				const t = setTimeout(() => resolve(false), 10000);
				s.onopen = () => s.send('px-live');
				s.onmessage = (e) => e.data === 'px-live' && (clearTimeout(t), s.close(), resolve(true));
				s.onerror = () => (clearTimeout(t), resolve(false));
			}),
	);
	check('[live] WebSocket echo round trip', ws);

	// Storage holds ciphertext only: the jar is persisted, yet no cookie value appears anywhere on disk (DO + R2).
	await page.goto(`${BASE}/`, { waitUntil: 'load' });
	const info = await page.evaluate(() => fetch('/__px/session').then((r) => r.json()));
	check('[live] jar persisted', info.active && info.stored && info.cookies >= 5, JSON.stringify(info));
	const doFiles = filesUnder(join(STATE, 'do'));
	const leaks = [...doFiles, ...filesUnder(join(STATE, 'r2'))].filter((f) => readFileSync(f).includes(TOKEN));
	check('[live] no plaintext cookie value in DO storage or cache', doFiles.length > 0 && leaks.length === 0, leaks.length ? leaks.join(', ') : `${doFiles.length} DO files scanned`);

	// Sliding idle TTL: shorten to 2 s, wait, and the jar is gone.
	await page.evaluate(() => fetch('/__px/session', { method: 'POST', body: JSON.stringify({ ttlSeconds: 2 }) }));
	await sleep(4000);
	const expired = await page.evaluate(() => fetch('/__px/session').then((r) => r.json()));
	check('[live] idle TTL deletes the jar', expired.active && expired.stored === false && expired.cookies === 0, JSON.stringify(expired));
	const afterTtl = await cookiesSeenUpstream(page, 'https://httpbin.org/cookies');
	check('[live] expired jar sends nothing upstream', Object.keys(afterTtl).length === 0, JSON.stringify(afterTtl));
	await ctx.close();
}

// --- toolbar ----------------------------------------------------------------------------------------
{
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto(`${BASE}/#https://example.com/`, { waitUntil: 'load' });
	await page.waitForFunction(() => /^snapshot/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
	const framed = page.frame({ name: 'preview' }).url();
	const popup = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
	await page.click('#newTab');
	const tab = await popup;
	if (tab) await tab.waitForLoadState('load');
	check('[toolbar] ↗ opens the framed page in a new tab', tab && tab.url() === framed, tab ? tab.url() : `no tab opened (frame now ${page.frame({ name: 'preview' }).url()})`);
	await ctx.close();
}

await browser.close();
for (const s of echoServers) s.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
