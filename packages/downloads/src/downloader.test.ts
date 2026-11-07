import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DownloadManager, type DownloadJob } from "./downloader.js";
import { estimateFit, type HardwareInfo } from "./hardware.js";

const PAYLOAD = Buffer.alloc(256 * 1024, 7);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** Serves PAYLOAD with Range support, like Hugging Face's CDN does. */
async function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "content-length": PAYLOAD.length - start });
    res.end(PAYLOAD.subarray(start));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}/model.bin` };
}

function waitFor(dm: DownloadManager, status: DownloadJob["status"]): Promise<DownloadJob> {
  return new Promise((resolve) => {
    dm.on("update", (job) => {
      if (job.status === status || job.status === "failed") resolve(job);
    });
  });
}

test("downloads, resumes a partial file and verifies SHA-256", async () => {
  const { server, url } = await startServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kesher-dl-"));
    const dest = join(dir, "model.bin");
    // Pretend a previous run stopped half way.
    await writeFile(`${dest}.part`, PAYLOAD.subarray(0, 100_000));

    const dm = new DownloadManager();
    const done = waitFor(dm, "done");
    dm.enqueue({ url, dest, size: PAYLOAD.length, sha256: SHA });
    const job = await done;

    assert.equal(job.status, "done", job.error);
    assert.deepEqual(await readFile(dest), PAYLOAD);
  } finally {
    server.close();
  }
});

test("a wrong hash fails the job", async () => {
  const { server, url } = await startServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kesher-dl-"));
    const dm = new DownloadManager();
    const failed = waitFor(dm, "failed");
    dm.enqueue({ url, dest: join(dir, "x.bin"), sha256: "0".repeat(64) });
    const job = await failed;
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /SHA-256 mismatch/);
  } finally {
    server.close();
  }
});

test("estimateFit grades against VRAM and RAM", () => {
  const GB = 1024 ** 3;
  const hw: HardwareInfo = {
    platform: "linux", cpu: "x", ramTotal: 64 * GB, ramFree: 32 * GB, unifiedMemory: false,
    gpus: [{ name: "GPU", vramTotal: 16 * GB, vramFree: 15 * GB }],
  };
  assert.equal(estimateFit(8 * GB, hw), "fits");
  assert.equal(estimateFit(23 * GB, hw), "tight");
  assert.equal(estimateFit(80 * GB, hw), "too-big");
});
