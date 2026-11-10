import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("the computer's load can be read, and Terminate needs its confirmation word", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-pc-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    const st = (await server.app.inject({ method: "GET", url: "/api/pc-status" })).json() as { system: unknown; cards: unknown[]; model: unknown; at: number };
    assert.ok("system" in st && Array.isArray(st.cards) && st.model === null && st.at > 0);
    assert.equal((await server.app.inject({ method: "POST", url: "/api/system/terminate", payload: {} })).statusCode, 400);
    const r = (await server.app.inject({ method: "POST", url: "/api/system/terminate", payload: { confirm: "terminate" } })).json() as { ok: boolean; restarting: boolean };
    assert.deepEqual(r, { ok: true, restarting: false }, "from the command line it frees what it can and does not restart");
    assert.ok(existsSync(join(dataDir, "terminated")), "the next start is told to stay light");
  } finally {
    await server.close();
  }
  // The next start reads the mark once (no model, no ComfyUI) and removes it.
  const again = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    assert.ok(!existsSync(join(dataDir, "terminated")));
  } finally {
    await again.close();
  }
});
