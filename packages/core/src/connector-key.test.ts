import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("a connector key opens only the MCP server", async () => {
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "conn-")), autodetect: false, pluginRoots: [] });
  try {
    const key = await s.services.deviceKeys!.issue("Claude (connector)", "mcp");
    const auth = { authorization: `Bearer ${key}` };
    const mcp = await s.app.inject({ method: "POST", url: "/mcp", remoteAddress: "192.168.1.9", headers: auth, payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(mcp.statusCode, 200);
    const viaQuery = await s.app.inject({ method: "POST", url: `/mcp?token=${encodeURIComponent(key)}`, remoteAddress: "192.168.1.9", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(viaQuery.statusCode, 200, "the link carries the key (custom connectors without headers)");
    for (const url of ["/api/conversations", "/api/settings", "/v1/models", "/api/remote/devices"]) {
      const r = await s.app.inject({ method: "GET", url, remoteAddress: "192.168.1.9", headers: auth });
      assert.equal(r.statusCode, 403, `${url} is closed to a connector key`);
    }
    const full = await s.services.deviceKeys!.issue("Phone");
    assert.equal((await s.app.inject({ method: "GET", url: "/api/conversations", remoteAddress: "192.168.1.9", headers: { authorization: `Bearer ${full}` } })).statusCode, 200);
  } finally {
    await s.close();
  }
});
