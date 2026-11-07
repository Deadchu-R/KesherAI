import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createKesherServer } from "./server.js";

test("a chat gets its own files folder that can be listed and downloaded", async () => {
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-files-")), autodetect: false, pluginRoots: [] });
  try {
    const c = (await s.app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", modelId: "x/y" } })).json() as { id: string; mode: string };
    assert.equal(c.mode, "auto-edit", "chats edit their own folder without asking");
    const { folder } = (await s.app.inject({ method: "GET", url: `/api/conversations/${c.id}/files` })).json() as { folder: string };
    assert.ok(folder.includes(join("outputs", c.id)));
    await s.services.conversations.open(c.id); // creates the folder
    await writeFile(join(folder, "calculator.py"), "print(1+1)\n");

    const list = (await s.app.inject({ method: "GET", url: `/api/conversations/${c.id}/files` })).json() as { files: Array<{ path: string; size: number }> };
    assert.deepEqual(list.files.map((f) => [f.path, f.size]), [["calculator.py", 11]]);

    const one = await s.app.inject({ method: "GET", url: `/api/conversations/${c.id}/files/download?path=calculator.py` });
    assert.equal(one.body, "print(1+1)\n");
    assert.match(String(one.headers["content-disposition"]), /attachment/);
    const escape = await s.app.inject({ method: "GET", url: `/api/conversations/${c.id}/files/download?path=../../config.json` });
    assert.equal(escape.statusCode, 400);

    const zip = await s.app.inject({ method: "GET", url: `/api/conversations/${c.id}/files/zip` });
    const entries = unzipSync(new Uint8Array(zip.rawPayload));
    assert.equal(Buffer.from(entries["calculator.py"]!).toString(), "print(1+1)\n");
  } finally {
    await s.close();
  }
});
