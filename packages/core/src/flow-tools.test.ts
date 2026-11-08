import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyUIProvider } from "@kesher/providers";
import { createKesherServer } from "./server.js";

test("make_music and make_3d are chat tools while Nodes is on, and say what is missing first", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-flowtools-")), autodetect: false, pluginRoots: [] });
  try {
    const tools = server.services.conversations.mediaTools().tools;
    const music = tools.find((t) => t.spec.name === "make_music");
    assert.ok(music && tools.some((t) => t.spec.name === "make_3d"));
    const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
    const out = await music.run({ tags: "pop" }, ctx);
    assert.match(out.output, /not installed|download/i);
    server.services.config.parts = { nodes: false };
    assert.equal(server.services.conversations.mediaTools().tools.some((t) => t.spec.name === "make_music"), false);
  } finally {
    await server.close();
  }
});

test("runFlow returns every file a flow saved (sound, 3D), not only pictures", async () => {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/prompt") return res.end(JSON.stringify({ prompt_id: "p1" }));
    if (url.pathname === "/history/p1") {
      return res.end(JSON.stringify({ p1: { status: { completed: true }, outputs: { "10": { audio: [{ filename: "song.mp3", subfolder: "audio", type: "output" }] }, "11": { "3d": [{ filename: "m.glb", subfolder: "mesh", type: "output" }] }, "12": { images: [{ filename: "tmp.png", subfolder: "", type: "temp" }] } } } }));
    }
    if (url.pathname === "/view") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(url.searchParams.get("filename"));
    }
    res.statusCode = 404;
    res.end();
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  try {
    const p = new ComfyUIProvider({ id: "c", type: "comfyui", name: "c", baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, location: "local" });
    const files = await p.runFlow({ "1": { class_type: "X", inputs: {} } });
    assert.deepEqual(files.map((f) => [f.filename, f.mimeType]), [["song.mp3", "audio/mpeg"], ["m.glb", "model/gltf-binary"]]);
  } finally {
    srv.close();
  }
});
