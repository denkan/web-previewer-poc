# web-previewer-poc

Throwaway PoC: render any URL through a local rewriting proxy, so the page looks like it does in a browser but every byte is served (and cached) by us. On top of it sits an extension layer for interacting with pages. Two example extensions use it: **comments** (click or select anything on a page, review in a drawer) and the **map view** (two pages side by side; mark and draw on both, and write how they relate).

Runs as a Cloudflare Worker with R2 (cache) and two Durable Object classes (live-mode cookie jars, extension storage). Locally `wrangler dev` simulates all of it, so you need no account.

```bash
npm install
npm run dev             # then open http://px.localhost:8787
npm run check           # typecheck + origin codec parity test
npm run test:features   # 32 browser checks: WebSockets, navigations, SSE, redirects, caching, cookie jar, toolbar (mutation-checked)
npm run test:comments   # 33 browser checks of the comments extension against a local fixture page (mutation-checked)
npm run test:map        # 28 browser checks of the map view against two local fixture sites (mutation-checked)
npm run compare         # original vs proxied screenshots + leak count, snapshot and live; writes out/report.html
```

Open **http://px.localhost:8787**. `*.localhost` resolves to loopback in Chrome, and `px.localhost` is a registrable domain, so the toolbar and every proxy host are one site, as they would be under `preview.example.com` in production. Type a URL and tick **live** if you need cookies (logins). The status line reads the page's own Resource Timing to show cache hits, fetches, what the service worker caught and what leaked. "Cache" lists cached bytes per origin.

## Addressing

One flattened, readable DNS label per origin, so a single wildcard certificate covers every site:

| original | snapshot (default) | live |
|---|---|---|
| `https://www.bbc.com/news` | `www-bbc-com.px.localhost:8787/news` | `www-bbc-com.live.px.localhost:8787/news` |
| `https://my-site.co.uk/` | `my--site-co-uk.px.localhost:8787/` | `my--site-co-uk.live.px.localhost:8787/` |
| `http://allthingsd.com/` | `allthingsd-com.http.px.localhost:8787/` | `allthingsd-com.http.live.px.localhost:8787/` |
| `http://localhost:3000/` | `{hash}.px.localhost:8787/` | `{hash}.live.px.localhost:8787/` |

- **Encoding**: `.` becomes `-` and `-` becomes `--` (Google Translate's site proxy does the same). `location.pathname` is byte-identical to the site's.
- **Dictionary fallback**: an origin that can't be one valid label (a port, a single-label host, more than 63 chars) gets a hash label backed by the R2 dictionary. Hashes never contain `-` and every readable label does, so the two can't collide.
- **Codec parity**: the encode logic exists in `src/origin.ts` and `src/client/codec.client.js` (inlined into the runtime and SW). `npm run check` asserts they agree and round-trip exactly.
- **Path mode (`/proxy/https/host/…`) was removed.** Measured on real sites, it breaks every client-side router that reads `location.pathname` (BBC 53.7% pixel diff, react.dev hydration error, MDN loading `proxy.ftl`). It doubled every code path, and the cookie jar can't work there because every site would share one origin. A workers.dev demo isn't a reason to keep it: subdomain mode needs a real zone anyway, and a custom domain on the free plan does the job.

## Snapshot vs live

| | snapshot (default) | live |
|---|---|---|
| cookies upstream | none | from the session's server-side jar |
| upstream `Set-Cookie` | dropped | absorbed into the jar, never sent to the browser |
| browser holds | nothing of the site's (JS-set cookies stay host-only on the proxy host) | only `__px_sid` |
| cache | everything shared in R2 (even responses that set cookies: they were made without any, and the `Set-Cookie` is dropped) | static assets only (by `Sec-Fetch-Dest`); nothing produced with jar cookies or that sets one |
| use for | commenting on public pages | logged-in previews |

### Server-side cookie jar (`src/jar.ts`)

- **One Durable Object per preview session.** The decrypted jar lives in the DO's memory while the session is active. Storage holds only the ciphertext.
- **Session cookie**: `__px_sid=<sessionId>.<256-bit key>; Domain=px.localhost; HttpOnly; Secure; SameSite=Lax`. It's set by `/go?live=1` (or by the first live request without one).
  - Verified in Chrome: `Domain=localhost` is rejected, but `Domain=px.localhost` is accepted (Secure included, on http) and reaches every `*.px.localhost` host, including inside the toolbar iframe.
  - In production it would be `Domain=preview.example.com`.
- **Encryption with a user-held key**: AES-GCM via WebCrypto. The key is HKDF-derived from the 256-bit secret in the user's HttpOnly cookie, salted with an optional server master key (the `JAR_MASTER_KEY` Worker secret; `.dev.vars` locally). Decrypting needs both. The ciphertext is bound to the DO id via AAD, so it can't be swapped into another session. A request with the wrong key fails GCM authentication and never gets the in-memory plaintext.
- **TTL**: a sliding idle expiry (`JAR_IDLE_TTL_SECONDS`, 24 h by default) pushes the alarm forward on every access. When the alarm fires it calls `deleteAll()`. Each cookie also honours its own `Expires`/`Max-Age`.
- **Cookie rules**: [tough-cookie](https://github.com/salesforce/tough-cookie) 6 runs unmodified on Workers; it only depends on `tldts`, and no `nodejs_compat` is needed. It handles:
  - Domain and Path matching,
  - `Secure`,
  - `__Host-` / `__Secure-` prefixes,
  - the Public Suffix List, including its private section,
  - SameSite contexts,
  - `Expires` / `Max-Age`.

  On top of it, the jar adds Chrome's behaviour where it differs:
  - `SameSite=Lax` when the attribute is missing (tough-cookie's default is None);
  - 4096-byte cookies, at most 180 per domain and 3000 in total;
  - the RFC 6265 §5.3 rule that a public-suffix `Domain` equal to the request host makes the cookie host-only (tough-cookie rejects those instead).
- **SameSite enforced by the server**: every proxy host is same-site to the browser, so the browser can't enforce it. The server compares the requesting page's original site (from the unproxied `Origin`/`Referer`) with the target's. Same site gives a strict context, a cross-site top-level GET navigation gives lax, and everything else gives none. So a page in the preview can't make credentialed cross-site requests that carry another site's Lax/Strict cookies.
- **`document.cookie`**:
  - Non-HttpOnly jar cookies for the page are shipped in the bootstrap config. Live documents are never cached, so that's safe.
  - The runtime serves reads from a local copy, so they stay synchronous. Writes update the copy and are beaconed to `/__px/cookie`.
  - That endpoint only accepts same-origin requests and only writes for *its own host's* origin, taking just the path from the body. So site A can't set site B's cookies.
  - HttpOnly cookies stay server-only.
- **WebSocket handshakes** carry jar cookies too.
- **Never logged**: no cookie values in logs, error messages, debug headers or cache keys. Error handlers log only messages, and anything tough-cookie throws (which can echo the cookie) is dropped.
- **Toolbar**: shows the jar's cookie count (never names or values) and has **Reset session** (`POST /__px/session/reset`: `deleteAll()` + expire `__px_sid`).

**Goal met.** A `Domain=.bbc.com` login cookie set on `www-bbc-com.live…` is attached to `account-bbc-com.live…`, because the jar matches against the *original* hosts. The flattened hosts only need one wildcard certificate.

## How it works

```
/go?url=https://site.com/a[&live=1]     307 to the proxied URL (creates the live session if needed)
{label}[.http][.live].{root}/...         proxy: R2 cache, or fetch upstream + rewrite (+ jar in live mode)
{proxy host}/__px/runtime.js | sw.js     client runtime (injected first in every page) + catch-all service worker
{proxy host}/__px/register               POST origin -> hash (dictionary fallback only)
{live host}/__px/cookie                  POST document.cookie write (same-origin only)
{root}/__px/session                      GET jar info (count, ttl) / POST {ttlSeconds}
{root}/__px/session/reset                POST: delete the jar, expire __px_sid
{root}/__px/origins | purge              cache stats per origin / purge {all} | {origin} | {urls}
{proxy host}/__px/ext.js                 extensions' page halves (loaded by the runtime when framed by the toolbar)
{root}/__px/shell.js                     extensions' toolbar halves
{root}/map?board=name#a=<url>&b=<url>   map view: two panes + notes
{root}/__px/ext/{ext}/items[/{id}]       extension storage: GET ?scope=&page= | POST | PATCH | DELETE
                                         scope = an original origin (comments) or "board:{name}" (map notes)
```

### Layers (each one catches what the previous one can't see)

1. **HTML rewrite** (`src/rewrite.ts`, streaming `HTMLRewriter`): every URL attribute, `srcset`, `<base>`, `<meta refresh>`, inline `<style>`, `style=""` and import maps. It strips CSP/referrer `<meta>`, SRI `integrity`, preconnects and speculation rules.
2. **CSS rewrite**: `url(...)` and `@import`, resolved against the stylesheet's own URL.
3. **Response headers**: an allowlist, so CSP, X-Frame-Options, HSTS, COOP/COEP, Link and Set-Cookie all drop. `Location` is rewritten.
4. **Client runtime** (`src/client/runtime.client.js`) patches:
   - `fetch`, XHR, `sendBeacon`, `Worker`, `WebSocket` and `window.open`;
   - URL property setters, `setAttribute` and `document.cookie`.

   It also rewrites clicks on absolute links, catches `location.href = …` and `location.replace` through the Navigation API (Chromium), repairs our own port-less hosts and blocks the site's own service worker.
5. **Service worker**: sees every subresource request (dynamic `import()`, `innerHTML` images, CSS-in-JS, workers). It never sees WebSockets.
6. **Origin literals in JS** (`src/rewrite.ts`): `"https://cdn.site.com"` becomes `"http://cdn-site-com.px.localhost:8787"` in JS files and inline scripts. That's the proxied page's real `location.origin`, so origin checks keep working. It was needed for:
   - Turbopack's asset prefix vs `document.currentScript.src`: BBC never hydrates without it;
   - `postMessage` origin checks: BBC's consent dialog.

   Left alone on purpose:
   - JSON responses, because they can be signed;
   - URLs in HTML-attribute position inside JS strings, because Lit SSR template digests break.
7. **Query-string un-proxying**: proxy URLs that page code sends upstream (consent, analytics) are swapped back to the originals, including ones embedded in JSON.

URL rewriting keeps each string's shape: absolute stays absolute, protocol-relative stays protocol-relative, and same-origin relative URLs aren't touched. Bundler runtimes find chunks with `script[src="<absolute url>"]`.

### Protocols, redirects, cache

- **WebSockets**: `wss://site.com/x` goes to `ws://site-com.px.localhost:8787/x`. The Worker returns the upstream `fetch()`'s 101 response, rewrites the handshake's `Origin` to the original, and attaches jar cookies in live mode.
- **Server-sent events** stream through and are never cached.
- **WebRTC and WebTransport** can't go through a Worker.
- **Redirects**: `Location` is rewritten and passed to the browser. Only 301/308 are cached.
- **Cache**: R2 at `c/{hash(origin)}/{sha256(mode + path + query)}`, storing rewritten bytes. Browsers get `no-store`, so purges are instant.

## Extensions: comments as the example

In the toolbar, **✚ Comment** puts the page in pick mode: click any element, or drag to select text, then write the comment in the drawer on the right. Pins are numbered per page. Clicking a pin opens its comment; clicking a comment scrolls to its pin and flashes it. The drawer filters Open / Resolved / All and lists **This page** or the **Whole site**; a comment on another page opens that page and selects it there. Esc cancels pick mode.

```
src/extensions/index.ts                   registry: one line per extension
src/extensions/comments/page.client.js    runs inside the proxied page: pins, highlights
src/extensions/comments/shell.client.js   runs in the toolbar: buttons, drawer, storage
src/extensions/map/…                      the map view's tools and notes (next section)
src/client/ext-page.client.js             page-side host: messaging, overlays, input, and the shared tools:
                                            px.anchors (find things again), px.pick (element / text), px.draw (freehand)
src/client/ext-shell.client.js            toolbar-side host: px.view, px.panes, send/on per pane, button, panel,
                                            px.store(scope), navigate, prefs
src/extstore.ts                           ExtStoreDO: one generic item store per (extension, scope)
```

Removing an extension means deleting its folder, its line in the registry and its test script. A new one is the same shape: a page half and/or a toolbar half calling `pxExtension(name, (px) => …)`. It needs no server code: `px.store(scope)` gives it list/create/update/delete. Picking, anchoring and drawing live in the host, so comments is now about 200 lines of pins and messages. Each extension checks `px.view` and stays out of views it isn't for.

**How the layer stays out of the page's way:**
- **Loaded only next to the toolbar.** The runtime loads `/__px/ext.js` after parsing, and only when the page is framed directly by the toolbar: not in a new tab, not in the page's own iframes, not in `npm run compare`.
- **Input before the page.** The runtime registers window-capture listeners for pointer, mouse and key events before any page script runs, so an extension's hook always fires first. In pick mode, presses never reach the page (no click handlers, no navigation, no form submits), but the browser's default action still runs, so native text selection works and CSS `:hover` menus still open.
- **No DOM edits.** Highlights use the CSS Custom Highlight API. Pins and outlines live in a shadow root under one `<px-overlay>` element, appended to `<html>` after `load`, so hydrating frameworks never see a changed `<body>`. A test asserts the body's HTML is byte-identical after pins, a highlight and an outline are drawn.
- **Messages with explicit targets.** The page half posts only to the toolbar's origin; the toolbar posts only to the proxy host that last said hello. Comment text never enters the page: it gets `{id, number, anchor}` only.
- **SPA navigations** (`history.pushState`/`replaceState`, `popstate`, the Navigation API) are reported by the runtime, so pins, the drawer and the URL bar follow route changes.

**Anchors.** A comment must find its target again on the next load, after re-renders, late content and redesigns. Each anchor carries several independent ways back, tried in order:

| kind | tried in order | drawer shows |
|---|---|---|
| text | the quote with 32 chars of prefix/suffix (picks the right one of several matches), then the same quote ignoring whitespace | nothing (found) |
| text, quote gone | the element it was in, as below | ≈ changed |
| element | CSS path (stable ids, else `nth-of-type`) verified by tag + text | nothing (found) |
| element, moved | same tag with the same text elsewhere, nearest to where it was | nothing (found) |
| element, edited | the CSS path if its text is still similar (Dice ≥ 0.5 over character pairs) | ≈ changed |
| anything else | no pin | ⚠ not found |

Anchors are re-resolved when the DOM changes, so a target that renders after load gets its pin when it appears.

**Storage.** One `ExtStoreDO` (SQLite) per extension and original origin. Comments are keyed by the original page URL without the fragment, so snapshot and live mode share them. The endpoints accept same-origin requests only (the toolbar). Proxied pages are other origins and get no CORS headers, and a test checks that a page can't write.

**What building it turned up:**
- **"Same place, content changed" pinned comments to the wrong element.** Once Gamma was removed, its old `nth-of-type` path pointed at its shifted sibling, and the comment silently moved there. That fallback now also requires similar text, and a test covers both directions: a removed element shows "⚠ not found", a reworded heading keeps its pin with "≈ changed".
- **Re-rendering the drawer dropped focus while typing** (status updates arrive mid-draft). The drawer now renders into a fixed skeleton and only swaps the composer when the draft changes.
- **Real sites break naive picking.** On BBC the "News" heading is an SVG, so a click anchored to one `<path>`; SVG parts now anchor to the outermost `<svg>`. Headlines sit inside card links, where a drag starts a link drag instead of a selection; pick mode now cancels link drags and forces text to be selectable, including where a site sets `user-select: none`.
- **The toolbar's URL-bar CSS leaked into the composer.** An unscoped `form { display: flex }` laid the comment form out as one squeezed row. The rule is now scoped to the URL bar, the composer sets its own layout, and a check measures it (textarea full width, between the quote and the name row).
- **On BBC and react.dev** (both hydrating React apps), an element comment and a text comment survive a reload with their pins and highlight, with no new console errors.

`npm run test:comments` has 33 checks. Each one was mutation-checked: 31 mutations each broke one feature and turned its check red, usually alone. A 31st, removing a CSS rule meant to make link text selectable, turned nothing red; the rule turned out to be redundant and was deleted. Four checks were weak at first, and the mutations exposed them:
- **"Page DOM untouched"** took its snapshot after the overlay already existed, so moving the overlay into `<body>` changed nothing. It now snapshots before any extension UI exists.
- **"Esc in the page"** pressed Escape on a heading that can't take focus, so the key reached the toolbar's own Esc handler instead.
- **"Opens the other page with it selected"** passed through the mouse still hovering the drawer item. It now checks for the flash, which only focusing a comment produces.
- **Half the suite crashed instead of reporting.** One broken step aborted everything after it. Each check now runs on its own and reports red with the error.

A test race also looked like a bug: Escape sent right after clicking "✚ Comment" arrived before the page had entered pick mode. The tests now wait for the page's pick-mode hint. I found no such race for a person to hit.

## Map view: relating two pages

For migrating content into a new shape: put the current page in **A** and the redesign in **B**, mark something in A and something in B, and write how they relate, or what to do.

Open **http://px.localhost:8787/map** (or **⫽ Map** in the toolbar, which carries over the current page as A).
- **▢ Mark** picks elements or text, as comments does. **✎ Draw** draws freehand; strokes made in one go join one drawing. Both tools work in either pane and stay on until Esc. Every mark joins the draft note, from either pane, and shows as a chip that can be removed.
- **Saved notes** get a number and a colour. Their marks are drawn in that colour in both panes: outlines, text highlights, strokes and a numbered badge. **Lines across the panes** connect each A mark to each B mark, follow scrolling, and turn dashed and stick to the pane edge when a mark is scrolled out of view.
- **Clicking a badge** selects its note. **Clicking a note** flashes its marks; if they're on other pages, both panes open those pages first. The drawer shows notes **On screen** or the **Whole board**, filtered by Open / Resolved / All.
- **Pages render at a real viewport width** (1440 / 1280 / 1024 / 768 / 390, or the pane width) and are scaled to fit, so desktop layouts sit side by side. Badges, outlines and strokes counter-scale to keep a readable size.
- **Boards** keep separate sets of notes: `/map?board=pricing-migration`. Everything is in the URL (`#a=…&b=…`), so a link reopens the same pair.

**How drawings stay put.** A stroke is anchored to the smallest element that contains all of it (found with the same anchors as comments), and its points are stored as fractions of that element's box. It follows the element when the page reflows and scales with it: a test switches the viewport from 1280 to 1024 and checks a circle around a half-width card still sits at the same fractions (2.2%–97.8%). A stroke across the whole page anchors to the document instead.

**What building it turned up:**
- **Switching Mark → Draw switched everything off.** Starting a tool ends the previous one, whose "ended" message told the toolbar to stop all tools. Tools now report why they ended, and a switch isn't an end.
- **A page scaled to 43% shrank our badges and strokes with it.** The toolbar now tells each page its scale, and overlay sizes multiply by its inverse. A test measures a badge at 24px on screen at that scale.
- **The drawing canvas was never on screen.** It was an `<svg>`, and SVG elements have no `hidden` property, so `canvas.hidden = false` set a plain JS property while the `hidden` attribute stayed. Drawing still worked through the input hook, so nothing looked broken, but the page kept reacting to the pointer: CSS `:hover` styles and its own `pointermove` listeners (58 of them during one test drawing). The canvas is now a `<div>`, the runtime hooks movement events too, and draw mode swallows them. Two checks cover it: no presses or moves reach the page's listeners, and a `:hover`-styled element doesn't react. A mutation run exposed it: hiding the canvas turned only a check that read that same JS property red.
- **A cached fixture made a check pass on `undefined === undefined`.** The proxy had cached the fixture page from before it counted pointer moves. The test now purges its fixture sites first and requires real numbers.
- **Picking and anchoring moved from comments into the host,** so the map could share them. Comments' 33 checks still pass (only the test's overlay selectors changed), and its 30 mutations were re-run against the code's new location: 29 turn their check red. The 30th removes only one of the composer's two independent layout protections, so nothing should turn red; removing both does.

`npm run test:map` has 28 checks against two local fixture sites. Each was mutation-checked: 30 mutations each broke one feature and turned its check red. On real sites, a note mapping Hacker News's first story row (A) to Lobsters' (B: its title plus a circle drawn around the row) survives a reload with all three marks and both lines, with no toolbar errors.

## Findings

`npm run compare`: headless Chromium at 1280×900, each site loaded directly and through the proxy (cold, then warm). It diffs the viewport screenshots and counts requests and WebSockets that escaped the proxy.

| site | snapshot | live | notes |
|---|---|---|---|
| example.com | 0% | 0% | |
| en.wikipedia.org | 0% | 0% | |
| news.ycombinator.com | 1.2% | 0% | votes and story order changed between loads |
| developer.mozilla.org | 6.2% | 0.7% | rotating ad slots only (checked in the diff images) |
| react.dev | 0% | 0% | |
| tailwindcss.com | 0.8% | 0.8% | animation frames |
| github.com (repo page) | 0.07% | 0.08% | |
| bbc.com/news | 0% | 0% | fully hydrated, consent dialog included |
| stripe.com | 0.08% | 0.09% | animations |
| apple.com | 13.1% | **0%** | snapshot has no cookies, so no geo banner. Live: Apple's `geo` cookie goes into the jar and back to the page through `document.cookie`, so the banner renders |

- **0 leaked requests or WebSockets** on every site, in both modes.
- **Warm reloads**: snapshot 15–360 ms; live 100 ms – 1 s, since documents aren't cached.
- **Remaining console errors**: only Apple's analytics beacons (2), which pick their endpoint from `location.hostname`.

`npm run test:features` covers 32 checks. Every new check was mutation-checked, by breaking the feature and watching exactly its check turn red:
- Domain sharing,
- public-suffix storage,
- the RFC host-only fallback,
- TTL expiry,
- ciphertext at rest,
- `document.cookie` read and write,
- SameSite,
- Set-Cookie cacheability, in both directions,
- the toolbar's ↗ button (it once did nothing: the toolbar's top-level `function open()` silently replaced `window.open`).

Two of the tests were vacuous at first, and the mutations caught both:

- **No same-site cookie-echo pair exists publicly.** `httpbin.org` and `postman-echo.com` are on the Public Suffix List, so their subdomains are *different sites* and a real browser wouldn't share their cookies either. The cross-subdomain test therefore uses a local echo server on `a.jartest.localhost` / `b.jartest.localhost`.
- **httpbin refuses to emit `Set-Cookie: …; Domain=org`.** The public-suffix rejection test now writes it through `document.cookie` and checks the jar's cookie count. tough-cookie also skips suffix domains on lookup, so "never sent" alone couldn't prove the jar stored nothing.

The comparison run also caught a regression the tests hadn't covered. Making *every* `Set-Cookie` response uncacheable stopped snapshot mode from caching Wikimedia's images, which set analytics cookies. Warm loads went from about 200 to 900 ms, and the extra upstream traffic caused blocked responses (ORB). The rule now applies to live mode only, and a check in each direction guards it.

## Limitations / next steps

Map view:
- **Lines connect marks, not meanings.** A note with several marks per side gets every A–B pair connected (capped at 4×4).
- **One drawing per pane per draw session**, re-anchored stroke by stroke; a stroke whose element disappears drops out ("approx").
- **Scaled panes are for looking.** Hover menus and small controls are harder to hit at 40%; pick "fit pane" to work at 100%.

Comments:
- **No auth, no realtime.** The author is a free-text name and anyone with the toolbar can edit or delete. Other reviewers' comments appear on reload; the Durable Object could push them over WebSockets.
- **No threads or replies.**
- **Element anchors depend on the layout.** Opening the drawer narrows the page and can cross a responsive breakpoint; a target hidden at that width keeps its comment but shows no pin.
- **Not every target can be picked.** Inside closed shadow roots or cross-origin iframes, the comment attaches to the host element.
- **The page's own scripts share the realm**, so they can see the overlay and our messages (anchors only, never comment text). Fine for reviewing someone's site; not a security boundary.

Proxy:

- **`location` is still ours**: code that branches on `location.hostname` (Apple's analytics) takes the "unknown host" path.
- **Navigation guard is Chromium-only** (Navigation API).
- **JS literal rewriting is heuristic**; `npm run compare <url>` is the tool for new sites.
- **SameSite is approximated** from `Origin`/`Referer`:
  - A page with `Referrer-Policy: no-referrer` looks like a top-level navigation (strict).
  - Cross-site navigations in embedded iframes are treated as top-level (lax).
- **Live `document.cookie` copy is per page**: after the page writes, it doesn't apply Domain/Path rules locally. The next page load gets the jar's exact view. The async `cookieStore` API isn't patched.
- **Before any public deploy**: this is an open proxy, and readable hosts like `paypal-com.preview…` make it easy to abuse. It needs auth or an allowlist and its own registrable domain. Live mode also means the proxy operator could decrypt jars while a session is active, because the key arrives with each request; the user-held key protects *stored* jars.

## Deploying

```bash
npx wrangler r2 bucket create web-previewer-poc
npx wrangler secret put JAR_MASTER_KEY      # optional: base64 of 32 random bytes
npm run deploy
```

Set `SUBDOMAIN_ROOT` to e.g. `preview.example.com` and add a wildcard DNS record plus the route `*.preview.example.com/*`. You need certificates for `*.preview…`, `*.http.preview…`, `*.live.preview…` and `*.http.live.preview…`. `workers.dev` doesn't do wildcard subdomains. The Cache API is not used because it doesn't work on `workers.dev`; R2 works everywhere.
