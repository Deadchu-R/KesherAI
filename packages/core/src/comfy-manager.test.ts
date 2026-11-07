import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComfyManager } from "./comfy-manager.js";

let python = true;
try {
  execFileSync(process.platform === "win32" ? "python" : "python3", ["--version"]);
} catch {
  python = false;
}

test("runs the user's own ComfyUI folder, waits until it answers, and stops it", { skip: !python }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-comfy-"));
  const own = join(dir, "MyComfy");
  await import("node:fs/promises").then((f) => f.mkdir(own));
  // A stand-in for ComfyUI: answers /system_stats on --port, and records its arguments.
  await writeFile(
    join(own, "main.py"),
    `import sys, http.server, json\nargs = sys.argv\nport = int(args[args.index("--port") + 1])\nopen("args.json", "w").write(json.dumps(args))\nclass H(http.server.BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")\n    def log_message(self, *a): pass\nhttp.server.HTTPServer(("127.0.0.1", port), H).serve_forever()\n`,
  );
  const port = 18000 + Math.floor(Math.random() * 1000);
  const ready: string[] = [];
  const m = new ComfyManager(join(dir, "engines"), {
    downloads: {} as never,
    runtimes: {} as never,
    modelsDir: () => join(dir, "models"),
    port: () => port,
    folder: () => own,
    nvidia: async () => false,
    onReady: (u) => void ready.push(u),
  });
  assert.equal(m.status().installed, true);
  assert.equal(m.status().managed, false);
  await m.start(20_000);
  assert.equal(m.status().running, true);
  assert.deepEqual(ready, [`http://127.0.0.1:${port}`]);
  const args = JSON.parse(await import("node:fs/promises").then((f) => f.readFile(join(own, "args.json"), "utf8"))) as string[];
  assert.ok(args.includes("--extra-model-paths-config") && args.includes("--cpu"));
  await m.stop();
  assert.equal(m.status().running, false);
});

test("without ComfyUI it says how to get it", async () => {
  const m = new ComfyManager(join(await mkdtemp(join(tmpdir(), "kesher-comfy-")), "e"), { downloads: {} as never, runtimes: {} as never, modelsDir: () => "/m", port: () => 8188, folder: () => undefined, nvidia: async () => false, onReady: () => undefined });
  assert.equal(m.status().installed, false);
  await assert.rejects(m.start(), /not installed/);
});
