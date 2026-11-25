/**
 * Extensions: scripts layered on top of the proxied page. Each one has up to two halves, both plain JS files that call
 * `pxExtension(name, (px) => { ... })`:
 *  - page.client.js  runs inside the proxied page (only when it's framed by the toolbar): DOM access, overlay, input
 *  - shell.client.js runs in the toolbar of a view (px.view: 'single' or 'map'): buttons, a drawer panel, storage via
 *                    px.store (no server code needed)
 * The halves talk over px.send / px.on. Adding one = a folder + a line below; removing one = the reverse.
 * See src/client/ext-page.client.js and ext-shell.client.js for the full `px` API on each side.
 */
import commentsPage from './comments/page.client.js';
import commentsShell from './comments/shell.client.js';
import mapPage from './map/page.client.js';
import mapShell from './map/shell.client.js';

export interface Extension {
	name: string;
	page?: string;
	shell?: string;
}

export const EXTENSIONS: Extension[] = [
	{ name: 'comments', page: commentsPage, shell: commentsShell }, // single view: comment on one page
	{ name: 'map', page: mapPage, shell: mapShell }, // map view (/map): relate marks and drawings across two pages
];

export const extensionNames = new Set(EXTENSIONS.map((e) => e.name));

/** host code first (defines pxExtension), then each extension in its own block, then the host's start(). */
export function bundle(host: string, half: 'page' | 'shell'): string {
	const parts = EXTENSIONS.filter((e) => e[half]).map((e) => `// --- extension: ${e.name} ---\n{\n${e[half]}\n}`);
	return `(() => {\n${host}\n${parts.join('\n')}\npxStart();\n})();\n`;
}
