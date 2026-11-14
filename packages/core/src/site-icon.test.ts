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

test("private addresses (v4 and v6) are refused", async () => {
  const { privateIp } = await import("./site-icon.js");
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(privateIp(ip), ip);
  for (const ip of ["8.8.8.8", "142.250.1.1", "2606:4700::1111"]) assert.ok(!privateIp(ip), ip);
});
