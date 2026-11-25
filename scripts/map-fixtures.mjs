// Two local "sites" for the map view: an old page (A) and its redesign (B). Used by test-map.mjs.
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 sans-serif;margin:0;padding:32px}h1{margin:0 0 16px}.hero{padding:24px;background:#fde68a;border-radius:8px}
#card{width:50%;height:180px;margin:24px 0;padding:16px;background:#dbeafe;border-radius:12px}.grid{display:flex;gap:12px}.grid div{flex:1;padding:12px;background:#f1f5f9}.grid div:hover{background:#ff0000}</style>
</head><body>${body}<script>window.clicks=0;window.downs=0;window.moves=0;document.addEventListener('mousedown',()=>window.downs++);document.addEventListener('pointermove',()=>window.moves++)</script></body></html>`;

export const OLD = page(
	'Old Acme',
	`<h1 id="title">Old Acme</h1>
<div class="hero"><p class="hero-copy">Fast, friendly widgets for every workshop.</p><a id="cta" href="https://example.com/buy">Buy now</a></div>
<ul id="features"><li>Durable steel</li><li>Lifetime warranty</li><li>Free shipping</li></ul>
<button id="counter" onclick="window.clicks++">Count</button>
<div style="height:1600px"></div><p id="far">Footer note far below</p>`,
);
export const NEW = page(
	'New Acme',
	`<h1>New Acme</h1>
<section id="card"><h2>Card component</h2><p>Room for the hero message.</p></section>
<p class="lead">Widgets that just work, shipped free.</p>
<div class="grid"><div>Steel</div><div>Warranty</div><div>Shipping</div></div>
<p id="other"><a href="/other">Another page</a></p>`,
);
export const OTHER = page('New Acme / other', `<h1>Other page</h1><p>Nothing mapped here.</p>`);

export function serve(port) {
	const handler = (req, res) => {
		const host = req.headers.host || '';
		const html = req.url.startsWith('/other') ? OTHER : host.startsWith('old.') ? OLD : NEW;
		res.writeHead(200, { 'content-type': 'text/html' }).end(html);
	};
	return ['127.0.0.1', '::1'].map((h) => http.createServer(handler).listen(port, h));
}
