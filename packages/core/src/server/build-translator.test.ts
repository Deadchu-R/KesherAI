import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadJob, DownloadRequest } from "@kesher/downloads";
import { downloadTranslationModel } from "./build-translator.js";

test("the translation model's download: a second press joins the running job (scan 171)", async () => {
  const modelsDir = await mkdtemp(join(tmpdir(), "kesher-translate-"));
  const jobs: DownloadJob[] = [];
  const downloads = {
    list: () => jobs.map((j) => ({ ...j })),
    enqueue: (r: DownloadRequest): DownloadJob => {
      const job = { id: `j${jobs.length + 1}`, label: r.label ?? r.dest, url: r.url, dest: r.dest, status: "downloading", received: 0, speed: 0 } as DownloadJob;
      jobs.push(job);
      return job;
    },
  };
  const list = async () => [{ path: "model-Q4_K_M.gguf", size: 10, url: "https://huggingface.co/x/resolve/main/model-Q4_K_M.gguf" }];
  const first = await downloadTranslationModel({ downloads, modelsDir, list });
  const second = await downloadTranslationModel({ downloads, modelsDir, list });
  assert.equal(jobs.length, 1);
  assert.equal(second.jobId, first.jobId);
  // Once that job has ended (failed or cancelled), a new press starts a new one.
  jobs[0]!.status = "failed";
  await downloadTranslationModel({ downloads, modelsDir, list });
  assert.equal(jobs.length, 2);
});
