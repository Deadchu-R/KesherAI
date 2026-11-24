import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { KesherServices } from "../services.js";
import { logRoutes } from "./logs.js";

test("/api/logs: sources, search, patterns, labels; Explain needs a local model; files only on the computer", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-logs-"));
  const app = Fastify();
  try {
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", "main.log"), "2026-11-24T10:00:00Z [ERROR] Hub answered 502\n2026-11-24T10:01:00Z [ERROR] Hub answered 503\n");
    const s = {
      paths: { root },
      engine: { status: () => ({ running: false, log: ["E: out of memory"], parallel: 1 }) },
      comfy: { status: () => ({ log: [] }) },
      sd: { logFile: join(root, "none.log") },
      unreal: {},
      registry: { resolve: () => { throw new Error("unknown model"); } },
      config: { activeModels: {} },
    } as unknown as KesherServices;
    logRoutes(app, s);

    const src = (await app.inject({ url: "/api/logs/sources" })).json() as { sources: Array<{ id: string }> };
    assert.ok(src.sources.some((x) => x.id === "kesher-main") && src.sources.some((x) => x.id === "engine-llama"));

    const found = (await app.inject({ url: "/api/logs/search?source=kesher-main&q=hub&levels=error" })).json() as { matched: number };
    assert.equal(found.matched, 2);
    assert.equal((await app.inject({ url: "/api/logs/search?source=kesher-main&q=(a%2B)%2B&regex=1" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/logs/search?source=nope" })).statusCode, 404);

    const pats = (await app.inject({ url: "/api/logs/patterns?source=kesher-main" })).json() as { patterns: Array<{ id: string; count: number; lines?: number[] }> };
    assert.equal(pats.patterns[0]!.count, 2);
    assert.equal(pats.patterns[0]!.lines, undefined);
    const id = pats.patterns[0]!.id;
    assert.equal((await app.inject({ method: "PUT", url: `/api/logs/patterns/${id}/label`, payload: { source: "kesher-main", label: "bug" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url: `/api/logs/patterns/${id}/label`, payload: { source: "kesher-main", label: "wrong" } })).statusCode, 400);
    const lines = (await app.inject({ url: `/api/logs/patterns/${id}/lines?source=kesher-main` })).json() as { pattern: { label: string }; entries: unknown[] };
    assert.equal(lines.pattern.label, "bug");
    assert.equal(lines.entries.length, 2);

    const ex = await app.inject({ method: "POST", url: "/api/logs/explain", payload: { kind: "pattern", source: "kesher-main", patternId: id } });
    assert.equal(ex.statusCode, 400);
    assert.equal((ex.json() as { code: string }).code, "no-local-model");

    // From a phone (not this computer) a file cannot be added or removed.
    const remote = { remoteAddress: "192.168.1.20" };
    assert.equal((await app.inject({ method: "POST", url: "/api/logs/files", payload: { path: "/etc/passwd" }, ...remote })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/logs/files/file-x", ...remote })).statusCode, 403);
    // On the computer, a file outside the home folder is refused.
    // (On Windows the temp folder is inside the home folder, often under an 8.3 short name: compare real paths.)
    if (!realpathSync.native(root).toLowerCase().startsWith(realpathSync.native(homedir()).toLowerCase())) assert.equal((await app.inject({ method: "POST", url: "/api/logs/files", payload: { path: join(root, "logs", "main.log") } })).statusCode, 400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
