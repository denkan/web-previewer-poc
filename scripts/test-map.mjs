// Map view checks (needs `npm run dev`). Usage: node scripts/test-map.mjs
// Drives /map against two local fixture sites (an old page in A, its redesign in B). Each run uses its own board and
// deletes it at the end. Every test runs on its own, so a broken feature shows up as its own red line.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { chromium } from 'playwright';
import { serve } from './map-fixtures.mjs';

const BASE = process.env.PX_BASE || 'http://px.localhost:8787';
const PORT = 8794;
const BOARD = 'test-' + randomBytes(4).toString('hex');
const A_URL = `http://old.localhost:${PORT}/`;
const B_URL = `http://new.localhost:${PORT}/`;
const MAP = `${BASE}/map?board=${BOARD}#a=${encodeURIComponent(A_URL)}&b=${encodeURIComponent(B_URL)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failures++;
	console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 130)}` : ''}`);
};
async function test(name, fn) {
	try {
		const [ok, detail] = await fn();
		check(name, ok, detail);
	} catch (err) {
		check(name, false, `threw: ${err.message.split('\n')[0]}`);
	}
}

function raw(url, { method = 'GET', headers = {}, body } = {}) {
	const u = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, 'sec-fetch-site': 'same-origin', ...headers } }, (res) => {
			let d = '';
			res.on('data', (c) => (d += c));
			res.on('end', () => resolve({ status: res.statusCode, body: d }));
		});
		req.on('error', reject);
		req.end(body);
	});
}
const storeUrl = (path = '') => `${BASE}/__px/ext/map/items${path}?scope=${encodeURIComponent('board:' + BOARD)}`;
const stored = async () => JSON.parse((await raw(storeUrl())).body);

const servers = serve(PORT);
// The fixture URLs are fixed, so drop any cached copies: the checks must run against the fixtures as written.
for (const o of [new URL(A_URL).origin, new URL(B_URL).origin]) await raw(`${BASE}/__px/purge`, { method: 'POST', body: JSON.stringify({ origin: o }) });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// --- helpers ----------------------------------------------------------------------------------------------------
const frame = (p) => page.frame({ name: 'pane-' + p });
async function open() {
	await page.goto('about:blank');
	await page.goto(MAP);
	await frame('a').waitForSelector('#title', { timeout: 15000 });
	await frame('b').waitForSelector('#card', { timeout: 15000 });
	await page.waitForFunction(() => document.querySelectorAll('#extButtons button').length >= 3);
	await sleep(800);
}
/** Pane geometry: where its page is on screen and how much it's scaled. */
async function geo(p) {
	const el = await page.$(`iframe[name=pane-${p}]`);
	const r = await el.boundingBox();
	return { x: r.x, y: r.y, s: r.width / (await el.evaluate((e) => e.offsetWidth)) };
}
const toScreen = (g, x, y) => [g.x + x * g.s, g.y + y * g.s];
const rectIn = (p, sel) => frame(p).$eval(sel, (e) => e.getBoundingClientRect().toJSON());
const hintOn = (p) => frame(p).evaluate(() => !!document.querySelector('px-overlay[data-ext=px]')?.shadowRoot?.querySelector('.hint:not([hidden])'));
const tool = async (name) => {
	await page.click(`#extButtons button:has-text("${name}")`);
	await frame('a').waitForFunction(() => document.querySelector('px-overlay[data-ext=px]')?.shadowRoot?.querySelector('.hint:not([hidden])'), null, { timeout: 3000 });
};
const toolOff = async () => {
	for (const b of await page.$$('#extButtons button.on')) if (/Mark|Draw/.test(await b.textContent())) await b.click();
};
const chips = () => page.$$eval('.mp-draft .mp-chip', (els) => els.map((e) => e.textContent));
/** What the map extension drew in a pane: outlines, strokes, badges (page px). */
const drawn = (p) =>
	frame(p).evaluate(() => {
		const root = document.querySelector('px-overlay[data-ext=map]')?.shadowRoot;
		if (!root) return { boxes: [], strokes: [], badges: [] };
		const box = (e) => e.getBoundingClientRect().toJSON();
		return {
			boxes: [...root.querySelectorAll('rect.box')].map((e) => ({ ...box(e), color: e.getAttribute('stroke'), cls: e.getAttribute('class') })),
			strokes: [...root.querySelectorAll('path.stroke')].map((e) => ({ ...box(e), color: e.getAttribute('stroke') })),
			badges: [...root.querySelectorAll('.badge')].map((e) => ({ id: e.dataset.id, text: e.textContent, cls: e.className, ...box(e) })),
		};
	});
const highlighted = (p) => frame(p).evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('px-map-')).flatMap((k) => [...CSS.highlights.get(k)].map((r) => r.toString())));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const inside = (pt, r, tol = 3) => pt && pt.x >= r.left - tol && pt.x <= r.right + tol && pt.y >= r.top - tol && pt.y <= r.bottom + tol;
const center = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
async function selectText(p, sel, text) {
	const g = await geo(p);
	const r = await frame(p).evaluate(
		([sel, text]) => {
			const n = [...document.querySelector(sel).childNodes].find((c) => c.nodeType === 3 && c.data.includes(text));
			const i = n.data.indexOf(text);
			const rg = document.createRange();
			rg.setStart(n, i);
			rg.setEnd(n, i + 1);
			const a = rg.getBoundingClientRect();
			rg.setStart(n, i + text.length - 1);
			rg.setEnd(n, i + text.length);
			const z = rg.getBoundingClientRect();
			return [a.left + 1, a.top + a.height / 2, z.right - 1, z.top + z.height / 2];
		},
		[sel, text],
	);
	await page.mouse.move(...toScreen(g, r[0], r[1]));
	await page.mouse.down();
	await page.mouse.move(...toScreen(g, r[2], r[3]), { steps: 8 });
	await page.mouse.up();
}
/** Draw an ellipse inset into an element's box, with real mouse events on screen. */
async function ellipse(p, sel, inset = 14) {
	const g = await geo(p);
	const r = await rectIn(p, sel);
	const cx = r.left + r.width / 2;
	const cy = r.top + r.height / 2;
	const rx = r.width / 2 - inset;
	const ry = r.height / 2 - inset;
	await page.mouse.move(...toScreen(g, cx + rx, cy));
	await page.mouse.down();
	for (let i = 1; i <= 28; i++) {
		const t = (i / 28) * Math.PI * 2;
		await page.mouse.move(...toScreen(g, cx + rx * Math.cos(t), cy + ry * Math.sin(t)));
	}
	await page.mouse.up();
}
const links = () => page.$$eval('#links path', (ps) => ps.map((p) => ({ note: p.dataset.note, d: p.getAttribute('d'), dash: p.getAttribute('stroke-dasharray'), color: p.getAttribute('stroke'), width: p.getAttribute('stroke-width') })));
const ends = (d) => {
	const n = d.match(/-?[\d.]+/g).map(Number);
	return { x1: n[0], y1: n[1], x2: n[n.length - 2], y2: n[n.length - 1] };
};

// --- checks --------------------------------------------------------------------------------------------------------
let note;
try {
	await open();
	const panesBox = await (await page.$('#panes')).boundingBox();

	await test('map view: both pages rendered at 1280px, scaled to fit their panes', async () => {
		const w = [await frame('a').evaluate(() => innerWidth), await frame('b').evaluate(() => innerWidth)];
		const g = await geo('a');
		return [w[0] === 1280 && w[1] === 1280 && g.s < 1, `innerWidth ${w} scale ${g.s.toFixed(2)}`];
	});
	await test('only the map tools in the map view, only comments in the single view', async () => {
		const here = await page.$$eval('#extButtons button', (bs) => bs.map((b) => b.textContent.trim()));
		const single = await ctx.newPage();
		await single.goto(`${BASE}/#${A_URL}`);
		await single.waitForSelector('#extButtons button');
		const there = await single.$$eval('#extButtons button', (bs) => bs.map((b) => b.textContent.trim()));
		await single.close();
		return [here.join() === '▢ Mark,✎ Draw,Notes' && there.every((t) => /Comment/.test(t)), `map ${here} · single ${there}`];
	});

	// Draft: marks from both panes, of every kind.
	await test('mark in A: the element joins a new note', async () => {
		await tool('Mark');
		await frame('a').click('.hero-copy');
		await page.waitForSelector('.mp-draft .mp-chip');
		const c = await chips();
		return [c.length === 1 && c[0].startsWith('A') && c[0].includes('<p>') && c[0].includes('Fast, friendly'), c.join(' | ')];
	});
	await test('Mark stays on after a pick (both panes)', async () => [(await hintOn('a')) && (await hintOn('b'))]);
	await test('marking: the page never sees clicks (no handlers, no navigation)', async () => {
		await frame('a').click('#counter');
		await frame('a').click('#cta');
		await sleep(500);
		const s = await frame('a').evaluate(() => ({ clicks: window.clicks, downs: window.downs, url: location.pathname }));
		// those two picks joined the draft: take them out again
		for (let i = 0; i < 2; i++) await page.click('.mp-draft .mp-chip:last-child button');
		return [s.clicks === 0 && s.downs === 0 && s.url === '/' && (await chips()).length === 1, JSON.stringify(s)];
	});
	await test('select text in B: the quote joins the same note', async () => {
		await selectText('b', '.lead', 'Widgets that just work');
		await sleep(400);
		const c = await chips();
		return [c.length === 2 && c[1].startsWith('B') && c[1].includes('“Widgets that just work”'), c.join(' | ')];
	});
	await test('switching Mark → Draw leaves Draw on', async () => {
		await page.click('#extButtons button:has-text("Draw")');
		await sleep(300);
		const on = await page.$$eval('#extButtons button.on', (bs) => bs.map((b) => b.textContent.trim()).filter((t) => /Mark|Draw/.test(t)));
		const canvas = await frame('b').evaluate(() => !document.querySelector('px-overlay[data-ext=px]').shadowRoot.querySelector('.canvas').hidden);
		return [on.join() === '✎ Draw' && canvas, on.join()];
	});
	let pageInput;
	await test('draw in B: strokes join one drawing, drawn in the note color', async () => {
		const before = await frame('b').evaluate(() => ({ downs: window.downs, moves: window.moves }));
		await ellipse('b', '#card');
		await ellipse('b', '#card', 40);
		await sleep(400);
		const c = await chips();
		const d = await drawn('b');
		const after = await frame('b').evaluate(() => ({ downs: window.downs, moves: window.moves }));
		pageInput = { before, after };
		return [c.length === 3 && c[2].includes('drawing · 2 strokes') && d.strokes.length === 2, `${c[2]} · ${d.strokes.length} strokes`];
	});
	await test('drawing: the page sees no presses and no pointer moves (no hover menus)', async () => {
		const { before, after } = pageInput;
		return [typeof before.moves === 'number' && after.downs === before.downs && after.moves === before.moves, `mousedowns ${before.downs}->${after.downs}, pointermoves ${before.moves}->${after.moves}`];
	});
	await test('a drawing sits where it was drawn', async () => {
		const card = await rectIn('b', '#card');
		const s = (await drawn('b')).strokes[0];
		return [near(s.left, card.left + 14, 4) && near(s.right, card.right - 14, 4) && near(s.top, card.top + 14, 4), `stroke ${s.left | 0}-${s.right | 0} card ${card.left | 0}-${card.right | 0}`];
	});
	await test('drawing: CSS :hover on the page doesn’t react (our canvas is on top)', async () => {
		const g = await geo('b');
		const r = await rectIn('b', '.grid div');
		await page.mouse.move(...toScreen(g, r.left + r.width / 2, r.top + r.height / 2));
		await sleep(150);
		const bg = await frame('b').$eval('.grid div', (e) => getComputedStyle(e).backgroundColor);
		return [bg !== 'rgb(255, 0, 0)', bg];
	});
	await page.keyboard.press('Escape');
	await test('Esc stops the tool in both panes', async () => [!(await hintOn('a')) && !(await hintOn('b')) && !(await page.$('#extButtons button.on:has-text("Draw")'))]);
	await test('a mark can be taken out of the draft (chip and outline)', async () => {
		await tool('Mark');
		await frame('a').click('#features li:nth-child(2)');
		await page.keyboard.press('Escape');
		await sleep(300);
		const before = (await drawn('a')).boxes.length;
		await page.click('.mp-draft .mp-chip:last-child button');
		await sleep(300);
		const after = (await drawn('a')).boxes.length;
		return [(await chips()).length === 3 && before === 2 && after === 1, `outlines in A ${before} -> ${after}`];
	});

	await test('save: one note with marks from both panes, each with its pane and page', async () => {
		await page.fill('.mp-draft textarea', 'Hero copy moves into the card; the new lead replaces the tagline.');
		await page.click('.mp-draft button.primary');
		await page.waitForSelector('.mp-item');
		note = (await stored())[0];
		const m = note?.data.marks || [];
		const sig = m.map((x) => `${x.pane}:${x.kind}:${new URL(x.page).hostname}`).join(' ');
		return [sig === 'a:element:old.localhost b:text:new.localhost b:drawing:new.localhost', sig];
	});
	await test('the drawing is anchored to the element it was drawn on', async () => {
		const d = note.data.marks.find((x) => x.kind === 'drawing');
		return [d.strokes.every((s) => s.anchor.selector === '#card' && s.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)), d.strokes.map((s) => s.anchor.selector).join()];
	});
	await test('all marks drawn in the note color, in both panes', async () => {
		const [a, b] = [await drawn('a'), await drawn('b')];
		const color = (await links())[0]?.color;
		return [a.boxes.length === 1 && a.boxes[0].color === color && b.strokes.every((s) => s.color === color) && (await highlighted('b')).join() === 'Widgets that just work', `${a.boxes[0]?.color} ${b.strokes.map((s) => s.color)} line ${color}`];
	});

	await test('badges keep their on-screen size in a scaled-down pane', async () => {
		const g = await geo('a');
		const b = (await drawn('a')).badges[0];
		const h = b.height * g.s;
		return [g.s < 0.8 && near(h, 24, 1), `badge ${h.toFixed(1)}px tall on screen (20px + 2px border) at scale ${g.s.toFixed(2)}`];
	});

	// Lines between the panes.
	await test('lines join the A mark to each B mark, edge to edge', async () => {
		const l = await links();
		const ga = await geo('a');
		const gb = await geo('b');
		const hero = await rectIn('a', '.hero-copy');
		const lead = await frame('b').evaluate(() => {
			const n = document.querySelector('.lead').firstChild;
			const r = document.createRange();
			r.setStart(n, 0);
			r.setEnd(n, 22);
			return r.getBoundingClientRect().toJSON();
		});
		const [ax, ay] = toScreen(ga, hero.right, hero.top + hero.height / 2);
		const [bx, by] = toScreen(gb, lead.left, lead.top + lead.height / 2);
		const e = l.map((x) => ends(x.d));
		const ok = l.length === 2 && e.every((x) => near(x.x1 + panesBox.x, ax, 2) && near(x.y1 + panesBox.y, ay, 2)) && e.some((x) => near(x.x2 + panesBox.x, bx, 2) && near(x.y2 + panesBox.y, by, 2));
		return [ok, `${l.length} lines, start ${JSON.stringify(e[0])} vs ${(ax - panesBox.x) | 0},${(ay - panesBox.y) | 0}`];
	});
	await test('lines follow scrolling', async () => {
		const y0 = ends((await links())[0].d).y1;
		await frame('a').evaluate(() => scrollBy(0, 40));
		await sleep(400);
		const y1 = ends((await links())[0].d).y1;
		const s = (await geo('a')).s;
		return [near(y0 - y1, 40 * s, 2), `moved ${(y0 - y1).toFixed(1)}px, expected ${(40 * s).toFixed(1)}`];
	});
	await test('an off-screen mark: dashed line pinned to the pane edge', async () => {
		await frame('a').evaluate(() => scrollBy(0, 1000));
		await sleep(400);
		const l = (await links())[0];
		const vp = await (await page.$('.pane[data-pane=a] .vp')).boundingBox();
		const y = ends(l.d).y1 + panesBox.y;
		await frame('a').evaluate(() => scrollTo(0, 0));
		return [!!l.dash && near(y, vp.y + 4, 2), `dash ${l.dash} y ${y.toFixed(1)} pane top ${vp.y.toFixed(1)}`];
	});

	// Reload: everything finds its place again.
	await open();
	await test('after reload: outline, quote, drawing and lines are back', async () => {
		const a = await drawn('a');
		const b = await drawn('b');
		const hero = await rectIn('a', '.hero-copy');
		const card = await rectIn('b', '#card');
		const ok = a.boxes.length === 1 && inside(center(a.boxes[0]), hero) && (await highlighted('b')).join() === 'Widgets that just work' && b.strokes.length === 2 && b.strokes.every((s) => inside(center(s), card)) && (await links()).length === 2;
		return [ok, `boxes ${a.boxes.length} strokes ${b.strokes.length} lines ${(await links()).length}`];
	});
	await test('a drawing scales with its element (1280 → 1024 viewport)', async () => {
		const frac = async () => {
			const card = await rectIn('b', '#card');
			const s = (await drawn('b')).strokes[0];
			return [(s.left - card.left) / card.width, (s.right - card.left) / card.width, card.width];
		};
		const f1 = await frac();
		await page.selectOption('#vw', '1024');
		await sleep(700);
		const f2 = await frac();
		await page.selectOption('#vw', '1280');
		await sleep(500);
		return [f2[2] < f1[2] - 50 && near(f1[0], f2[0], 0.02) && near(f1[1], f2[1], 0.02), `card ${f1[2] | 0}→${f2[2] | 0}px, stroke at ${f1[0].toFixed(3)}-${f1[1].toFixed(3)} → ${f2[0].toFixed(3)}-${f2[1].toFixed(3)}`];
	});
	await test('clicking a badge selects its note in the drawer', async () => {
		if (await page.isVisible('#drawer')) await page.click('#extButtons button:has-text("Notes")');
		const badge = (await drawn('b')).badges[0];
		const g = await geo('b');
		await page.mouse.click(...toScreen(g, badge.left + badge.width / 2, badge.top + badge.height / 2));
		await sleep(300);
		const sel = await page.$eval('.mp-item.selected', (e) => e.dataset.id).catch(() => null);
		return [(await page.isVisible('#drawer')) && sel === note.id, sel];
	});

	// Notes on other pages.
	await page.fill('.pane[data-pane=a] .url', `http://old.localhost:${PORT}/other`);
	await page.press('.pane[data-pane=a] .url', 'Enter');
	await page.fill('.pane[data-pane=b] .url', `http://new.localhost:${PORT}/other`);
	await page.press('.pane[data-pane=b] .url', 'Enter');
	await frame('a').waitForSelector('text=Other page');
	await frame('b').waitForSelector('text=Other page');
	await sleep(800);
	await test('other pages: “On screen” hides the note, “Whole board” lists it', async () => {
		const hereCount = (await page.$$('.mp-item')).length;
		await page.click('.mp-seg button:has-text("Whole board")');
		await sleep(200);
		return [hereCount === 0 && (await page.$$('.mp-item')).length === 1 && (await links()).length === 0, `on screen ${hereCount}`];
	});
	await test('clicking it opens both its pages and flashes its marks', async () => {
		await page.click('.mp-item');
		await frame('a').waitForSelector('.hero-copy', { timeout: 10000 });
		await frame('b').waitForSelector('#card', { timeout: 10000 });
		const flashed = await frame('b')
			.waitForFunction(() => document.querySelector('px-overlay[data-ext=map]')?.shadowRoot?.querySelector('.badge.flash'), null, { timeout: 4000 })
			.then(() => true, () => false);
		await page.click('.mp-seg button:has-text("On screen")');
		return [flashed && (await links()).length === 2, `flash ${flashed}, lines ${(await links()).length}`];
	});

	await test('resolve hides the note, its marks and its lines', async () => {
		await page.click('.mp-item button:has-text("Resolve")');
		await sleep(400);
		const gone = (await page.$$('.mp-item')).length === 0 && (await drawn('a')).boxes.length === 0 && (await drawn('b')).strokes.length === 0 && (await links()).length === 0;
		await page.click('.mp-seg button:has-text("All")');
		await sleep(300);
		return [gone && (await links()).length === 2];
	});
	await test('store: scopes are validated', async () => {
		const bad = await raw(`${BASE}/__px/ext/map/items?scope=${encodeURIComponent('board:../x')}`);
		const cross = await raw(storeUrl(), { headers: { 'sec-fetch-site': 'same-site' } });
		return [bad.status === 400 && cross.status === 403, `bad ${bad.status} same-site ${cross.status}`];
	});
	await test('no page errors in the toolbar', async () => [errors.length === 0, errors.join(' | ')]);
} catch (err) {
	check('suite setup', false, err.message.split('\n')[0]);
} finally {
	for (const n of await stored().catch(() => [])) await raw(storeUrl('/' + n.id), { method: 'DELETE' });
	await browser.close();
	for (const s of servers) s.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
