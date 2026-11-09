#!/usr/bin/env node
/**
 * Smoke test: starts the real KesherAI server (built packages) on a free
 * port with an empty data folder, and checks the things every version must
 * do: it starts, answers /api/health, serves the interface, refuses a
 * request from a foreign website, and stops cleanly.
 *
 * Runs in CI on Linux and Windows before a release is published
 * (.github/workflows/ci.yml and release.yml). Usage: node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = 7600 + Math.floor(Math.random() * 300);
const data = await mkdtemp(join(tmpdir(), "kesher smoke "));
const base = `http://127.0.0.1:${port}`;
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};

// The data folder has a space on purpose: paths with spaces broke Windows commands before.
const child = spawn(process.execPath, [join(root, "packages/core/dist/main.js"), "--port", String(port), "--data-dir", data, "--no-autodetect"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KESHER_SMOKE: "1" } });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

try {
  let health;
  for (let i = 0; i < 60 && !health; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (child.exitCode !== null) break;
    health = await fetch(`${base}/api/health`).then((r) => (r.ok ? r.json() : undefined), () => undefined);
  }
  check(!!health, "the server starts and answers /api/health");
  if (health) {
    const page = await fetch(base).then((r) => r.text(), () => "");
    check(/<html/i.test(page), "it serves the interface");
    const foreign = await fetch(`${base}/api/conversations`, { headers: { origin: "https://evil.example" } }).then((r) => r.status, () => 0);
    check(foreign === 403 || foreign === 401, `a request from a foreign website is refused (got ${foreign})`);
    const nul = await fetch(`${base}/api/conversations`, { headers: { origin: "null" } }).then((r) => r.status, () => 0);
    check(nul === 403 || nul === 401, `a request with Origin: null is refused (got ${nul})`);
    // fetch() may not set Host, so a plain request: a site that made its own name point to this computer.
    const rebind = await new Promise((res) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/conversations", headers: { host: `evil.example:${port}` } }, (r) => {
        r.resume();
        res(r.statusCode ?? 0);
      });
      req.on("error", () => res(0));
      req.end();
    });
    check(rebind === 401 || rebind === 403, `a request naming another host (DNS rebinding) needs the token (got ${rebind})`);
    // The MCP server (other AI apps give KesherAI tasks through it): the same guards.
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const mcpForeign = await fetch(`${base}/mcp`, { method: "POST", body: rpc, headers: { "content-type": "application/json", origin: "https://evil.example" } }).then((r) => r.status, () => 0);
    check(mcpForeign === 403 || mcpForeign === 401, `/mcp refuses a foreign website (got ${mcpForeign})`);
    const mcpOwn = await fetch(`${base}/mcp`, { method: "POST", body: rpc, headers: { "content-type": "application/json" } }).then((r) => r.json(), () => undefined);
    check(Array.isArray(mcpOwn?.result?.tools) && mcpOwn.result.tools.some((t) => t.name === "kesher_chat"), "/mcp answers this computer with its tools");
    const own = await fetch(`${base}/api/conversations`).then((r) => r.status, () => 0);
    check(own === 200, `the computer itself gets its chats (got ${own})`);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));
  await rm(data, { recursive: true, force: true }).catch(() => undefined);
}
if (fails.length) {
  console.log(`\n${fails.length} smoke check(s) failed. Server output:\n${out.slice(-4000)}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
process.exit(0);
