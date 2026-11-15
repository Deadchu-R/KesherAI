import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { CanvasStore, canvasTools, describeCanvas, layoutShapes, type CanvasElement } from "./canvas.js";
import { canvasRoutes } from "./routes/canvas.js";

const store = async () => new CanvasStore(join(await mkdtemp(join(tmpdir(), "kesher-canvas-")), "canvases"));

test("the model adds shapes and arrows by id; KesherAI places them; the page draws and saves them", async () => {
  const s = await store();
  const [tool] = canvasTools(s, "c1", () => "Login flow");
  const out = await tool!.run({ action: "add", shapes: [{ id: "start", text: "Open app" }, { id: "login", kind: "diamond", text: "Signed in?", color: "blue" }, { id: "home", text: "Home" }], arrows: [{ from: "start", to: "login" }, { from: "login", to: "home", text: "yes" }] }, {} as never);
  assert.match(String(out.output), /rectangle start at 0,0: "Open app" \(not drawn yet\)/);
  assert.match(String(out.output), /diamond login at 300,0/);
  assert.match(String(out.output), /rectangle home at 600,0/);
  assert.match(String(out.output), /arrow login-to-home: login -> home "yes"/);
  const doc = (await s.get("chat-c1"))!;
  assert.equal(doc.title, "Login flow");
  assert.equal(doc.pending.length, 5);
  assert.deepEqual(doc.pending.find((p) => p.id === "login"), { type: "diamond", id: "login", x: 300, y: 0, width: 200, height: 100, label: { text: "Signed in?" }, strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
  await assert.rejects(tool!.run({ action: "add", shapes: [{ id: "home", text: "again" }] }, {} as never), /already a shape "home"/);
  await assert.rejects(tool!.run({ action: "add", arrows: [{ from: "home", to: "nowhere" }] }, {} as never), /two shapes that exist/);

  // The open page turned the skeletons into elements and saves them; an old revision is refused.
  const els: CanvasElement[] = [
    { id: "start", type: "rectangle", x: 0, y: 0, width: 200, height: 100, version: 2 },
    { id: "t1", type: "text", containerId: "start", text: "Open app", version: 2 },
    { id: "home", type: "rectangle", x: 560, y: 0, width: 200, height: 100, version: 2 },
    { id: "a1", type: "arrow", startBinding: { elementId: "start" }, endBinding: { elementId: "home" }, version: 2 },
  ];
  await assert.rejects(s.save("chat-c1", els, doc.rev - 1, ["start"]), /changed/);
  const saved = await s.save("chat-c1", els, doc.rev, ["start", "home", "start-to-login"]);
  assert.deepEqual(saved.pending.map((p) => p.id), ["login", "login-to-home"]);

  // New shapes go in a row under what is there.
  await tool!.run({ action: "add", shapes: [{ id: "next", kind: "note", text: "Later" }] }, {} as never);
  const n = (await s.get("chat-c1"))!.pending.find((p) => p.id === "next")!;
  assert.deepEqual([n.x, n.y, n.backgroundColor], [0, 180, "#ffec99"]);

  // Change a drawn shape's text and color: a higher version, so it wins the page's merge.
  await tool!.run({ action: "change", id: "start", text: "Launch", color: "green" }, {} as never);
  let d = (await s.get("chat-c1"))!;
  assert.deepEqual(d.elements.find((e) => e.id === "t1")!.text, "Launch");
  assert.equal(d.elements.find((e) => e.id === "t1")!.version, 3);
  assert.equal(d.elements.find((e) => e.id === "start")!.strokeColor, "#2f9e44");
  await assert.rejects(tool!.run({ action: "change", id: "start", color: "pink" }, {} as never), /Unknown color/);

  // Delete a shape: its label and its arrows go too.
  await tool!.run({ action: "delete", ids: ["start"] }, {} as never);
  d = (await s.get("chat-c1"))!;
  assert.deepEqual(d.elements.filter((e) => e.isDeleted).map((e) => e.id).sort(), ["a1", "start", "t1"]);
  assert.match(describeCanvas(d), /rectangle home at 560,0/);
  assert.doesNotMatch(describeCanvas(d), /Launch/);
});

test("canvas routes: a chat's canvas, saving with revisions, bad ids, sizes", async () => {
  const s = await store();
  const app = Fastify();
  await canvasRoutes(app, s, (id) => (id === "c1" ? "My chat" : undefined));
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/conversations/nope/canvas" })).statusCode, 404);
    const made = (await app.inject({ method: "POST", url: "/api/conversations/c1/canvas" })).json() as { id: string; rev: number; title: string };
    assert.deepEqual([made.id, made.title], ["chat-c1", "My chat"]);
    const again = (await app.inject({ method: "POST", url: "/api/conversations/c1/canvas" })).json() as { id: string };
    assert.equal(again.id, made.id, "one canvas per chat");
    const free = (await app.inject({ method: "POST", url: "/api/canvases", payload: { title: "Ideas" } })).json() as { id: string };
    const put = await app.inject({ method: "PUT", url: `/api/canvases/${free.id}`, payload: { elements: [{ id: "a", type: "rectangle" }, { junk: 1 }], rev: 0 } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual((put.json() as { elements: unknown[] }).elements, [{ id: "a", type: "rectangle" }]);
    assert.equal((await app.inject({ method: "PUT", url: `/api/canvases/${free.id}`, payload: { elements: [], rev: 0 } })).statusCode, 409);
    assert.equal((await app.inject({ method: "PUT", url: `/api/canvases/${free.id}`, payload: { title: "Big ideas" } })).statusCode, 200);
    const list = (await app.inject({ method: "GET", url: "/api/canvases" })).json() as { canvases: Array<{ title: string; shapes: number }> };
    assert.deepEqual(list.canvases.map((c) => [c.title, c.shapes]).sort(), [["Big ideas", 1], ["My chat", 0]]);
    assert.equal((await app.inject({ method: "GET", url: "/api/canvases/..%2F..%2Fconfig" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/canvases/missing" })).statusCode, 404);
    const huge = [{ id: "big", type: "text", text: "x".repeat(6 * 1024 * 1024) }];
    assert.equal((await app.inject({ method: "PUT", url: `/api/canvases/${free.id}`, payload: { elements: huge, rev: 2 } })).statusCode, 413);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/canvases/${free.id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/canvases/${free.id}` })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("new shapes are laid out as a left-to-right flowchart along the arrows; arrows run edge to edge", async () => {
  const at = layoutShapes(["a", "b", "c", "d", "lone"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "b", to: "d" }, { from: "a", to: "d" }], 40);
  assert.deepEqual([...at.entries()], [["a", { x: 0, y: 40 }], ["b", { x: 300, y: 40 }], ["c", { x: 600, y: 40 }], ["d", { x: 600, y: 200 }], ["lone", { x: 0, y: 200 }]]);
  // A cycle does not loop for ever.
  assert.equal(layoutShapes(["x", "y"], [{ from: "x", to: "y" }, { from: "y", to: "x" }], 0).size, 2);
  const s = await store();
  const [tool] = canvasTools(s, "c2", () => "Flow");
  await tool!.run({ action: "add", shapes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], arrows: [{ from: "a", to: "b" }] }, {} as never);
  const arrow = (await s.get("chat-c2"))!.pending.find((p) => p.type === "arrow")!;
  // From A's right edge (x 200) to B's left edge (x 300), with a small gap each side, at the boxes' middle height.
  assert.deepEqual([Math.round(arrow.x), Math.round(arrow.y), Math.round(arrow.width!), Math.round(arrow.height!)], [208, 50, 84, 0]);
});
