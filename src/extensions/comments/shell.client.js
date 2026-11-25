/*
 * Comments, toolbar half: the "Comment" button (puts the page in pick mode), and a drawer panel with the composer and
 * the list. Comments are stored per original site via px.store; the page half only ever gets {id, n, anchor}.
 * Everything user-written is rendered with textContent: the toolbar origin holds the session API.
 */
pxExtension('comments', (px) => {
	if (px.view !== 'single') return;
	const panel = px.panel({ title: 'Comments' });
	/** Comments live in the store of the page's original site, keyed by page URL. */
	const store = () => px.store(new URL(px.page()).origin);
	let items = []; // store items in the current scope
	let status = {}; // id -> 'ok' | 'approx' | 'missing', reported by the page
	let filter = px.prefs.get('filter', 'open'); // open | resolved | all
	let scope = px.prefs.get('scope', 'page'); // page | site
	let draft = null; // anchor picked on the page, waiting for text
	let composer = null; // its form, kept across re-renders so typing survives status updates
	let selected = null;
	let picking = false;
	let pendingFocus = null; // comment on another page: focus it once that page has loaded

	const pickBtn = px.button({
		label: '✚ Comment',
		title: 'Click an element or select text on the page to comment on it (Esc cancels)',
		onClick: () => setPicking(!picking),
	});
	const drawerBtn = px.button({ label: 'Comments', title: 'Show the comments drawer', onClick: () => panel.toggle() });
	panel.onToggle((open) => drawerBtn.classList.toggle('on', open));
	pickBtn.disabled = true;

	px.css(`
		.cm { display: flex; flex-direction: column; min-height: 100%; font-size: 13px }
		.cm-head { position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 12px; background: var(--panel); border-bottom: 1px solid var(--line) }
		.cm-head h2 { flex: 1 0 100%; margin: 0 0 4px; font-size: 14px }
		.cm-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden }
		.cm-seg button { border: 0; border-radius: 0; padding: 4px 8px; font-size: 12px; background: transparent; color: var(--muted) }
		.cm-seg button.on { background: #2a3350; color: var(--text) }
		.cm-draft { display: block; margin: 12px; padding: 10px; border: 1px solid #ff8a00; border-radius: 8px; background: #1d1a16 }
		.cm-draft textarea { display: block; box-sizing: border-box; width: 100%; min-height: 72px; resize: vertical; margin: 8px 0; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit }
		.cm-draft textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px }
		.cm-row { display: flex; gap: 6px; align-items: center }
		.cm-row input { flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px; font-family: inherit }
		.cm-anchor { color: var(--muted); font-size: 12px; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical }
		.cm-anchor code { color: #b9a8ff }
		.cm-list { list-style: none; margin: 0; padding: 4px 0 }
		.cm-item { padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: pointer }
		.cm-item:hover { background: #1c2029 }
		.cm-item.selected { background: #222838; box-shadow: inset 3px 0 #ff8a00 }
		.cm-item.resolved .cm-body { color: var(--muted); text-decoration: line-through }
		.cm-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; color: var(--muted); font-size: 12px }
		.cm-meta b { color: var(--text) }
		.cm-n { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px 10px 10px 3px; background: #7c5cff; color: #fff; font-weight: 700; font-size: 11px }
		.cm-warn { color: var(--warn) }
		.cm-body { margin: 6px 0; white-space: pre-wrap; word-break: break-word }
		.cm-page { color: var(--accent); font: 11px ui-monospace, monospace; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
		.cm-actions { display: flex; gap: 6px }
		.cm-actions button { padding: 2px 8px; font-size: 11px }
		.cm-empty { margin: 24px 16px; color: var(--muted); line-height: 1.5; text-align: center }
	`);

	/** Tiny DOM builder: h('div', { class: 'x', onclick }, 'text', child) — text always goes in as text. */
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
		if (s < 60) return 'just now';
		if (s < 3600) return Math.round(s / 60) + ' min ago';
		if (s < 86400) return Math.round(s / 3600) + ' h ago';
		return new Date(t).toLocaleDateString();
	};
	const describe = (a) =>
		!a ? '' : a.kind === 'text' ? h('span', null, '“' + a.quote.exact.slice(0, 140) + (a.quote.exact.length > 140 ? '…' : '') + '”') : h('span', null, h('code', null, '<' + a.tag + '>'), a.text ? ' ' + a.text + (a.text.length >= 80 ? '…' : '') : '');

	/** Numbers are per page, in creation order, and never change when comments are filtered out. */
	function numbers() {
		const n = {};
		const per = {};
		for (const i of [...items].sort((a, b) => a.created - b.created)) n[i.id] = per[i.page] = (per[i.page] || 0) + 1;
		return n;
	}
	const shown = (i) => filter === 'all' || (filter === 'resolved') === !!i.data.resolved;
	const here = (i) => i.page === px.page();

	function sync() {
		const n = numbers();
		px.send('comments', items.filter((i) => here(i) && shown(i)).map((i) => ({ id: i.id, n: n[i.id], anchor: i.data.anchor })));
	}

	async function refresh() {
		try {
			items = await store().list(scope === 'site' ? null : px.page());
		} catch {
			items = [];
		}
		render();
		sync();
	}

	function setPicking(on) {
		picking = on;
		pickBtn.classList.toggle('on', on);
		px.send('mode', on);
	}

	async function save(body, author) {
		px.prefs.set('author', author);
		let item;
		try {
			item = await store().create(px.page(), { body, author: author || 'Anonymous', anchor: draft, resolved: false });
		} catch (err) {
			alert('Could not save the comment (' + err.message + ')');
			return;
		}
		items.push(item);
		draft = composer = null;
		selected = item.id;
		px.send('draft-clear');
		render();
		sync();
		px.send('active', item.id);
	}
	function cancelDraft() {
		draft = composer = null;
		px.send('draft-clear');
		render();
	}
	async function update(item, data) {
		const next = await store().update(item.id, data);
		items = items.map((i) => (i.id === next.id ? next : i));
		render();
		sync();
	}
	async function remove(item) {
		if (!confirm('Delete this comment?')) return;
		await store().remove(item.id);
		items = items.filter((i) => i.id !== item.id);
		if (selected === item.id) selected = null;
		render();
		sync();
	}
	function open(item) {
		selected = item.id;
		render();
		if (here(item)) px.send('focus', item.id);
		else {
			pendingFocus = item.id;
			px.navigate(item.page);
		}
	}

	const head = h('div', { class: 'cm-head' });
	const draftSlot = h('div');
	const listEl = h('ol', { class: 'cm-list' });
	const emptyEl = h('p', { class: 'cm-empty' });
	panel.el.append(h('div', { class: 'cm' }, head, draftSlot, listEl, emptyEl));

	function render() {
		const n = numbers();
		const list = items.filter(shown).sort((a, b) => (a.page === b.page ? a.created - b.created : here(a) ? -1 : here(b) ? 1 : a.page < b.page ? -1 : 1));
		const openCount = items.filter((i) => here(i) && !i.data.resolved).length;
		drawerBtn.textContent = 'Comments' + (openCount ? ' · ' + openCount : '');
		const seg = (value, options, set) =>
			h('div', { class: 'cm-seg' }, options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', onclick: () => set(v) }, label)));

		if (draft && !composer) {
			const text = h('textarea', { placeholder: 'Add a comment…' });
			const name = h('input', { placeholder: 'Your name', value: px.prefs.get('author', '') });
			const submit = () => text.value.trim() && save(text.value.trim(), name.value.trim());
			text.onkeydown = (e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
				if (e.key === 'Escape') cancelDraft();
			};
			composer = h(
				'form',
				{ class: 'cm-draft', onsubmit: (e) => (e.preventDefault(), submit()) },
				h('div', { class: 'cm-anchor' }, describe(draft)),
				text,
				h('div', { class: 'cm-row' }, name, h('button', { type: 'button', onclick: cancelDraft }, 'Cancel'), h('button', { class: 'primary' }, 'Save')),
			);
			setTimeout(() => text.focus());
		}

		const rows = list.map((i) => {
			const st = here(i) ? status[i.id] : null;
			return h(
				'li',
				{
					class: 'cm-item' + (i.id === selected ? ' selected' : '') + (i.data.resolved ? ' resolved' : ''),
					'data-id': i.id,
					onclick: () => open(i),
					onmouseenter: () => here(i) && px.send('active', i.id),
					onmouseleave: () => px.send('active', selected),
				},
				!here(i) && h('div', { class: 'cm-page', title: i.page }, new URL(i.page).pathname + new URL(i.page).search),
				h(
					'div',
					{ class: 'cm-meta' },
					h('span', { class: 'cm-n' }, n[i.id]),
					h('b', null, i.data.author || 'Anonymous'),
					h('span', null, ago(i.created)),
					st === 'missing' && h('span', { class: 'cm-warn', title: 'The commented element or text is gone from this page' }, '⚠ not found'),
					st === 'approx' && h('span', { class: 'cm-warn', title: 'The content changed since this was written; pinned to where it was' }, '≈ changed'),
				),
				h('div', { class: 'cm-anchor' }, describe(i.data.anchor)),
				h('div', { class: 'cm-body' }, i.data.body),
				h(
					'div',
					{ class: 'cm-actions' },
					h('button', { onclick: (e) => (e.stopPropagation(), update(i, { resolved: !i.data.resolved })) }, i.data.resolved ? 'Reopen' : 'Resolve'),
					h('button', { onclick: (e) => (e.stopPropagation(), remove(i)) }, 'Delete'),
				),
			);
		});

		head.replaceChildren(
			h('h2', null, 'Comments'),
			seg(filter, [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']], (v) => {
				px.prefs.set('filter', (filter = v));
				render();
				sync();
			}),
			seg(scope, [['page', 'This page'], ['site', 'Whole site']], (v) => {
				px.prefs.set('scope', (scope = v));
				refresh();
			}),
		);
		// Only swap the composer when it changes: moving it would drop focus mid-typing.
		if ((draftSlot.firstChild || null) !== composer) draftSlot.replaceChildren(...(composer ? [composer] : []));
		listEl.replaceChildren(...rows);
		emptyEl.hidden = !!(rows.length || draft);
		emptyEl.textContent = items.length ? 'Nothing here with this filter.' : 'No comments yet. Click “✚ Comment”, then click anything on the page or select some text.';
		const sel = selected && panel.el.querySelector(`[data-id="${selected}"]`);
		if (sel) sel.scrollIntoView({ block: 'nearest' });
	}

	// --- page events ---------------------------------------------------------------------------------------------
	px.onPage(async () => {
		draft = composer = null;
		status = {};
		picking = false;
		pickBtn.classList.remove('on');
		pickBtn.disabled = false;
		if (!pendingFocus) selected = null;
		await refresh();
		if (pendingFocus) {
			selected = pendingFocus;
			pendingFocus = null;
			render();
			setTimeout(() => px.send('focus', selected), 300); // give late-rendering pages a moment
		}
	});
	px.on('picked', (anchor) => {
		picking = false;
		pickBtn.classList.remove('on');
		draft = anchor;
		composer = null;
		panel.open();
		render();
	});
	px.on('mode', (on) => {
		picking = !!on;
		pickBtn.classList.toggle('on', picking);
	});
	px.on('status', (s) => {
		status = s || {};
		render();
	});
	px.on('select', (id) => {
		selected = id;
		const item = items.find((i) => i.id === id);
		if (item && !shown(item)) {
			filter = 'all';
			sync();
		}
		panel.open();
		render();
		px.send('active', id);
	});
	addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && picking) setPicking(false);
	});
	render();
});
