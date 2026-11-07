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

test("performance estimates rank models sensibly on a 12 GB RTX 4070 Ti", async () => {
  const { estimatePerformance } = await import("./hardware.js");
  const GB = 1024 ** 3;
  const hw: HardwareInfo = {
    platform: "win32", cpu: "AMD Ryzen 7", ramTotal: 64 * GB, ramFree: 40 * GB, unifiedMemory: false,
    gpus: [{ name: "NVIDIA GeForce RTX 4070 Ti", vramTotal: 12 * GB, vramFree: 11 * GB }],
  };
  const small = estimatePerformance(2.5 * GB, hw);
  const mid = estimatePerformance(9 * GB, hw);
  const moe = estimatePerformance(18.6 * GB, hw, { activeFraction: 0.11 });
  const dense30 = estimatePerformance(18.6 * GB, hw);
  const huge = estimatePerformance(120 * GB, hw);
  assert.equal(small.rating, "good");
  assert.ok(small.tokensPerSecond > mid.tokensPerSecond);
  assert.ok(moe.tokensPerSecond > dense30.tokensPerSecond * 3, "MoE models read only their active experts");
  assert.equal(dense30.rating, "slow");
  assert.equal(huge.rating, "too-big");
  assert.equal(huge.tasks.length, 0);
  assert.deepEqual(small.tasks.map((t) => t.task), ["short-answer", "long-answer", "read-file", "load"]);
});

test("summarizeCard keeps the first real paragraphs of a model card", async () => {
  const { summarizeCard, parametersFromName } = await import("./huggingface.js");
  const card = `---\nlicense: apache-2.0\n---\n# Qwen3-8B\n\n<img src="x.png">\n\n[![badge](b.svg)](https://x)\n\n**Qwen3** is the latest generation of [large language models](https://qwen.ai) in the Qwen series, with dense and MoE models.\n\n| a | b |\n|---|---|\n\nIt supports thinking and non-thinking modes in one model, switching seamlessly.`;
  assert.equal(
    summarizeCard(card),
    "Qwen3 is the latest generation of large language models in the Qwen series, with dense and MoE models.\n\nIt supports thinking and non-thinking modes in one model, switching seamlessly.",
  );
  assert.equal(parametersFromName("Qwen/Qwen3-8B-GGUF"), "8B");
  assert.equal(parametersFromName("unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"), "30B");
  assert.equal(parametersFromName("HuggingFaceTB/SmolLM2-135M-Instruct"), "135M");
  assert.equal(parametersFromName("black-forest-labs/FLUX.1-dev"), undefined);
});

test("pause keeps the part file and resume finishes the download", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DownloadManager } = await import("./downloader.js");
  const data = Buffer.alloc(400_000, 7);
  const srv = createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { "content-length": String(data.length - start) });
    // Send slowly so there is time to pause.
    let i = start;
    const tick = () => {
      if (i >= data.length) return res.end();
      res.write(data.subarray(i, i + 20_000));
      i += 20_000;
      setTimeout(tick, 15);
    };
    tick();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/f.bin`;
  const dir = await mkdtemp(join(tmpdir(), "kesher-dl-"));
  const dm = new DownloadManager();
  const job = dm.enqueue({ url, dest: join(dir, "f.bin"), size: data.length });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(dm.pause(job.id));
  assert.equal(dm.list()[0]!.status, "paused");
  const got = dm.list()[0]!.received;
  assert.ok(got > 0 && got < data.length);
  dm.retry(job.id);
  for (let i = 0; i < 200 && dm.list()[0]!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(dm.list()[0]!.status, "done");
  assert.deepEqual(await readFile(join(dir, "f.bin")), data);
  srv.closeAllConnections();
  srv.close();
});

test("free space can be read for a folder that does not exist yet", async () => {
  const { freeSpace } = await import("./downloader.js");
  const free = await freeSpace("/tmp/kesher-not-there/deeper");
  assert.ok(free === undefined || free > 0);
});
