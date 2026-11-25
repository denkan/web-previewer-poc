/*
 * Map, toolbar half (map view only). "▢ Mark" and "✎ Draw" work in both panes; every mark or drawing joins the draft
 * note, from either pane, and the note explains how they relate. Notes are stored per board ("board:{name}"), each
 * mark remembering its pane and page. Lines across the panes connect a note's marks in A to its marks in B.
 * Everything user-written is rendered with textContent.
 */
pxExtension('map', (px) => {
	if (px.view !== 'map') return;
	const board = document.body.dataset.board || 'default';
	const store = px.store('board:' + board);
	const COLORS = ['#ff5c8a', '#2b9bff', '#ffb020', '#22c55e', '#a855f7', '#f97316', '#14b8a6', '#e11d48'];
	const LABEL = { a: 'A', b: 'B' };
	const panel = px.panel({ title: 'Notes' });
	const links = document.getElementById('links');
	const panesEl = document.getElementById('panes');

	let notes = []; // every note on the board
	let draft = null; // { marks: [] } while composing
	let composer = null; // { form, chips }: kept across renders so typing survives
	let tool = null; // 'mark' | 'draw' | null
	let selected = null;
	let hovered = null;
	let pendingFocus = null; // a note on other pages: focus it once both panes show its pages
	const status = { a: {}, b: {} }; // mark id -> 'ok' | 'approx' | 'missing', per pane
	const rects = { a: {}, b: {} }; // note id | 'draft' -> [[x, y, w, h]] in that pane's page px
	let filter = px.prefs.get('filter', 'open'); // open | resolved | all
	let scope = px.prefs.get('scope', 'screen'); // screen | board

	const markBtn = px.button({ label: '▢ Mark', title: 'Click an element or select text, in A or B (Esc stops)', onClick: () => setTool(tool === 'mark' ? null : 'mark') });
	const drawBtn = px.button({ label: '✎ Draw', title: 'Draw freehand in A or B; strokes join one drawing until you stop (Esc)', onClick: () => setTool(tool === 'draw' ? null : 'draw') });
	const notesBtn = px.button({ label: 'Notes', title: 'Show the notes drawer', onClick: () => panel.toggle() });
	panel.onToggle((open) => notesBtn.classList.toggle('on', open));

	px.css(`
		.mp { display: flex; flex-direction: column; min-height: 100%; font-size: 13px }
		.mp-head { position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 12px; background: var(--panel); border-bottom: 1px solid var(--line) }
		.mp-head h2 { flex: 1 0 100%; margin: 0 0 4px; font-size: 14px } .mp-head h2 small { color: var(--muted); font-weight: 400 }
		.mp-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden }
		.mp-seg button { border: 0; border-radius: 0; padding: 4px 8px; font-size: 12px; background: transparent; color: var(--muted) }
		.mp-seg button.on { background: #2a3350; color: var(--text) }
		.mp-draft { display: block; margin: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: #161a22 }
		.mp-draft h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 13px }
		.mp-draft textarea { display: block; box-sizing: border-box; width: 100%; min-height: 80px; resize: vertical; margin: 8px 0; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit }
		.mp-draft textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px }
		.mp-hint { color: var(--muted); font-size: 12px; line-height: 1.4 }
		.mp-row { display: flex; gap: 6px; align-items: center }
		.mp-row input { flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px; font-family: inherit }
		.mp-chips { display: flex; flex-wrap: wrap; gap: 4px }
		.mp-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 2px 4px 2px 2px; border: 1px solid var(--line); border-radius: 12px; font-size: 12px; background: var(--bg) }
		.mp-chip.away { opacity: .55 } .mp-chip.missing { border-color: var(--warn) }
		.mp-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 230px }
		.mp-chip code { color: #b9a8ff }
		.mp-chip button { border: 0; padding: 0 4px; background: transparent; color: var(--muted); font-size: 13px; line-height: 1 }
		.mp-pane { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 9px; font: 800 10px/1 system-ui; color: #0b0d12; background: var(--accent) }
		.mp-pane.b { background: #ffb020 }
		.mp-dot { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; color: #fff; font-weight: 700; font-size: 11px }
		.mp-list { list-style: none; margin: 0; padding: 4px 0 }
		.mp-item { padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: pointer }
		.mp-item:hover { background: #1c2029 } .mp-item.selected { background: #222838 }
		.mp-item.resolved .mp-body { color: var(--muted); text-decoration: line-through }
		.mp-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; color: var(--muted); font-size: 12px } .mp-meta b { color: var(--text) }
		.mp-warn { color: var(--warn) }
		.mp-body { margin: 6px 0; white-space: pre-wrap; word-break: break-word }
		.mp-actions { display: flex; gap: 6px } .mp-actions button { padding: 2px 8px; font-size: 11px }
		.mp-empty { margin: 24px 16px; color: var(--muted); line-height: 1.5; text-align: center }
	`);

	function h(tag, props, ...kids) {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v == null || v === false) continue;
			if (k.startsWith('on')) el[k] = v;
			else if (k === 'class') el.className = v;
			else el.setAttribute(k, v === true ? '' : v);
		}
		for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
		return el;
	}
	const ago = (t) => {
		const s = Math.round((Date.now() - t) / 1000);
		return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString();
	};

	/** Numbers and colors follow creation order on the board, so they never change when notes are filtered. */
	function meta() {
		const m = {};
		[...notes].sort((a, b) => a.created - b.created).forEach((x, i) => (m[x.id] = { n: i + 1, color: COLORS[i % COLORS.length] }));
		return m;
	}
	const draftColor = () => COLORS[notes.length % COLORS.length];
	const shownHere = (m) => px.page(m.pane) === m.page;
	const onScreen = (note) => note.data.marks.some(shownHere);
	const passes = (note) => filter === 'all' || (filter === 'resolved') === !!note.data.resolved;

	// --- page halves ------------------------------------------------------------------------------------------
	function setTool(t) {
		tool = t;
		markBtn.classList.toggle('on', t === 'mark');
		drawBtn.classList.toggle('on', t === 'draw');
		px.send('tool', { kind: t, color: draftColor() });
	}
	function syncNotes() {
		const M = meta();
		for (const pane of px.panes) {
			const list = notes.filter(passes).map((x) => ({ id: x.id, n: M[x.id].n, color: M[x.id].color, marks: x.data.marks.filter((m) => m.pane === pane && shownHere(m)) }));
			px.send('notes', list.filter((x) => x.marks.length), pane);
		}
	}
	function syncDraft() {
		for (const pane of px.panes) px.send('draft', { color: draftColor(), marks: draft ? draft.marks.filter((m) => m.pane === pane && shownHere(m)) : [] }, pane);
	}

	// --- actions -------------------------------------------------------------------------------------------------
	async function save(body, author) {
		px.prefs.set('author', author);
		const pair = (px.page('a') || '') + ' ⇄ ' + (px.page('b') || '');
		let item;
		try {
			item = await store.create(pair, { body, author: author || 'Anonymous', marks: draft.marks, resolved: false });
		} catch (err) {
			alert('Could not save the note (' + err.message + ')');
			return;
		}
		notes.push(item);
		draft = composer = null;
		selected = item.id;
		if (tool) setTool(tool); // the next note gets the next color
		render();
		syncDraft();
		syncNotes();
		px.send('active', item.id);
	}
	function cancelDraft() {
		draft = composer = null;
		render();
		syncDraft();
		drawLinks();
	}
	async function update(note, data) {
		const next = await store.update(note.id, data);
		notes = notes.map((x) => (x.id === next.id ? next : x));
		render();
		syncNotes();
	}
	async function remove(note) {
		if (!confirm('Delete this note?')) return;
		await store.remove(note.id);
		notes = notes.filter((x) => x.id !== note.id);
		if (selected === note.id) selected = null;
		render();
		syncNotes();
	}
	/** Select a note; if its marks are on other pages, open those first. */
	function open(note) {
		selected = note.id;
		render();
		const need = {};
		for (const m of note.data.marks) if (!need[m.pane]) need[m.pane] = m.page;
		let away = false;
		for (const [pane, url] of Object.entries(need)) {
			if (px.page(pane) !== url) {
				away = true;
				px.navigate(url, pane);
			}
		}
		if (away) pendingFocus = { id: note.id, need };
		else focus(note.id);
	}
	function focus(id) {
		px.send('focus', id);
		px.send('active', id);
		drawLinks();
	}

	// --- drawer ----------------------------------------------------------------------------------------------------
	const head = h('div', { class: 'mp-head' });
	const draftSlot = h('div');
	const listEl = h('ol', { class: 'mp-list' });
	const emptyEl = h('p', { class: 'mp-empty' });
	panel.el.append(h('div', { class: 'mp' }, head, draftSlot, listEl, emptyEl));

	function chip(m, { removable, st } = {}) {
		const what =
			m.kind === 'drawing'
				? '✎ drawing' + (m.strokes && m.strokes.length > 1 ? ' · ' + m.strokes.length + ' strokes' : '')
				: m.kind === 'text'
					? '“' + m.label + '”'
					: [h('code', null, '<' + (m.tag || (m.anchor && m.anchor.tag) || '?') + '>'), m.label ? ' ' + m.label : ''];
		const away = !shownHere(m);
		return h(
			'span',
			{ class: 'mp-chip' + (away ? ' away' : '') + (st === 'missing' ? ' missing' : ''), title: away ? 'On ' + m.page : st === 'missing' ? 'Not found on this page' : null, 'data-mark': m.id },
			h('b', { class: 'mp-pane ' + m.pane }, LABEL[m.pane] || m.pane),
			h('span', null, what),
			st === 'missing' && h('span', { class: 'mp-warn' }, '⚠'),
			removable &&
				h('button', {
					type: 'button',
					title: 'Remove this mark',
					onclick: () => {
						draft.marks = draft.marks.filter((x) => x.id !== m.id);
						render();
						syncDraft();
					},
				}, '×'),
		);
	}

	function render() {
		const M = meta();
		const list = notes.filter((x) => passes(x) && (scope === 'board' || onScreen(x))).sort((a, b) => a.created - b.created);
		const openCount = notes.filter((x) => onScreen(x) && !x.data.resolved).length;
		notesBtn.textContent = 'Notes' + (openCount ? ' · ' + openCount : '');
		const seg = (value, options, set) => h('div', { class: 'mp-seg' }, options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', onclick: () => set(v) }, label)));
		head.replaceChildren(
			h('h2', null, 'Notes ', h('small', null, 'board ' + board)),
			seg(filter, [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']], (v) => {
				px.prefs.set('filter', (filter = v));
				render();
				syncNotes();
				drawLinks();
			}),
			seg(scope, [['screen', 'On screen'], ['board', 'Whole board']], (v) => {
				px.prefs.set('scope', (scope = v));
				render();
			}),
		);

		if (draft && !composer) {
			const text = h('textarea', { placeholder: 'How do these relate? Instructions for the migration…' });
			const name = h('input', { placeholder: 'Your name', value: px.prefs.get('author', '') });
			const submit = () => {
				if (!draft.marks.length) return alert('Mark or draw something in A or B first.');
				if (text.value.trim()) save(text.value.trim(), name.value.trim());
			};
			text.onkeydown = (e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
				if (e.key === 'Escape') cancelDraft();
			};
			const chips = h('div', { class: 'mp-chips' });
			composer = {
				chips,
				form: h(
					'form',
					{ class: 'mp-draft', onsubmit: (e) => (e.preventDefault(), submit()) },
					h('h3', null, h('span', { class: 'mp-dot', style: 'background:' + draftColor() }, '+'), 'New note'),
					chips,
					text,
					h('div', { class: 'mp-row' }, name, h('button', { type: 'button', onclick: cancelDraft }, 'Cancel'), h('button', { class: 'primary' }, 'Save')),
				),
			};
			setTimeout(() => text.focus());
		}
		if (composer) {
			composer.chips.replaceChildren(
				...(draft.marks.length ? draft.marks.map((m) => chip(m, { removable: true })) : [h('span', { class: 'mp-hint' }, 'Use ▢ Mark or ✎ Draw in A and B. Everything you mark joins this note.')]),
			);
		}
		if ((draftSlot.firstChild || null) !== (composer ? composer.form : null)) draftSlot.replaceChildren(...(composer ? [composer.form] : []));

		listEl.replaceChildren(
			...list.map((x) => {
				const missing = x.data.marks.filter((m) => shownHere(m) && (status[m.pane] || {})[m.id] === 'missing').length;
				return h(
					'li',
					{
						class: 'mp-item' + (x.id === selected ? ' selected' : '') + (x.data.resolved ? ' resolved' : ''),
						'data-id': x.id,
						onclick: () => open(x),
						onmouseenter: () => {
							hovered = x.id;
							px.send('active', x.id);
							drawLinks();
						},
						onmouseleave: () => {
							hovered = null;
							px.send('active', selected);
							drawLinks();
						},
					},
					h('div', { class: 'mp-meta' }, h('span', { class: 'mp-dot', style: 'background:' + M[x.id].color }, M[x.id].n), h('b', null, x.data.author || 'Anonymous'), h('span', null, ago(x.created)), missing > 0 && h('span', { class: 'mp-warn' }, '⚠ ' + missing + ' not found')),
					h('div', { class: 'mp-chips' }, x.data.marks.map((m) => chip(m, { st: shownHere(m) ? (status[m.pane] || {})[m.id] : null }))),
					h('div', { class: 'mp-body' }, x.data.body),
					h(
						'div',
						{ class: 'mp-actions' },
						h('button', { onclick: (e) => (e.stopPropagation(), update(x, { resolved: !x.data.resolved })) }, x.data.resolved ? 'Reopen' : 'Resolve'),
						h('button', { onclick: (e) => (e.stopPropagation(), remove(x)) }, 'Delete'),
					),
				);
			}),
		);
		emptyEl.hidden = !!(list.length || draft);
		emptyEl.textContent = notes.length
			? 'No notes for the pages on screen with this filter. “Whole board” lists them all.'
			: 'No notes yet. Open a page in A and one in B, then use ▢ Mark (click or select) and ✎ Draw on both, and write how they relate.';
		drawLinks();
	}

	// --- lines between panes ----------------------------------------------------------------------------------------
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	function drawLinks() {
		const host = panesEl.getBoundingClientRect();
		const geo = {};
		for (const pane of px.panes) {
			const f = px.frame(pane);
			const fr = f.getBoundingClientRect();
			const vp = f.parentElement.getBoundingClientRect();
			geo[pane] = {
				x: fr.left - host.left,
				y: fr.top - host.top,
				s: f.offsetWidth ? fr.width / f.offsetWidth : 1, // the page is scaled to fit its pane
				clip: { l: vp.left - host.left, t: vp.top - host.top, r: vp.right - host.left, b: vp.bottom - host.top },
			};
		}
		/** A mark's edge in toolbar px, pinned to its pane's visible area (off-screen marks get a dashed line). */
		const end = (g, [x, y, w, hgt], side) => {
			const px_ = g.x + (side === 'right' ? x + w : x) * g.s;
			const py = g.y + (y + hgt / 2) * g.s;
			const off = py < g.clip.t || py > g.clip.b || px_ < g.clip.l || px_ > g.clip.r;
			return { x: clamp(px_, g.clip.l, g.clip.r), y: clamp(py, g.clip.t + 4, g.clip.b - 4), off };
		};
		const out = [];
		const line = (id, c, on) => {
			for (const ra of (rects.a[id] || []).slice(0, 4)) {
				for (const rb of (rects.b[id] || []).slice(0, 4)) {
					const p = end(geo.a, ra, 'right');
					const q = end(geo.b, rb, 'left');
					const dx = Math.max(40, Math.abs(q.x - p.x) * 0.45);
					const dash = p.off || q.off ? ' stroke-dasharray="6 5"' : '';
					out.push(
						`<path data-note="${id}" d="M${p.x.toFixed(1)} ${p.y.toFixed(1)} C${(p.x + dx).toFixed(1)} ${p.y.toFixed(1)} ${(q.x - dx).toFixed(1)} ${q.y.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}" fill="none" stroke="${c}" stroke-width="${on ? 2.5 : 1.5}" opacity="${on ? 1 : 0.4}"${dash}/>` +
							`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${on ? 4 : 3}" fill="${c}" opacity="${on ? 1 : 0.5}"/><circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${on ? 4 : 3}" fill="${c}" opacity="${on ? 1 : 0.5}"/>`,
					);
				}
			}
		};
		const M = meta();
		for (const x of notes.filter(passes)) line(x.id, M[x.id].color, x.id === selected || x.id === hovered);
		if (draft) line('draft', draftColor(), true);
		links.innerHTML = out.join('');
	}
	/** Tell each page how much it's scaled down, so its badges and strokes stay a readable size. */
	function sendScale(only) {
		for (const pane of only ? [only] : px.panes) {
			const f = px.frame(pane);
			if (f.offsetWidth) px.send('scale', f.getBoundingClientRect().width / f.offsetWidth, pane);
		}
	}
	addEventListener('resize', drawLinks);
	addEventListener('px:geometry', () => {
		sendScale();
		drawLinks();
	});

	// --- messages from the panes ------------------------------------------------------------------------------------
	px.on('mark', (mark, pane) => {
		if (!mark || !mark.id || !px.page(pane)) return;
		if (!draft) draft = { marks: [] };
		draft.marks.push({ ...mark, pane, page: px.page(pane) });
		panel.open();
		render();
		syncDraft();
	});
	px.on('mark-update', (u, pane) => {
		const m = draft && u && draft.marks.find((x) => x.id === u.id && x.pane === pane);
		if (!m) return;
		m.strokes = u.strokes;
		render();
		syncDraft();
	});
	px.on('tool-end', () => tool && setTool(null)); // Esc in one pane stops the tool in both
	px.on('status', (s, pane) => {
		status[pane] = s || {};
		render();
	});
	px.on('rects', (r, pane) => {
		rects[pane] = r || {};
		drawLinks();
	});
	px.on('select', (id) => {
		const note = notes.find((x) => x.id === id);
		if (note && !passes(note)) {
			filter = 'all';
			syncNotes();
		}
		selected = id;
		panel.open();
		render();
		px.send('active', id);
		const row = listEl.querySelector(`[data-id="${id}"]`);
		if (row) row.scrollIntoView({ block: 'nearest' });
	});
	px.onPage((url, pane) => {
		rects[pane] = {};
		status[pane] = {};
		syncNotes();
		syncDraft();
		if (tool) px.send('tool', { kind: tool, color: draftColor() }, pane);
		sendScale(pane);
		render();
		if (pendingFocus && Object.entries(pendingFocus.need).every(([p, u]) => px.page(p) === u)) {
			const id = pendingFocus.id;
			pendingFocus = null;
			setTimeout(() => focus(id), 400); // give late-rendering pages a moment
		}
	});
	addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && tool) setTool(null);
	});

	store
		.list()
		.then((items) => {
			notes = items;
			render();
			syncNotes();
		})
		.catch(() => render());
});
