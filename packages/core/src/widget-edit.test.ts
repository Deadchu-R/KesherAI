import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWidgetOps, widgetOutline, widgetPrompt } from "./widget-edit.js";

test("a Widget Blueprint's tree reads as a short outline for the model", () => {
  const root = { name: "Root", class: "CanvasPanel", props: { Visibility: "Visible" }, children: [{ name: "Title", class: "TextBlock", props: { Text: '"Hi"', fontSize: 48 }, slot: { x: 10, y: 20, w: 300, h: 60, autoSize: false } }] };
  const out = widgetOutline(root);
  assert.equal(out, 'Root: CanvasPanel\n  Title: TextBlock @(10,20) size(300,60) {Text="Hi" fontSize=48}');
  assert.equal(widgetOutline(undefined), "(empty: no root widget yet)");
  const [system, user] = widgetPrompt(root, "make the title red", "Title");
  assert.match(system!.content, /"op":"add"/);
  assert.match(user!.content, /selected: Title/);
});

test("a small model's widget operations are made right before they reach the editor", () => {
  const ops = cleanWidgetOps(
    [
      { op: "add", class: "Border", parent: "Root", name: "Box" },
      { op: "set", widget: "Title", property: "position|slot.size|slot.anchors", value: "1,2" },
      { op: "set", widget: "Title", property: "position", value: "0,100" },
      { op: "set", widget: "Title", property: "Size", value: "900,120" },
      { op: "set", widget: "Title", property: "Color", value: "(R=1,G=0,B=0,A=1)" },
      { op: "set", widget: "Box", property: "BackgroundColor", value: "(R=0,G=0,B=1,A=1)" },
      { op: "set", widget: "Title", property: "FontSize", value: "64" },
    ],
    (n) => (n === "Title" ? "TextBlock" : undefined),
  );
  assert.equal(ops.length, 6, "the copied list of choices is left out");
  assert.equal(ops[1]!.property, "slot.position");
  assert.equal(ops[2]!.property, "slot.size");
  assert.equal(ops[3]!.property, "ColorAndOpacity");
  assert.match(String(ops[3]!.value), /^\(SpecifiedColor=\(R=1/);
  assert.equal(ops[4]!.property, "BrushColor");
  assert.equal(ops[5]!.property, "fontSize");
});

test("a style operation in plain words becomes the exact Unreal settings", () => {
  const ops = cleanWidgetOps(
    [
      { op: "add", class: "TextBlock", parent: "Root", name: "Title" },
      { op: "style", widget: "Title", text: "MY GAME", fontSize: 96, color: "orange", place: "top", size: [900, 140], offset: [0, 120], align: "center" },
      { op: "style", widget: "Start", background: "blue", place: "bottom-right", offset: [40, 40] },
    ],
    (n) => ({ Root: "CanvasPanel", Start: "Button" })[n],
    (n) => (n === "Start" ? "CanvasPanel" : undefined),
  );
  const v = (w: string, p: string) => ops.find((o) => o.widget === w && o.property === p)?.value;
  assert.equal(v("Title", "Text"), "MY GAME");
  assert.equal(v("Title", "fontSize"), "96");
  assert.match(String(v("Title", "ColorAndOpacity")), /^\(SpecifiedColor=\(R=1\.0000,G=0\.268/);
  assert.equal(v("Title", "slot.anchors"), "0.5,0,0.5,0");
  assert.equal(v("Title", "slot.alignment"), "0.5,0");
  assert.equal(v("Title", "slot.position"), "0,120");
  assert.equal(v("Title", "slot.size"), "900,140");
  assert.equal(v("Title", "Justification"), "Center");
  assert.match(String(v("Start", "BackgroundColor")), /^\(R=/);
  assert.equal(v("Start", "slot.position"), "-40,-40", "offsets go inward from the bottom-right");
});

test("text inside a Border or Button is centred unless asked otherwise", () => {
  const ops = cleanWidgetOps([{ op: "style", widget: "Label", text: "START" }, { op: "style", widget: "Side", text: "X", align: "left" }], () => "TextBlock", () => "Border");
  const v = (w: string, p: string) => ops.find((o) => o.widget === w && o.property === p)?.value;
  assert.equal(v("Label", "slot.HorizontalAlignment"), "HAlign_Center");
  assert.equal(v("Label", "slot.VerticalAlignment"), "VAlign_Center");
  assert.equal(v("Side", "slot.HorizontalAlignment"), "HAlign_Left");
});
