// Two demo pages for the README screenshots: an invented coffee roastery's old site and its redesign.
// Served locally (old at fernhill-old.localhost, new at fernhill.localhost) so screenshots hold no third-party content.
import http from 'node:http';

export const OLD = `<!doctype html><html><head><meta charset="utf-8"><title>Fernhill Coffee Roasters</title><style>
body{margin:0;background:#e8e1d3;font:15px/1.5 Georgia,serif;color:#3b2a1d}
.wrap{width:940px;margin:0 auto;background:#fffdf8;box-shadow:0 0 12px rgba(0,0,0,.15)}
header{background:#3b2414;color:#f4e6cf;padding:18px 24px;display:flex;align-items:baseline;gap:28px}
header h1{margin:0;font-size:28px;font-weight:normal;letter-spacing:.5px}
nav a{color:#e6c79c;margin-right:16px;text-decoration:none;font-size:14px}
.banner{margin:16px;height:170px;border-radius:4px;background:linear-gradient(135deg,#6b3f22,#a86a3d 60%,#d9a066);display:flex;align-items:flex-end;padding:20px}
.banner p{font-size:23px;margin:0;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.cols{display:flex;gap:22px;padding:0 16px 18px}.main{flex:1}aside{width:250px;padding-top:18px}
h2{font-size:19px;border-bottom:1px solid #d8c8b0;padding-bottom:4px;color:#5a3a22}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border:1px solid #d8c8b0;padding:6px 8px;text-align:left}th{background:#f1e6d4}
.box{background:#f6eee1;border:1px solid #e0cfb5;padding:10px 12px;margin-bottom:14px;font-size:13px}
.box input{width:88%;margin-top:6px;padding:3px}
footer{background:#3b2414;color:#cdb08a;font-size:12px;padding:12px 24px}
</style></head><body><div class="wrap">
<header><h1>Fernhill Coffee</h1><nav><a href="#">Home</a><a href="#">Our Coffee</a><a href="#">Wholesale</a><a href="#">Contact</a></nav></header>
<div class="banner"><p class="tagline">Roasted by hand in small batches since 1998.</p></div>
<div class="cols"><div class="main">
<h2>Welcome!</h2>
<p>Fernhill is a family roastery on the edge of town. Every week we roast green beans from small farms we know by name, and we ship them the same day so they reach you fresh.</p>
<h2>Our Coffees</h2>
<table id="coffees"><tr><th>Coffee</th><th>Origin</th><th>250 g</th></tr>
<tr><td>Morning Hill</td><td>Colombia</td><td>$14</td></tr><tr><td>Yirga Bloom</td><td>Ethiopia</td><td>$16</td></tr><tr><td>Dark Fern</td><td>Sumatra</td><td>$15</td></tr></table>
</div><aside>
<div class="box" id="hours"><b>Opening hours</b><br>Mon–Fri 7:00–17:00<br>Sat 8:00–14:00<br>Sun closed</div>
<div class="box" id="newsletter"><b>Newsletter</b><br>Get our roast calendar by email.<br><input placeholder="your@email"></div>
</aside></div>
<footer>Fernhill Coffee Roasters · 12 Mill Lane · Open since 1998</footer></div></body></html>`;

export const NEW = `<!doctype html><html><head><meta charset="utf-8"><title>Fernhill · Small-batch coffee</title><style>
body{margin:0;font:16px/1.55 system-ui,-apple-system,sans-serif;color:#1d1b19;background:#fbfaf7}
nav{display:flex;align-items:center;gap:28px;padding:20px 48px}
.logo{font-weight:800;font-size:22px;letter-spacing:-.5px}.logo span{color:#c2632d}
nav a{color:#57534e;text-decoration:none}nav .shop{margin-left:auto;background:#1d1b19;color:#fff;padding:10px 18px;border-radius:999px}
.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:40px;padding:36px 48px 48px;align-items:center}
.eyebrow{text-transform:uppercase;letter-spacing:2px;font-size:12px;color:#c2632d;font-weight:700}
.hero h1{font-size:50px;line-height:1.05;margin:10px 0 16px;letter-spacing:-1.5px}
.hero p{color:#57534e;font-size:18px;max-width:440px;margin:0}
.cta{display:inline-block;margin-top:20px;background:#c2632d;color:#fff;padding:14px 24px;border-radius:999px;font-weight:600;text-decoration:none}
.photo{height:300px;border-radius:28px;background:radial-gradient(circle at 30% 30%,#e9b98a,#a2582c 55%,#4a2412)}
section{padding:16px 48px}h2{font-size:28px;letter-spacing:-.5px;margin:0 0 16px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.card{background:#fff;border-radius:20px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.06)}
.swatch{height:110px;border-radius:14px;margin-bottom:14px}
.card h3{margin:0;font-size:19px}.origin{color:#78716c;font-size:14px}.price{float:right;font-weight:700}
.card p{font-size:14px;color:#57534e;margin:8px 0 0}
.visit{display:grid;grid-template-columns:1.4fr 1fr;gap:24px;background:#f1ebe3;border-radius:24px;margin:28px 48px;padding:28px}
.visit p{margin:0;color:#57534e}footer{padding:8px 48px 32px;color:#78716c;font-size:14px}
</style></head><body>
<nav><div class="logo">Fernhill<span>.</span></div><a href="#">Coffee</a><a href="#">Subscriptions</a><a href="#">Visit</a><a class="shop" href="#">Shop beans</a></nav>
<header class="hero"><div><div class="eyebrow">Since 1998</div><h1 id="headline">Small-batch coffee, roasted every Tuesday.</h1>
<p>We buy from farms we know by name and ship the same day we roast.</p><a class="cta" href="#">Shop beans</a></div><div class="photo" id="photo"></div></header>
<section id="coffee"><h2>Our coffee</h2><div class="cards" id="cards">
<div class="card"><div class="swatch" style="background:linear-gradient(135deg,#f3c892,#c27a3b)"></div><span class="price">$14</span><h3>Morning Hill</h3><div class="origin">Colombia</div><p>Caramel, red apple, a clean finish.</p></div>
<div class="card"><div class="swatch" style="background:linear-gradient(135deg,#f6d6c2,#d1785c)"></div><span class="price">$16</span><h3>Yirga Bloom</h3><div class="origin">Ethopia</div><p>Jasmine and bergamot, tea-like and bright.</p></div>
<div class="card"><div class="swatch" style="background:linear-gradient(135deg,#a98468,#3f2a1e)"></div><span class="price">$15</span><h3>Dark Fern</h3><div class="origin">Sumatra</div><p>Cocoa, cedar and a heavy body.</p></div>
</div></section>
<div class="visit" id="visit"><div><h2>Visit the roastery</h2><p>Watch us roast on Tuesdays and taste what's fresh off the drum.</p></div><div><b>Hours</b><br>Mon–Fri 7–17<br>Sat 8–14</div></div>
<footer><span id="footnote">Fernhill Coffee Roasters · 12 Mill Lane</span></footer>
</body></html>`;

export function serve(port) {
	const handler = (req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end((req.headers.host || '').startsWith('fernhill-old.') ? OLD : NEW);
	return ['127.0.0.1', '::1'].map((h) => http.createServer(handler).listen(port, h));
}
