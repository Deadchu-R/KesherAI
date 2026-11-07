import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { GitHubAuth, type GitHubConfig } from "./github.js";

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
  for (let i = 0; i < 200 && !g.connected; i++) await new Promise((r) => setTimeout(r, 10));
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
