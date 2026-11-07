import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";
import type { GoogleEndpoints } from "./google.js";

/** An in-memory stand-in for Google's OAuth and Drive endpoints. */
async function fakeGoogle() {
  const files = new Map<string, { name: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string>; body?: string; trashed?: boolean }>();
  let next = 1;
  const tokenRequests: URLSearchParams[] = [];
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return raw;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await read(req));
      tokenRequests.push(form);
      const idToken = `x.${Buffer.from(JSON.stringify({ email: "roee@example.com" })).toString("base64url")}.y`;
      return json(200, { access_token: "at", expires_in: 3600, refresh_token: "rt", id_token: idToken });
    }
    if (url.pathname === "/revoke") return json(200, {});
    if (req.headers.authorization !== "Bearer at") return json(401, { error: "unauthorized" });
    if (url.pathname === "/api/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const list = [...files.entries()]
        .filter(([, f]) => !f.trashed)
        .filter(([, f]) => (parent ? f.parents?.includes(parent) : q.includes("mimeType") ? f.mimeType === "application/vnd.google-apps.folder" : true))
        .map(([id, f]) => ({ id, name: f.name, appProperties: f.appProperties }));
      return json(200, { files: list });
    }
    if (url.pathname === "/api/files" && req.method === "POST") {
      const meta = JSON.parse(await read(req)) as { name: string; mimeType: string };
      const id = `f${next++}`;
      files.set(id, meta);
      return json(200, { id });
    }
    const media = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (media && req.method === "GET") return json(200, JSON.parse(files.get(media[1]!)?.body ?? "null"));
    if (media && req.method === "PATCH") {
      Object.assign(files.get(media[1]!) ?? {}, JSON.parse(await read(req)));
      return json(200, { id: media[1] });
    }
    const upload = /^\/upload\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (upload) {
      const raw = await read(req);
      const parts = raw.split(/--kesher[0-9a-f]+/).map((p) => p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
      const meta = JSON.parse(parts[1]!) as { name: string; parents?: string[]; appProperties: Record<string, string> };
      const id = upload[1] ?? `f${next++}`;
      files.set(id, { ...files.get(id), ...meta, body: parts[2] });
      return json(200, { id });
    }
    json(404, { error: url.pathname });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoints: GoogleEndpoints = { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/api`, upload: `${base}/upload` };
  return { endpoints, files, tokenRequests, close: () => server.close() };
}

async function signIn(server: Awaited<ReturnType<typeof createKesherServer>>) {
  const { url } = (await server.app.inject({ method: "POST", url: "/api/google/connect" })).json() as { url: string };
  const auth = new URL(url);
  assert.equal(auth.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file openid email profile");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  const cb = await server.app.inject({ method: "GET", url: `/api/google/callback?code=abc&state=${auth.searchParams.get("state")}` });
  assert.match(cb.body, /connected to Google/);
}

test("connect, upload on save, and a second computer downloads it", async () => {
  const g = await fakeGoogle();
  const dirA = await mkdtemp(join(tmpdir(), "kesher-ga-"));
  const a = await createKesherServer({ dataDir: dirA, autodetect: false, pluginRoots: [], googleEndpoints: g.endpoints });
  try {
    const before = (await a.app.inject({ method: "GET", url: "/api/google" })).json() as { configured: boolean };
    assert.equal(before.configured, false);
    assert.equal((await a.app.inject({ method: "POST", url: "/api/google/connect" })).statusCode, 400, "needs a client id");
    await a.app.inject({ method: "PUT", url: "/api/google/client", payload: { clientId: "cid.apps.googleusercontent.com", clientSecret: "sec" } });

    await signIn(a);
    assert.equal(g.tokenRequests[0]?.get("code_verifier")?.length, 43, "PKCE verifier sent");
    assert.equal(g.tokenRequests[0]?.get("client_secret"), "sec");
    const status = (await a.app.inject({ method: "GET", url: "/api/google" })).json() as { connected: boolean; email: string };
    assert.deepEqual([status.connected, status.email], [true, "roee@example.com"]);

    await a.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Drive project" } });
    const synced = (await a.app.inject({ method: "POST", url: "/api/google/sync" })).json() as { uploaded: number };
    assert.equal(synced.uploaded, 1);
    const uploaded = [...g.files.values()].filter((f) => f.appProperties?.kind === "projects");
    assert.equal(uploaded.length, 1);
    assert.match(uploaded[0]!.body ?? "", /Drive project/);
  } finally {
    await a.close();
  }

  const dirB = await mkdtemp(join(tmpdir(), "kesher-gb-"));
  const b = await createKesherServer({ dataDir: dirB, autodetect: false, pluginRoots: [], googleEndpoints: g.endpoints });
  try {
    await b.app.inject({ method: "PUT", url: "/api/google/client", payload: { clientId: "cid.apps.googleusercontent.com" } });
    await signIn(b);
    const r = (await b.app.inject({ method: "POST", url: "/api/google/sync" })).json() as { downloaded: number };
    assert.equal(r.downloaded, 1);
    const projects = (await b.app.inject({ method: "GET", url: "/api/projects" })).json() as Array<{ name: string }>;
    assert.deepEqual(projects.map((p) => p.name), ["Drive project"]);

    await b.app.inject({ method: "POST", url: "/api/google/disconnect" });
    assert.equal(((await b.app.inject({ method: "GET", url: "/api/google" })).json() as { connected: boolean }).connected, false);
  } finally {
    await b.close();
    g.close();
  }
});

test("a reused or unknown sign-in state is refused", async () => {
  const g = await fakeGoogle();
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-gc-")), autodetect: false, pluginRoots: [], googleEndpoints: g.endpoints });
  try {
    await s.app.inject({ method: "PUT", url: "/api/google/client", payload: { clientId: "cid" } });
    const cb = await s.app.inject({ method: "GET", url: "/api/google/callback?code=abc&state=forged" });
    assert.match(cb.body, /expired/);
    const remote = await s.app.inject({ method: "POST", url: "/api/google/connect", remoteAddress: "192.168.1.9", headers: { authorization: `Bearer ${s.services.config.remote.token}` } });
    assert.equal(remote.statusCode, 403, "sign-in only from this computer");
  } finally {
    await s.close();
    g.close();
  }
});
