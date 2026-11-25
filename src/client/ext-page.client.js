/*
 * Extension host, page side. Bundled with every extension's page.client.js into /__px/ext.js (see src/extensions),
 * which the runtime loads only into a page framed directly by the toolbar. Each extension calls
 * pxExtension(name, (px) => { ... }) and gets:
 *
 *   px.send(event, data) / px.on(event, fn)  talk to the same extension's toolbar half
 *   px.page()                                original URL of this page, without the fragment
 *   px.onNavigate(fn)                        SPA navigation (history / Navigation API): fn(newUrl)
 *   px.overlay()                             this extension's own shadow root, drawn above the page (attached after load)
 *   px.isOwn(event)                          true if the event happened inside this extension's overlay
 *   px.css(text)                             document-level stylesheet via adoptedStyleSheets: { replace(text), remove() }
 *   px.onInput(fn)                           pointer/key events before any page listener; return true to swallow it.
 *                                            Events on an extension's overlay go to that extension only, and never to the page.
 *   px.anchors                               find things again later: element(el, event?), text(range), resolve(anchor),
 *                                            resolveAll(anchors), alive(target), rect(target), point(target, anchor), targetOf(event)
 *   px.pick({ sticky, hint, onPick, onEnd })  pick mode: click an element or select text -> onPick({ anchor, el | range })
 *   px.draw({ color, hint, onStroke, onEnd }) draw mode: freehand strokes -> onStroke({ anchor, points }), points relative to anchor
 *   px.uiScale(scale)                        the toolbar shows this page scaled by `scale`: overlay sizes use var(--px-z) = 1/scale
 *   px.stopTool()                            end pick / draw mode. onEnd(why) runs either way: 'stop' | 'switch' | 'esc' | 'navigate'
 *   px.toProxy(url)                          original URL -> proxied URL
 *
 * Apart from one overlay host element per extension, appended to <html> after load, nothing here touches the page's
 * DOM, so it can't upset hydration. The page's own scripts share this realm: they could read the overlays or our
 * messages. Fine for a review tool on someone else's site, not a security boundary.
 */
const cfg = window.__PX__;
const TOOLBAR = location.protocol + '//' + cfg.root; // the only window we talk to
const registered = [];
const handlers = new Map(); // "ext event" -> fn[]
const inputs = new Map(); // ext -> fn[]

const post = (ext, event, data) => parent.postMessage({ type: 'px:ext', ext, event, data }, TOOLBAR);
const page = () => String(cfg.currentUrl() || '').replace(/#.*$/, '');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// --- overlays: one shadow root per extension, plus the host's own (pick / draw tools) ------------------------
const overlays = new Map(); // owner -> { host, root }
let attachable = false;
let uiZoom = 1; // 1 / how much the toolbar scales this page down; overlay UI multiplies its sizes by --px-z
function attachAll() {
	if (!attachable) return;
	for (const { host } of overlays.values()) if (!host.isConnected) document.documentElement.appendChild(host);
}
function overlayFor(owner) {
	let o = overlays.get(owner);
	if (!o) {
		const host = document.createElement('px-overlay');
		host.dataset.ext = owner;
		host.style.cssText = 'all:initial;display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict';
		host.style.setProperty('--px-z', uiZoom);
		o = { host, root: host.attachShadow({ mode: 'open' }) };
		overlays.set(owner, o);
		attachAll();
	}
	return o.root;
}
/** Which overlay (extension name, or 'px' for the tools) an event happened in, if any. */
function ownerOf(e) {
	const path = e.composedPath();
	for (const [owner, { host }] of overlays) if (path.includes(host)) return owner;
	return null;
}
// Attach only after load (hydrating frameworks own the document until then), or 3 s after parsing at the latest.
const ready = () => {
	if (attachable) return;
	attachable = true;
	attachAll();
	new MutationObserver(attachAll).observe(document.documentElement, { childList: true }); // SPAs that rebuild <html>
};
if (document.readyState === 'complete') ready();
else {
	addEventListener('load', ready, { once: true });
	setTimeout(ready, 3000);
}

function css(text) {
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(text);
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	return {
		replace: (t) => sheet.replaceSync(t),
		remove: () => (document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)),
	};
}

// --- anchors ------------------------------------------------------------------------------------------------
/*
 * An anchor is several independent ways back to a target, tried in order:
 *   text    {quote: {exact, prefix, suffix}}  W3C-style text quote (prefix/suffix pick among repeats); whitespace-insensitive
 *                                             fallback; else the element it was in ("approx")
 *   element {selector, tag, text, point}      CSS path verified by tag + text; else the same tag + text elsewhere, nearest
 *                                             to where it was (moved); else the path if its text is still similar (approx)
 * Resolved targets: { el | range, status: 'ok' | 'approx' | 'missing' }.
 */
const anchors = (() => {
	const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
	const clamp = (v) => Math.min(1, Math.max(0, v));
	function snippet(el) {
		const t = norm(el.textContent).slice(0, 80);
		if (t) return t;
		const a = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
		return norm(a || (el.getAttribute('src') || '').split('/').pop()).slice(0, 80);
	}
	function cssPath(el) {
		const parts = [];
		for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
			// Ids are the most stable hook, unless generated (React's :r1:, long digit runs).
			if (n.id && !/\d{3,}|^\d|:/.test(n.id) && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) {
				parts.unshift('#' + CSS.escape(n.id));
				break;
			}
			if (n === document.body) {
				parts.unshift('body');
				break;
			}
			let i = 1;
			for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
			parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
		}
		return parts.join(' > ');
	}
	function element(el, e) {
		const r = el.getBoundingClientRect();
		const x = e ? e.clientX : r.left + r.width / 2;
		const y = e ? e.clientY : r.top + r.height / 2;
		return {
			kind: 'element',
			selector: cssPath(el),
			tag: el.tagName.toLowerCase(),
			text: snippet(el),
			point: { x: r.width ? clamp((x - r.left) / r.width) : 0.5, y: r.height ? clamp((y - r.top) / r.height) : 0.5 },
			doc: { x: Math.round(x + scrollX), y: Math.round(y + scrollY) },
			viewport: { w: innerWidth, h: innerHeight },
		};
	}
	/** All text of <body> as one string, plus where each text node starts in it. */
	function textIndex() {
		const nodes = [];
		let text = '';
		const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => (SKIP_TEXT.has(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
		});
		for (let n; (n = w.nextNode()); ) {
			nodes.push({ n, start: text.length });
			text += n.data;
		}
		return { text, nodes };
	}
	function offsetOf(idx, container, offset) {
		if (container.nodeType === 3) {
			const hit = idx.nodes.find((x) => x.n === container);
			if (hit) return hit.start + offset;
		}
		const ref = container.nodeType === 3 ? container : container.childNodes[offset] || container;
		for (const x of idx.nodes) {
			if (ref === x.n || ref.contains(x.n) || ref.compareDocumentPosition(x.n) & Node.DOCUMENT_POSITION_FOLLOWING) return x.start;
		}
		return idx.text.length;
	}
	function text(range) {
		const idx = textIndex();
		const s = offsetOf(idx, range.startContainer, range.startOffset);
		const e = Math.min(offsetOf(idx, range.endContainer, range.endOffset), s + 2000);
		const host = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
		const r = range.getBoundingClientRect();
		return {
			kind: 'text',
			quote: { exact: idx.text.slice(s, e), prefix: idx.text.slice(Math.max(0, s - 32), s), suffix: idx.text.slice(e, e + 32) },
			selector: cssPath(host),
			tag: host.tagName.toLowerCase(),
			text: snippet(host),
			point: { x: 0, y: 0 },
			doc: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY) },
			viewport: { w: innerWidth, h: innerHeight },
		};
	}
	function rangeAt(idx, s, e) {
		const find = (pos, isEnd) => {
			let lo = 0;
			let hi = idx.nodes.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				const st = idx.nodes[mid].start;
				if (isEnd ? st < pos : st <= pos) lo = mid;
				else hi = mid - 1;
			}
			return idx.nodes[lo];
		};
		const a = find(s, false);
		const b = find(e, true);
		if (!a || !b) return null;
		const r = document.createRange();
		r.setStart(a.n, Math.min(s - a.start, a.n.data.length));
		r.setEnd(b.n, Math.min(e - b.start, b.n.data.length));
		return r;
	}
	const sharedTail = (a, b) => {
		let i = 0;
		while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
		return i;
	};
	const sharedHead = (a, b) => {
		let i = 0;
		while (i < a.length && i < b.length && a[i] === b[i]) i++;
		return i;
	};
	function bestMatch(t, q) {
		let best = -1;
		let score = -1;
		for (let i = t.indexOf(q.exact); i !== -1; i = t.indexOf(q.exact, i + 1)) {
			const sc = sharedTail(t.slice(Math.max(0, i - q.prefix.length), i), q.prefix) + sharedHead(t.slice(i + q.exact.length, i + q.exact.length + q.suffix.length), q.suffix);
			if (sc > score) {
				best = i;
				score = sc;
			}
		}
		return best;
	}
	function findQuote(idx, q) {
		if (!q.exact) return null;
		const at = bestMatch(idx.text, q);
		if (at >= 0) return rangeAt(idx, at, at + q.exact.length);
		// Whitespace differs between server HTML and the hydrated DOM more often than words do: match collapsed.
		const map = [];
		let flat = '';
		for (let i = 0; i < idx.text.length; i++) {
			if (/\s/.test(idx.text[i])) {
				if (flat.endsWith(' ')) continue;
				flat += ' ';
			} else flat += idx.text[i];
			map.push(i);
		}
		const cq = { exact: norm(q.exact), prefix: q.prefix.replace(/\s+/g, ' '), suffix: q.suffix.replace(/\s+/g, ' ') };
		const f = bestMatch(flat, cq);
		return f >= 0 ? rangeAt(idx, map[f], map[f + cq.exact.length - 1] + 1) : null;
	}
	/** Dice coefficient over character bigrams >= 0.5. */
	function similar(a, b) {
		if (a === b) return true;
		const grams = (s) => {
			const m = new Map();
			for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
			return m;
		};
		const x = grams(a.toLowerCase());
		const y = grams(b.toLowerCase());
		let common = 0;
		for (const [g, n] of x) common += Math.min(n, y.get(g) || 0);
		const total = Math.max(0, a.length - 1) + Math.max(0, b.length - 1);
		return total > 0 && (2 * common) / total >= 0.5;
	}
	function findElement(a) {
		let el = null;
		try {
			el = document.querySelector(a.selector);
		} catch {}
		const sameTag = el && el.tagName.toLowerCase() === a.tag;
		if (sameTag && snippet(el) === a.text) return { el, status: 'ok' };
		if (a.text) {
			// Moved: the same tag with the same text elsewhere, nearest to where it was.
			const all = document.getElementsByTagName(a.tag);
			let best = null;
			let dist = Infinity;
			for (let i = 0; i < all.length && i < 5000; i++) {
				if (snippet(all[i]) !== a.text) continue;
				const r = all[i].getBoundingClientRect();
				const d = Math.hypot(r.left + scrollX - a.doc.x, r.top + scrollY - a.doc.y);
				if (d < dist) {
					best = all[i];
					dist = d;
				}
			}
			if (best) return { el: best, status: 'ok' };
		}
		// Same place, content edited (a price, a reworded heading): only if the text is still similar, otherwise the
		// path now points at a different element (the original was removed and its siblings shifted up).
		return sameTag && similar(snippet(el), a.text) ? { el, status: 'approx' } : { status: 'missing' };
	}
	function resolveWith(anchor, idx) {
		if (!anchor) return { status: 'missing' };
		if (anchor.kind === 'doc') return { doc: true, status: 'ok' };
		if (anchor.kind === 'text') {
			const range = findQuote(idx(), anchor.quote);
			if (range) return { range, status: 'ok' };
			const f = findElement(anchor);
			return f.el ? { el: f.el, status: 'approx' } : f;
		}
		return findElement(anchor);
	}
	/** Resolve many at once: they share one text index. */
	function resolveAll(list) {
		let idx = null;
		const lazy = () => idx || (idx = textIndex());
		return list.map((a) => resolveWith(a, lazy));
	}
	const alive = (t) =>
		!!t && t.status !== 'missing' && (t.doc || (t.range ? t.range.startContainer.isConnected && !t.range.collapsed : t.el.isConnected));
	/** Viewport rect of a target (null if gone or hidden). */
	function rect(t) {
		if (!alive(t) || t.doc) return null;
		const r = t.range ? t.range.getBoundingClientRect() : t.el.getBoundingClientRect();
		return r.width || r.height ? r : null;
	}
	/** Where a pin goes: the clicked point of an element, the start of a quote. */
	function point(t, anchor) {
		if (!alive(t)) return null;
		if (t.range) {
			const r = t.range.getClientRects()[0];
			return r ? { x: r.left, y: r.top } : null;
		}
		const r = rect(t);
		return r ? { x: r.left + anchor.point.x * r.width, y: r.top + anchor.point.y * r.height } : null;
	}
	/** The page element an event is about: skip shadow internals (use their host), html and body; SVG parts -> the <svg>. */
	function targetOf(e) {
		const el = e.composedPath().find((n) => n instanceof Element && n.getRootNode() === document && n !== document.documentElement && n !== document.body) || document.body;
		let svg = el instanceof SVGElement ? el.closest('svg') : null;
		while (svg && svg.parentElement && svg.parentElement.closest('svg')) svg = svg.parentElement.closest('svg');
		return svg || el;
	}
	return { element, text, resolve: (a) => resolveAll([a])[0], resolveAll, alive, rect, point, targetOf, snippet };
})();

// --- tools: pick and draw -------------------------------------------------------------------------------------
// One tool at a time across all extensions. Both live in the host's own overlay ('px').
let tool = null; // { kind: 'pick' | 'draw', opts }
let toolUi = null;
const toolCss = css('');
function ensureToolUi() {
	if (toolUi) return toolUi;
	const root = overlayFor('px');
	root.innerHTML = `<style>
		.box { position: fixed; border: 2px dashed #7c5cff; border-radius: 3px; background: rgba(124,92,255,.08); pointer-events: none }
		.box span { position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; padding: 3px 6px; border-radius: 3px; transform: scale(var(--px-z)); transform-origin: 0 100%;
			background: #7c5cff; color: #fff; font: 11px/1 ui-monospace, monospace; white-space: nowrap }
		.hint { position: fixed; left: 50%; bottom: calc(18px * var(--px-z)); transform: translateX(-50%) scale(var(--px-z)); transform-origin: 50% 100%; padding: 9px 14px; border-radius: 8px; pointer-events: none;
			background: rgba(17,17,20,.92); color: #fff; font: 500 13px/1.3 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.3); white-space: nowrap }
		.canvas { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair }
		.canvas svg { width: 100%; height: 100% }
		.canvas path { fill: none; stroke-width: calc(3px * var(--px-z)); stroke-linecap: round; stroke-linejoin: round }
		[hidden] { display: none !important }
	</style><div class="box" hidden><span></span></div><div class="canvas" hidden><svg><path></path></svg></div><div class="hint" hidden></div>`;
	toolUi = { box: root.querySelector('.box'), canvas: root.querySelector('.canvas'), live: root.querySelector('.canvas path'), hint: root.querySelector('.hint') };
	return toolUi;
}
function startTool(kind, opts) {
	stopTool('switch');
	tool = { kind, opts };
	const ui = ensureToolUi();
	ui.hint.textContent = opts.hint || (kind === 'pick' ? 'Click an element or select text · Esc to stop' : 'Draw on the page · Esc to stop');
	ui.hint.hidden = false;
	if (kind === 'pick') {
		// Any text is selectable while picking: also where the site disables selection, and inside links (their drag
		// is cancelled below, so a drag selects text instead).
		toolCss.replace('*, *::before, *::after { cursor: crosshair !important; user-select: text !important; -webkit-user-select: text !important }');
		getSelection().removeAllRanges();
	} else {
		ui.canvas.hidden = false; // drawing happens on our canvas: the page gets no pointer events at all
		ui.live.setAttribute('stroke', opts.color || '#ff8a00');
	}
}
/** why: 'stop' (an extension asked), 'switch' (another tool started), 'esc', 'navigate'. Passed to onEnd. */
function stopTool(why = 'stop') {
	if (!tool) return;
	const t = tool;
	tool = null;
	toolCss.replace('');
	if (toolUi) {
		toolUi.box.hidden = toolUi.hint.hidden = toolUi.canvas.hidden = true;
		toolUi.live.setAttribute('d', '');
	}
	stroke = null;
	if (t.opts.onEnd) t.opts.onEnd(why);
}

/** Pointer movement events: hooked too, so draw mode can hide them from the page. Pick mode lets them through. */
const MOVES = new Set(['pointermove', 'mousemove', 'pointerover', 'pointerout', 'mouseover', 'mouseout', 'pointerenter', 'pointerleave', 'mouseenter', 'mouseleave']);

function pickInput(e) {
	const o = tool.opts;
	if (MOVES.has(e.type)) {
		// The page still sees movement while picking (hover menus open, so their items can be picked).
		if (e.type === 'pointermove' && !ownerOf(e)) {
			const el = anchors.targetOf(e);
			const r = el.getBoundingClientRect();
			toolUi.box.hidden = false;
			Object.assign(toolUi.box.style, { left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
			toolUi.box.firstChild.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
		}
		return false;
	}
	if (e.type === 'mouseup') {
		// A drag that selected text picks the text; the selection is final once this event is done.
		setTimeout(() => {
			const sel = getSelection();
			if (!tool || tool.opts !== o || !sel.rangeCount || sel.isCollapsed || !norm(sel.toString())) return;
			const range = sel.getRangeAt(0).cloneRange();
			sel.removeAllRanges();
			if (!o.sticky) stopTool();
			o.onPick({ anchor: anchors.text(range), range, status: 'ok' });
		});
	}
	if (e.type === 'click') {
		e.preventDefault(); // links don't navigate, buttons don't submit
		const sel = getSelection();
		if (sel.rangeCount && !sel.isCollapsed && norm(sel.toString())) return true; // text pick, handled on mouseup
		const el = anchors.targetOf(e);
		if (!o.sticky) stopTool();
		o.onPick({ anchor: anchors.element(el, e), el, status: 'ok' });
	}
	if (e.type === 'dragstart' || e.type === 'contextmenu' || e.type === 'auxclick') e.preventDefault();
	// Everything else (pointerdown, mousedown, selectstart, touch): hidden from the page, but the browser's default
	// still runs, so native text selection works.
	return true;
}

let stroke = null; // [[x, y], ...] in viewport px while drawing
/** Draw mode: our canvas covers the page (so CSS :hover doesn't react), and every pointer event, moves included, is
 * swallowed here (so the page's own listeners don't either). */
function drawInput(e) {
	if (e.type === 'pointermove' && stroke) {
		const [lx, ly] = stroke[stroke.length - 1];
		if (Math.hypot(e.clientX - lx, e.clientY - ly) >= 2 && stroke.length <= 2000) {
			stroke.push([e.clientX, e.clientY]);
			toolUi.live.setAttribute('d', 'M' + stroke.map((p) => p.join(' ')).join(' L'));
		}
	} else if (e.type === 'pointerdown' && e.button === 0) {
		e.preventDefault();
		stroke = [[e.clientX, e.clientY]];
	} else if (e.type === 'pointerup' && stroke) {
		const pts = stroke;
		stroke = null;
		toolUi.live.setAttribute('d', '');
		if (pts.length > 1) tool.opts.onStroke(strokeAnchor(pts));
	}
	return true;
}

/**
 * A stroke is anchored to the smallest element that contains all of it, with its points stored as fractions of that
 * element's box: it follows the element when the page reflows, and scales with it. Strokes across the whole page
 * (nothing smaller contains them) are anchored to the document instead.
 */
function strokeAnchor(pts) {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const box = { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
	toolUi.canvas.hidden = true; // hit-test the page, not our canvas
	let el = document.elementFromPoint((box.l + box.r) / 2, (box.t + box.b) / 2);
	toolUi.canvas.hidden = false;
	const contains = (n) => {
		const r = n.getBoundingClientRect();
		return r.left <= box.l + 4 && r.top <= box.t + 4 && r.right >= box.r - 4 && r.bottom >= box.b - 4;
	};
	while (el && el !== document.body && el !== document.documentElement && !contains(el)) el = el.parentElement;
	if (!el || el === document.body || el === document.documentElement) {
		return { anchor: { kind: 'doc' }, points: pts.map(([x, y]) => [Math.round(x + scrollX), Math.round(y + scrollY)]) };
	}
	const r = el.getBoundingClientRect();
	const f = (v) => Math.round(v * 10000) / 10000;
	return { anchor: anchors.element(el), points: pts.map(([x, y]) => [f((x - r.left) / r.width), f((y - r.top) / r.height)]) };
}
/** Stroke points (as stored) -> viewport points, given its resolved anchor target. */
function strokePoints(s, t) {
	if (!anchors.alive(t)) return null;
	if (t.doc) return s.points.map(([x, y]) => [x - scrollX, y - scrollY]);
	const r = anchors.rect(t);
	return r ? s.points.map(([x, y]) => [r.left + x * r.width, r.top + y * r.height]) : null;
}

// --- input routing ------------------------------------------------------------------------------------------------
cfg.onInput((e) => {
	// Events on an extension's overlay belong to that extension (pins, badges) and never reach the page.
	const owner = ownerOf(e);
	if (owner && owner !== 'px') {
		if (!MOVES.has(e.type)) for (const fn of inputs.get(owner) || []) fn(e);
		return true;
	}
	if (tool) {
		if (e.type === 'keydown' && e.key === 'Escape') {
			stopTool('esc');
			return true;
		}
		if (e.type === 'keydown' || e.type === 'keyup') return false;
		return tool.kind === 'pick' ? pickInput(e) : drawInput(e);
	}
	if (MOVES.has(e.type)) return false;
	for (const fns of inputs.values()) for (const fn of fns) if (fn(e)) return true;
	return false;
});

// --- messages ---------------------------------------------------------------------------------------------------
addEventListener('message', (e) => {
	if (e.source !== parent || e.origin !== TOOLBAR || !e.data || e.data.type !== 'px:ext') return;
	const { ext, event, data } = e.data;
	if (ext === '*') {
		if (event === 'hello?') post('*', 'hello', { url: page() });
		if (event === 'navigate-to' && data && /^https?:/.test(data.url)) location.assign(cfg.toProxy(data.url));
		return;
	}
	for (const fn of handlers.get(ext + ' ' + event) || []) {
		try {
			fn(data);
		} catch (err) {
			console.error('[px:' + ext + ']', err);
		}
	}
});

function pxExtension(name, init) {
	registered.push({ name, init });
}

function pxStart() {
	for (const { name, init } of registered) {
		const navs = [];
		cfg.onNavigate(() => navs.forEach((fn) => fn(page())));
		const px = {
			send: (event, data) => post(name, event, data),
			on: (event, fn) => {
				const k = name + ' ' + event;
				handlers.set(k, [...(handlers.get(k) || []), fn]);
			},
			page,
			onNavigate: (fn) => navs.push(fn),
			overlay: () => overlayFor(name),
			isOwn: (e) => ownerOf(e) === name,
			css,
			onInput: (fn) => inputs.set(name, [...(inputs.get(name) || []), fn]),
			anchors,
			pick: (opts) => startTool('pick', opts),
			draw: (opts) => startTool('draw', opts),
			stopTool,
			tool: () => (tool ? tool.kind : null),
			/** The toolbar shows this page scaled down by `scale`: keep overlay UI (labels, hints, strokes) its normal size. */
			uiScale(scale) {
				uiZoom = scale > 0 ? 1 / scale : 1;
				for (const { host } of overlays.values()) host.style.setProperty('--px-z', uiZoom);
			},
			strokePoints,
			toProxy: cfg.toProxy,
		};
		try {
			init(px);
		} catch (err) {
			console.error('[px:' + name + ']', err);
		}
	}
	cfg.onNavigate(() => {
		stopTool('navigate');
		post('*', 'navigate', { url: page() });
	});
	post('*', 'hello', { url: page() });
}
