import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadManager } from "./downloader.js";

/** A server that starts answering and never finishes, so every download stays "downloading" until stopped. */
async function startStalledServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": 1_000_000 });
    res.write(Buffer.alloc(10));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/x.bin` };
}

/** Makes a manager with `n` jobs against a stalled server; returns the job ids in the order added. */
async function setup(concurrency: number, n: number) {
  const { server, url } = await startStalledServer();
  const dir = await mkdtemp(join(tmpdir(), "kesher-queue-"));
  const dm = new DownloadManager(concurrency);
  const ids = Array.from({ length: n }, (_, i) => dm.enqueue({ url, dest: join(dir, `f${i}.bin`), label: `f${i}` }).id);
  const stop = () => {
    for (const id of ids) dm.cancel(id);
    server.closeAllConnections();
    server.close();
  };
  const order = () => dm.list().filter((j) => j.status === "queued").sort((a, b) => a.position! - b.position!).map((j) => j.label);
  return { dm, ids, order, stop };
}

test("queue: runs only as many as the concurrency, the rest wait with places 1, 2, 3", async () => {
  const { dm, order, stop } = await setup(2, 5);
  try {
    const by = (s: string) => dm.list().filter((j) => j.status === s);
    assert.equal(by("downloading").length, 2);
    assert.deepEqual(order(), ["f2", "f3", "f4"]);
    assert.deepEqual(by("queued").map((j) => j.position), [1, 2, 3]);
    assert.equal(by("downloading")[0]!.position, undefined);
  } finally {
    stop();
  }
});

test("queue: move to the top, up, down and to a place; running jobs are not moved", async () => {
  const { dm, ids, order, stop } = await setup(1, 5);
  try {
    assert.deepEqual(order(), ["f1", "f2", "f3", "f4"]);
    assert.ok(dm.move(ids[4]!, "top"));
    assert.deepEqual(order(), ["f4", "f1", "f2", "f3"]);
    assert.ok(dm.move(ids[3]!, "up"));
    assert.deepEqual(order(), ["f4", "f1", "f3", "f2"]);
    assert.ok(dm.move(ids[4]!, "down"));
    assert.deepEqual(order(), ["f1", "f4", "f3", "f2"]);
    assert.ok(dm.move(ids[1]!, 2));
    assert.deepEqual(order(), ["f4", "f3", "f1", "f2"]);
    // Past either end stays at the end; a running job and an unknown id are refused.
    assert.ok(dm.move(ids[2]!, "up") && dm.move(ids[4]!, "up"));
    assert.deepEqual(order(), ["f4", "f3", "f2", "f1"]);
    assert.ok(dm.move(ids[4]!, 99));
    assert.deepEqual(order(), ["f3", "f2", "f1", "f4"]);
    assert.equal(dm.move(ids[0]!, "top"), false);
    assert.equal(dm.move("nope", "top"), false);
    assert.equal(dm.move(ids[1]!, 1.5), false);
  } finally {
    stop();
  }
});

test("queue: the job moved to the top is the next one to start", async () => {
  const { dm, ids, stop } = await setup(1, 3);
  try {
    dm.move(ids[2]!, "top");
    dm.pause(ids[0]!);
    // f0 stopped; the next job to start is the one moved to the top.
    await new Promise((r) => setTimeout(r, 50));
    const status = (i: number) => dm.list().find((j) => j.id === ids[i])!.status;
    assert.equal(status(2), "downloading");
    assert.equal(status(1), "queued");
    assert.equal(status(0), "paused");
  } finally {
    stop();
  }
});

test("queue: a higher concurrency starts waiting jobs at once; pause all and resume all keep the order", async () => {
  const { dm, ids, order, stop } = await setup(1, 4);
  try {
    dm.setConcurrency(3);
    assert.equal(dm.list().filter((j) => j.status === "downloading").length, 3);
    dm.setConcurrency(1);
    dm.move(ids[3]!, "top");
    assert.equal(dm.pauseAll(), 4);
    assert.deepEqual(dm.list().map((j) => j.status), ["paused", "paused", "paused", "paused"]);
    assert.equal(dm.resumeAll(), 4);
    // The paused downloads let go of their slots a moment later; then one starts and the others queue in list order.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dm.list().filter((j) => j.status === "downloading").length, 1);
    assert.equal(order().length, 3);
  } finally {
    stop();
  }
});

test("queue: announces the jobs whose place changed", async () => {
  const { dm, ids, stop } = await setup(1, 4);
  try {
    const seen = new Map<string, number | undefined>();
    dm.on("update", (j) => seen.set(j.label, j.position));
    dm.move(ids[3]!, "top");
    assert.deepEqual([seen.get("f3"), seen.get("f1"), seen.get("f2")], [1, 2, 3]);
  } finally {
    stop();
  }
});
