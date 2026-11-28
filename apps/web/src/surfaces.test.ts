import { test } from "node:test";
import assert from "node:assert/strict";
import { itemFromResult as docFromResult } from "./doc-items.js";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget, openedFile } from "./surfaces.js";

const ids = (l: ReadonlyArray<{ id: string }>) => l.map((s) => s.id);
const nothing = { parts: [], pluginPages: [] };

test("the registry is built from what is installed: an off part or an unloaded plugin is not registered", () => {
  assert.deepEqual(ids(buildSurfaces(BUILT_IN, nothing)), ["doc", "sheet", "deck", "code", "image", "blueprint", "model", "scenes", "video", "sound", "word"]);
  const on = buildSurfaces(BUILT_IN, { parts: [{ id: "image-editor", on: true }, { id: "model-editor", on: false }], pluginPages: [{ pluginId: "image-editor" }, { pluginId: "model-editor" }] });
  assert.deepEqual(ids(on), ["doc", "sheet", "deck", "code", "image", "blueprint", "model", "scenes", "video", "sound", "word", "image-editor"]);
  // A part the server does not list counts as on (as partOn does), but its plugin page must be loaded.
  assert.deepEqual(ids(buildSurfaces(BUILT_IN, { parts: [], pluginPages: [{ pluginId: "sound-editor" }] })), ["doc", "sheet", "deck", "code", "image", "blueprint", "model", "scenes", "video", "sound", "word", "sound-editor"]);
});

test("the surface contract: every surface has an id, kinds, a lazy panel, tools, phone and versions", () => {
  const seen = new Set<string>();
  for (const s of BUILT_IN) {
    assert.ok(!seen.has(s.id), s.id);
    seen.add(s.id);
    assert.ok(s.kinds.length > 0 && typeof s.panel === "function" && Array.isArray(s.tools));
    assert.ok(["edit", "view+ask", "open-on-pc"].includes(s.phone));
    assert.ok(["server", "none"].includes(s.versions));
    if (s.plugin) assert.ok(s.part, `${s.id}: a plugin surface belongs to a part`);
  }
});

test("doc, sheet and deck open through the registry exactly as before", () => {
  const list = buildSurfaces(BUILT_IN, nothing);
  const cases: Array<[string, string]> = [
    ["document", "Saved v3 (120 words). The user sees it at #/docs/chat-c1."],
    ["sheet", "Saved v2. The user sees it at #/sheets/abc-1.\nA1: x"],
    ["slides", "Saved v5: 4 slides. The user sees it at #/slides/d9.\n…"],
    ["document", "# Title\n\nsee #/docs/x"],
    ["document", "Saved (3 words). The user sees it at #/docs/x."],
    ["write_file", "Saved v2 at #/docs/x"],
    ["sheet", "Saved v2 at #/docs/x"],
  ];
  for (const [tool, out] of cases) {
    const before = docFromResult(tool, true, out);
    const now = itemFromResult(list, tool, true, out);
    assert.deepEqual(now && { kind: now.kind, id: now.id, ver: now.ver }, before && { kind: before.kind, id: before.id, ver: before.ver }, `${tool}: ${out}`);
    if (now) assert.equal(now.surface, now.kind);
  }
  assert.equal(itemFromResult(list, "document", false, "Saved v2 at #/docs/x"), undefined);
  // The doc surfaces keep DocPanel's panel class and the selection message.
  const doc = list.find((s) => s.id === "doc")!;
  assert.equal(doc.panelClass, "doc-panel");
  const msg = doc.selection!({ item: { surface: "doc", kind: "doc", id: "d1" }, title: "T", selection: "a", instruction: "why?", change: true, he: false });
  assert.match(msg, /Use the document tool with id "d1"/);
});

test("open_in_chat: an item address opens its doc surface; a file is mapped by its type", () => {
  const list = buildSurfaces(BUILT_IN, { parts: [{ id: "image-editor", on: true }, { id: "model-editor", on: false }], pluginPages: [{ pluginId: "image-editor" }] });
  assert.deepEqual(itemFromResult(list, "open_in_chat", true, "Opened in the chat: #/sheets/s1\nThe user sees it."), { surface: "sheet", kind: "sheet", id: "s1" });
  assert.equal(itemFromResult(list, "open_in_chat", true, "Opened in the chat: shared/hero.png"), undefined);
  assert.equal(openedFile("open_in_chat", true, "Opened in the chat: shared/my hero.png\nThe user sees it."), "shared/my hero.png");
  assert.equal(openedFile("open_in_chat", true, "Opened in the chat: #/docs/d1"), undefined);
  assert.equal(openedFile("open_in_chat", false, "Opened in the chat: a.png"), undefined);
  assert.equal(openedFile("send_file", true, "Opened in the chat: a.png"), undefined);
});

test("Open in chat by file type: the installed surface, else the install offer for its part, else nothing", () => {
  const list = buildSurfaces(BUILT_IN, { parts: [{ id: "image-editor", on: true }, { id: "model-editor", on: false }], pluginPages: [{ pluginId: "image-editor" }] });
  const pic = openTarget(BUILT_IN, list, "shared/Hero.PNG");
  assert.ok(pic && !("install" in pic) && pic.surface.id === "image");
  const model = openTarget(BUILT_IN, list, "out/ship.glb");
  // The built-in 3D viewer opens a model with no install; the 3D editor is offered from inside it.
  assert.ok(model && !("install" in model) && model.surface.id === "model");
  // A song opens in the sound surface (always there); the sound editor is its "Full editor".
  const song = openTarget(BUILT_IN, list, "song.mp3");
  assert.ok(song && !("install" in song) && song.surface.id === "sound");
  assert.equal(openTarget(BUILT_IN, list, "notes.txt"), undefined);
});

test("image surface: generate_image / edit_image results make a card, a picture file opens it, a region becomes the chat message", () => {
  const list = buildSurfaces(BUILT_IN, nothing);
  const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.deepEqual(itemFromResult(list, "generate_image", true, "Generated 1 image(s).", { assetIds: [A] }), { surface: "image", kind: "image", id: A });
  assert.deepEqual(itemFromResult(list, "edit_image", true, `Edited (ids: ${A}).`), { surface: "image", kind: "image", id: A });
  assert.equal(itemFromResult(list, "generate_image", false, "x", { assetIds: [A] }), undefined);
  assert.equal(itemFromResult(list, "make_music", true, "Made", { assetIds: [A] }), undefined);
  const img = BUILT_IN.find((s) => s.id === "image")!;
  assert.equal(img.versions, "server");
  assert.equal(img.phone, "edit");
  assert.ok(["a.png", "b.jpg", "c.webp", "d.gif"].every((f) => img.fileTypes!.test(f)));
  const item = { surface: "image", kind: "image", id: A };
  const msg = (he: boolean) => img.selection!({ item, title: "fox", selection: "10,20,100,50/400×200", instruction: "what is it?", change: false, he });
  assert.match(msg(false), /about this area: x=10, y=20, width=100, height=50 \(of 400×200/);
  assert.match(msg(true), /על האזור הזה/);
});

test("blueprint surface: graph write results make a card, no file type opens it, it is view+ask on the phone", () => {
  const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });
  assert.ok(list.some((s) => s.id === "blueprint"));
  const out = `Done.\n[graph-change] ${JSON.stringify({ path: "/Game/BP_A.BP_A", graph: "EventGraph", kind: "unreal", nodes: 3, added: [], removed: [], changed: [], links: 0, unlinked: 0 })}`;
  const it = itemFromResult(list, "unreal_change_graph", true, out);
  assert.equal(it?.surface, "blueprint");
  assert.equal(it?.id, "/Game/BP_A.BP_A");
  assert.equal(it?.data, out);
  assert.equal(itemFromResult(list, "unreal_change_graph", true, "Applied 1/1 operations."), undefined);
  const bp = BUILT_IN.find((s) => s.id === "blueprint")!;
  assert.equal(bp.phone, "view+ask");
  assert.deepEqual([...bp.tools], ["unreal_change_graph", "unity_change_graph"]);
  assert.equal(bp.fileTypes, undefined);
});
