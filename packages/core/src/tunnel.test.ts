import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredAsset, tunnelFailureFrom, tunnelUrlFrom } from "./tunnel.js";
import { createKesherServer } from "./server.js";

test("picks the cloudflared download and reads the tunnel address", () => {
  assert.deepEqual(cloudflaredAsset("win32", "x64"), { file: "cloudflared-windows-amd64.exe", archive: false });
  assert.deepEqual(cloudflaredAsset("darwin", "arm64"), { file: "cloudflared-darwin-arm64.tgz", archive: true });
  assert.deepEqual(cloudflaredAsset("linux", "arm64"), { file: "cloudflared-linux-arm64", archive: false });
  assert.equal(
    tunnelUrlFrom("2026-11-07T15:00:00Z INF |  https://brave-otter-river-mint.trycloudflare.com  |"),
    "https://brave-otter-river-mint.trycloudflare.com",
  );
  assert.equal(tunnelUrlFrom("INF Starting tunnel"), undefined);
  const err = 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: no such host';
  assert.equal(tunnelUrlFrom(err), undefined, "the API address in an error is not the tunnel");
  assert.match(tunnelFailureFrom(err) ?? "", /Could not reach Cloudflare/);
});

test("requests through a tunnel are remote even though they come from 127.0.0.1", async () => {
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-tun-")), autodetect: false, pluginRoots: [] });
  try {
    const cf = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc" };
    assert.equal((await s.app.inject({ method: "GET", url: "/api/remote", headers: cf })).statusCode, 401, "the token page never leaks through the tunnel");
    const token = s.services.config.remote.token!;
    const withToken = await s.app.inject({ method: "GET", url: "/api/remote", headers: { ...cf, authorization: `Bearer ${token}` } });
    assert.equal(withToken.statusCode, 403, "and it is local-only even with the token");
    assert.equal((await s.app.inject({ method: "GET", url: "/api/health", headers: cf })).statusCode, 401);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200, "this computer still needs no token");

    // The phone app learns this computer's name and addresses with the token.
    const links = await s.app.inject({ method: "GET", url: "/api/remote/links", headers: { ...cf, authorization: `Bearer ${token}` } });
    assert.equal(links.statusCode, 200);
    const body = links.json() as { name: string; links: Array<{ url: string }> };
    assert.ok(body.name.length > 0);
    assert.ok(!JSON.stringify(body).includes(token), "the token is not in the answer");

    // Guessing the token is cut off after 20 tries from one address.
    for (let i = 0; i < 20; i++) await s.app.inject({ method: "GET", url: "/api/health", headers: { "cf-connecting-ip": "198.51.100.1", authorization: "Bearer wrong" } });
    const locked = await s.app.inject({ method: "GET", url: "/api/health", headers: { "cf-connecting-ip": "198.51.100.1", authorization: `Bearer ${token}` } });
    assert.equal(locked.statusCode, 429);
  } finally {
    await s.close();
  }
});

test("a restart keeps the tunnel and the next start takes it over", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, writeFile: write, chmod: mode } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const { Tunnel } = await import("./tunnel.js");
  const dir = await mkdtemp(j(tmp(), "tunnel-"));
  await write(j(dir, "cloudflared"), "#!/bin/sh\necho 'INF |  https://brave-otter-river-mint.trycloudflare.com  |'\nexec sleep 30\n");
  await mode(j(dir, "cloudflared"), 0o755);
  const downloads = {} as never;
  const first = new Tunnel(dir, downloads);
  const url = await first.start(7999);
  assert.equal(url, "https://brave-otter-river-mint.trycloudflare.com");
  first.detach();
  const second = new Tunnel(dir, downloads);
  assert.equal(await second.start(7999), url);
  assert.equal(second.status().running, true);
  const { pid } = JSON.parse(await (await import("node:fs/promises")).readFile(j(dir, "running.json"), "utf8")) as { pid: number };
  second.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0));
});
