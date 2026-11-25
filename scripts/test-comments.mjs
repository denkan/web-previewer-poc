// Comments extension checks (needs `npm run dev`). Usage: node scripts/test-comments.mjs
// Drives the real toolbar against a local fixture page, so every check is deterministic. Each run uses its own page
// path and deletes its comments at the end.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { chromium } from 'playwright';

const BASE = process.env.PX_BASE || 'http://px.localhost:8787';
const PORT = 8792;
const RUN = randomBytes(4).toString('hex');
const SITE = `http://cm-fixture.localhost:${PORT}`;
const PAGE = `${SITE}/r/${RUN}/page`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failures++;
	console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
};

// --- fixture -------------------------------------------------------------------------------------------
// #shift (fragment: same page key) inserts an item before Beta, removes Gamma and rewords the heading, as a redesign would.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<style>body{font:16px/1.5 sans-serif;margin:40px;max-width:640px}.item{padding:8px;margin:4px 0;background:#eef}</style></head><body>
<h1 id="title">Comment fixture</h1>
<p class="intro">The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.</p>
<p class="second">Here the quick brown fox shows up again, so the quote alone is ambiguous.</p>
<button id="counter" onclick="window.clicks++">Count</button>
<a id="away" href="https://example.com/">Go elsewhere</a>
<div id="list"><div class="item">Alpha</div><div class="item">Beta</div><div class="item">Gamma</div></div>
<p><a id="card" href="https://example.com/story">Headline inside a link card</a></p>
<p id="noselect" style="user-select:none;-webkit-user-select:none">Copy the site made unselectable</p>
<svg id="logo" width="60" height="30" viewBox="0 0 60 30"><g><rect id="logopart" width="60" height="30" fill="#c00"/></g></svg>
<button id="spa" onclick="history.pushState({}, '', 'other'); document.getElementById('route').textContent = 'Other route'">SPA nav</button>
<p id="route">Home route</p>
<script>
window.clicks = 0; window.downs = 0;
document.addEventListener('mousedown', () => window.downs++);
if (location.hash === '#shift') {
	const list = document.getElementById('list');
	list.insertBefore(Object.assign(document.createElement('div'), { className: 'item', textContent: 'Zeta' }), list.children[1]);
	list.lastElementChild.remove();
	document.getElementById('title').textContent = 'Comment fixtures';
	document.body.insertBefore(document.createElement('p'), document.querySelector('.intro')).textContent = 'A new first paragraph.';
}
setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { id: 'late', textContent: 'Late paragraph' })), 1200);
</script></body></html>`;
const servers = ['127.0.0.1', '::1'].map((h) =>
	http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE)).listen(PORT, h),
);

/** Node can't resolve *.px.localhost, so talk to 127.0.0.1 with a Host header. */
function raw(url, { method = 'GET', headers = {}, body } = {}) {
	const u = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, ...headers } }, (res) => {
			let data = '';
			res.on('data', (d) => (data += d));
			res.on('end', () => resolve({ status: res.statusCode, body: data }));
		});
		req.on('error', reject);
		req.end(body);
	});
}
const storeUrl = (q = '') => `${BASE}/__px/ext/comments/items?scope=${encodeURIComponent(SITE)}${q}`;
const stored = async () => JSON.parse((await raw(storeUrl(), { headers: { 'sec-fetch-site': 'same-origin' } })).body).filter((i) => i.page.includes(`/r/${RUN}/`));

// --- toolbar helpers ---------------------------------------------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const frame = () => page.frame({ name: 'preview' });

async function open(url) {
	await page.goto('about:blank');
	await page.goto(`${BASE}/#${url}`);
	await page.waitForFunction(() => !document.querySelector('#extButtons button').disabled, null, { timeout: 15000 });
	await frame().waitForSelector('#late', { timeout: 10000 });
}
/** Pins currently drawn in the page overlay, with their tip point and the item id they belong to. */
const pins = () =>
	frame().evaluate(() => {
		const root = document.querySelector('px-overlay[data-ext=comments]')?.shadowRoot;
		return root ? [...root.querySelectorAll('.pin')].map((p) => ({ id: p.dataset.id, n: p.textContent, x: p.getBoundingClientRect().left, y: p.getBoundingClientRect().bottom, cls: p.className })) : [];
	});
const rectOf = (sel) => frame().$eval(sel, (el) => el.getBoundingClientRect().toJSON());
const inside = (p, r) => p && p.x >= r.left - 2 && p.x <= r.right + 2 && p.y >= r.top - 2 && p.y <= r.bottom + 2;
const drawerItems = () => page.$$eval('.cm-item', (els) => els.map((e) => ({ id: e.dataset.id, body: e.querySelector('.cm-body').textContent, text: e.textContent, selected: e.classList.contains('selected') })));
const highlights = () =>
	frame().evaluate(() => {
		const h = [...(CSS.highlights.get('px-comment') || []), ...(CSS.highlights.get('px-comment-active') || [])];
		return h.map((r) => ({ text: r.toString(), in: r.startContainer.parentElement.className || r.startContainer.parentElement.id }));
	});

async function comment(body) {
	await page.waitForSelector('.cm-draft textarea', { timeout: 5000 });
	await page.fill('.cm-draft textarea', body);
	await page.fill('.cm-draft input', 'Tester');
	await page.click('.cm-draft button.primary');
	await page.waitForFunction((b) => [...document.querySelectorAll('.cm-body')].some((e) => e.textContent === b), body, { timeout: 5000 });
}
/** Click "✚ Comment" and wait until the page itself is in pick mode (the toolbar tells it by postMessage). */
async function startPicking() {
	await page.click('#extButtons button:has-text("Comment")');
	await frame().waitForFunction(() => document.querySelector('px-overlay[data-ext=px]')?.shadowRoot?.querySelector('.hint:not([hidden])'), null, { timeout: 3000 });
}
async function pickElement(sel, dx = 10, dy = 10) {
	await startPicking();
	await frame().click(sel, { position: { x: dx, y: dy } });
}
/** Drag-select `text` inside the element matching `sel`, with real mouse events. */
async function selectText(sel, text) {
	const fb = await (await page.$('#frame')).boundingBox();
	const r = await frame().evaluate(
		([sel, text]) => {
			const el = document.querySelector(sel);
			const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes(text));
			const i = node.data.indexOf(text);
			const range = document.createRange();
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			const a = range.getBoundingClientRect();
			range.setStart(node, i + text.length - 1);
			range.setEnd(node, i + text.length);
			const b = range.getBoundingClientRect();
			return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
		},
		[sel, text],
	);
	await startPicking();
	await page.mouse.move(fb.x + r.x1, fb.y + r.y1);
	await page.mouse.down();
	await page.mouse.move(fb.x + r.x2, fb.y + r.y2, { steps: 8 });
	await page.mouse.up();
}

// --- checks --------------------------------------------------------------------------------------------------
// Each test runs on its own: a throw (a composer that never opened, a missing pin) marks that test red and the suite
// carries on, so a broken feature shows up as its own red line instead of aborting everything after it.
page.setDefaultTimeout(6000);
async function test(name, fn) {
	try {
		const [ok, detail] = await fn();
		check(name, ok, detail);
	} catch (err) {
		check(name, false, `threw: ${err.message.split('\n')[0]}`);
	}
}
const cancelDraft = () => page.click('.cm-draft button:has-text("Cancel")', { timeout: 1500 }).catch(() => {});
const find = async (body) => (await stored()).find((i) => i.data.body === body);
const pinOf = async (id) => (await pins()).find((x) => x.id === id);
let beta, fox, late, gamma, title, bodyBefore;

try {
	// Extensions load only next to the toolbar: a proxied page opened on its own gets no overlay and no ext.js.
	await test('not framed: extensions not loaded', async () => {
		const solo = await ctx.newPage();
		const loaded = [];
		solo.on('request', (r) => loaded.push(r.url()));
		await solo.goto(`${BASE}/go?url=${encodeURIComponent(PAGE)}`);
		await solo.waitForSelector('#late');
		const ok = !loaded.some((u) => u.includes('/__px/ext.js')) && !(await solo.$('px-overlay'));
		await solo.close();
		return [ok, loaded.filter((u) => u.includes('__px')).join(' ')];
	});

	await open(PAGE);
	bodyBefore = await frame().evaluate(() => document.body.innerHTML); // before any extension UI exists

	await test('click in pick mode opens the composer with the element', async () => {
		await pickElement('#list .item:nth-child(2)', 40, 12);
		const label = await page.textContent('.cm-draft .cm-anchor');
		return [label.includes('<div>') && label.includes('Beta'), label];
	});
	await test('composer layout: quote, full-width textarea, then name + buttons', async () => {
		const box = (sel) => page.$eval(sel, (e) => e.getBoundingClientRect().toJSON());
		const [form, quote, text, row] = await Promise.all(['.cm-draft', '.cm-draft .cm-anchor', '.cm-draft textarea', '.cm-draft .cm-row'].map(box));
		const ok = text.width >= form.width - 40 && quote.bottom <= text.top && text.bottom <= row.top && row.width >= form.width - 40;
		return [ok, `form ${form.width | 0} textarea ${text.width | 0}×${text.height | 0} quote→text→row ${quote.bottom | 0}/${text.top | 0} ${text.bottom | 0}/${row.top | 0}`];
	});
	await test('comment stored with its anchor', async () => {
		await comment('Beta needs a better name');
		beta = await find('Beta needs a better name');
		const a = beta?.data.anchor;
		return [a?.kind === 'element' && a?.text === 'Beta', JSON.stringify(a)];
	});
	await test('pin drawn on the element, where it was clicked', async () => {
		await sleep(300);
		const p = await pinOf(beta.id);
		const r = await rectOf('#list .item:nth-child(2)');
		return [inside(p, r) && Math.abs(p.x - (r.left + 40)) < 3, `pin ${JSON.stringify(p)} rect ${r.left},${r.top}`];
	});

	// Picking never reaches the page: no click handler, no mousedown listener, no navigation.
	await cancelDraft();
	const before = await frame().evaluate(() => ({ downs: window.downs, clicks: window.clicks }));
	await test('pick mode: page click handlers never run', async () => {
		await pickElement('#counter');
		await cancelDraft();
		const now = await frame().evaluate(() => ({ downs: window.downs, clicks: window.clicks }));
		return [now.clicks === before.clicks && now.downs === before.downs, JSON.stringify(now)];
	});
	await test('pick mode: links do not navigate', async () => {
		const url = frame().url();
		await pickElement('#away');
		await sleep(700);
		await cancelDraft();
		return [frame().url() === url, frame().url()];
	});
	if (!frame().url().includes(`/r/${RUN}/page`)) await open(PAGE); // a broken guard navigated away: carry on

	// Esc leaves pick mode, from the page and from the toolbar; clicks reach the page again.
	await test('Esc in the page ends pick mode (and clicks work again)', async () => {
		const n = await frame().evaluate(() => window.clicks);
		await startPicking();
		await frame().locator('#counter').press('Escape'); // focus moves into the page (no click), Esc goes to the page
		await sleep(200);
		const btn = await page.$eval('#extButtons button', (b) => b.className);
		await frame().click('#counter');
		const draft = !!(await page.$('.cm-draft'));
		await cancelDraft();
		const now = await frame().evaluate(() => window.clicks);
		return [now === n + 1, `clicks ${n} -> ${now}, pick button "${btn}", draft ${draft}`];
	});
	await test('Esc in the toolbar ends pick mode', async () => {
		const n = await frame().evaluate(() => window.clicks);
		await startPicking();
		await page.keyboard.press('Escape');
		await frame().click('#counter');
		await cancelDraft();
		return [(await frame().evaluate(() => window.clicks)) === n + 1];
	});
	await page.keyboard.press('Escape');

	// Text comment on an ambiguous quote: the prefix/suffix pick the second occurrence.
	await test('text selection opens the composer with the quote', async () => {
		await selectText('.second', 'quick brown fox');
		return [(await page.textContent('.cm-draft .cm-anchor')).includes('“quick brown fox”')];
	});
	await test('quote highlighted, in the paragraph it was selected in', async () => {
		await comment('Fox again?');
		fox = await find('Fox again?');
		const hl = await highlights();
		return [hl.length === 1 && hl[0].text === 'quick brown fox' && hl[0].in === 'second', JSON.stringify(hl)];
	});
	await test('page DOM untouched by pins, highlights and outlines', async () => [(await frame().evaluate(() => document.body.innerHTML)) === bodyBefore]);

	// Real-world markup: headlines inside links, selection disabled by the site, icons made of SVG parts.
	for (const [name, sel, text] of [
		['text inside a link can be selected', '#card', 'inside a link'],
		['text the site made unselectable can be selected', '#noselect', 'made unselectable'],
	]) {
		await test(name, async () => {
			await selectText(sel, text);
			const label = await page.textContent('.cm-draft .cm-anchor');
			await cancelDraft();
			return [label.includes(`“${text}”`) && frame().url().includes(`/r/${RUN}/page`), label];
		});
	}
	await test('clicking an SVG part comments on the whole <svg>', async () => {
		await pickElement('#logopart');
		const label = await page.textContent('.cm-draft .cm-anchor');
		await cancelDraft();
		return [label.startsWith('<svg>'), label];
	});

	// Late content: a comment on an element that renders after load.
	await pickElement('#late').catch(() => {});
	await comment('Late but noted').catch(() => {});
	late = await find('Late but noted');

	// Reload: everything re-anchors.
	await open(PAGE);
	await sleep(1500);
	await test('after reload: element comment re-anchored', async () => [inside(await pinOf(beta.id), await rectOf('#list .item:nth-child(2)')), JSON.stringify(await pinOf(beta.id))]);
	await test('after reload: quote re-found in the right paragraph', async () => {
		const hl = await highlights();
		return [hl.length === 1 && hl[0].in === 'second', JSON.stringify(hl)];
	});
	await test('after reload: late-rendered target found once it appears', async () => [inside(await pinOf(late.id), await rectOf('#late'))]);

	// Redesign (#shift): Beta moved (its CSS path now points at Zeta), Gamma gone, the heading reworded.
	await pickElement('#list .item:nth-child(3)').catch(() => {});
	await comment('Gamma is going away').catch(() => {});
	gamma = await find('Gamma is going away');
	await pickElement('#title').catch(() => {});
	await comment('Heading copy').catch(() => {});
	title = await find('Heading copy');
	await open(`${PAGE}#shift`);
	await page.click('#extButtons button:has-text("Comments")');
	await sleep(1200);
	const itemText = async (id) => (await drawerItems()).find((i) => i.id === id)?.text;
	await test('moved element found by its text, not its old path', async () => {
		const betaNow = await frame().evaluate(() => [...document.querySelectorAll('.item')].find((e) => e.textContent === 'Beta').getBoundingClientRect().toJSON());
		return [inside(await pinOf(beta.id), betaNow), JSON.stringify(await pinOf(beta.id))];
	});
	await test('removed element: no pin, drawer says not found', async () => [!(await pinOf(gamma.id)) && (await itemText(gamma.id)).includes('not found'), await itemText(gamma.id)]);
	await test('edited element: still pinned, drawer says changed', async () => [inside(await pinOf(title.id), await rectOf('#title')) && (await itemText(title.id)).includes('changed'), await itemText(title.id)]);

	// Pin ⇄ drawer.
	await test('clicking a pin opens the drawer on its comment', async () => {
		await page.click('#extButtons button:has-text("Comments")'); // close it first
		const p = await pinOf(fox.id);
		const fb = await (await page.$('#frame')).boundingBox();
		await page.mouse.click(fb.x + p.x + 8, fb.y + p.y - 10);
		await sleep(300);
		const sel = (await drawerItems()).find((i) => i.selected);
		return [(await page.isVisible('#drawer')) && sel?.id === fox.id, sel?.body];
	});
	await test('clicking a comment flashes its pin', async () => {
		await page.click(`.cm-item[data-id="${beta.id}"]`);
		await sleep(150);
		return [(await pinOf(beta.id))?.cls.includes('flash')];
	});

	// Resolve / reopen / delete.
	await test('resolved: gone from the Open list and the page', async () => {
		await page.click(`.cm-item[data-id="${beta.id}"] button:has-text("Resolve")`);
		await sleep(300);
		return [!(await drawerItems()).some((i) => i.id === beta.id) && !(await pinOf(beta.id))];
	});
	await test('Resolved filter shows it again (list and pin)', async () => {
		await page.click('.cm-seg button:has-text("Resolved")');
		await sleep(300);
		return [(await drawerItems()).some((i) => i.id === beta.id) && !!(await pinOf(beta.id))];
	});
	await page.click('.cm-seg button:has-text("Open")');
	await test('delete removes it from the drawer and the store', async () => {
		page.once('dialog', (d) => d.accept());
		await page.click(`.cm-item[data-id="${gamma.id}"] button:has-text("Delete")`);
		await sleep(400);
		return [!(await drawerItems()).some((i) => i.id === gamma.id) && !(await stored()).some((i) => i.id === gamma.id)];
	});

	// SPA navigation: new page key, the URL bar follows; Whole site lists the other page and jumps back to it.
	await test('SPA route change: pins and list follow the new URL', async () => {
		await frame().click('#spa');
		await sleep(600);
		return [(await pins()).length === 0 && (await drawerItems()).length === 0 && (await page.inputValue('#url')).endsWith('/other'), await page.inputValue('#url')];
	});
	await test('Whole site lists other pages’ comments', async () => {
		await page.click('.cm-seg button:has-text("Whole site")');
		await sleep(400);
		return [(await drawerItems()).some((i) => i.id === fox.id && i.text.includes(`/r/${RUN}/page`))];
	});
	await test('clicking another page’s comment opens that page with it selected', async () => {
		await page.click(`.cm-item[data-id="${fox.id}"]`);
		await page.waitForFunction((run) => document.querySelector('#url').value.endsWith(`/r/${run}/page`), RUN, { timeout: 10000 });
		// Flashing is what focusing a comment does (hovering the drawer item only marks it active).
		const flashed = await frame()
			.waitForFunction((id) => document.querySelector('px-overlay[data-ext=comments]')?.shadowRoot?.querySelector(`.pin.flash[data-id="${id}"]`), fox.id, { timeout: 4000 })
			.then(() => true, () => false);
		return [flashed, JSON.stringify(await pinOf(fox.id))];
	});
	await page.click('.cm-seg button:has-text("This page")').catch(() => {});

	// Storage is the toolbar's only: proxied pages (other origins) and cross-site requests can't write.
	await test('a proxied page cannot write comments', async () => {
		const res = await frame().evaluate(async (u) => {
			try {
				return (await fetch(u, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{"page":"x","data":{}}' })).status;
			} catch (e) {
				return 'blocked: ' + e.message;
			}
		}, storeUrl());
		return [String(res).startsWith('blocked') || res === 403, res];
	});
	await test('cross-site write rejected', async () => {
		const r = await raw(storeUrl(), { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ page: PAGE, data: { body: 'x' } }) });
		return [r.status === 403, r.status];
	});
	await test('unknown extension: 404', async () => {
		const r = await raw(`${BASE}/__px/ext/nope/items?origin=${encodeURIComponent(SITE)}`, { headers: { 'sec-fetch-site': 'same-origin' } });
		return [r.status === 404, r.status];
	});
	await test('no page errors in the toolbar', async () => [errors.length === 0, errors.join(' | ')]);
} catch (err) {
	check('suite setup', false, err.message.split('\n')[0]);
} finally {
	for (const i of await stored().catch(() => [])) await raw(`${BASE}/__px/ext/comments/items/${i.id}?origin=${encodeURIComponent(SITE)}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin' } });
	await browser.close();
	for (const s of servers) s.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
