import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { createKesherServer } from "./server.js";
import { importedChatId } from "./chat-import.js";
import { ImportSessions, mediaIndex } from "./import-session.js";

/** A small ChatGPT export: one chat with a picture and an edited message, one plain chat, custom instructions. */
function chatgptZip(): Buffer {
  const m = (role: string, content: unknown) => ({ author: { role }, content, create_time: 1_762_000_000 });
  const conversations = [
    {
      conversation_id: "pic", title: "Sketch", create_time: 1_762_000_000, current_node: "a1",
      mapping: {
        r: { parent: null, children: ["ctx"], message: null },
        ctx: { parent: "r", children: ["u1", "u2"], message: { ...m("user", { content_type: "user_editable_context", user_profile: "", user_instructions: "Be short." }), metadata: { is_visually_hidden_from_conversation: true } } },
        u1: { parent: "ctx", children: ["a1"], message: m("user", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-Ab12" }, "What is this?"] }) },
        a1: { parent: "u1", children: [], message: m("assistant", { content_type: "text", parts: ["A sketch."] }) },
        u2: { parent: "ctx", children: [], message: m("user", { content_type: "text", parts: ["Never mind"] }) },
      },
    },
    { conversation_id: "plain", title: "Hello", create_time: 1_761_000_000, current_node: "u", mapping: { u: { parent: null, children: [], message: m("user", { content_type: "text", parts: ["hi"] }) } } },
  ];
  return Buffer.from(zipSync({ "conversations.json": strToU8(JSON.stringify(conversations)), "file-Ab12-sketch.png": new Uint8Array([137, 80, 78, 71]), "user.json": strToU8("{}") }));
}

test("pictures are found in the zip by ChatGPT's pointer or Gemini's file name", () => {
  const find = mediaIndex(["dalle-generations/file-Zz9-x.webp", "pic/image/file_00ff-a.png", "Takeout/My Activity/Gemini Apps/plan.pdf"]);
  assert.equal(find({ name: "x", ref: "file-service://file-Zz9" }), "dalle-generations/file-Zz9-x.webp");
  assert.equal(find({ name: "x", ref: "sediment://file_00ff" }), "pic/image/file_00ff-a.png");
  assert.equal(find({ name: "plan.pdf", ref: "gemini:plan.pdf" }), "Takeout/My Activity/Gemini Apps/plan.pdf");
  assert.equal(find({ name: "none" }), undefined);
});

test("import from an uploaded zip: preview, pick, pictures attached, branches kept, a second import adds nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-import-up-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    const upload = async () => {
      const r = await server.app.inject({ method: "POST", url: "/api/import/upload", headers: { "content-type": "application/x-kesher-import", "x-file-name": encodeURIComponent("צ'אטים.zip") }, payload: chatgptZip() });
      assert.equal(r.statusCode, 200, r.body);
      return r.json() as { token: string; source: string; chats: Array<{ key: string; branches: number; files: number; have: boolean; messages: number }>; personas: Array<{ name: string; have: boolean }>; from: string; to: string };
    };
    const p = await upload();
    assert.equal(p.source, "chatgpt");
    assert.deepEqual(p.chats.map((c) => [c.key, c.branches, c.files, c.have]), [["pic", 1, 1, false], ["plain", 0, 0, false]]);
    assert.ok(p.from < p.to);
    assert.deepEqual(p.personas.map((x) => [x.name, x.have]), [["ChatGPT custom instructions", false]]);
    // The preview is still there if the page is opened again (the phone switched apps).
    const pending = (await server.app.inject({ method: "POST", url: "/api/import/preview", payload: {} })).json() as { preview: { token: string } };
    assert.equal(pending.preview.token, p.token);

    const c = await server.app.inject({ method: "POST", url: "/api/import/commit", payload: { token: p.token, keys: ["pic"], personas: [0] } });
    assert.equal(c.statusCode, 200, c.body);
    assert.deepEqual(c.json(), { source: "chatgpt", added: 2, skipped: 0, personas: 1 });
    const main = await server.services.library.getConversation(importedChatId("chatgpt", "pic"));
    assert.equal(main?.importedFrom, "chatgpt");
    const first = main?.events[0] as { text: string };
    assert.equal(first.text, "What is this?\n\n[Attached: imported/1/sketch.png]");
    const picture = join(server.services.conversations.workspaceOf(main!)!, "imported", "1", "sketch.png");
    assert.deepEqual([...(await readFile(picture))], [137, 80, 78, 71]);
    const branch = await server.services.library.getConversation(importedChatId("chatgpt", "pic#u2"));
    assert.deepEqual(branch?.branchOf, { id: main!.id, seq: 1, title: "Sketch" });
    assert.equal(branch?.title, "Sketch ↳");
    assert.equal(await server.services.library.getConversation(importedChatId("chatgpt", "plain")), undefined, "not picked");
    assert.equal(existsSync(join(dataDir, "imports", `${p.token}.upload`)), false, "the upload is deleted");

    // Again: what is here is marked, and importing everything adds only the chat left out before.
    const again = await upload();
    assert.deepEqual(again.chats.map((x) => x.have), [true, false]);
    assert.equal(again.personas[0]!.have, true);
    const c2 = (await server.app.inject({ method: "POST", url: "/api/import/commit", payload: { token: again.token, personas: [0] } })).json() as { added: number; skipped: number; personas: number };
    assert.deepEqual([c2.added, c2.skipped, c2.personas], [1, 2, 0]);

    const bad = await server.app.inject({ method: "POST", url: "/api/import/upload", headers: { "content-type": "application/x-kesher-import" }, payload: Buffer.from('[{"hello": 1}]') });
    assert.equal(bad.statusCode, 400);
    assert.match((bad.json() as { error: string }).error, /not a chat export/);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a zip entry that inflates past the limit is dropped, not written whole (zip bomb)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-import-bomb-"));
  try {
    const conversations = [{
      conversation_id: "pic", title: "Two pictures", create_time: 1_762_000_000, current_node: "u1",
      mapping: { u1: { parent: null, children: [], message: { author: { role: "user" }, create_time: 1_762_000_000, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-Big1" }, { content_type: "image_asset_pointer", asset_pointer: "file-service://file-Ok22" }, "Look"] } } } },
    }];
    // 64 KB of zeros deflates to a few hundred bytes; the limit here is 16 KB.
    const zip = Buffer.from(zipSync({ "conversations.json": strToU8(JSON.stringify(conversations)), "file-Big1-bomb.png": new Uint8Array(64 * 1024), "file-Ok22-fine.png": new Uint8Array([1, 2, 3]) }));
    const sessions = new ImportSessions(dir, () => false, () => false, { media: 16 * 1024, total: 1024 * 1024 });
    const token = await sessions.receive([zip], "export.zip");
    await sessions.preview(token);
    const seen: Array<string | undefined> = [];
    await sessions.commit(token, {}, {
      saveChats: async (chats, media) => {
        for (const c of chats) for (const m of c.messages) for (const f of m.files ?? []) seen.push(media(f) ? f.ref : undefined);
        return { added: chats.length, skipped: 0 };
      },
      savePersona: async () => false,
    });
    assert.deepEqual(seen, [undefined, "file-service://file-Ok22"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
