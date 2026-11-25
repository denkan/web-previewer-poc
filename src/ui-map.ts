import { BASE_CSS } from './ui';

/**
 * Map view: two proxied pages side by side (A and B), each rendered at a real viewport width and scaled to fit its
 * pane, with an SVG layer over both for lines between related marks. The "map" extension adds the tools and notes.
 * State lives in the URL: /map?board=name#a=<url>&b=<url>.
 */
export const MAP_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Previewer · Map</title>
<style>${BASE_CSS}
	header .title { font-weight: 700; margin-right: 6px }
	header .muted { color: var(--muted); font-size: 12px; white-space: nowrap }
	header label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; white-space: nowrap }
	header label input[type=checkbox] { flex: none }
	header .spacer { flex: 1 }
	header a { color: var(--muted); font-size: 12px; text-decoration: none } header a:hover { color: var(--text) }
	#panes { position: relative; flex: 1; min-width: 0; display: flex; gap: 10px; padding: 10px; background: #0a0c10 }
	.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px }
	.bar { display: flex; gap: 6px; align-items: center }
	.tag { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; background: var(--accent); color: #0b0d12; font-weight: 800 }
	.pane[data-pane=b] .tag { background: #ffb020 }
	.vp { position: relative; flex: 1; min-height: 0; overflow: hidden; border-radius: 6px; background: #fff; box-shadow: 0 0 0 1px var(--line) }
	.vp iframe { position: absolute; left: 0; top: 0; border: 0; background: #fff; transform-origin: 0 0 }
	.empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8b93a7; font-size: 13px; background: #f4f5f7; text-align: center; padding: 20px }
	#links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 2 }
</style>
</head>
<body data-view="map">
<header>
	<span class="title">Map</span>
	<span class="muted">board <b id="boardName"></b></span>
	<span id="extButtons"></span>
	<span class="spacer"></span>
	<label title="Width each page is rendered at, then scaled to fit its pane">viewport
		<select id="vw"><option value="1440">1440</option><option value="1280" selected>1280</option><option value="1024">1024</option><option value="768">768</option><option value="390">390</option><option value="0">fit pane</option></select></label>
	<label title="Live: server-side cookie jar (logins work)"><input type="checkbox" id="live"> live</label>
	<a href="/" id="toSingle">single view</a>
</header>
<main>
	<section id="panes">
		<div class="pane" data-pane="a">
			<form class="bar"><span class="tag">A</span><input class="url" placeholder="https://current-site.com/page" spellcheck="false" autocomplete="off"><button>Open</button></form>
			<div class="vp"><div class="empty">Open the page content comes from</div><iframe data-pane="a" name="pane-a" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"></iframe></div>
		</div>
		<div class="pane" data-pane="b">
			<form class="bar"><span class="tag">B</span><input class="url" placeholder="https://new-site.com/page" spellcheck="false" autocomplete="off"><button>Open</button></form>
			<div class="vp"><div class="empty">Open the page it goes to</div><iframe data-pane="b" name="pane-b" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"></iframe></div>
		</div>
		<svg id="links"></svg>
	</section>
	<aside id="drawer" hidden><nav id="drawerTabs" hidden></nav><div id="drawerPanels"></div></aside>
</main>
<script>
// Before shell.js: the board name is read by the map extension when it starts.
document.body.dataset.board = (new URLSearchParams(location.search).get('board') || 'default').replace(/[^A-Za-z0-9._~-]/g, '-').slice(0, 100);
</script>
<script src="/__px/shell.js"></script>
<script>
const $ = (s, el = document) => el.querySelector(s);
$('#boardName').textContent = document.body.dataset.board;
const pane = (id) => $('.pane[data-pane="' + id + '"]');
const frameOf = (id) => $('iframe', pane(id));
const hashState = () => new URLSearchParams(location.hash.slice(1));
function remember(id, url) {
	const h = hashState();
	h.set(id, url);
	history.replaceState(null, '', '#' + h.toString());
}

try { $('#live').checked = localStorage.getItem('px-live') === '1'; $('#vw').value = localStorage.getItem('px-map-vw') || '1280' } catch {}
function load(id, raw) {
	raw = String(raw || '').trim();
	if (!raw) return;
	if (!/^https?:[/][/]/i.test(raw)) raw = 'https://' + raw;
	$('.url', pane(id)).value = raw;
	$('.empty', pane(id)).hidden = true;
	remember(id, raw);
	frameOf(id).src = '/go?url=' + encodeURIComponent(raw) + ($('#live').checked ? '&live=1' : '');
}
for (const id of ['a', 'b']) $('form', pane(id)).onsubmit = (e) => { e.preventDefault(); load(id, $('.url', pane(id)).value) };
$('#live').onchange = () => { try { localStorage.setItem('px-live', $('#live').checked ? '1' : '0') } catch {} for (const id of ['a', 'b']) load(id, $('.url', pane(id)).value) };
// Extensions open pages in panes through this (it works before a pane has loaded anything).
addEventListener('px:navigate', (e) => { e.preventDefault(); load(e.detail.pane, e.detail.url) });
// Follow navigation inside the panes (links, SPA routes) in the URL bars and the address bar.
addEventListener('message', (e) => {
	const d = e.data;
	if (!d || d.type !== 'px:ext' || d.ext !== '*' || (d.event !== 'hello' && d.event !== 'navigate') || !d.data) return;
	const id = ['a', 'b'].find((p) => frameOf(p).contentWindow === e.source);
	if (!id || !d.data.url) return;
	if (document.activeElement !== $('.url', pane(id))) $('.url', pane(id)).value = d.data.url;
	remember(id, d.data.url);
});
$('#toSingle').onclick = (e) => { const a = hashState().get('a'); if (a) $('#toSingle').href = '/#' + a };

// Render each page at a real viewport width and scale it down to its pane: desktop layouts side by side.
function fit() {
	const want = Number($('#vw').value);
	for (const id of ['a', 'b']) {
		const vp = $('.vp', pane(id));
		const f = frameOf(id);
		const w = vp.clientWidth;
		const h = vp.clientHeight;
		const width = want || w;
		const scale = Math.min(1, w / width);
		f.style.width = width + 'px';
		f.style.height = Math.round(h / scale) + 'px';
		f.style.transform = 'scale(' + scale + ')';
	}
	dispatchEvent(new Event('px:geometry'));
}
$('#vw').onchange = () => { try { localStorage.setItem('px-map-vw', $('#vw').value) } catch {} fit() };
new ResizeObserver(fit).observe($('#panes'));
fit();
const start = hashState();
for (const id of ['a', 'b']) load(id, start.get(id));
</script>
</body>
</html>`;
