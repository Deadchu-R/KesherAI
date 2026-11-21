import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DownloadManager, type DownloadJob } from "./downloader.js";

/** Bytes that differ across the file, so a hole or a part written to the wrong place shows up. */
const PAYLOAD = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 255));
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const BLOCK = 16 * 1024;

/** A file server with Range support; `gap` makes it slow (ms between 16 KB chunks); `seen` gets each ranged start. */
async function serve(opts: { gap?: number; seen?: number[] } = {}): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const from = m ? Number(m[1]) : 0;
    const to = m && m[2] ? Number(m[2]) : PAYLOAD.length - 1;
    if (m) opts.seen?.push(from);
    const body = PAYLOAD.subarray(from, to + 1);
    res.writeHead(m ? 206 : 200, { "content-length": body.length, ...(m ? { "content-range": `bytes ${from}-${to}/${PAYLOAD.length}` } : {}) });
    let at = 0;
    const next = () => {
      if (res.destroyed) return;
      if (at >= body.length) return void res.end();
      res.write(body.subarray(at, at + BLOCK));
      at += BLOCK;
      setTimeout(next, opts.gap ?? 0);
    };
    next();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/m.bin` };
}

/** A manager that splits files of 64 KB or more into 4 parts and looks for holes in 16 KB blocks. */
function manager(): DownloadManager {
  const dm = new DownloadManager();
  dm.parts = 4;
  dm.parallelMinBytes = 64 * 1024;
  dm.partBackoffMs = 5;
  dm.scanBlock = BLOCK;
  return dm;
}

const until = (dm: DownloadManager, id: string, ok: (j: DownloadJob) => boolean) =>
  new Promise<DownloadJob>((resolve) => {
    const cur = dm.get(id);
    if (cur && ok(cur)) return resolve(cur);
    dm.on("update", (j) => j.id === id && ok(j) && resolve(j));
  });

const tmp = () => mkdtemp(join(tmpdir(), "kesher-bv-"));

/** Downloads the payload and returns the manager, the finished job and the file's path. */
async function finished(url: string, extra: { sha256?: string } = { sha256: SHA }) {
  const dm = manager();
  const dest = join(await tmp(), "m.bin");
  const id = dm.enqueue({ url, dest, size: PAYLOAD.length, ...extra }).id;
  const job = await until(dm, id, (j) => j.status === "done" || j.status === "failed");
  assert.equal(job.status, "done", job.error);
  return { dm, id, dest };
}

/** Writes zeros over one block of the finished file, like a part that never landed. */
async function punchHole(dest: string, at: number): Promise<void> {
  const fh = await open(dest, "r+");
  await fh.write(Buffer.alloc(BLOCK), 0, BLOCK, at);
  await fh.close();
}

test("a game in Play pauses a running download and starts it again after; Don't slow is never paused", async () => {
  const { server, url } = await serve({ gap: 20 });
  try {
    const dm = manager();
    let playing = false;
    dm.busySource = () => ({ chat: false, playing });
    const dir = await tmp();
    const a = dm.enqueue({ url, dest: join(dir, "a.bin"), size: PAYLOAD.length }).id;
    const b = dm.enqueue({ url, dest: join(dir, "b.bin"), size: PAYLOAD.length }).id;
    dm.setDontSlow(b, true);
    await until(dm, a, (j) => j.status === "downloading");
    playing = true;
    dm.refreshBusy();
    const paused = dm.get(a)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.busy, "paused");
    assert.notEqual(dm.get(b)!.status, "paused", "marked Don't slow");
    // A waiting job is held while Play lasts.
    const c = dm.enqueue({ url, dest: join(dir, "c.bin"), size: PAYLOAD.length }).id;
    dm.setConcurrency(1);
    await new Promise((r) => setTimeout(r, 100));
    dm.refreshBusy();
    assert.equal(dm.get(c)!.busy, "paused");
    assert.equal(dm.get(c)!.status, "queued");
    playing = false;
    dm.refreshBusy();
    for (const id of [a, b, c]) assert.equal((await until(dm, id, (j) => j.status === "done" || j.status === "failed")).status, "done");
    assert.deepEqual(await readFile(join(dir, "a.bin")), PAYLOAD);
    assert.equal(dm.get(a)!.busy, undefined);
  } finally {
    server.close();
  }
});

test("a download the user paused is not started by the end of Play", async () => {
  const { server, url } = await serve({ gap: 20 });
  try {
    const dm = manager();
    dm.busySource = () => ({ chat: false, playing: false });
    const id = dm.enqueue({ url, dest: join(await tmp(), "a.bin"), size: PAYLOAD.length }).id;
    await until(dm, id, (j) => j.status === "downloading");
    dm.pause(id);
    dm.refreshBusy();
    assert.equal(dm.get(id)!.status, "paused");
    assert.equal(dm.get(id)!.busy, undefined);
  } finally {
    server.close();
  }
});

test("while the chat answers a download is badged slowed and takes longer; setting it off lets it run free", async () => {
  const { server, url } = await serve();
  try {
    const timed = async (chat: boolean, enabled: boolean) => {
      const dm = manager();
      dm.parts = 1;
      dm.slowWhenBusy = enabled;
      // 1 MB/s limit at a 25% share is the 256 KB/s floor: 512 KB takes about two seconds.
      dm.limit = 1024 * 1024;
      dm.busyShare = 0.25;
      dm.busySource = () => ({ chat, playing: false });
      const t0 = Date.now();
      const id = dm.enqueue({ url, dest: join(await tmp(), "a.bin"), size: PAYLOAD.length }).id;
      let badge: string | undefined;
      dm.on("update", (j) => { if (j.id === id && j.busy) badge = j.busy; });
      await new Promise((r) => setTimeout(r, 50));
      dm.refreshBusy();
      await until(dm, id, (j) => j.status === "done" || j.status === "failed");
      return { ms: Date.now() - t0, badge };
    };
    const slow = await timed(true, true);
    assert.equal(slow.badge, "slowed");
    assert.ok(slow.ms >= 1000, `slowed took ${slow.ms} ms`);
    const free = await timed(true, false);
    assert.equal(free.badge, undefined);
    assert.ok(free.ms < slow.ms);
  } finally {
    server.close();
  }
});

test("Verify passes a good file, shows no repair, and a job without a hash needs one", async () => {
  const { server, url } = await serve();
  try {
    const { dm, id } = await finished(url);
    assert.equal(dm.get(id)!.integrity, "ok", "checked right after the download");
    const checking = await dm.verify(id);
    assert.equal((checking as DownloadJob).status, "verifying");
    const job = await until(dm, id, (j) => j.status === "done");
    assert.equal(job.integrity, "ok");
    assert.equal(await dm.repair(id), "not-bad");

    const bare = await finished(url, {});
    assert.equal(bare.dm.get(bare.id)!.sha256, undefined);
    assert.equal(await bare.dm.verify(bare.id, async () => undefined), "no-hash");
    assert.equal(bare.dm.get(bare.id)!.status, "done", "nothing changed");
    // An old job: the hash is fetched on Verify and kept.
    await bare.dm.verify(bare.id, async () => SHA);
    assert.equal((await until(bare.dm, bare.id, (j) => j.status === "done")).integrity, "ok");
    assert.equal(bare.dm.get(bare.id)!.sha256, SHA);
  } finally {
    server.close();
  }
});

test("a hole in a part-downloaded file is found, and Repair fetches only that range", async () => {
  const seen: number[] = [];
  const { server, url } = await serve({ seen });
  try {
    const { dm, id, dest } = await finished(url);
    await punchHole(dest, 10 * BLOCK);
    await dm.verify(id);
    const bad = await until(dm, id, (j) => j.status === "done");
    assert.equal(bad.integrity, "bad");
    assert.equal(bad.repair, "ranges");
    seen.length = 0;
    await dm.repair(id);
    const fixed = await until(dm, id, (j) => j.status === "done" && j.integrity === "ok");
    assert.equal(fixed.repair, undefined);
    assert.deepEqual(seen, [10 * BLOCK], "one ranged request, at the hole only");
    assert.deepEqual(await readFile(dest), PAYLOAD);
  } finally {
    server.close();
  }
});

test("damage that is not a hole is repaired by downloading the whole file again", async () => {
  const { server, url } = await serve();
  try {
    const { dm, id, dest } = await finished(url);
    const fh = await open(dest, "r+");
    await fh.write(Buffer.from([1, 2, 3]), 0, 3, 5000);
    await fh.close();
    await dm.verify(id);
    const bad = await until(dm, id, (j) => j.status === "done");
    assert.equal(bad.integrity, "bad");
    assert.equal(bad.repair, "whole");
    await dm.repair(id);
    const fixed = await until(dm, id, (j) => j.status === "done" && j.integrity === "ok");
    assert.equal(fixed.integrity, "ok");
    assert.deepEqual(await readFile(dest), PAYLOAD);
  } finally {
    server.close();
  }
});
