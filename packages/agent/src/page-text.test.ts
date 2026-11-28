import test from "node:test";
import assert from "node:assert/strict";
import { pageText, PAGE_CHARS } from "./system-tools.js";

test("pageText keeps the main part of a page and drops side bars", () => {
  const html = `<html><body><nav>menu</nav><aside>Related junk</aside><main><p>${"Haifa tomorrow: 24 degrees, sunny. ".repeat(20)}</p></main></body></html>`;
  const t = pageText(html, "text/html");
  assert.match(t, /Haifa tomorrow/);
  assert.doesNotMatch(t, /Related junk|menu/);
});

test("pageText falls back to the whole page when there is no real main part", () => {
  assert.match(pageText("<body><div>short page text</div></body>", "text/html"), /short page text/);
});

test("pageText cuts a long page and says so", () => {
  const t = pageText("x".repeat(PAGE_CHARS * 2), "text/plain");
  assert.ok(t.length < PAGE_CHARS + 200);
  assert.match(t, /Cut here/);
});
