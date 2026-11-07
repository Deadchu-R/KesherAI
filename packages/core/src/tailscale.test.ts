import { test } from "node:test";
import assert from "node:assert/strict";
import { Tailscale } from "./tailscale.js";

test("HTTPS through Tailscale: status, turn on, and the tailnet link when HTTPS is off there", async () => {
  const calls: string[] = [];
  let serving = false;
  let allowed = false;
  const ts = new Tailscale(async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.tail123.ts.net." } });
    if (args[0] === "serve" && args[1] === "status") return serving ? JSON.stringify({ Web: { "pc.tail123.ts.net:443": { Handlers: { "/": { Proxy: "http://100.101.1.2:7420" } } } } }) : "{}";
    if (args[0] === "serve" && args[1] === "--bg") {
      if (!allowed) throw new Error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n");
      serving = true;
      return "";
    }
    if (args.includes("off")) serving = false;
    return "";
  });
  assert.deepEqual(await ts.status(7420), { installed: true, running: true, on: false, url: "https://pc.tail123.ts.net" });
  const first = await ts.enable(7420, "100.101.1.2");
  assert.equal(first.on, false);
  assert.match(first.hint!, /login\.tailscale\.com\/f\/serve\?node=abc/);
  allowed = true;
  assert.equal((await ts.enable(7420, "100.101.1.2")).on, true);
  assert.ok(calls.includes("serve --bg --https=443 http://100.101.1.2:7420"));
  assert.equal((await ts.disable(7420)).on, false);
  const none = new Tailscale(async () => {
    throw new Error("spawn tailscale ENOENT");
  });
  assert.deepEqual(await none.status(7420), { installed: false, running: false, on: false });
});
