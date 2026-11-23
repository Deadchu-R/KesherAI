import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DownloadJob, DownloadRequest } from "@kesher/downloads";
import { downloadTranslationModel, findTranslationFile, translatorChosenAndPresent } from "./build-translator.js";

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

/** A models folder with empty files at the given relative paths (made-up names). */
async function folderWith(...rel: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-translate-"));
  for (const r of rel) {
    await mkdir(join(dir, dirname(r)), { recursive: true });
    await writeFile(join(dir, r), "");
  }
  return dir;
}

test("findTranslationFile finds a TranslateGemma GGUF the model downloader saved in the chat folder, any quant", async () => {
  const dir = await folderWith("chat/Someone/translategemma-4b-it-GGUF/translategemma-4b_Q5_K_M.gguf", "chat/Someone/other/llama-8b.gguf");
  assert.equal(findTranslationFile({}, dir), join(dir, "chat/Someone/translategemma-4b-it-GGUF/translategemma-4b_Q5_K_M.gguf"));
  assert.equal(findTranslationFile({}, await folderWith("chat/Someone/llama-8b.gguf")), undefined);
});

test("findTranslationFile: the model-team choice (id or name) wins over the quant order; Q4_K_M comes first otherwise", async () => {
  const dir = await folderWith("chat/a/translategemma-4b_Q4_K_M.gguf", "chat/b/translategemma-4b_Q5_K_M.gguf", "chat/b/mmproj-translategemma.gguf");
  const q5 = join(dir, "chat/b/translategemma-4b_Q5_K_M.gguf");
  assert.equal(findTranslationFile({}, dir), join(dir, "chat/a/translategemma-4b_Q4_K_M.gguf"));
  for (const translator of ["translategemma-4b_Q5_K_M", "llamacpp/translategemma-4b_Q5_K_M", q5]) {
    assert.equal(findTranslationFile({ translator }, dir), q5);
    assert.equal(translatorChosenAndPresent({ translator }, dir), true);
  }
  // `main`, `off` or a model that is not here: not "chosen"; the file found anyway is still used.
  for (const translator of ["main", "off", "llamacpp/not-here"]) assert.equal(translatorChosenAndPresent({ translator }, dir), false);
});

test("findTranslationFile still finds the one-click download's folder", async () => {
  const dir = await folderWith("translation/42ailab/TranslateGemma-4B-GGUF/some-model-Q4_K_M.gguf", "translation/readme.txt");
  assert.equal(findTranslationFile({}, dir), join(dir, "translation/42ailab/TranslateGemma-4B-GGUF/some-model-Q4_K_M.gguf"));
});
