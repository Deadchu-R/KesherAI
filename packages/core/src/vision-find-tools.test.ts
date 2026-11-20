import { test } from "node:test";
import assert from "node:assert/strict";
import { VISION_MODELS } from "@kesher/shared";
import { browserFindTool, computerFindTool, matchSnapshot, snapshotElements } from "./vision-find-tools.js";
import { VisionGrounder } from "./vision-ground.js";
import type { Grounding } from "./vision-service.js";

const ctx = { signal: new AbortController().signal } as Parameters<ReturnType<typeof computerFindTool>["run"]>[1];
const missing = { installId: "vision-model", name: "Qwen3-VL 8B", sizeGb: 6.2, where: "E:\\KesherAI\\gui-vision" };

/** A fake vision engine: always answers the same point (0–1000). */
function fakeVision(installed: boolean, answer = '{"point_2d": [500, 500]}'): Grounding & { asked: string[] } {
  const asked: string[] = [];
  const g = new VisionGrounder(async (a) => (asked.push(a.user), { text: answer, tokens: [{ token: "500", logprob: Math.log(0.9) }] }));
  const model = VISION_MODELS[0]!;
  return { asked, model: () => (installed ? model : undefined), missing: () => missing, ground: (r) => g.ground(model, r) };
}

test("computer_find answers from the window's controls first, without the vision model", async () => {
  const v = fakeVision(true);
  const tool = computerFindTool({
    gate: () => undefined,
    shoot: async () => assert.fail("no screenshot needed"),
    treeMatch: async () => ({ x: 10, y: 20, label: 'Button "Save"', ref: "u3" }),
    record: () => undefined,
    vision: () => v,
  });
  const r = await tool.run({ query: "the Save button" }, ctx);
  assert.match(r.output, /Button "Save" \(ref u3\).*computer_invoke with ref u3/);
  assert.equal(v.asked.length, 0);
});

test("computer_find falls back to the vision model on a screenshot and returns a crop to check", async () => {
  const v = fakeVision(true);
  const log: string[] = [];
  const tool = computerFindTool({
    gate: () => undefined,
    shoot: async () => ({ png: Buffer.from("png"), width: 1000, height: 600 }),
    treeMatch: async () => undefined,
    around: async (x, y) => Buffer.from(`crop ${x},${y}`),
    record: (a, ok) => log.push(`${ok}:${a}`),
    vision: () => v,
  });
  const r = await tool.run({ query: "the play icon" }, ctx);
  assert.match(r.output, /x=500, y=300.*90%.*computer_click with x=500, y=300/);
  assert.equal(Buffer.from(r.images![0]!.data, "base64").toString(), "crop 500,300");
  assert.match(log[0]!, /^true:looked for "the play icon"/);
});

test("computer_find offers the Install button when no vision model is installed", async () => {
  const tool = computerFindTool({ gate: () => undefined, shoot: async () => assert.fail(), record: () => undefined, vision: () => fakeVision(false) });
  const r = await tool.run({ query: "the play icon" }, ctx);
  assert.match(r.output, /Install button for Qwen3-VL 8B \(6\.2 GB, saved in E:\\KesherAI\\gui-vision\).*\[offer_install:vision-model\]/);
});

test("computer_find stops when computer control is off", async () => {
  const tool = computerFindTool({ gate: () => { throw new Error("Computer control is off."); }, shoot: async () => assert.fail(), record: () => undefined, vision: () => fakeVision(true) });
  await assert.rejects(tool.run({ query: "x" }, ctx), /off/);
});

test("browser_find_visual: a ref from the snapshot, else a point for browser_click_at; not found is said", async () => {
  const tree = '- heading "Shop"\n  - button "Search" [ref=e1]\n  - link "Help" [ref=e2]\n  - button [ref=e3]';
  assert.deepEqual(snapshotElements(tree).map((e) => e.ref), ["e1", "e2"]);
  assert.deepEqual(matchSnapshot(tree, "the search button"), { ref: "e1", label: 'button "Search"' });
  const host = (v: Grounding) => ({
    tabArg: {},
    vision: () => v,
    snapshotMatch: async (_i: Record<string, unknown>, q: string) => matchSnapshot(tree, q),
    shot: async () => ({ png: Buffer.from("p"), width: 800, height: 400 }),
  });
  assert.match((await browserFindTool(host(fakeVision(true))).run({ query: "Search" }, ctx)).output, /\[ref=e1\].*browser_click with ref e1/);
  assert.match((await browserFindTool(host(fakeVision(true))).run({ query: "the red heart icon" }, ctx)).output, /x=400, y=200.*browser_click_at/);
  assert.match((await browserFindTool(host(fakeVision(true, '{"none": true}'))).run({ query: "the red heart icon" }, ctx)).output, /^Not found on the screenshot/);
  assert.match((await browserFindTool(host(fakeVision(false))).run({ query: "the red heart icon" }, ctx)).output, /\[offer_install:vision-model\]/);
});
