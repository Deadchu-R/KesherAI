import { test } from "node:test";
import assert from "node:assert/strict";
import { GLYPHS, glyphName } from "./glyphs.js";
import { NAV_ICONS } from "../nav-icons.js";

test("every emoji and page maps to a drawing that exists", () => {
  for (const [href, emoji] of Object.entries(NAV_ICONS)) {
    const n = glyphName(emoji, href);
    assert.ok(n, `${href} ${emoji} has no drawing`);
    assert.ok(GLYPHS[n!], `${n} is not drawn`);
  }
});

test("unknown icons stay as they are, and the page wins over its emoji", () => {
  assert.equal(glyphName("🦄"), undefined);
  assert.equal(glyphName(undefined), undefined);
  assert.equal(glyphName("📦", "#/libraries"), "library");
  assert.equal(glyphName("📦", "#/models"), "box");
  assert.equal(glyphName(" ⚙ "), "gear");
});

test("every path is a drawable SVG path", () => {
  for (const [name, paths] of Object.entries(GLYPHS)) for (const d of paths) assert.match(d, /^[Mm][\d\s.,a-zA-Z-]+$/, name);
});
