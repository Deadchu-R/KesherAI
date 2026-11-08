import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAppearance, cleanColor, isLight, resolveAppearance } from "./appearance.js";

test("cleanAppearance keeps only valid looks", () => {
  const a = cleanAppearance({
    colors: { bg: "#FFF", accent: "red", text: "url(evil)", "panel-2": "#123456" },
    font: "Heebo",
    fontSize: 99,
    radius: -4,
    density: "huge",
    background: { kind: "gradient", from: "#000", to: "javascript:x" },
    navOrder: ["work", "work", "nope", "create"],
    extra: "x",
  });
  assert.deepEqual(a, { colors: { bg: "#ffffff", "panel-2": "#123456", accent: "#e5484d" }, font: "heebo", fontSize: 20, radius: 0, navOrder: ["work", "create"] });
});

test("presets sit under the user's own colours", () => {
  const r = resolveAppearance({ preset: "paper", colors: { accent: "#00ff00" } });
  assert.equal(r.colors?.bg, "#f6f5f2");
  assert.equal(r.colors?.accent, "#00ff00");
});

test("colours", () => {
  assert.equal(cleanColor("#abc"), "#aabbcc");
  assert.equal(cleanColor("rgb(1,2,3)"), undefined);
  assert.ok(isLight("#f6f5f2"));
  assert.ok(!isLight("#121213"));
});
