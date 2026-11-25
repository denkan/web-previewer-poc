/*
 * Catch-all service worker (scope "/"). Sees every subresource request a proxied page makes, including ones no DOM
 * patch can reach: dynamic import(), innerHTML-inserted images, CSS-in-JS, workers. Cross-origin http(s) requests go
 * to their proxied URL. Registered as /__px/sw.js?root=px.localhost:8787[&live=1]. WebSockets never reach it.
 */
/*@codec*/

const params = new URL(self.location.href).searchParams;
const ROOT = params.get('root');
const LIVE = params.get('live') === '1';
const ROOT_HOSTNAME = ROOT.replace(/:\d+$/, '');
const ROOT_PORT = (ROOT.match(/:(\d+)$/) || ['', ''])[1];
const hashes = new Map(); // origin -> Promise<hash>, dictionary fallback only

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const isOurHostname = (h) => h === ROOT_HOSTNAME || h.endsWith('.' + ROOT_HOSTNAME);

function hashFor(origin) {
	if (!hashes.has(origin)) {
		const p = fetch('/__px/register', { method: 'POST', body: origin }).then((r) => {
			if (!r.ok) throw new Error(`register ${origin}: ${r.status}`);
			return r.text();
		});
		p.catch(() => hashes.delete(origin));
		hashes.set(origin, p);
	}
	return hashes.get(origin);
}

async function proxiedOrigin(origin) {
	const host = pxSubHost(origin, ROOT, LIVE) ?? `${await hashFor(origin)}${LIVE ? '.live' : ''}.${ROOT}`;
	return `${self.location.protocol}//${host}`;
}

async function forward(req, url) {
	const sameOrigin = new URL(url, self.location.href).origin === self.location.origin;
	// Cross-host no-cors loads (img, script without crossorigin) can be answered with an opaque response.
	const mode = sameOrigin ? 'same-origin' : req.mode === 'no-cors' ? 'no-cors' : 'cors';
	// Live: the session cookie (Domain={root}) must ride along so the server can attach jar cookies.
	const credentials = sameOrigin || LIVE ? 'include' : 'omit';
	const init = { method: req.method, headers: req.headers, mode, credentials, redirect: 'follow' };
	if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
	return fetch(url, init);
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.mode === 'navigate') return; // navigations are rewritten server-side / by the runtime
	const url = new URL(req.url);
	if (url.origin === self.location.origin) return;
	if (isOurHostname(url.hostname)) {
		// One of our hosts minus its port (built from location.hostname): repair the port, don't proxy it again.
		if (url.port !== ROOT_PORT) {
			url.port = ROOT_PORT;
			event.respondWith(forward(req, url.href));
		}
		return;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
	event.respondWith(
		proxiedOrigin(url.origin).then(
			(o) => forward(req, o + url.pathname + url.search),
			() => fetch(req),
		),
	);
});
