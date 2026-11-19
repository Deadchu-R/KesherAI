import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS } from "./http.js";

const hubDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under a folder, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p).map((f) => join(n, f)) : [n];
  });
}

test("the page's static headers carry the same CSP as the API answers", () => {
  const headers = readFileSync(join(hubDir, "public/_headers"), "utf8");
  const csp = /^\s+Content-Security-Policy: (.+)$/m.exec(headers)?.[1];
  assert.equal(csp, SECURITY_HEADERS["content-security-policy"]);
  assert.match(headers, /X-Frame-Options: DENY/);
});

test("the committed page JS is compiled from the current sources (pnpm --filter @kesher/hub build:page)", () => {
  const out = mkdtempSync(join(tmpdir(), "kesher-hubpage-"));
  try {
    const tsc = join(hubDir, "../../node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", join(hubDir, "tsconfig.page.json"), "--outDir", out], { stdio: "pipe" });
    const committed = join(hubDir, "public/js");
    const want = files(out).sort();
    assert.deepEqual(files(committed).sort(), want, "the same files");
    for (const f of want) assert.equal(readFileSync(join(committed, f), "utf8"), readFileSync(join(out, f), "utf8"), `${relative(hubDir, join(committed, f))} is stale`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
