// Origin codec for the runtime + service worker; the server inlines this file at their @codec placeholder.
// Mirrors the encode half of src/origin.ts — scripts/test-codec.mjs checks they agree.
function pxHostLabel(hostname) {
	if (!hostname.includes('.')) return null;
	for (const l of hostname.split('.')) if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) return null;
	const label = hostname.replace(/-/g, '--').replace(/\./g, '-');
	return label.length <= 63 ? label : null;
}
function pxSubHost(origin, root, live) {
	const u = new URL(origin);
	if (u.port) return null;
	const label = pxHostLabel(u.hostname);
	if (!label) return null;
	return label + (u.protocol === 'http:' ? '.http' : '') + (live ? '.live' : '') + '.' + root;
}
