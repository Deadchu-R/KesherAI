import { test } from "node:test";
import assert from "node:assert/strict";
import { framed, isArtifact } from "./ArtifactPanel.js";

test("which code blocks open live", () => {
  assert.ok(isArtifact("html", "<!doctype html><html><body>hi</body></html>"));
  assert.ok(isArtifact("svg", "<svg viewBox='0 0 10 10'></svg>"));
  assert.ok(!isArtifact("html", "<b>hi</b>"), "a tiny snippet stays code");
  assert.ok(!isArtifact("csharp", "<!doctype html>"));
});

test("the content policy comes before anything of the page", () => {
  const f = framed("<!doctype html><html><head><script>fetch('https://x')</script></head><body></body></html>");
  assert.ok(f.indexOf("Content-Security-Policy") < f.indexOf("<script>"));
  assert.match(framed("<div>x</div>"), /default-src 'none'/);
  assert.match(framed("<svg></svg>"), /^<!doctype html>.*Content-Security-Policy.*<svg><\/svg>/s);
});

test("a refresh to another site is taken out, and forms cannot post anywhere", () => {
  const f = framed(`<html><head><meta http-equiv="refresh" content="0;url=https://x.example/?d=1"></head></html>`);
  assert.doesNotMatch(f, /refresh/);
  assert.match(f, /form-action 'none'/);
});

test("a screen's size on the design canvas", async () => {
  const { frameSize } = await import("./design-frame.js");
  assert.deepEqual(frameSize(`<meta name="kesher-frame" content="phone">`), { w: 390, h: 844, phone: true });
  assert.equal(frameSize(`<meta name="viewport" content="width=390">`).phone, true);
  assert.equal(frameSize("<html></html>").w, 1280);
});
