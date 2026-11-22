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

test("Funnel: a fixed public address, or the link to allow it", async () => {

  let allowed = false;
  const calls: string[] = [];
  const ts = new Tailscale(async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.tail123.ts.net." } });
    if (args[0] === "serve") return "{}";
    if (args[0] === "funnel" && args[1] === "--bg") {
      if (!allowed) throw new Error("Funnel not available; \"funnel\" node attribute not set. To enable, visit:\n\n https://login.tailscale.com/f/funnel?node=abc\n");
      return "";
    }
    return "";
  });
  const first = await ts.funnel(7420, "127.0.0.1");
  assert.match(first.hint!, /login\.tailscale\.com\/f\/funnel\?node=abc/);
  allowed = true;
  const second = await ts.funnel(7420, "127.0.0.1");
  assert.equal(second.url, "https://pc.tail123.ts.net");
  assert.ok(calls.includes("funnel --bg --https=443 http://127.0.0.1:7420"));
});

test("a request through Funnel needs a key: it names another host and is marked", async () => {
  const { isLocalRequest } = await import("./auth.js");
  assert.equal(isLocalRequest({ ip: "127.0.0.1", headers: { host: "pc.tail123.ts.net", "tailscale-funnel-request": "?1", "x-forwarded-for": "1.2.3.4" } }), false);
  assert.equal(isLocalRequest({ ip: "127.0.0.1", headers: { host: "127.0.0.1:7420" } }), true);
});

/** A fake Tailscale CLI with a Funnel on (as an older KesherAI left it): records calls, answers serve status. */
function funnelCli() {
  const calls: string[] = [];
  const st = { funnel: true, serving: true };
  const ts = new Tailscale(async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.tail123.ts.net.", TailscaleIPs: ["100.101.1.2", "fd7a:115c::1"] } });
    if (args[0] === "serve" && args[1] === "status") return JSON.stringify(st.serving ? { Web: { "pc.tail123.ts.net:443": { Handlers: { "/": { Proxy: "http://100.101.1.2:7420" } } } }, ...(st.funnel ? { AllowFunnel: { "pc.tail123.ts.net:443": true } } : {}) } : {});
    if (args[0] === "funnel" && args.includes("off")) Object.assign(st, { funnel: false, serving: false });
    if (args[0] === "serve" && args[1] === "--bg") st.serving = true;
    return "";
  });
  return { ts, calls, st };
}

test("a Funnel left on is closed and replaced by tailnet-only serve; the tailnet addresses for the phone", async () => {
  const { ts, calls, st } = funnelCli();
  assert.deepEqual(await ts.self(), { ip: "100.101.1.2", dns: "pc.tail123.ts.net" });
  assert.equal(await ts.funnelActive(), true);
  assert.equal(await ts.closeFunnel(7420, "100.101.1.2"), true);
  assert.ok(calls.includes("funnel --https=443 off"));
  assert.ok(calls.includes("serve --bg --https=443 http://100.101.1.2:7420"));
  assert.equal(st.funnel, false);
  assert.equal(await ts.closeFunnel(7420, "100.101.1.2"), false, "nothing to close the second time");
  assert.deepEqual(await ts.direct(7420), { url: "https://pc.tail123.ts.net", ip: "100.101.1.2", dns: "pc.tail123.ts.net" });
});

test("mode tailscale: serve (tailnet only) unless Funnel was explicitly allowed", async () => {
  const { Tunnel } = await import("./tunnel.js");
  const { ts, calls } = funnelCli();
  let allow = false;
  const tunnel = new Tunnel("/nonexistent-kesher-test", {} as never, { mode: () => "tailscale", tailscale: ts, tailscaleTarget: async () => "127.0.0.1", allowFunnel: () => allow });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await tunnel.start(7420), "https://pc.tail123.ts.net");
  } finally {
    console.warn = warn;
  }
  assert.ok(calls.includes("funnel --https=443 off"), "the old Funnel was closed");
  assert.ok(calls.includes("serve --bg --https=443 http://100.101.1.2:7420"));
  assert.equal(calls.some((c) => c.startsWith("funnel --bg")), false, "never a Funnel by default");
  tunnel.stop();
  assert.equal(calls.filter((c) => c === "funnel --https=443 off").length, 1, "stop keeps tailnet-only serve (the backup path)");
  allow = true;
  await tunnel.start(7420);
  assert.ok(calls.includes("funnel --bg --https=443 http://127.0.0.1:7420"), "Funnel only when allowed");
});
