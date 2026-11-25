/*
 * Extension host, toolbar side. Bundled with every extension's shell.client.js into /__px/shell.js (see
 * src/extensions). A view has one or more panes: <iframe data-pane="..."> ("main" in the single view, "a" and "b" in
 * the map view). Each extension calls pxExtension(name, (px) => { ... }) and gets:
 *
 *   px.view                                   'single' | 'map' (from <body data-view>); an extension returns early if it doesn't apply
 *   px.panes                                  pane ids in this view, e.g. ['main'] or ['a', 'b']
 *   px.send(event, data, pane?)               to the extension's page half in one pane (default: every pane)
 *   px.on(event, fn)                          fn(data, pane) for messages from the page halves
 *   px.page(pane?) / px.onPage(fn)            original URL shown in a pane; fn(url, pane) on every load and SPA navigation
 *   px.frame(pane)                            the pane's <iframe> (geometry for overlays drawn across panes)
 *   px.button({ label, title, onClick })      a toolbar button (returns the element)
 *   px.panel({ title })                       a tab in the right-hand drawer: { el, open(), close(), toggle(), isOpen(), onToggle(fn) }
 *   px.store(scope)                           server-side items: list(page?), create(page, data), update(id, data), remove(id).
 *                                             scope: an original origin ("https://site.com") or "{kind}:{name}" (e.g. "board:default")
 *   px.navigate(url, pane?)                   load an original URL in a pane
 *   px.prefs                                  localStorage, namespaced: get(key, fallback), set(key, value)
 *   px.css(text)                              add a stylesheet to the toolbar
 */
const VIEW = document.body.dataset.view || 'single';
const frames = new Map([...document.querySelectorAll('iframe[data-pane]')].map((f) => [f.dataset.pane, f]));
const PANES = [...frames.keys()];
const buttons = document.getElementById('extButtons');
const drawer = document.getElementById('drawer');
const tabs = document.getElementById('drawerTabs');
const panels = document.getElementById('drawerPanels');
const registered = [];
const handlers = new Map(); // "ext event" -> fn[]
const pageHooks = [];
const allPanels = [];
const panes = new Map(PANES.map((p) => [p, { origin: null, url: null }])); // origin: proxy host that last said hello

const isProxyOrigin = (o) => {
	try {
		return new URL(o).host.endsWith('.' + location.host);
	} catch {
		return false;
	}
};
const paneOf = (win) => PANES.find((p) => frames.get(p).contentWindow === win);
function post(pane, ext, event, data) {
	const s = panes.get(pane);
	if (s && s.origin) frames.get(pane).contentWindow.postMessage({ type: 'px:ext', ext, event, data }, s.origin);
}

addEventListener('message', (e) => {
	const pane = paneOf(e.source);
	if (!pane || !e.data || e.data.type !== 'px:ext' || !isProxyOrigin(e.origin)) return;
	const { ext, event, data } = e.data;
	const s = panes.get(pane);
	if (ext === '*') {
		// A page (re)loaded or navigated: its extension state starts over, so every extension re-syncs.
		if ((event === 'hello' || event === 'navigate') && data && typeof data.url === 'string') {
			s.origin = e.origin;
			s.url = data.url;
			for (const fn of pageHooks) fn(s.url, pane);
		}
		return;
	}
	if (e.origin !== s.origin) return;
	for (const fn of handlers.get(ext + ' ' + event) || []) {
		try {
			fn(data, pane);
		} catch (err) {
			console.error('[px:' + ext + ']', err);
		}
	}
});

function panel(title) {
	const tab = document.createElement('button');
	tab.textContent = title;
	const el = document.createElement('section');
	el.hidden = true;
	tabs.append(tab);
	panels.append(el);
	const toggles = [];
	const p = {
		el,
		isOpen: () => !drawer.hidden && !el.hidden,
		open() {
			for (const o of allPanels) if (o !== p && o.isOpen()) o.close();
			el.hidden = drawer.hidden = false;
			tab.classList.add('on');
			toggles.forEach((fn) => fn(true));
			dispatchEvent(new Event('resize')); // panes changed size
		},
		close() {
			el.hidden = true;
			tab.classList.remove('on');
			if (allPanels.every((o) => o.el.hidden)) drawer.hidden = true;
			toggles.forEach((fn) => fn(false));
			dispatchEvent(new Event('resize'));
		},
		toggle: () => (p.isOpen() ? p.close() : p.open()),
		onToggle: (fn) => toggles.push(fn),
	};
	tab.onclick = () => p.open();
	allPanels.push(p);
	tabs.hidden = allPanels.length < 2;
	return p;
}

function store(name, scope) {
	const q = (extra = '') => '?scope=' + encodeURIComponent(scope) + extra;
	const req = (path, init) =>
		fetch('/__px/ext/' + name + '/items' + path, init).then((r) => {
			if (!r.ok) throw new Error('store ' + r.status);
			return r.status === 204 ? null : r.json();
		});
	const send = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	return {
		list: (page) => req(q(page ? '&page=' + encodeURIComponent(page) : '')),
		create: (page, data) => req(q(), send('POST', { page: page || '', data })),
		update: (id, data) => req('/' + id + q(), send('PATCH', { data })),
		remove: (id) => req('/' + id + q(), { method: 'DELETE' }),
	};
}

function pxExtension(name, init) {
	registered.push({ name, init });
}

function pxStart() {
	for (const { name, init } of registered) {
		const key = 'px-ext-' + name + '-';
		const px = {
			view: VIEW,
			panes: PANES,
			send: (event, data, pane) => (pane ? [pane] : PANES).forEach((p) => post(p, name, event, data)),
			on: (event, fn) => {
				const k = name + ' ' + event;
				handlers.set(k, [...(handlers.get(k) || []), fn]);
			},
			page: (pane = PANES[0]) => (panes.get(pane) || {}).url || null,
			onPage: (fn) => pageHooks.push(fn),
			frame: (pane) => frames.get(pane),
			button({ label, title, onClick }) {
				const b = document.createElement('button');
				b.textContent = label;
				if (title) b.title = title;
				b.onclick = onClick;
				buttons.append(b);
				return b;
			},
			panel: ({ title }) => panel(title),
			store: (scope) => store(name, scope),
			navigate(url, pane = PANES[0]) {
				// The view may handle it (the map view loads panes itself, even before they show anything).
				const ev = new CustomEvent('px:navigate', { cancelable: true, detail: { url, pane } });
				if (dispatchEvent(ev)) post(pane, '*', 'navigate-to', { url });
			},
			prefs: {
				get(k, fallback) {
					try {
						const v = localStorage.getItem(key + k);
						return v == null ? fallback : JSON.parse(v);
					} catch {
						return fallback;
					}
				},
				set(k, v) {
					try {
						localStorage.setItem(key + k, JSON.stringify(v));
					} catch {}
				},
			},
			css(text) {
				const s = document.createElement('style');
				s.textContent = text;
				document.head.append(s);
			},
		};
		try {
			init(px);
		} catch (err) {
			console.error('[px:' + name + ']', err);
		}
	}
	// A frame may have said hello before this script ran: ask again (no data in it, so any target is fine).
	for (const f of frames.values()) if (f.contentWindow) f.contentWindow.postMessage({ type: 'px:ext', ext: '*', event: 'hello?' }, '*');
}
