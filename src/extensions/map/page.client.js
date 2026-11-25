/*
 * Map, page half (runs in each pane of the map view). Makes marks with the host's tools (px.pick for elements and
 * text, px.draw for freehand strokes) and renders every note's marks on this page in the note's color: element
 * outlines, text highlights, strokes, and a numbered badge per mark. It reports where each note's marks are on screen,
 * so the toolbar can draw lines between related marks in the two panes.
 *
 * Mark: { id, kind: 'element' | 'text', anchor, label } or { id, kind: 'drawing', strokes: [{ anchor, points }], label }
 */
pxExtension('map', (px) => {
	const A = px.anchors;
	const hasHighlights = !!(window.CSS && CSS.highlights && window.Highlight);
	const rid = () => Math.random().toString(36).slice(2, 10);
	const color = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ff5c8a');
	const esc = (s) => String(s).replace(/[^\w-]/g, '');

	let notes = []; // [{ id, n, color, marks }] on this page, from the toolbar
	let draft = { color: '#ff5c8a', marks: [] };
	let active = null; // note id selected / hovered in the drawer
	let scale = 1; // how much the toolbar scales this page down
	let flashId = null;
	const targets = new Map(); // mark id -> target, or [target per stroke] for drawings
	let drawing = null; // the draft drawing mark that new strokes join, while the draw tool stays on
	let lastStatus = '';
	let lastRects = '';
	let lastSvg = '';
	let lastBadges = '';

	const hlCss = px.css('');
	let svg = null;
	let badges = null;
	function ui() {
		if (svg) return;
		const root = px.overlay();
		root.innerHTML = `<style>
			svg { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible }
			.box { stroke-width: calc(2px * var(--px-z)); rx: 3 } .box.on { stroke-width: calc(3px * var(--px-z)) }
			.box.draft { stroke-dasharray: calc(6px * var(--px-z)) calc(4px * var(--px-z)) }
			.stroke { fill: none; stroke-width: calc(3px * var(--px-z)); stroke-linecap: round; stroke-linejoin: round; opacity: .9 } .stroke.on { stroke-width: calc(4px * var(--px-z)); opacity: 1 }
			.badge { position: fixed; min-width: 20px; height: 20px; padding: 0 5px; transform: translate(-50%, -50%) scale(var(--px-z)); border-radius: 10px; display: grid; place-items: center;
				border: 2px solid #fff; color: #fff; font: 700 11px/1 system-ui, sans-serif; pointer-events: auto; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.35) }
			.badge.flash { animation: flash 1.4s ease-out }
			@keyframes flash { 0%, 50% { box-shadow: 0 0 0 8px rgba(255,255,255,.7) } 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0) } }
		</style><svg></svg><div class="badges"></div>`;
		svg = root.querySelector('svg');
		badges = root.querySelector('.badges');
	}

	// --- resolving ---------------------------------------------------------------------------------------------
	const markAlive = (m) => {
		const t = targets.get(m.id);
		return m.kind === 'drawing' ? Array.isArray(t) && t.every(A.alive) : A.alive(t);
	};
	function resolveMarks(marks, force) {
		const todo = marks.filter((m) => force || !markAlive(m));
		const flat = [];
		for (const m of todo) {
			if (m.kind === 'drawing') for (const s of m.strokes) flat.push(s.anchor);
			else flat.push(m.anchor);
		}
		const res = A.resolveAll(flat);
		let i = 0;
		for (const m of todo) {
			if (m.kind === 'drawing') targets.set(m.id, m.strokes.map(() => res[i++]));
			else targets.set(m.id, res[i++]);
		}
	}
	function statusOf(m) {
		const t = targets.get(m.id);
		if (m.kind !== 'drawing') return t ? t.status : 'missing';
		const ok = (t || []).filter(A.alive).length;
		return ok === m.strokes.length ? 'ok' : ok ? 'approx' : 'missing';
	}
	function resolveAll(force) {
		resolveMarks([...notes.flatMap((n) => n.marks), ...draft.marks], force);
		const status = {};
		for (const n of notes) for (const m of n.marks) status[m.id] = statusOf(m);
		const s = JSON.stringify(status);
		if (s !== lastStatus) {
			lastStatus = s;
			px.send('status', status);
		}
	}

	// --- drawing ------------------------------------------------------------------------------------------------
	/** Where a mark is on screen: { box, path? } in viewport px, or null. */
	function geometry(m) {
		const t = targets.get(m.id);
		if (m.kind === 'drawing') {
			const paths = [];
			let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity;
			m.strokes.forEach((s, i) => {
				const pts = px.strokePoints(s, t && t[i]);
				if (!pts) return;
				paths.push('M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L'));
				for (const [x, y] of pts) {
					l = Math.min(l, x);
					tp = Math.min(tp, y);
					r = Math.max(r, x);
					b = Math.max(b, y);
				}
			});
			return paths.length ? { box: { left: l, top: tp, width: r - l, height: b - tp }, paths } : null;
		}
		const box = A.rect(t);
		return box ? { box, range: t.range || null } : null;
	}

	let frameReq = 0;
	function schedule() {
		if (!frameReq) frameReq = requestAnimationFrame(draw);
	}
	function draw() {
		frameReq = 0;
		if (!notes.length && !draft.marks.length && !svg) return;
		ui();
		const shapes = [];
		const pins = [];
		const ranges = new Map(); // highlight name -> ranges
		const rects = {};
		const colors = new Set();
		const render = (id, n, c, marks, isDraft) => {
			c = color(c);
			colors.add(c);
			const on = isDraft || id === active;
			for (const m of marks) {
				const g = geometry(m);
				if (!g) continue;
				(rects[id] = rects[id] || []).push([g.box.left, g.box.top, g.box.width, g.box.height].map(Math.round));
				if (g.paths) for (const d of g.paths) shapes.push(`<path class="stroke${on ? ' on' : ''}" stroke="${c}" d="${d}"/>`);
				else if (g.range) {
					const name = 'px-map-' + c.slice(1) + (on ? '-on' : '');
					ranges.set(name, [...(ranges.get(name) || []), g.range]);
				} else {
					const b = g.box;
					shapes.push(`<rect class="box${on ? ' on' : ''}${isDraft ? ' draft' : ''}" x="${b.left - 3}" y="${b.top - 3}" width="${b.width + 6}" height="${b.height + 6}" stroke="${c}" fill="${c}${on ? '26' : '12'}"/>`);
				}
				const z = 1 / (scale || 1); // badges are 24px on screen at any scale: keep them fully inside the page
				const x = Math.max(12 * z, g.box.left);
				const y = Math.max(12 * z, g.box.top);
				if (x < innerWidth && y < innerHeight && g.box.top + g.box.height > 0) {
					pins.push(`<div class="badge${id === flashId ? ' flash' : ''}" data-id="${isDraft ? '' : esc(id)}" style="left:${x}px;top:${y}px;background:${c}">${isDraft ? '+' : Number(n) || ''}</div>`);
				}
			}
		};
		for (const n of notes) render(n.id, n.n, n.color, n.marks, false);
		if (draft.marks.length) render('draft', '+', draft.color, draft.marks, true);

		const svgHtml = shapes.join('');
		if (svgHtml !== lastSvg) svg.innerHTML = lastSvg = svgHtml;
		const badgeHtml = pins.join('');
		if (badgeHtml !== lastBadges) badges.innerHTML = lastBadges = badgeHtml;
		if (hasHighlights) {
			for (const k of [...CSS.highlights.keys()]) if (k.startsWith('px-map-')) CSS.highlights.delete(k);
			for (const [name, rs] of ranges) CSS.highlights.set(name, new Highlight(...rs));
			hlCss.replace([...colors].map((c) => `::highlight(px-map-${c.slice(1)}) { background-color: ${c}38 } ::highlight(px-map-${c.slice(1)}-on) { background-color: ${c}70 }`).join('\n'));
		}
		const r = JSON.stringify(rects);
		if (r !== lastRects) {
			lastRects = r;
			px.send('rects', rects);
		}
	}

	addEventListener('scroll', schedule, { capture: true, passive: true });
	addEventListener('resize', schedule);
	let mutTimer = 0;
	new MutationObserver(() => {
		if (!notes.length && !draft.marks.length) return;
		schedule();
		if (!mutTimer)
			mutTimer = setTimeout(() => {
				mutTimer = 0;
				resolveAll(false);
				schedule();
			}, 300);
	}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	setInterval(() => (notes.length || draft.marks.length) && schedule(), 1000);

	// --- tools ----------------------------------------------------------------------------------------------------
	function labelOf(anchor) {
		return anchor.kind === 'text' ? anchor.quote.exact.slice(0, 120) : anchor.text;
	}
	function setTool(kind, c) {
		drawing = null;
		if (kind === 'mark') {
			px.pick({
				sticky: true,
				hint: 'Mark: click an element or select text · Esc to stop',
				onPick: (t) => {
					const mark = { id: rid(), kind: t.anchor.kind, anchor: t.anchor, tag: t.anchor.tag, label: labelOf(t.anchor) };
					targets.set(mark.id, t);
					px.send('mark', mark);
				},
				onEnd: (why) => why !== 'switch' && px.send('tool-end'),
			});
		} else if (kind === 'draw') {
			px.draw({
				color: color(c),
				hint: 'Draw · strokes join one drawing until you stop · Esc to stop',
				onStroke: (s) => {
					if (drawing) {
						drawing.strokes.push(s);
						targets.delete(drawing.id);
						px.send('mark-update', { id: drawing.id, strokes: drawing.strokes });
					} else {
						drawing = { id: rid(), kind: 'drawing', strokes: [s], label: 'drawing' };
						px.send('mark', drawing);
					}
				},
				onEnd: (why) => {
					drawing = null;
					if (why !== 'switch') px.send('tool-end');
				},
			});
		} else if (px.tool()) px.stopTool();
	}

	// Badges: a click selects that note in the drawer.
	px.onInput((e) => {
		if (!px.isOwn(e) || e.type !== 'click') return false;
		const b = e.composedPath().find((n) => n.classList && n.classList.contains('badge'));
		if (b && b.dataset.id) {
			active = b.dataset.id;
			px.send('select', active);
			schedule();
		}
		return true;
	});

	// --- toolbar messages --------------------------------------------------------------------------------------------
	px.on('tool', (t) => setTool(t && t.kind, t && t.color));
	px.on('draft', (d) => {
		draft = { color: color(d && d.color), marks: Array.isArray(d && d.marks) ? d.marks : [] };
		if (drawing && !draft.marks.some((m) => m.id === drawing.id)) drawing = null; // saved, cancelled or removed
		resolveAll(false);
		schedule();
	});
	px.on('notes', (list) => {
		notes = Array.isArray(list) ? list : [];
		resolveAll(false);
		schedule();
	});
	px.on('active', (id) => {
		active = id || null;
		schedule();
	});
	px.on('scale', (s) => {
		scale = Number(s) || 1;
		px.uiScale(scale);
		schedule();
	});
	px.on('focus', (id) => {
		active = id;
		// Scroll the first mark that's on the page into view (its element, so marks in scrolling containers work too).
		const n = notes.find((x) => x.id === id);
		for (const m of n ? n.marks : []) {
			const t = targets.get(m.id);
			const ts = (Array.isArray(t) ? t : [t]).filter(A.alive);
			if (!ts.length) continue;
			const el = ts[0].el || (ts[0].range && ts[0].range.startContainer.parentElement);
			if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
			else {
				const g = geometry(m); // a stroke anchored to the document
				if (g) scrollBy({ top: g.box.top + g.box.height / 2 - innerHeight / 2, behavior: 'smooth' });
			}
			break;
		}
		flashId = id;
		setTimeout(() => {
			flashId = null;
			schedule();
		}, 1500);
		schedule();
	});
	px.onNavigate(() => {
		notes = [];
		draft = { color: draft.color, marks: [] };
		targets.clear();
		active = null;
		drawing = null;
		lastStatus = lastRects = '';
		schedule();
	});
});
