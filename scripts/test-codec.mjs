// Parity + round-trip test for the origin codec: src/origin.ts (server) vs src/client/codec.client.js (runtime/SW).
// Usage: node scripts/test-codec.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hostLabel, labelHost, parseSubHost, subHost } from '../src/origin.ts';

const client = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('../src/client/codec.client.js', import.meta.url), 'utf8'), client);

const ROOT = 'localhost:8787';
const origins = [
	'https://www.bbc.com',
	'https://my-site.co.uk',
	'https://a--b.example.com',
	'https://xn--bcher-kva.example', // punycode: "--" inside a label
	'http://allthingsd.com',
	'https://1.2.3.4',
	'https://static.files.bbci.co.uk',
	'http://localhost:3000', // port + single label -> fallback
	'https://example.com:8443', // port -> fallback
	'https://intranet', // single label -> fallback
	'https://under_score.example.com', // not a DNS label -> fallback
	`https://${'a'.repeat(40)}.${'b'.repeat(30)}.com`, // > 63 chars -> fallback
];

let n = 0;
for (const o of origins) {
	for (const live of [false, true]) {
		assert.equal(client.pxSubHost(o, ROOT, live), subHost(o, ROOT, live), `subHost parity: ${o} live=${live}`);
		n++;
	}
	assert.equal(client.pxHostLabel(new URL(o).hostname), hostLabel(new URL(o).hostname), `hostLabel parity: ${o}`);

	// Round trips back to the exact origin.
	const sh = subHost(o, ROOT, true);
	if (sh) {
		const p = parseSubHost(sh, ROOT);
		assert.ok(p && p.live, `parse ${sh}`);
		assert.equal(`${p.http ? 'http' : 'https'}://${labelHost(p.label)}`, o, `subdomain round trip: ${o} via ${sh}`);
	}
	n += 2;
}

// Fixed expectations, so a change to the encoding itself is noticed (parity alone would pass if both drifted together).
assert.equal(subHost('https://www.my-site.com', ROOT, false), 'www-my--site-com.localhost:8787');
assert.equal(subHost('http://allthingsd.com', ROOT, true), 'allthingsd-com.http.live.localhost:8787');
assert.equal(parseSubHost('a-b.evil.localhost:8787', ROOT), null, 'unknown level rejected');
console.log(`codec: ${n + 3} checks passed`);
