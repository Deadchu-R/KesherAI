import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { OneDrive, type OneDriveConfig } from "./onedrive.js";

/** An in-memory stand-in for Microsoft's sign-in and the OneDrive app folder. */
async function fakeMicrosoft() {
  const files = new Map<string, { path: string; body: string; modified: string }>();
  let next = 1;
  const tokens: URLSearchParams[] = [];
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return raw;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body?: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname === "/login/token") {
      const form = new URLSearchParams(await read(req));
      tokens.push(form);
      const idToken = `x.${Buffer.from(JSON.stringify({ preferred_username: "roee@outlook.com", name: "Roee" })).toString("base64url")}.y`;
      return json(200, { access_token: "at", expires_in: 3600, refresh_token: `rt${tokens.length}`, id_token: idToken });
    }
    if (req.headers.authorization !== "Bearer at") return json(401, { error: "unauthorized" });
    const p = decodeURIComponent(url.pathname);
    const children = /^\/graph\/me\/drive\/special\/approot:\/(\w+):\/children$/.exec(p);
    if (children) {
      const list = [...files.entries()].filter(([, f]) => f.path.startsWith(`${children[1]}/`));
      if (!list.length) return json(404, { error: { code: "itemNotFound" } });
      return json(200, { value: list.map(([id, f]) => ({ id, name: f.path.split("/")[1], fileSystemInfo: { lastModifiedDateTime: f.modified } })) });
    }
    const content = /^\/graph\/me\/drive\/special\/approot:\/(.+):\/content$/.exec(p);
    if (content && req.method === "PUT") {
      const body = await read(req);
      const found = [...files.entries()].find(([, f]) => f.path === content[1]);
      const id = found?.[0] ?? `i${next++}`;
      files.set(id, { path: content[1]!, body, modified: new Date().toISOString() });
      return json(200, { id });
    }
    const item = /^\/graph\/me\/drive\/items\/([^/]+)(\/content)?$/.exec(p);
    if (item && item[2]) return json(200, JSON.parse(files.get(item[1]!)?.body ?? "null"));
    if (item && req.method === "PATCH") {
      const { fileSystemInfo } = JSON.parse(await read(req)) as { fileSystemInfo: { lastModifiedDateTime: string } };
      // OneDrive keeps whole seconds.
      files.get(item[1]!)!.modified = fileSystemInfo.lastModifiedDateTime.replace(/\.\d+Z$/, "Z");
      return json(200, { id: item[1] });
    }
    const del = /^\/graph\/me\/drive\/special\/approot:\/(.+)$/.exec(p);
    if (del && req.method === "DELETE") {
      const found = [...files.entries()].find(([, f]) => f.path === del[1]);
      if (!found) return json(404, {});
      files.delete(found[0]);
      return json(204);
    }
    json(404, { error: "no route" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, files, tokens, endpoints: { login: `http://127.0.0.1:${port}/login`, graph: `http://127.0.0.1:${port}/graph` } };
}

test("OneDrive: PKCE sign-in, upload with the item's time, list, download, remove", async () => {
  const ms = await fakeMicrosoft();
  try {
    const config: OneDriveConfig = {};
    let saves = 0;
    const od = new OneDrive(config, async () => void saves++, ms.endpoints, "00000000-0000-0000-0000-000000000001");
    assert.equal(od.configured, true);
    assert.equal(od.connected, false);

    const url = new URL(od.authUrl("http://localhost:7420/api/onedrive/callback"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope")!, /Files\.ReadWrite\.AppFolder/);
    assert.doesNotMatch(url.searchParams.get("scope")!, /Files\.ReadWrite\.All/);
    await assert.rejects(od.finish("code", "wrong-state"), /expired/);
    const email = await od.finish("code", url.searchParams.get("state")!);
    assert.equal(email, "roee@outlook.com");
    assert.equal(config.refreshToken, "rt1");
    assert.ok(ms.tokens[0]!.get("code_verifier"));
    assert.equal(ms.tokens[0]!.get("client_secret"), null);

    const updatedAt = "2026-11-08T10:00:00.123Z";
    await od.upload("conversations", "c1", { updatedAt, title: "hi" } as { updatedAt: string });
    const list = await od.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.kind, "conversations");
    assert.equal(list[0]!.id, "c1");
    assert.equal(list[0]!.updatedAt, "2026-11-08T10:00:00Z");
    assert.deepEqual(await od.download(list[0]!.fileId), { updatedAt, title: "hi" });

    await od.remove("conversations", "c1");
    await od.remove("conversations", "missing");
    assert.equal((await od.list()).length, 0);

    await od.disconnect();
    assert.equal(od.connected, false);
    assert.equal(config.email, undefined);
    assert.ok(saves >= 2);
  } finally {
    ms.server.close();
  }
});

test("OneDrive: no application id gives a clear message", () => {
  const od = new OneDrive({}, async () => undefined);
  assert.equal(od.configured, false);
  assert.throws(() => od.authUrl("http://localhost/x"), /application id/);
});
