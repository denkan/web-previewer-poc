/*
 * Comments, page half: pick a target with px.pick (click an element, or select text), and draw numbered pins +
 * highlights for the comments the toolbar sends. Anchoring (finding targets again after reloads, re-renders and
 * redesigns) is px.anchors in the host. All UI text lives in the toolbar.
 * Highlights use the CSS Custom Highlight API and pins live in the overlay's shadow root: the page DOM is never edited.
 */
pxExtension('comments', (px) => {
	const PIN = '#7c5cff';
	const ACTIVE = '#ff8a00';
	const hasHighlights = !!(window.CSS && CSS.highlights && window.Highlight);
	const A = px.anchors;

	let comments = []; // [{ id, n, anchor }] to show on this page, from the toolbar
	const targets = new Map(); // id -> resolved target
	let draft = null; // { anchor, el | range } while the toolbar composes
	let active = null; // id hovered / selected in the drawer
	let lastStatus = '';
	let flashId = null;
	let lastHtml = '';

	px.css(`::highlight(px-comment) { background-color: rgba(124, 92, 255, .22) }
		::highlight(px-comment-active) { background-color: rgba(255, 138, 0, .45) }`);

	let layer = null;
	function ui() {
		if (layer) return;
		const root = px.overlay();
		root.innerHTML = `<style>
			* { box-sizing: border-box }
			.layer { position: fixed; inset: 0; pointer-events: none; font: 600 12px/1 system-ui, -apple-system, sans-serif }
			.pin { position: fixed; width: 26px; height: 26px; margin: -26px 0 0 0; display: grid; place-items: center;
				border-radius: 13px 13px 13px 3px; border: 2px solid #fff; background: ${PIN}; color: #fff; pointer-events: auto;
				cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.35); transition: transform .12s, background .12s; transform-origin: 0 100% }
			.pin:hover, .pin.active, .pin.draft { background: ${ACTIVE}; transform: scale(1.15) }
			.pin.flash { animation: flash 1.4s ease-out }
			@keyframes flash { 0%, 50% { box-shadow: 0 0 0 8px rgba(255,138,0,.55) } 100% { box-shadow: 0 0 0 0 rgba(255,138,0,0) } }
			.box { position: fixed; border: 2px solid ${ACTIVE}; border-radius: 3px; background: rgba(255,138,0,.08) }
		</style><div class="layer"></div>`;
		layer = root.querySelector('.layer');
	}

	function resolveAll(force) {
		const todo = comments.filter((c) => force || !A.alive(targets.get(c.id)));
		A.resolveAll(todo.map((c) => c.anchor)).forEach((t, i) => targets.set(todo[i].id, t));
		if (draft && !A.alive(draft)) Object.assign(draft, A.resolve(draft.anchor));
		const status = Object.fromEntries(comments.map((c) => [c.id, targets.get(c.id).status]));
		const s = JSON.stringify(status);
		if (s !== lastStatus) {
			lastStatus = s;
			px.send('status', status);
		}
	}

	let frameReq = 0;
	function schedule() {
		if (!frameReq) frameReq = requestAnimationFrame(draw);
	}
	function draw() {
		frameReq = 0;
		if (!comments.length && !draft && !layer) return;
		ui();
		const out = [];
		const ranges = [];
		const activeRanges = [];
		const pin = (p, label, cls, id) => {
			if (!p || p.x < -30 || p.y < 0 || p.x > innerWidth || p.y > innerHeight + 26) return;
			out.push(`<div class="pin ${cls}" data-id="${id}" style="left:${p.x}px;top:${p.y}px">${label}</div>`);
		};
		for (const c of comments) {
			const t = targets.get(c.id);
			if (t && t.range && A.alive(t)) (c.id === active ? activeRanges : ranges).push(t.range);
			const cls = (c.id === active ? 'active' : '') + (c.id === flashId ? ' flash' : '');
			pin(A.point(t, c.anchor), Number(c.n) || '', cls, String(c.id).replace(/[^\w-]/g, ''));
		}
		if (draft) {
			if (draft.range && A.alive(draft)) activeRanges.push(draft.range);
			pin(A.point(draft, draft.anchor), '+', 'draft', '');
		}
		const focus = (active && targets.get(active)) || (draft && !draft.range ? draft : null);
		const b = focus && !focus.range ? A.rect(focus) : null;
		if (b) out.push(`<div class="box" style="left:${b.left - 3}px;top:${b.top - 3}px;width:${b.width + 6}px;height:${b.height + 6}px"></div>`);
		const html = out.join('');
		if (html !== lastHtml) layer.innerHTML = lastHtml = html; // unchanged frames keep their DOM (hover, animations)
		if (hasHighlights) {
			CSS.highlights.set('px-comment', new Highlight(...ranges));
			CSS.highlights.set('px-comment-active', new Highlight(...activeRanges));
		}
	}

	// Keep pins glued to their targets: scrolling, resizing, re-rendering, late content.
	addEventListener('scroll', schedule, { capture: true, passive: true });
	addEventListener('resize', schedule);
	let mutTimer = 0;
	new MutationObserver(() => {
		if (!comments.length && !draft) return;
		schedule();
		if (!mutTimer)
			mutTimer = setTimeout(() => {
				mutTimer = 0;
				resolveAll(false);
				schedule();
			}, 300);
	}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	setInterval(() => (comments.length || draft) && schedule(), 1000); // CSS animations, sticky headers, lazy layout

	function setPicking(on, tellToolbar) {
		if (on) {
			px.pick({
				hint: 'Click an element or select text to comment · Esc to cancel',
				onPick: (target) => {
					draft = target;
					px.send('picked', target.anchor);
					schedule();
				},
				onEnd: (why) => why !== 'switch' && px.send('mode', false),
			});
		} else if (px.tool()) px.stopTool();
		if (tellToolbar) px.send('mode', on);
	}

	// Our own pins: a click selects that comment in the drawer.
	px.onInput((e) => {
		if (!px.isOwn(e) || e.type !== 'click') return false;
		const pin = e.composedPath().find((n) => n.classList && n.classList.contains('pin'));
		if (pin && pin.dataset.id) {
			active = pin.dataset.id;
			px.send('select', active);
			schedule();
		}
		return true;
	});

	// --- toolbar messages --------------------------------------------------------------------------------------------
	px.on('comments', (list) => {
		comments = Array.isArray(list) ? list : [];
		for (const id of [...targets.keys()]) if (!comments.some((c) => c.id === id)) targets.delete(id);
		resolveAll(false);
		schedule();
	});
	px.on('mode', (on) => setPicking(!!on, false));
	px.on('draft-clear', () => {
		draft = null;
		schedule();
	});
	px.on('active', (id) => {
		active = id || null;
		schedule();
	});
	px.on('focus', (id) => {
		active = id;
		const t = targets.get(id);
		const el = t && A.alive(t) ? (t.range ? t.range.startContainer.parentElement : t.el) : null;
		if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
		flashId = id;
		setTimeout(() => {
			flashId = null;
			schedule();
		}, 1500);
		schedule();
	});
	px.onNavigate(() => {
		comments = [];
		targets.clear();
		draft = null;
		active = null;
		lastStatus = '';
		schedule();
	});
});
