import { test } from "node:test";
import assert from "node:assert/strict";
import { iconLinks, publicSite } from "./site-icon.js";
import { cleanShortcut } from "./menu-shortcuts.js";

test("the page's best icon first; only public sites", () => {
  const html = `<link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180"><link rel="stylesheet" href="/x.css">`;
  assert.deepEqual(iconLinks(html, new URL("https://example.com/a")), ["https://example.com/touch.png", "https://example.com/favicon-16.png"]);
  assert.throws(() => publicSite("http://localhost:7420/"), /public/);
  assert.throws(() => publicSite("http://192.168.1.2/"), /public/);
  assert.throws(() => publicSite("file:///etc/passwd"), /web sites/);
});

test("a shortcut keeps a small image icon, never other data", () => {
  const ok = cleanShortcut({ label: "YT", href: "https://youtube.com", image: "data:image/png;base64,iVBORw0KGgo=" });
  assert.ok(!("error" in ok) && ok.image);
  const bad = cleanShortcut({ label: "x", href: "https://x.com", image: "data:text/html;base64,PHNjcmlwdD4=" });
  assert.ok(!("error" in bad) && !bad.image);
});
