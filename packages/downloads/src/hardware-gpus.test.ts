import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gpuBandwidth, linuxGpus } from "./hardware.js";

test("Linux: AMD and Intel cards are read from the kernel; NVIDIA is left to nvidia-smi", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-drm-"));
  const card = async (n: string, vendor: string, extra: Record<string, string> = {}) => {
    const dev = join(root, n, "device");
    await mkdir(dev, { recursive: true });
    await writeFile(join(dev, "vendor"), `${vendor}\n`);
    for (const [k, v] of Object.entries(extra)) await writeFile(join(dev, k), v);
  };
  await card("card0", "0x1002", { mem_info_vram_total: String(16 * 1024 ** 3), mem_info_vram_used: String(1024 ** 3), product_name: "Radeon RX 7800 XT" });
  await card("card1", "0x10de");
  await card("card2", "0x8086");
  await mkdir(join(root, "card0-DP-1"), { recursive: true });
  const gpus = await linuxGpus(root);
  assert.equal(gpus.length, 2);
  assert.deepEqual(gpus[0], { name: "Radeon RX 7800 XT", vramTotal: 16 * 1024 ** 3, vramFree: 15 * 1024 ** 3, vendor: "amd" });
  assert.equal(gpus[1]!.vendor, "intel");
  const hw = { platform: "linux" as const, cpu: "x", ramTotal: 0, ramFree: 0, unifiedMemory: false, gpus };
  assert.equal(gpuBandwidth(hw), 624);
});
