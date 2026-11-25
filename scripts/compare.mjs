// Loads each URL directly and through the proxy in headless Chromium, then reports:
//  - pixel diff of the two viewport screenshots
//  - requests that leaked straight to the internet (bypassing the proxy and the service worker)
//  - failed requests, console errors, cold vs warm (cached) load times
// Usage: node scripts/compare.mjs [url ...]   (needs `npm run dev` running; PX_BASE overrides the server)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const BASE = process.env.PX_BASE || 'http://px.localhost:8787'; // proxy hosts are *.px.localhost
const MODES = (process.env.PX_MODES || 'snapshot,live').split(','); // snapshot | live
const OUT = new URL('../out/', import.meta.url).pathname;
const VIEWPORT = { width: 1280, height: 900 };
const SETTLE_MS = 3000;
const DEFAULT_URLS = [
	'https://example.com',
	'https://en.wikipedia.org/wiki/Cloudflare',
	'https://news.ycombinator.com',
	'https://developer.mozilla.org/en-US/docs/Web/HTML',
	'https://react.dev',
	'https://tailwindcss.com',
	'https://github.com/cloudflare/workerd',
	'https://www.bbc.com/news',
	'https://stripe.com',
	'https://www.apple.com',
];
const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
mkdirSync(OUT, { recursive: true });

const slug = (u) => u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').slice(0, 60);
const BASE_HOST = new URL(BASE).host;
const local = (u) => {
	const h = new URL(u).host;
	return h === BASE_HOST || h.endsWith(`.${BASE_HOST}`);
};

async function load(page, url) {
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 45000 });
	} catch (e) {
		console.warn(`  goto ${url}: ${e.message.split('\n')[0]}`);
	}
	await page.waitForTimeout(SETTLE_MS);
	return page.evaluate(() => {
		const n = performance.getEntriesByType('navigation')[0];
		return n ? { load: Math.round(n.loadEventEnd), dcl: Math.round(n.domContentLoadedEventEnd) } : {};
	});
}

function diff(a, b, outPath) {
	const A = PNG.sync.read(readFileSync(a));
	const B = PNG.sync.read(readFileSync(b));
	const w = Math.min(A.width, B.width);
	const h = Math.min(A.height, B.height);
	const crop = (img) => {
		if (img.width === w && img.height === h) return img.data;
		const out = Buffer.alloc(w * h * 4);
		for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
		return out;
	};
	const D = new PNG({ width: w, height: h });
	const changed = pixelmatch(crop(A), crop(B), D.data, w, h, { threshold: 0.15 });
	writeFileSync(outPath, PNG.sync.write(D));
	return +((changed / (w * h)) * 100).toFixed(2);
}

const browser = await chromium.launch();
await new Promise((resolve, reject) => {
	// Honest cold numbers. Node may resolve *.localhost to ::1 only, so talk to 127.0.0.1 with a Host header.
	const u = new URL(BASE);
	const req = http.request({ host: '127.0.0.1', port: u.port, path: '/__px/purge', method: 'POST', headers: { host: u.host } }, (res) => res.resume().on('end', resolve));
	req.on('error', reject);
	req.end(JSON.stringify({ all: true }));
});
const results = [];

for (const url of urls) {
	const s = slug(url);
	console.log(`\n▶ ${url}`);
	const r = { url, slug: s };

	// 1. Original, straight from the internet.
	const ctxA = await browser.newContext({ viewport: VIEWPORT });
	const pa = await ctxA.newPage();
	r.original = await load(pa, url);
	await pa.screenshot({ path: `${OUT}${s}-orig.png` });
	await ctxA.close();

	for (const mode of MODES) {
		// 2. Through the proxy, cold cache, fresh browser profile (service worker not yet installed).
		const ctxB = await browser.newContext({ viewport: VIEWPORT });
		const pb = await ctxB.newPage();
		const reqs = [];
		const failed = [];
		const errors = [];
		pb.on('request', (q) => reqs.push(q));
		const sockets = [];
		pb.on('websocket', (ws) => sockets.push(ws.url()));
		pb.on('requestfailed', (q) => failed.push(`${q.failure()?.errorText} ${q.url().slice(0, 140)}`));
		pb.on('response', (res) => res.status() >= 400 && failed.push(`${res.status()} ${res.url().slice(0, 140)}`));
		pb.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
		pb.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
		const m = { mode };
		m.cold = await load(pb, `${BASE}/go?url=${encodeURIComponent(url)}${mode === 'live' ? '&live=1' : ''}`);
		await pb.screenshot({ path: `${OUT}${s}-${mode}.png` });
		m.finalUrl = pb.url();

		const httpReqs = reqs.filter((q) => /^https?:/.test(q.url()));
		const external = await Promise.all(
			httpReqs.filter((q) => !local(q.url())).map(async (q) => ({ url: q.url(), sw: !!(await q.response().catch(() => null))?.fromServiceWorker() })),
		);
		m.requests = {
			total: httpReqs.length,
			local: httpReqs.length - external.length,
			caughtBySW: external.filter((e) => e.sw).length,
			leaked: [...external.filter((e) => !e.sw).map((e) => e.url.slice(0, 160)), ...sockets.filter((u) => !local(u)).map((u) => `websocket ${u}`)],
			websockets: sockets.length,
		};
		m.failed = failed;
		m.consoleErrors = errors;

		// 3. Same profile, reload: service worker now active, everything served from the R2 cache.
		m.warm = await load(pb, pb.url());
		await ctxB.close();

		m.diffPct = diff(`${OUT}${s}-orig.png`, `${OUT}${s}-${mode}.png`, `${OUT}${s}-${mode}-diff.png`);
		console.log(
			`  [${mode}] diff ${m.diffPct}% · reqs ${m.requests.total} (local ${m.requests.local}, SW ${m.requests.caughtBySW}, leaked ${m.requests.leaked.length}) · failed ${failed.length} · errors ${errors.length} · load orig ${r.original.load}ms / cold ${m.cold.load}ms / warm ${m.warm.load}ms`,
		);
		r[mode] = m;
	}
	results.push(r);
}
await browser.close();

writeFileSync(`${OUT}report.json`, JSON.stringify(results, null, 2));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const list = (items) => (items.length ? `<details><summary>${items.length}</summary><pre>${esc(items.join('\n'))}</pre></details>` : '0');
const modeBlock = (r, mode) => {
	const m = r[mode];
	return `<tr><td><b>${mode}</b></td><td>diff <b>${m.diffPct}%</b> · ${m.requests.total} requests (${m.requests.local} via proxy, ${m.requests.caughtBySW} caught by SW, leaked ${list(m.requests.leaked)}) · failed ${list(m.failed)} · console errors ${list(m.consoleErrors)} · load cold ${m.cold.load} / warm ${m.warm.load} ms</td></tr>`;
};
writeFileSync(
	`${OUT}report.html`,
	`<!doctype html><meta charset="utf-8"><title>Previewer compare</title>
<style>body{font:13px system-ui;margin:16px;background:#111;color:#ddd}h2{margin:28px 0 6px;font-size:15px}table{border-collapse:collapse}td{padding:2px 10px 2px 0;vertical-align:top}
details{display:inline}.imgs{display:grid;grid-template-columns:repeat(${1 + MODES.length},1fr);gap:8px}.imgs img{width:100%;border:1px solid #333}pre{white-space:pre-wrap;font-size:11px;max-width:1200px}</style>
<h1>Original vs proxied (${new Date().toISOString().slice(0, 16)})</h1>
${results
	.map(
		(r) => `<h2>${esc(r.url)}</h2><table><tr><td>original</td><td>load ${r.original.load} ms</td></tr>${MODES.map((mode) => modeBlock(r, mode)).join('')}</table>
<div class="imgs"><figure><img src="${r.slug}-orig.png"><figcaption>original</figcaption></figure>${MODES.map((mode) => `<figure><img src="${r.slug}-${mode}.png"><figcaption>${mode} mode</figcaption></figure>`).join('')}</div>`,
	)
	.join('')}`,
);
console.log(`\nReport: ${OUT}report.html`);
