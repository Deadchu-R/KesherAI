import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DownloadManager, type DownloadJob } from "./downloader.js";
import { loadParts, partsFilePath, planParts, saveParts, validParts } from "./parallel.js";

/** Bytes that differ across the file, so a part written to the wrong place shows up. */
const PAYLOAD = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 255));
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

interface Hooks {
  ranges?: boolean;
  /** Called for each request; return true to answer 500. */
  fail?: (req: IncomingMessage, from: number) => boolean;
  /** Called with each ranged request's start. */
  seen?: (from: number, headers: IncomingMessage["headers"]) => void;
  /** Bytes per chunk and ms between chunks (to make a transfer slow enough to stop or measure). */
  chunk?: number;
  gap?: number;
}

/** A file server with Range support that can fail, refuse ranges or be slow. */
async function serve(h: Hooks = {}): Promise<{ server: Server; url: string }> {
  const ranges = h.ranges ?? true;
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (!ranges || !m) {
      res.writeHead(200, { "content-length": PAYLOAD.length });
      res.end(PAYLOAD);
      return;
    }
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : PAYLOAD.length - 1;
    h.seen?.(from, req.headers);
    if (h.fail?.(req, from)) {
      res.writeHead(500);
      res.end();
      return;
    }
    const body = PAYLOAD.subarray(from, to + 1);
    res.writeHead(206, { "content-length": body.length, "content-range": `bytes ${from}-${to}/${PAYLOAD.length}`, "accept-ranges": "bytes" });
    const step = h.chunk ?? body.length;
    let at = 0;
    const next = () => {
      if (res.destroyed) return;
      if (at >= body.length) return void res.end();
      res.write(body.subarray(at, at + step));
      at += step;
      setTimeout(next, h.gap ?? 0);
    };
    next();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/m.bin` };
}

/** A manager that splits files of 64 KB or more, with short retry waits. */
function manager(parts = 4): DownloadManager {
  const dm = new DownloadManager();
  dm.parts = parts;
  dm.parallelMinBytes = 64 * 1024;
  dm.partBackoffMs = 5;
  return dm;
}

const waitFor = (dm: DownloadManager, status: DownloadJob["status"]) =>
  new Promise<DownloadJob>((resolve) => dm.on("update", (j) => (j.status === status || j.status === "failed") && resolve(j)));

test("planParts tiles the file and validParts rejects bad states", () => {
  const parts = planParts(1001, 4);
  assert.equal(parts.length, 4);
  assert.equal(parts[0]!.start, 0);
  assert.equal(parts[3]!.end, 1000);
  assert.ok(validParts({ size: 1001, parts }, 1001));
  assert.ok(!validParts({ size: 1001, parts }, 1002));
  assert.ok(!validParts({ size: 1001, parts: [{ start: 0, end: 10, done: 99 }] }, 11));
  assert.ok(!validParts({ size: 10, parts: [{ start: 1, end: 9, done: 0 }] }, 10));
});

test("ranges supported: 4 parts at once, correct bytes, token on every request, hash checked after", async () => {
  const starts: number[] = [];
  const tokens: (string | undefined)[] = [];
  const { server, url } = await serve({ seen: (from, h) => (starts.push(from), tokens.push(h.authorization)) });
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest, sha256: SHA, headers: { authorization: "Bearer test" } });
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
    // The probe (0-0) plus one request per part: at least four different offsets.
    assert.ok(new Set(starts).size >= 4, `offsets ${starts}`);
    assert.ok(tokens.every((t) => t === "Bearer test"));
    assert.equal(job.received, PAYLOAD.length);
    await assert.rejects(stat(partsFilePath(`${dest}.part`)));
  } finally {
    server.close();
  }
});

test("a part that fails once is tried again, the others go on", async () => {
  const failed = new Set<number>();
  const hits = new Map<number, number>();
  const quarter = PAYLOAD.length / 4;
  const { server, url } = await serve({
    seen: (from) => hits.set(from, (hits.get(from) ?? 0) + 1),
    fail: (_r, from) => {
      if (from === quarter && !failed.has(from)) return failed.add(from), true;
      return false;
    },
  });
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest });
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
    assert.equal(hits.get(quarter), 2, "the failed part asked twice");
    assert.equal(hits.get(2 * quarter), 1, "another part asked once");
  } finally {
    server.close();
  }
});

test("a part that always fails fails the job", async () => {
  const { server, url } = await serve({ fail: (_r, from) => from > 0 && from < PAYLOAD.length / 4 * 2 });
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const failed = waitFor(dm, "done");
    dm.enqueue({ url, dest });
    const job = await failed;
    assert.equal(job.status, "failed");
  } finally {
    server.close();
  }
});

test("stopped half way, then resumed: each part continues from its own offset", async () => {
  const requested: number[] = [];
  const { server, url } = await serve({ chunk: 16 * 1024, gap: 80, seen: (from) => requested.push(from) });
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const job0 = dm.enqueue({ url, dest, sha256: SHA });
    // Let it get about a third of the way.
    while (dm.list()[0]!.received <= PAYLOAD.length / 3) await new Promise((r) => setTimeout(r, 10));
    dm.pause(job0.id);
    // The parts file is written a moment after the pause (slower on the Windows runner): wait for it, up to 3 s.
    let saved = await loadParts(`${dest}.part`, PAYLOAD.length);
    for (let i = 0; i < 30 && !(saved && saved.parts.some((p) => p.done > 0)); i++) {
      await new Promise((r) => setTimeout(r, 100));
      saved = await loadParts(`${dest}.part`, PAYLOAD.length);
    }
    assert.ok(saved, "parts are saved");
    const doneBefore = saved.parts.reduce((n, p) => n + p.done, 0);
    assert.ok(doneBefore > 0 && doneBefore < PAYLOAD.length);
    const before = requested.length;
    const done = new Promise<DownloadJob>((resolve) => dm.on("update", (j) => (j.status === "done" || j.status === "failed") && resolve(j)));
    dm.retry(job0.id);
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
    // The second run did not ask for any part's start again (those parts that had begun resumed further in).
    const second = requested.slice(before);
    const begun = saved.parts.filter((p) => p.done > 0).map((p) => p.start);
    assert.ok(second.every((f) => !begun.includes(f)), `asked ${second} but parts ${begun} had begun`);
  } finally {
    server.close();
  }
});

test("a restart after a crash (new manager, saved parts) continues", async () => {
  const { server, url } = await serve();
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const part = `${dest}.part`;
    // Lay out what a crashed run leaves: a full-size file with the first half of every part in place.
    const state = { size: PAYLOAD.length, parts: planParts(PAYLOAD.length, 4) };
    const file = Buffer.alloc(PAYLOAD.length);
    for (const p of state.parts) {
      p.done = Math.floor((p.end - p.start + 1) / 2);
      PAYLOAD.copy(file, p.start, p.start, p.start + p.done);
    }
    await writeFile(part, file);
    await saveParts(part, state);
    // The setting is 1 now: saved parts still win, because the file on disk is laid out in parts.
    const dm = manager(1);
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest, sha256: SHA, size: PAYLOAD.length });
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
  } finally {
    server.close();
  }
});

test("no ranges: one stream, no parts file", async () => {
  const { server, url } = await serve({ ranges: false });
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest, sha256: SHA });
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
  } finally {
    server.close();
  }
});

test("a server that answers a part with the whole file falls back to one stream", async () => {
  // The probe (0-0) gets a 206, but the real part requests get 200: like a redirect target that refuses ranges.
  let probed = false;
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (m && m[1] === "0" && m[2] === "0" && !probed) {
      probed = true;
      res.writeHead(206, { "content-length": 1, "content-range": `bytes 0-0/${PAYLOAD.length}` });
      return void res.end(PAYLOAD.subarray(0, 1));
    }
    res.writeHead(200, { "content-length": PAYLOAD.length });
    res.end(PAYLOAD);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/m.bin`;
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest, sha256: SHA });
    const job = await done;
    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
    await assert.rejects(stat(partsFilePath(`${dest}.part`)));
  } finally {
    server.close();
  }
});

test("the setting 1 and small files stay single", async () => {
  const seen: number[] = [];
  const { server, url } = await serve({ seen: (f) => seen.push(f) });
  try {
    const dir = await mkdtemp(join(tmpdir(), "kesher-dl-"));
    const off = manager(1);
    const d1 = waitFor(off, "done");
    off.enqueue({ url, dest: join(dir, "a.bin") });
    assert.equal((await d1).status, "done");
    const small = manager();
    small.parallelMinBytes = 10 * PAYLOAD.length;
    const d2 = waitFor(small, "done");
    small.enqueue({ url, dest: join(dir, "b.bin"), size: PAYLOAD.length });
    assert.equal((await d2).status, "done");
    assert.deepEqual(seen, [], "no ranged request at all");
  } finally {
    server.close();
  }
});

test("the speed limit holds across all parts together", async () => {
  const { server, url } = await serve();
  try {
    const dest = join(await mkdtemp(join(tmpdir(), "kesher-dl-")), "m.bin");
    const dm = manager();
    // 512 KB at 256 KB/s in total should take about 2 s; four unshared limits would take 0.5 s.
    dm.limit = 256 * 1024;
    const done = waitFor(dm, "done");
    const t0 = Date.now();
    dm.enqueue({ url, dest });
    const job = await done;
    const secs = (Date.now() - t0) / 1000;
    assert.equal(job.status, "done", job.error);
    assert.ok(secs > 1.2 && secs < 6, `took ${secs}s`);
  } finally {
    server.close();
  }
});
