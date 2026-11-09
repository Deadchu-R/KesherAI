import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaToWidgetOps, type FigmaNode } from "./figma-umg.js";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test("a Figma frame becomes UMG widgets: canvas positions, auto layout as boxes, text, shapes", () => {
  const frame: FigmaNode = {
    id: "1:1", name: "Main Menu", type: "FRAME", absoluteBoundingBox: box(100, 100, 1920, 1080),
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    children: [
      { id: "2", name: "Title", type: "TEXT", characters: "AUTO SHOOTER", absoluteBoundingBox: box(560, 300, 800, 120), style: { fontSize: 96, textAlignHorizontal: "CENTER" }, fills: [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0, a: 1 } }] },
      { id: "3", name: "Buttons", type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 20, absoluteBoundingBox: box(860, 600, 400, 200), children: [
        { id: "4", name: "Start", type: "RECTANGLE", absoluteBoundingBox: box(860, 600, 400, 80), fills: [{ type: "SOLID", color: { r: 0, g: 0.4, b: 1, a: 1 } }] },
        { id: "5", name: "Logo", type: "RECTANGLE", absoluteBoundingBox: box(860, 700, 400, 80), fills: [{ type: "IMAGE" }] },
      ] },
      { id: "6", name: "hidden", type: "TEXT", visible: false, characters: "x" },
    ],
  };
  const { ops, notes } = figmaToWidgetOps(frame, "", ["Title"]);
  const adds = ops.filter((o) => o.op === "add");
  assert.deepEqual(adds.map((o) => o.class), ["CanvasPanel", "Image", "TextBlock", "VerticalBox", "Image", "Image"]);
  assert.equal(adds[0]!.parent, undefined, "an empty Widget Blueprint: the frame is the root");
  assert.equal(adds[2]!.name, "Title_2", "names stay unique");
  assert.ok(ops.some((o) => o.widget === "Title_2" && o.property === "slot.position" && o.value === "460,200"), "position inside the frame");
  assert.ok(ops.some((o) => o.widget === "Title_2" && o.property === "Text" && o.value === "AUTO SHOOTER"));
  assert.ok(ops.some((o) => o.widget === "Start" && o.property === "slot.Padding" && /Bottom=20/.test(String(o.value))), "auto-layout gap as padding");
  assert.ok(!ops.some((o) => o.widget === "Logo" && o.property === "slot.Padding"), "no gap after the last child");
  assert.ok(notes.some((n) => /Logo: a picture/.test(n)));
  assert.ok(!adds.some((o) => o.name === "hidden"));
  // Into an existing canvas: the frame keeps its size there.
  const into = figmaToWidgetOps({ ...frame, children: [] }, "Root", [], 300, true);
  assert.ok(into.ops.some((o) => o.property === "slot.size" && o.value === "1920,1080"));
});
