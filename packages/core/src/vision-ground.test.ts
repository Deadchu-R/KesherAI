import { test } from "node:test";
import assert from "node:assert/strict";
import { VISION_MODELS, pickVisionModel } from "@kesher/shared";
import { VisionGrounder, bestNameMatch, confidenceOf, foundText, groundPrompt, parseGround, smartResize } from "./vision-ground.js";

const qwen = VISION_MODELS.find((m) => m.id === "qwen3-vl-8b")!;
const tars = VISION_MODELS.find((m) => m.id === "ui-tars-1.5-7b")!;

test("smartResize rounds to multiples of 28 and keeps the area in its limits", () => {
  assert.deepEqual(smartResize(1280, 720), { width: 1288, height: 728 });
  const big = smartResize(8000, 6000);
  assert.ok(big.width % 28 === 0 && big.height % 28 === 0 && big.width * big.height <= 16384 * 28 * 28);
  const tiny = smartResize(20, 20);
  assert.ok(tiny.width * tiny.height >= 56 * 56);
});

test("groundPrompt: JSON with 0–1000 points for Qwen3-VL, UI-TARS' own grounding line", () => {
  assert.match(groundPrompt(qwen, "the blue Save button").user, /point_2d.*0 to 1000/s);
  assert.match(groundPrompt(tars, "the blue Save button").user, /^Output only the coordinate of one point.*the blue Save button$/);
});

test("parseGround maps Qwen3-VL's relative points and boxes to picture pixels", () => {
  assert.deepEqual(parseGround('```json\n{"point_2d": [500, 250]}\n```', qwen, 1280, 720), { x: 640, y: 180 });
  const b = parseGround('[{"bbox_2d": [100, 100, 200, 300], "label": "Save"}]', qwen, 1000, 1000);
  assert.deepEqual(b, { x: 150, y: 200, box: [100, 100, 100, 200] });
  assert.ok("none" in parseGround('{"none": true}', qwen, 100, 100));
  assert.ok("none" in parseGround("I cannot help", qwen, 100, 100));
  assert.ok("none" in parseGround('{"point_2d": [1200, 10]}', qwen, 100, 100));
});

test("parseGround maps UI-TARS' resized-picture pixels back", () => {
  // 1280×720 → 1288×728 in the model.
  assert.deepEqual(parseGround("(644,364)", tars, 1280, 720), { x: 640, y: 360 });
  assert.deepEqual(parseGround("click(start_box='<|box_start|>(644,364)<|box_end|>')", tars, 1280, 720), { x: 640, y: 360 });
});

test("confidenceOf: geometric mean of the number tokens' probabilities", () => {
  assert.equal(confidenceOf(undefined), undefined);
  assert.equal(confidenceOf([{ token: "{", logprob: -5 }, { token: "50", logprob: Math.log(0.9) }, { token: "0", logprob: Math.log(0.9) }]), 0.9);
});

test("bestNameMatch: naming words must all match, look words are ignored, the closest name wins", () => {
  const items = [{ name: "Save as…" }, { name: "Save" }, { name: "Cancel" }];
  assert.equal(bestNameMatch("the blue Save button", items)?.name, "Save");
  assert.equal(bestNameMatch("the gear icon", items), undefined);
  assert.equal(bestNameMatch("button", items), undefined);
  assert.equal(bestNameMatch("כפתור שמירה", [{ name: "שמירה" }])?.name, "שמירה");
});

test("VisionGrounder asks the model with the picture and answers in picture pixels, one call at a time", async () => {
  let running = 0;
  let most = 0;
  const asks: string[] = [];
  let t = 0;
  const g = new VisionGrounder(async (a) => {
    running++;
    most = Math.max(most, running);
    asks.push(a.user);
    assert.equal(a.png.toString(), "PNG");
    await new Promise((r) => setTimeout(r, 5));
    running--;
    t += 1500;
    return { text: '{"point_2d": [250, 500]}', tokens: [{ token: "250", logprob: Math.log(0.8) }] };
  }, () => t);
  const [a, b] = await Promise.all([
    g.ground(qwen, { png: Buffer.from("PNG"), width: 800, height: 600, query: "Save" }),
    g.ground(qwen, { png: Buffer.from("PNG"), width: 800, height: 600, query: "Open" }),
  ]);
  assert.equal(most, 1);
  assert.equal(asks.length, 2);
  assert.ok(a.found && b.found);
  if (a.found) {
    assert.deepEqual([a.x, a.y, a.confidence, a.ms, a.model], [200, 300, 0.8, 1500, "qwen3-vl-8b"]);
    assert.match(foundText(a, "computer_click"), /x=200, y=300.*80%.*computer_click with x=200, y=300/);
  }
  const unsure = foundText({ found: true, x: 1, y: 2, confidence: 0.3, ms: 10, model: "m" }, "browser_click_at");
  assert.match(unsure, /unsure/);
});

test("pickVisionModel: auto takes the first installed in catalog order; a chosen one only when installed", () => {
  assert.equal(pickVisionModel("auto", ["ui-tars-1.5-7b"])?.id, "ui-tars-1.5-7b");
  assert.equal(pickVisionModel("auto", ["ui-tars-1.5-7b", "qwen3-vl-8b"])?.id, "qwen3-vl-8b");
  assert.equal(pickVisionModel("ui-tars-1.5-7b", ["qwen3-vl-8b"]), undefined);
  assert.equal(pickVisionModel("auto", []), undefined);
});
