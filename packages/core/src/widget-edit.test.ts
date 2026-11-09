import { test } from "node:test";
import assert from "node:assert/strict";
import { widgetOutline, widgetPrompt } from "./widget-edit.js";

test("a Widget Blueprint's tree reads as a short outline for the model", () => {
  const root = { name: "Root", class: "CanvasPanel", props: { Visibility: "Visible" }, children: [{ name: "Title", class: "TextBlock", props: { Text: '"Hi"', fontSize: 48 }, slot: { x: 10, y: 20, w: 300, h: 60, autoSize: false } }] };
  const out = widgetOutline(root);
  assert.equal(out, 'Root: CanvasPanel\n  Title: TextBlock @(10,20) size(300,60) {Text="Hi" fontSize=48}');
  assert.equal(widgetOutline(undefined), "(empty: no root widget yet)");
  const [system, user] = widgetPrompt(root, "make the title red", "Title");
  assert.match(system!.content, /"op":"add"/);
  assert.match(user!.content, /selected: Title/);
});
