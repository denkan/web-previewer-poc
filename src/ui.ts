/** Shared by every view: colors, controls, and the extension drawer (#extButtons, #drawer) the shell host fills. */
export const BASE_CSS = /* css */ `
	:root { --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --text:#e6e8ee; --muted:#8b93a7; --accent:#7aa2ff; --ok:#5fd08a; --warn:#f0b35a; --bad:#f07178 }
	* { box-sizing: border-box }
	html, body { height: 100%; margin: 0 }
	body { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif }
	header { display: flex; gap: 6px; align-items: center; padding: 8px 10px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap }
	select { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px; font: 12px ui-monospace, monospace }
	input { flex: 1; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; font-family: ui-monospace, monospace }
	input:focus { outline: 2px solid var(--accent); outline-offset: -1px }
	button { background: #222734; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; cursor: pointer; white-space: nowrap }
	button:hover { border-color: var(--accent) }
	button.primary { background: var(--accent); color: #0b0d12; border-color: var(--accent); font-weight: 600 }
	button.on { border-color: var(--accent); background: #2a3350 }
	button:disabled { opacity: .45; cursor: default; border-color: var(--line) }
	#extButtons { display: contents }
	main { flex: 1; display: flex; min-height: 0 }
	#drawer { flex: none; width: 360px; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg) }
	#drawer[hidden] { display: none }
	#drawerTabs { display: flex; gap: 4px; padding: 6px; border-bottom: 1px solid var(--line) }
	#drawerTabs[hidden] { display: none }
	#drawerPanels { flex: 1; overflow: auto }
	#drawerPanels > [hidden] { display: none }
`;

/** Toolbar shell: URL bar + cache controls on top, the proxied page in an iframe, extension drawer on the right. */
export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Previewer</title>
<style>${BASE_CSS}
	#go { display: flex; flex: 1 1 360px; gap: 6px }
	#stats { padding: 5px 12px; font: 12px/1.5 ui-monospace, monospace; color: var(--muted); border-bottom: 1px solid var(--line); min-height: 27px }
	#stats b { color: var(--text); font-weight: 600 }
	#stats .HIT { color: var(--ok) } #stats .MISS { color: var(--warn) } #stats .bad { color: var(--bad) }
	#liveWrap { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; white-space: nowrap }
	#dict { max-height: 40vh; overflow: auto; border-bottom: 1px solid var(--line); background: var(--panel) }
	#dict table { width: 100%; border-collapse: collapse; font: 12px ui-monospace, monospace }
	#dict td, #dict th { padding: 4px 12px; text-align: left; border-top: 1px solid var(--line) }
	#dict th { color: var(--muted); font-weight: 500 }
	#dict button { padding: 2px 8px; font-size: 11px }
	iframe { flex: 1; min-width: 0; border: 0; background: #fff }
</style>
</head>
<body data-view="single">
<header>
	<form id="go"><input id="url" placeholder="https://example.com" spellcheck="false" autocomplete="off" autofocus>
		<label id="liveWrap" title="Live: a server-side cookie jar per session (logins work); documents aren't cached"><input type="checkbox" id="live"> live</label>
		<button class="primary">Open</button></form>
	<button id="reload" title="Reload; served from cache where possible">Reload</button>
	<button id="refetch" title="Purge this page and every asset it loaded, then reload">Refetch page</button>
	<button id="purgeAll" title="Purge every cached response">Purge all</button>
	<button id="toggleDict" title="Cached responses per origin">Cache</button>
	<span id="extButtons"></span>
	<button id="toMap" title="Two pages side by side: mark and draw on both, and note how they relate">⫽ Map</button>
	<button id="newTab" title="Open the proxied page in its own tab">↗</button>
	<button id="resetSession" title="Delete this live session's cookie jar and start a new one" hidden>Reset session</button>
</header>
<div id="stats">Enter a URL to preview it through the proxy.</div>
<div id="dict" hidden></div>
<main>
	<iframe id="frame" name="preview" data-pane="main" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"></iframe>
	<aside id="drawer" hidden><nav id="drawerTabs" hidden></nav><div id="drawerPanels"></div></aside>
</main>
<script src="/__px/shell.js"></script>
<script>
const $ = (id) => document.getElementById(id);
const frame = $('frame');
let state = null; // last px:state from the framed page
const post = (body) => fetch('/__px/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const ask = () => frame.contentWindow && frame.contentWindow.postMessage({ type: 'px:query' }, '*');

try { $('live').checked = localStorage.getItem('px-live') === '1' } catch {}
const syncLive = () => { $('resetSession').hidden = !$('live').checked };
$('live').onchange = () => { syncLive(); try { localStorage.setItem('px-live', $('live').checked ? '1' : '0') } catch {} if ($('url').value) load($('url').value) };
const session = () => fetch('/__px/session').then((r) => r.json()).catch(() => ({ active: false }));

// Not called open(): a top-level function declaration in a classic script replaces window.open.
function load(raw) {
	raw = raw.trim();
	if (!raw) return;
	if (!/^https?:[/][/]/i.test(raw)) raw = 'https://' + raw;
	$('url').value = raw;
	history.replaceState(null, '', '#' + raw);
	state = null;
	$('stats').textContent = 'Loading ' + raw + ' …';
	frame.src = '/go?url=' + encodeURIComponent(raw) + ($('live').checked ? '&live=1' : '');
}

// The framed page is on another host, so all page state arrives via postMessage from the runtime.
addEventListener('message', async (e) => {
	if (e.source !== frame.contentWindow || !e.data) return;
	if (e.data.type === 'px:loaded') { ask(); setTimeout(ask, 1500); setTimeout(ask, 5000) }
	if (e.data.type === 'px:ext' && e.data.ext === '*' && e.data.event === 'navigate') ask(); // SPA route change: refresh URL bar
	if (e.data.type !== 'px:state') return;
	state = e.data;
	const s = state.stats;
	if (state.url && document.activeElement !== $('url')) { $('url').value = state.url; history.replaceState(null, '', '#' + state.url) }
	const jar = state.live ? await session() : null;
	$('stats').innerHTML =
		(state.live ? 'live · jar <b>' + (jar && jar.active ? jar.cookies + ' cookies' : 'empty') + '</b>' : 'snapshot') + ' · page <b class="' + s.page + '">' + s.page + '</b> · load <b>' + s.loadMs + ' ms</b> · assets: <b class="HIT">' + s.hit +
		'</b> cached, <b class="MISS">' + s.miss + '</b> fetched' + (s.other ? ', <b>' + s.other + '</b> other' : '') + ', <b>' + s.sw +
		'</b> caught by SW, <b class="' + (s.leaked ? 'bad' : '') + '">' + s.leaked + '</b> leaked';
});
frame.onload = () => setTimeout(() => { if (!state) $('stats').textContent = 'No runtime in frame (not a proxied HTML page?)' }, 6000);

async function renderDict() {
	const rows = await fetch('/__px/origins').then((r) => r.json());
	const kb = (b) => (b / 1024).toFixed(0) + ' KB';
	$('dict').innerHTML = '<table><tr><th>origin</th><th>cached</th><th></th></tr>' +
		rows.map((r) => '<tr><td>' + r.origin + '</td><td>' + r.objects + ' · ' + kb(r.bytes) +
			'</td><td><button data-origin="' + r.origin + '">purge</button></td></tr>').join('') + '</table>';
}

$('go').onsubmit = (e) => { e.preventDefault(); load($('url').value) };
$('reload').onclick = () => frame.contentWindow.postMessage({ type: 'px:reload' }, '*');
$('refetch').onclick = async () => {
	if (!state) return;
	const { deleted } = await post({ urls: state.stats.assets });
	$('stats').textContent = 'Purged ' + deleted + ' entries, refetching …';
	frame.contentWindow.postMessage({ type: 'px:reload' }, '*');
};
$('purgeAll').onclick = async () => {
	if (!confirm('Purge every cached response?')) return;
	const { deleted } = await post({ all: true });
	$('stats').textContent = 'Purged ' + deleted + ' entries.';
	if (!$('dict').hidden) renderDict();
};
$('toggleDict').onclick = () => { $('dict').hidden = !$('dict').hidden; if (!$('dict').hidden) renderDict() };
$('dict').onclick = async (e) => { const o = e.target.dataset && e.target.dataset.origin; if (o) { await post({ origin: o }); renderDict() } };
$('newTab').onclick = () => state && window.open(state.href, '_blank');
$('toMap').onclick = () => { location.href = '/map' + ($('url').value ? '#a=' + encodeURIComponent($('url').value) : '') };
$('resetSession').onclick = async () => {
	await fetch('/__px/session/reset', { method: 'POST' });
	$('stats').textContent = 'Live session reset: cookie jar deleted.';
	frame.contentWindow && frame.contentWindow.postMessage({ type: 'px:reload' }, '*');
};
syncLive();
if (location.hash.length > 1) load(decodeURIComponent(location.hash.slice(1)));
</script>
</body>
</html>`;
