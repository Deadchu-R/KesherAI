import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { GitHubAuth, type GitHubConfig } from "./github.js";
import { GcmGitHub, type GitRun } from "./git-credential.js";

const read = async (req: IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return new URLSearchParams(raw);
};

test("device sign-in: code, waiting, then a token and the user's name", async () => {
  let polls = 0;
  const srv = createServer(async (req, res) => {
    const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.url === "/login/device/code") {
      const b = await read(req);
      assert.equal(b.get("client_id"), "Iv1.test");
      assert.match(b.get("scope")!, /repo/);
      return json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 });
    }
    if (req.url === "/login/oauth/access_token") {
      const b = await read(req);
      assert.equal(b.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      polls++;
      return json(polls < 2 ? { error: "authorization_pending" } : { access_token: "gho_x", scope: "repo,read:org,workflow" });
    }
    if (req.url === "/user") return json({ login: "Deadchu-R" });
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const config: GitHubConfig = {};
  let saved = 0;
  const g = new GitHubAuth(config, async () => void saved++, "Iv1.test", { web: base, api: base }, 0);
  const start = await g.start();
  assert.equal(start.userCode, "ABCD-1234");
  for (let i = 0; i < 1000 && !(g.connected && config.login && g.status().pending?.state === "done"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(config.token, "gho_x");
  assert.equal(config.login, "Deadchu-R");
  assert.equal(g.status().pending?.state, "done");
  assert.ok(saved >= 1);
  await g.disconnect();
  assert.equal(g.connected, false);
  srv.closeAllConnections();
  srv.close();
});

test("no client id: a clear message", async () => {
  await assert.rejects(new GitHubAuth({}, async () => undefined).start(), /not set up/);
});

test("Git Credential Manager sign-in: GCM's token is checked, only the name is saved, and GCM is asked again later", async () => {
  const srv = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer gho_gcm";
    if (!ok) return void res.writeHead(401).end("{}");
    if (req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": "gist, repo, workflow" });
      return void res.end(JSON.stringify({ login: "octo" }));
    }
    if (req.url?.startsWith("/user/repos")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify([{ full_name: "octo/a" }, { full_name: "octo/b" }]));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  // A fake git: GCM is set up, `fill` answers with a token, approve/reject are recorded.
  const calls: string[] = [];
  const run: GitRun = async (args, opts) => {
    if (args[0] === "config") return { code: 0, out: "manager\n" };
    const action = args[args.length - 1]!;
    calls.push(`${action}:${opts.env?.GCM_INTERACTIVE ?? ""}`);
    return action === "fill" ? { code: 0, out: "protocol=https\nhost=github.com\nusername=octo\npassword=gho_gcm\n" } : { code: 0, out: "" };
  };
  const config: GitHubConfig = {};
  const g = new GitHubAuth(config, async () => undefined, undefined, { web: base, api: base }, 0, new GcmGitHub(run));
  assert.equal(await g.gcmAvailable(), true);
  g.startGcm();
  for (let i = 0; i < 500 && g.status().pending?.state === "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.status().pending?.state, "done");
  assert.deepEqual(config, { via: "gcm", login: "octo", scopes: "gist, repo, workflow" }, "no token in the config");
  assert.equal(g.status().via, "gcm");
  assert.equal(g.connected, true);
  assert.equal(g.pushToken(), undefined, "git asks GCM itself");
  assert.deepEqual(calls, ["fill:auto", "approve:never"]);
  assert.deepEqual(await g.repos(), { count: 2, more: false, names: ["octo/a", "octo/b"] });

  // After a restart (no token in memory) the token comes from GCM again, without a window.
  const again = new GitHubAuth(config, async () => undefined, undefined, { web: base, api: base }, 0, new GcmGitHub(run));
  assert.equal(again.token(), undefined);
  assert.equal(await again.getToken(), "gho_gcm");
  assert.equal(calls.at(-1), "fill:never");

  await again.disconnect();
  assert.deepEqual(config, {});
  srv.closeAllConnections();
  srv.close();
});

test("Git Credential Manager sign-in: a token GitHub refuses is reported to GCM and nothing is saved", async () => {
  const srv = createServer((_req, res) => void res.writeHead(401).end("{}"));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const calls: string[] = [];
  const run: GitRun = async (args) => {
    calls.push(args[args.length - 1]!);
    return args.at(-1) === "fill" ? { code: 0, out: "password=gho_old\n" } : { code: 0, out: "" };
  };
  const config: GitHubConfig = {};
  const g = new GitHubAuth(config, async () => undefined, undefined, { web: base, api: base }, 0, new GcmGitHub(run));
  g.startGcm();
  for (let i = 0; i < 500 && g.status().pending?.state === "waiting"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.status().pending?.state, "denied");
  assert.deepEqual(calls, ["fill", "reject"]);
  assert.deepEqual(config, {});
  srv.closeAllConnections();
  srv.close();
});
