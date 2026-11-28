import { test } from "node:test";
import assert from "node:assert/strict";
import { itemFromResult as docFromResult } from "./doc-items.js";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget, openedFile } from "./surfaces.js";

const ids = (l: ReadonlyArray<{ id: string }>) => l.map((s) => s.id);
const nothing = { parts: [], pluginPages: [] };

test("the registry is built from what is installed: an off part or an unloaded plugin is not registered", () => {
  assert.deepEqual(ids(buildSurfaces(BUILT_IN, nothing)), ["doc", "sheet", "deck"]);
  const on = buildSurfaces(BUILT_IN, { parts: [{ id: "image-editor", on: true }, { id: "model-editor", on: false }], pluginPages: [{ pluginId: "image-editor" }, { pluginId: "model-editor" }] });
  assert.deepEqual(ids(on), ["doc", "sheet", "deck", "image-editor"]);
  // A part the server does not list counts as on (as partOn does), but its plugin page must be loaded.
  assert.deepEqual(ids(buildSurfaces(BUILT_IN, { parts: [], pluginPages: [{ pluginId: "sound-editor" }] })), ["doc", "sheet", "deck", "sound-editor"]);
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
  assert.ok(pic && !("install" in pic) && pic.surface.id === "image-editor");
  const model = openTarget(BUILT_IN, list, "out/ship.glb");
  assert.ok(model && "install" in model && model.install === "model-editor");
  const song = openTarget(BUILT_IN, list, "song.mp3");
  assert.ok(song && "install" in song && song.install === "sound-editor");
  assert.equal(openTarget(BUILT_IN, list, "notes.txt"), undefined);
});
