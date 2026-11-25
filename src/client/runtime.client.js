/*
 * Proxy runtime. Injected synchronously at the very top of every proxied HTML page, before any page script.
 * The server rewrites every URL it can see in HTML/CSS/JS; this catches URLs that page JavaScript builds at runtime.
 * The service worker (registered at the bottom) is the catch-all for anything these patches miss.
 * window.__PX__, the postMessage API and the extension hooks at the bottom are what extensions build on.
 */
(() => {
	if (window.__PX_RUNTIME__) return;
	window.__PX_RUNTIME__ = true;

	/*@codec*/

	const cfg = (window.__PX__ = window.__PX__ || { hashes: {} });
	cfg.hashes = cfg.hashes || {};
	const ROOT = cfg.root || location.host.split('.').slice(1).join('.'); // "px.localhost:8787"
	const LIVE = !!cfg.live;
	const HERE = location.origin;
	const SKIP = /^\s*(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
	const nativeFetch = window.fetch.bind(window);
	const nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
	const xhrOpen = XMLHttpRequest.prototype.open;
	const ROOT_HOSTNAME = ROOT.replace(/:\d+$/, '');
	const ROOT_PORT = (ROOT.match(/:(\d+)$/) || ['', ''])[1];
	const isOurHostname = (h) => h === ROOT_HOSTNAME || h.endsWith('.' + ROOT_HOSTNAME);

	try {
		performance.setResourceTimingBufferSize(5000); // stats() below reads these
	} catch {}

	// Dictionary fallback for the rare origin that can't be one DNS label (ports, single-label hosts). Synchronous on
	// purpose: callers like img.src= are sync. Readable origins (nearly all) need no request at all.
	function hashFor(origin) {
		let h = cfg.hashes[origin];
		if (h) return h;
		try {
			const x = new XMLHttpRequest();
			xhrOpen.call(x, 'POST', '/__px/register', false);
			x.send(origin);
			if (x.status === 200) h = cfg.hashes[origin] = x.responseText;
		} catch {}
		return h;
	}

	/** Absolute proxied origin: "http://cdn-site-com.px.localhost:8787" (".live." in live mode). */
	function proxiedOrigin(origin) {
		let host = pxSubHost(origin, ROOT, LIVE);
		if (!host) {
			const h = hashFor(origin);
			if (!h) return null;
			host = h + (LIVE ? '.live' : '') + '.' + ROOT;
		}
		return location.protocol + '//' + host;
	}

	function toProxy(input) {
		if (input == null || input === '') return input;
		const s = String(input);
		if (SKIP.test(s)) return input;
		let u;
		try {
			u = new URL(s.trim(), document.baseURI);
		} catch {
			return input;
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;
		// Page code that builds URLs from location.hostname drops our port ("http://www-apple-com.px.localhost/b/ss"):
		// that's one of our own hosts, so repair the port instead of proxying it a second time.
		if (isOurHostname(u.hostname)) {
			if (u.port === ROOT_PORT) return s;
			u.port = ROOT_PORT;
			return u.href;
		}
		const origin = proxiedOrigin(u.origin);
		if (!origin) return input;
		// Keep the string's shape (protocol-relative stays protocol-relative) so code comparing URLs as strings still matches.
		const tail = u.pathname + u.search + u.hash;
		return s.trim().startsWith('//') ? origin.replace(/^https?:/, '') + tail : origin + tail;
	}

	function srcset(value) {
		return String(value)
			.split(/,\s+(?=\S)/)
			.map((c) => {
				const [url, ...d] = c.trim().split(/\s+/);
				return [toProxy(url), ...d].join(' ');
			})
			.join(', ');
	}

	const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
	function css(value) {
		return String(value).replace(CSS_URL, (whole, dq, sq, bare) => {
			const u = dq ?? sq ?? bare ?? '';
			if (!u || /^data:/i.test(u)) return whole;
			const q = dq != null ? '"' : sq != null ? "'" : '';
			return `url(${q}${toProxy(u)}${q})`;
		});
	}

	// --- network APIs ---------------------------------------------------------------------------
	window.fetch = function (input, init) {
		try {
			if (input instanceof Request) {
				const next = toProxy(input.url);
				if (next !== input.url) input = new Request(next, input);
			} else {
				input = toProxy(input instanceof URL ? input.href : input);
			}
		} catch {}
		return nativeFetch(input, init);
	};

	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		return xhrOpen.call(this, method, toProxy(url), ...rest);
	};

	if (nativeBeacon) navigator.sendBeacon = (url, data) => nativeBeacon(toProxy(url), data);

	const NativeWorker = window.Worker;
	if (NativeWorker) {
		window.Worker = class extends NativeWorker {
			constructor(url, opts) {
				super(toProxy(url), opts);
			}
		};
	}

	// WebSockets: a service worker can't see them, so this patch is the only layer. wss://site.com/x is an upgraded
	// https request: route it through the https proxy URL, then switch the scheme back to ws(s) for our own host.
	const NativeWebSocket = window.WebSocket;
	if (NativeWebSocket) {
		const toProxyWs = (url) => {
			try {
				const u = new URL(String(url), location.href);
				if (u.protocol === 'ws:' || u.protocol === 'wss:') u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
				const next = new URL(toProxy(u.href), location.href);
				next.protocol = next.protocol === 'https:' ? 'wss:' : 'ws:';
				return next.href;
			} catch {
				return url;
			}
		};
		window.WebSocket = class extends NativeWebSocket {
			constructor(url, protocols) {
				super(toProxyWs(url), protocols);
			}
		};
	}

	// --- DOM URL properties & attributes --------------------------------------------------------
	function patchProp(proto, name, fn) {
		const d = proto && Object.getOwnPropertyDescriptor(proto, name);
		if (!d || !d.set) return;
		Object.defineProperty(proto, name, {
			...d,
			set(v) {
				d.set.call(this, fn(v));
			},
		});
	}
	const props = [
		[window.HTMLImageElement, ['src']],
		[window.HTMLScriptElement, ['src']],
		[window.HTMLLinkElement, ['href']],
		[window.HTMLIFrameElement, ['src']],
		[window.HTMLSourceElement, ['src']],
		[window.HTMLMediaElement, ['src']],
		[window.HTMLVideoElement, ['poster']],
		[window.HTMLEmbedElement, ['src']],
		[window.HTMLObjectElement, ['data']],
		[window.HTMLFormElement, ['action']],
		[window.HTMLInputElement, ['src', 'formAction']],
		[window.HTMLButtonElement, ['formAction']],
		[window.HTMLTrackElement, ['src']],
	];
	for (const [C, names] of props) if (C) for (const n of names) patchProp(C.prototype, n, toProxy);
	patchProp(HTMLImageElement.prototype, 'srcset', srcset);
	patchProp(HTMLSourceElement.prototype, 'srcset', srcset);

	// Anchors are left alone on purpose: SPA routers compare a.href to location; the click handler below covers navigation.
	const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster', 'background', 'data-src', 'xlink:href']);
	const setAttr = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (name, value) {
		try {
			const n = String(name).toLowerCase();
			if (n === 'srcset' || n === 'imagesrcset') value = srcset(value);
			else if (n === 'style') value = css(value);
			else if (n === 'data' && this instanceof HTMLObjectElement) value = toProxy(value);
			else if (URL_ATTRS.has(n) && !(this instanceof HTMLAnchorElement || this instanceof HTMLAreaElement)) value = toProxy(value);
		} catch {}
		return setAttr.call(this, name, value);
	};

	// --- cookies --------------------------------------------------------------------------------
	const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
	if (LIVE) {
		// Live: the jar lives on the server. document.cookie reads a local copy of this page's non-HttpOnly jar cookies
		// (shipped in the bootstrap config, so reads stay synchronous); writes update the copy and are beaconed back.
		const local = new Map();
		for (const part of String(cfg.cookies || '').split(/;\s*/)) {
			if (!part) continue;
			const i = part.indexOf('=');
			local.set(i < 0 ? '' : part.slice(0, i), i < 0 ? part : part.slice(i + 1));
		}
		Object.defineProperty(Document.prototype, 'cookie', {
			configurable: true,
			enumerable: true,
			get() {
				return [...local].map(([k, v]) => (k ? k + '=' + v : v)).join('; ');
			},
			set(v) {
				const str = String(v);
				const [pair, ...attrs] = str.split(';');
				const i = pair.indexOf('=');
				const name = (i < 0 ? '' : pair.slice(0, i)).trim();
				const value = (i < 0 ? pair : pair.slice(i + 1)).trim();
				if (attrs.some((a) => a.trim().toLowerCase() === 'httponly')) return; // JS can't set HttpOnly
				const expired = attrs.some((a) => {
					const [k, ...rest] = a.split('=');
					const key = k.trim().toLowerCase();
					const val = rest.join('=').trim();
					return (key === 'max-age' && Number(val) <= 0) || (key === 'expires' && Date.parse(val) < Date.now());
				});
				if (expired) local.delete(name);
				else local.set(name, value);
				const body = JSON.stringify({ url: location.href, cookie: str });
				if (!nativeBeacon || !nativeBeacon('/__px/cookie', new Blob([body], { type: 'text/plain' }))) {
					nativeFetch('/__px/cookie', { method: 'POST', body, keepalive: true }).catch(() => {});
				}
			},
		});
	} else if (cookieDesc && cookieDesc.set) {
		// Snapshot: cookies stay in the browser, host-only on the proxy host. Domain=.site.com would be rejected there.
		Object.defineProperty(Document.prototype, 'cookie', {
			...cookieDesc,
			set(v) {
				cookieDesc.set.call(this, String(v).replace(/;\s*domain=[^;]*/gi, ''));
			},
		});
	}

	// --- navigation -----------------------------------------------------------------------------
	// Runs last in the bubble phase, so SPA routers that preventDefault() and pushState() win.
	addEventListener('click', (e) => {
		if (e.defaultPrevented || e.button !== 0) return;
		const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement);
		if (!a || !a.href || a.hasAttribute('download')) return;
		const next = new URL(toProxy(a.href), location.href).href;
		if (next === a.href) return;
		e.preventDefault();
		if (e.metaKey || e.ctrlKey || a.target === '_blank') window.open(next, '_blank');
		else location.assign(next);
	});

	// location.href = "https://site.com/x" can't be intercepted by patching (location is unforgeable), but the
	// Navigation API (Chromium) fires a cancelable `navigate` event for it: cancel and go to the proxied URL instead.
	if (window.navigation) {
		navigation.addEventListener('navigate', (e) => {
			if (!e.cancelable || e.hashChange || e.formData || e.downloadRequest != null) return;
			let u;
			try {
				u = new URL(e.destination.url);
			} catch {
				return;
			}
			if (u.origin === HERE || (u.protocol !== 'http:' && u.protocol !== 'https:')) return;
			const next = toProxy(u.href);
			if (!next || next === u.href) return;
			e.preventDefault();
			if (e.navigationType === 'replace') location.replace(next);
			else location.assign(next);
		});
	}

	const nativeOpen = window.open;
	window.open = function (url, ...rest) {
		return nativeOpen.call(this, url == null ? url : toProxy(url), ...rest);
	};

	// --- service worker -------------------------------------------------------------------------
	const sw = navigator.serviceWorker;
	if (sw) {
		const register = sw.register.bind(sw);
		// The page's own service worker would claim our scope and outrank ours; refuse it.
		sw.register = () => Promise.reject(new DOMException('Service workers are disabled in the previewer', 'SecurityError'));
		register('/__px/sw.js?root=' + encodeURIComponent(ROOT) + (LIVE ? '&live=1' : ''), { scope: '/' })
			.then((r) => r.update())
			.catch(() => {});
	}

	// --- API for the toolbar / future interaction layer -----------------------------------------
	cfg.toProxy = toProxy;
	cfg.currentUrl = () => (cfg.origin ? cfg.origin + location.pathname + location.search + location.hash : null);

	const isProxied = (u) => isOurHostname(u.hostname);
	cfg.stats = () => {
		const tag = (e) => ((e.serverTiming || []).find((t) => t.name === 'px') || {}).description;
		const nav = performance.getEntriesByType('navigation')[0];
		const s = { page: (nav && tag(nav)) || '?', loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : null, hit: 0, miss: 0, other: 0, sw: 0, leaked: 0 };
		const assets = [location.href];
		for (const e of performance.getEntriesByType('resource')) {
			const u = new URL(e.name);
			if (u.pathname.startsWith('/__px/')) continue;
			assets.push(u.href);
			if (isProxied(u)) {
				const t = tag(e);
				t === 'HIT' ? s.hit++ : t === 'MISS' ? s.miss++ : s.other++;
			} else if (e.workerStart > 0) s.sw++;
			else s.leaked++;
		}
		return { ...s, assets };
	};

	// The toolbar is on another host, so it talks to us via postMessage.
	addEventListener('message', (e) => {
		if (e.source !== parent || !e.data || typeof e.data.type !== 'string') return;
		if (e.data.type === 'px:query') {
			parent.postMessage({ type: 'px:state', live: LIVE, href: location.href, url: cfg.currentUrl(), stats: cfg.stats() }, '*');
		} else if (e.data.type === 'px:reload') {
			location.reload();
		}
	});
	if (parent !== window) addEventListener('load', () => parent.postMessage({ type: 'px:loaded' }, '*'));

	// --- hooks for extensions (see src/client/ext-page.client.js) --------------------------------
	// Input: registered here, before any page script, because window capture listeners run in registration order. An
	// extension hook that returns true swallows the event before the page sees it (e.g. clicks while picking a target).
	const inputHooks = [];
	cfg.onInput = (fn) => inputHooks.push(fn);
	const INPUT_EVENTS = [
		'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'selectstart', 'dragstart', 'touchstart', 'touchend', 'keydown', 'keyup',
		'pointermove', 'mousemove', 'pointerover', 'pointerout', 'mouseover', 'mouseout', 'pointerenter', 'pointerleave', 'mouseenter', 'mouseleave',
	];
	for (const type of INPUT_EVENTS) {
		addEventListener(
			type,
			(e) => {
				for (const h of inputHooks) {
					if (h(e)) return e.stopImmediatePropagation();
				}
			},
			true,
		);
	}

	// SPA navigations (history API, Navigation API) don't reload the page or the extensions; tell them instead.
	const navHooks = [];
	cfg.onNavigate = (fn) => navHooks.push(fn);
	const bare = () => location.href.replace(/#.*$/, '');
	let lastUrl = bare();
	const navigated = () => {
		if (bare() === lastUrl) return;
		lastUrl = bare();
		for (const fn of navHooks) {
			try {
				fn(cfg.currentUrl());
			} catch {}
		}
	};
	for (const m of ['pushState', 'replaceState']) {
		const orig = history[m];
		history[m] = function (...args) {
			const r = orig.apply(this, args);
			navigated();
			return r;
		};
	}
	addEventListener('popstate', navigated);
	if (window.navigation) navigation.addEventListener('navigatesuccess', navigated);

	// Extensions sit next to the toolbar, so they only load in a page framed directly by it (not in a new tab, not in
	// the page's own iframes). Loaded after parsing: they only need the DOM, never patch anything early.
	if (parent !== window && parent === top) {
		const load = () => {
			const s = document.createElement('script');
			s.src = '/__px/ext.js';
			s.onload = s.onerror = () => s.remove();
			document.documentElement.appendChild(s);
		};
		if (document.readyState === 'loading') addEventListener('DOMContentLoaded', load, { once: true });
		else load();
	}
})();
