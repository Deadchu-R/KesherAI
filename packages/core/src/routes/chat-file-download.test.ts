import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import { createKesherServer } from "../server.js";

/** A model that is never asked: a chat needs one to be created. */
const idle: ProviderFactory = {
  type: "idle",
  displayName: "Idle",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Idle",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async () => ({ text: "ok", toolCalls: [] }),
  }),
};

/**
 * The download a file card's button uses (and the phone streams from the PC): it works for this computer, from
 * another device only with the device's key, and never serves a path outside the chat's folder.
 */
test("chat file download: authorized from another device, and never outside the chat's folder", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-dl-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(idle);
  const app = server.app;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "idle", type: "idle" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "idle/m" } } });
    const made = await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } });
    const { id } = made.json() as { id: string };
    assert.ok(id, made.body);
    const listed = await app.inject({ url: `/api/conversations/${id}/files` });
    const folder = (listed.json() as { folder: string }).folder;
    assert.ok(folder, listed.body);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "report.md"), "# hello");
    await writeFile(join(dataDir, "outside.txt"), "no");
    const url = (p: string) => `/api/conversations/${id}/files/download?path=${encodeURIComponent(p)}`;

    const local = await app.inject({ url: url("report.md") });
    assert.equal(local.statusCode, 200);
    assert.equal(local.body, "# hello");
    assert.match(String(local.headers["content-disposition"]), /attachment; filename="report\.md"/);

    for (const bad of ["../outside.txt", "..%2F..%2Foutside.txt", join(dataDir, "outside.txt")]) {
      assert.equal((await app.inject({ url: `/api/conversations/${id}/files/download?path=${bad.includes("%") ? bad : encodeURIComponent(bad)}` })).statusCode, 400, bad);
    }
    assert.equal((await app.inject({ url: url("missing.md") })).statusCode, 404);

    // From another device (the phone): refused without the key.
    const far = { remoteAddress: "100.64.1.2", headers: { host: "100.64.1.1:7420" } };
    const refused = await app.inject({ url: url("report.md"), ...far });
    assert.ok(refused.statusCode === 401 || refused.statusCode === 403, `phone without a key: ${refused.statusCode}`);
    assert.doesNotMatch(refused.body, /hello/);
  } finally {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});
