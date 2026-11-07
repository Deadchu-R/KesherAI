import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Runtimes, nodeDownload, uvAsset } from "./runtimes.js";

test("picks the Node.js LTS and uv downloads for each system", () => {
  const index = [
    { version: "v25.1.0", lts: false as const, files: ["win-x64-zip", "osx-arm64-tar", "linux-x64"] },
    { version: "v24.11.0", lts: "Krypton", files: ["win-x64-zip", "osx-arm64-tar", "linux-x64"] },
  ];
  assert.equal(nodeDownload(index, "win32", "x64")?.url, "https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip");
  assert.equal(nodeDownload(index, "darwin", "arm64")?.file, "node-v24.11.0-darwin-arm64.tar.gz");
  const assets = ["uv-x86_64-pc-windows-msvc.zip", "uv-aarch64-apple-darwin.tar.gz", "uv-x86_64-unknown-linux-gnu.tar.gz"].map((name) => ({ name }));
  assert.equal(uvAsset(assets, "win32", "x64")?.name, "uv-x86_64-pc-windows-msvc.zip");
  assert.equal(uvAsset(assets, "darwin", "arm64")?.name, "uv-aarch64-apple-darwin.tar.gz");
});

test("installed runtimes go first on the servers' PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-rt-"));
  const bin = join(dir, "node", "node-v24-win-x64");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npx.cmd"), "");
  const r = new Runtimes(dir, {} as never);
  assert.equal((await r.status()).node.installed, true);
  assert.equal((await r.status()).uv.installed, false);
  const env = await r.env({ Path: "C:\\\\Windows" });
  assert.equal(env.Path, [bin, "C:\\\\Windows"].join(delimiter));
  assert.equal(env.PATH, undefined);
});
