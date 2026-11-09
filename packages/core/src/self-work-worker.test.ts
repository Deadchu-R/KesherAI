import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("the main app passes self-work to the worker; both share one task board; the worker uses the main app's models", async () => {
  const mainRoot = await mkdtemp(join(tmpdir(), "main-"));
  let workerAt = "";
  const main = await createKesherServer({ dataDir: mainRoot, autodetect: false, pluginRoots: [], port: 0, workerHost: { ensure: async () => workerAt, url: () => workerAt || undefined } });
  await main.listen();
  const mainUrl = `http://127.0.0.1:${(main.app.server.address() as { port: number }).port}`;
  const worker = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "worker-")), autodetect: false, pluginRoots: [], port: 0, worker: { mainUrl, mainRoot, version: "9.9.9" } });
  await worker.listen();
  const workerUrl = `http://127.0.0.1:${(worker.app.server.address() as { port: number }).port}`;
  workerAt = workerUrl;
  try {
    // The main app answers with the worker's state (and the worker says its version).
    const st = await fetch(`${workerUrl}/api/self-work`).then((r) => r.json() as Promise<{ version?: string }>);
    assert.equal(st.version, "9.9.9");
    // Through the main app: the worker's run (none yet), and the main app knows the worker is up.
    const viaMain = (await main.app.inject({ method: "GET", url: "/api/self-work" })).json() as { run: unknown; worker?: boolean };
    assert.deepEqual(viaMain, { run: null, worker: true });
    const log = (await main.app.inject({ method: "GET", url: "/api/self-work/log" })).json() as { lines: string[]; waiting: unknown[] };
    assert.deepEqual(log, { lines: [], waiting: [] });
    // A start the main app refuses never reaches the worker; one that passes gets the worker's own answer.
    assert.equal((await main.app.inject({ method: "POST", url: "/api/self-work/start", payload: { repo: "/etc", goal: "x" } })).statusCode, 400);
    const plain = await mkdtemp(join(homedir(), "kesher-not-git-"));
    const notGit = await main.app.inject({ method: "POST", url: "/api/self-work/start", payload: { repo: plain, goal: "x" } });
    await rm(plain, { recursive: true, force: true });
    assert.match((notGit.json() as { error: string }).error, /not a git project/, "the worker checked the folder");
    // One board: a task added in the main app is on the worker's board.
    await main.app.inject({ method: "POST", url: "/api/self-work/board", payload: { changes: [{ op: "add", title: "From Roee" }] } });
    const b = await worker.services.board!.read();
    assert.deepEqual(b.tasks.map((t) => t.title), ["From Roee"]);
    // The worker reaches the main app's models through its local API.
    assert.ok(worker.services.registry.get("main"), "the worker's model connection is the main app");
    // Worker-only route: refused on the main app.
    const up = await main.app.inject({ method: "POST", url: "/api/self-work/upgrade" });
    assert.equal(up.statusCode, 403);
    // The worker never opens remote access.
    assert.equal(worker.services.config.remote.enabled, false);
  } finally {
    await worker.close();
    await main.close();
  }
});
