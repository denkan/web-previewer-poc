// README screenshots (needs `npm run dev`). Usage: node scripts/screenshots.mjs
// Drives the real UI against two local demo pages (scripts/demo-sites.mjs) and writes docs/screenshots/*.png.
// Everything it creates (comments, a map board) is deleted again at the end.
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './demo-sites.mjs';

const BASE = process.env.PX_BASE || 'http://px.localhost:8787';
const PORT = 8796;
const OLD = `http://fernhill-old.localhost:${PORT}/`;
const NEW = `http://fernhill.localhost:${PORT}/`;
const BOARD = 'readme-demo';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

function raw(path, { method = 'GET', body } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: 8787, path, method, headers: { host: new URL(BASE).host, 'sec-fetch-site': 'same-origin' } }, (res) => {
			let d = '';
			res.on('data', (c) => (d += c));
			res.on('end', () => resolve(d));
		});
		req.on('error', reject);
		req.end(body);
	});
}
async function wipe() {
	for (const [ext, scope] of [['comments', new URL(NEW).origin], ['map', 'board:' + BOARD]]) {
		const q = '?scope=' + encodeURIComponent(scope);
		for (const i of JSON.parse(await raw(`/__px/ext/${ext}/items${q}`))) await raw(`/__px/ext/${ext}/items/${i.id}${q}`, { method: 'DELETE' });
	}
}

const servers = serve(PORT);
for (const u of [OLD, NEW]) await raw('/__px/purge', { method: 'POST', body: JSON.stringify({ origin: new URL(u).origin }) });
await wipe();
const browser = await chromium.launch();

/** Where a frame's page sits on screen, and how much it's scaled. */
async function geo(page, iframeSel) {
	const el = await page.$(iframeSel);
	const r = await el.boundingBox();
	return { x: r.x, y: r.y, s: r.width / (await el.evaluate((e) => e.offsetWidth)) };
}
/** Drag-select `text` inside `sel` with real mouse events. */
async function selectText(page, frame, iframeSel, sel, text) {
	const g = await geo(page, iframeSel);
	const r = await frame.evaluate(
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
	await page.mouse.move(g.x + r[0] * g.s, g.y + r[1] * g.s);
	await page.mouse.down();
	await page.mouse.move(g.x + r[2] * g.s, g.y + r[3] * g.s, { steps: 10 });
	await page.mouse.up();
}
/** Draw a loose ellipse around `sel`. */
async function circle(page, frame, iframeSel, sel, pad = 14) {
	const g = await geo(page, iframeSel);
	const r = await frame.$eval(sel, (e) => e.getBoundingClientRect().toJSON());
	const cx = r.left + r.width / 2;
	const cy = r.top + r.height / 2;
	const rx = r.width / 2 + pad;
	const ry = r.height / 2 + pad;
	await page.mouse.move(g.x + (cx + rx) * g.s, g.y + (cy - 4) * g.s);
	await page.mouse.down();
	for (let i = 1; i <= 44; i++) {
		const t = (i / 40) * Math.PI * 2; // a little past the start, like a hand-drawn loop
		await page.mouse.move(g.x + (cx + rx * Math.cos(t)) * g.s, g.y + (cy - 4 + ry * Math.sin(t)) * g.s);
	}
	await page.mouse.up();
}
const waitHint = (frame) => frame.waitForFunction(() => document.querySelector('px-overlay[data-ext=px]')?.shadowRoot?.querySelector('.hint:not([hidden])'));

try {
	// --- comments: one page, pins + drawer ----------------------------------------------------------------
	{
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
		await page.goto(`${BASE}/#${NEW}`);
		await page.waitForFunction(() => !document.querySelector('#extButtons button').disabled);
		const f = page.frame({ name: 'preview' });
		await f.waitForSelector('#cards');
		await sleep(600);
		const comment = async (author, body) => {
			await page.waitForSelector('.cm-draft textarea');
			await page.fill('.cm-draft textarea', body);
			await page.fill('.cm-draft input', author);
			await page.click('.cm-draft button.primary');
			await sleep(500);
		};
		const pick = async () => {
			await page.click('#extButtons button:has-text("✚ Comment")');
			await waitHint(f);
		};
		await pick();
		await f.click('.cta', { position: { x: 30, y: 12 } });
		await comment('Maya', 'Same label as the nav button. “Find your coffee” here instead?');
		await pick();
		await f.click('#photo', { position: { x: 200, y: 150 } });
		await comment('Sam', 'Placeholder: needs the roastery photo from the shoot.');
		await pick();
		await selectText(page, f, '#frame', '.card:nth-child(2) .origin', 'Ethopia');
		await comment('Maya', 'Typo: Ethiopia.');
		await page.click('.cm-item:last-child');
		await page.mouse.move(700, 880);
		await sleep(1800); // past the focus flash
		await f.evaluate(() => scrollTo(0, document.getElementById('photo').getBoundingClientRect().top + scrollY - 140)); // all three pins in view
		await sleep(400);
		await page.screenshot({ path: OUT + 'comments.png' });
		await page.close();
	}

	// --- map: old site in A, redesign in B ----------------------------------------------------------------------
	{
		const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
		await page.goto(`${BASE}/map?board=${BOARD}#a=${encodeURIComponent(OLD)}&b=${encodeURIComponent(NEW)}`);
		await page.selectOption('#vw', '1024');
		const A = page.frame({ name: 'pane-a' });
		const B = page.frame({ name: 'pane-b' });
		await A.waitForSelector('#coffees');
		await B.waitForSelector('#cards');
		await page.waitForFunction(() => document.querySelectorAll('#extButtons button').length >= 3);
		await sleep(800);
		/** Switch tool and wait until both panes are in it (Draw shows a canvas; Mark shows the hint without one). */
		const tool = async (name) => {
			await page.click(`#extButtons button:has-text("${name}")`);
			const draw = name === 'Draw';
			const inTool = (f) =>
				f.waitForFunction((draw) => {
					const r = document.querySelector('px-overlay[data-ext=px]')?.shadowRoot;
					return r && !r.querySelector('.hint').hidden && r.querySelector('.canvas').hidden === !draw;
				}, draw);
			await Promise.all([inTool(A), inTool(B)]);
		};
		const save = async (author, body) => {
			await page.keyboard.press('Escape');
			await page.fill('.mp-draft textarea', body);
			await page.fill('.mp-draft input', author);
			await page.click('.mp-draft button.primary');
			await sleep(700);
		};

		// 1: the old tagline becomes the hero heading
		await tool('Mark');
		await selectText(page, A, 'iframe[name=pane-a]', '.tagline', 'Roasted by hand in small batches since 1998.');
		await B.click('#headline', { position: { x: 20, y: 20 } });
		await save('Maya', 'The old tagline becomes the hero heading. Keep “Since 1998” as the eyebrow above it.');

		// 2: the coffee table becomes cards
		await tool('Draw');
		await circle(page, A, 'iframe[name=pane-a]', '#coffees', 10);
		await tool('Mark');
		// The gap between two cards is the grid itself. Click it on screen: the pane is scaled.
		const gb = await geo(page, 'iframe[name=pane-b]');
		const first = await B.$eval('#cards .card', (e) => e.getBoundingClientRect().toJSON());
		await page.mouse.click(gb.x + (first.right + 11) * gb.s, gb.y + (first.top + first.height / 2) * gb.s);
		await save('Sam', 'Each table row becomes a card: name as title, origin underneath, price top right. Tasting notes are new copy, so ask the roaster.');

		// 3: opening hours move into the Visit section
		await tool('Mark');
		await A.click('#hours', { position: { x: 12, y: 40 } });
		await B.click('#visit', { position: { x: 8, y: 8 } });
		await save('Maya', 'Opening hours move into “Visit the roastery”. Drop the Sunday line.');

		await page.click('.mp-item:nth-child(2)');
		await page.mouse.move(800, 950);
		await sleep(1800);
		await page.screenshot({ path: OUT + 'map.png' });

		// A draft in progress: marks from both panes, before writing the note
		await tool('Mark');
		await A.click('#newsletter', { position: { x: 12, y: 30 } });
		await tool('Draw');
		await circle(page, B, 'iframe[name=pane-b]', '#footnote', 12);
		await page.keyboard.press('Escape');
		await page.fill('.mp-draft textarea', 'The newsletter box moves to the footer as a single email field.');
		await page.mouse.move(800, 950);
		await sleep(600);
		await page.screenshot({ path: OUT + 'map-draft.png' });
		await page.click('.mp-draft button:has-text("Cancel")');
		await page.close();
	}
} finally {
	await browser.close();
	await wipe();
	for (const s of servers) s.close();
}
console.log('wrote', ['comments.png', 'map.png', 'map-draft.png'].map((f) => 'docs/screenshots/' + f).join(', '));
