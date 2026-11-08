import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastDownload, redact } from "./fast-download.js";

test("downloads in parts, resumes a part that drops, and checks the size", async () => {
  const data = new Uint8Array(20 * 1024 * 1024).map((_, i) => i % 251);
  let drops = 1;
  const f = (async (_u: string | URL, init?: RequestInit) => {
    const m = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>)?.range));
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, data.length - 1];
    const slice = data.subarray(a, b + 1);
    // The first request of the second part stops half way.
    if (drops > 0 && a > 0 && a < data.length / 2) {
      drops--;
      const half = slice.subarray(0, slice.length / 2);
      return new Response(new ReadableStream({ start(c) { c.enqueue(half); c.close(); } }), { status: 206 });
    }
    return new Response(slice, { status: 206 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "kesher-fd-"));
  const lines: string[] = [];
  await fastDownload("https://x/y", join(dir, "f"), { size: data.length, fetchImpl: f, log: (l) => lines.push(l) });
  assert.deepEqual(new Uint8Array(await readFile(join(dir, "f"))), data);
  assert.ok(lines.some((l) => /trying again/.test(l)));

  await assert.rejects(fastDownload("https://x/y", join(dir, "g"), { size: 100, fetchImpl: (async () => new Response(new Uint8Array(50), { status: 200 })) as unknown as typeof fetch }), /attempt|not 100|closed early|failed/i);
});

test("logs keep no secrets", () => {
  assert.equal(redact("GET https://h/?token=abcdef123&x=1 Bearer abcdefghijkl kd_1234567890"), "GET https://h/?token=…&x=1 Bearer … kd_…");
});

test("the installer's sha512 is read from the release feed", async () => {
  const { expectedSha512 } = await import("./updates.js");
  const yml = "version: 0.5.33\nfiles:\n  - url: KesherAI-Setup-0.5.33.exe\n    sha512: QDZP72k1==\n    size: 105217283\npath: KesherAI-Setup-0.5.33.exe\nsha512: QDZP72k1==\n";
  assert.equal(expectedSha512(yml, "KesherAI-Setup-0.5.33.exe"), "QDZP72k1==");
  assert.equal(expectedSha512(yml, "other.exe"), undefined);
});
