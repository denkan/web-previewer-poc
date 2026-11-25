/**
 * Readable origin encodings, one DNS label per origin (Google Translate proxy style: "." -> "-", "-" -> "--"):
 *
 *   https://www.bbc.com     -> www-bbc-com.{root}
 *   http://allthingsd.com   -> allthingsd-com.http.{root}
 *   live (cookie jar) mode  -> www-bbc-com.live.{root}
 *   not one valid DNS label -> {hash}.{root}  (ports, single-label hosts, >63 chars: dictionary fallback)
 *
 * The encode half is mirrored in src/client/codec.client.js for the runtime + service worker;
 * scripts/test-codec.mjs checks the two agree. Keep this file free of non-erasable TS so Node can import it.
 */

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** "www.my-site.com" -> "www-my--site-com"; null when the result can't be a single DNS label (so the reverse is exact). */
export function hostLabel(hostname: string): string | null {
	if (!hostname.includes('.')) return null;
	if (!hostname.split('.').every((l) => DNS_LABEL.test(l))) return null;
	const label = hostname.replace(/-/g, '--').replace(/\./g, '-');
	return label.length <= 63 ? label : null;
}

/** Inverse of hostLabel. Labels without a hyphen are dictionary hashes, not hosts. */
export function labelHost(label: string): string | null {
	if (!label.includes('-')) return null;
	return label.replace(/--|-/g, (m) => (m === '--' ? '-' : '.'));
}

/** Subdomain-mode host for an origin, or null if it needs the dictionary fallback. */
export function subHost(origin: string, root: string, live: boolean): string | null {
	const u = new URL(origin);
	if (u.port) return null;
	const label = hostLabel(u.hostname);
	if (!label) return null;
	return `${label}${u.protocol === 'http:' ? '.http' : ''}${live ? '.live' : ''}.${root}`;
}

export interface SubHost {
	label: string;
	http: boolean;
	live: boolean;
}

/** "www-bbc-com.http.live.localhost:8787" -> { label, http, live }; null if not one of ours. */
export function parseSubHost(host: string, root: string): SubHost | null {
	if (!host.endsWith(`.${root}`)) return null;
	const parts = host.slice(0, -(root.length + 1)).split('.');
	const label = parts.shift() ?? '';
	let http = false;
	let live = false;
	if (parts[0] === 'http') {
		http = true;
		parts.shift();
	}
	if (parts[0] === 'live') {
		live = true;
		parts.shift();
	}
	if (parts.length || !/^[a-z0-9-]{1,63}$/.test(label)) return null;
	return { label, http, live };
}
