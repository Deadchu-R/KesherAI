import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Copilot, cleanCopilotText, copilotProvider, COPILOT_SCOPES } from "./copilot.js";
import { createKesherServer } from "./server.js";

async function fakeMicrosoft() {
  const seen: Array<{ path: string; body: unknown; form?: URLSearchParams }> = [];
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const c of req) raw += c;
    return raw;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    const raw = await read(req);
    if (url.pathname.endsWith("/token")) {
      const form = new URLSearchParams(raw);
      seen.push({ path: url.pathname, body: null, form });
      return json(200, { access_token: "at", expires_in: 3600, refresh_token: "rt", id_token: `x.${Buffer.from(JSON.stringify({ preferred_username: "roee@contoso.com" })).toString("base64url")}.y` });
    }
    if (req.headers.authorization !== "Bearer at") return json(401, {});
    seen.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === "/graph/beta/copilot/conversations") return json(201, { id: "c1" });
    if (url.pathname === "/graph/beta/copilot/conversations/c1/chat") {
      return json(200, {
        messages: [
          { text: "echo of the question" },
          { text: "You have <Event>Standup</Event> at 9 AM[^1^].", attributions: [{ attributionType: "citation", providerDisplayName: "Standup", seeMoreWebUrl: "https://teams.microsoft.com/l/meeting/1" }, { attributionType: "annotation", seeMoreWebUrl: "https://x.example" }] },
        ],
      });
    }
    json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, seen, endpoints: { login: `http://127.0.0.1:${port}/common/login`, graph: `http://127.0.0.1:${port}/graph/v1.0` } };
}

test("Copilot: work-account sign-in with the Chat API's permissions, then a question with context and sources", async () => {
  const ms = await fakeMicrosoft();
  try {
    const config = { web: false };
    const c = new Copilot(config, async () => undefined, ms.endpoints, () => "00000000-0000-0000-0000-000000000002");
    const url = new URL(c.authUrl("http://localhost:7420/api/copilot/callback"));
    assert.match(url.pathname, /\/organizations\/login\/authorize$/);
    assert.equal(url.searchParams.get("scope"), COPILOT_SCOPES);
    await c.finish("code", url.searchParams.get("state")!);
    assert.equal(c.connected, true);

    const provider = copilotProvider(c);
    assert.equal((await provider.listModels())[0]!.id, "copilot/m365-copilot");
    let text = "";
    for await (const ev of provider.chat!({ providerModelId: "m365-copilot", messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "What is at 9?" },
    ] } as never)) if (ev.type === "delta") text += ev.text;
    assert.match(text, /^You have Standup at 9 AM\[1\]\./);
    assert.match(text, /Sources:\n1\. \[Standup\]\(https:\/\/teams\.microsoft\.com\/l\/meeting\/1\)/);
    assert.doesNotMatch(text, /x\.example/);
    const chat = ms.seen.find((x) => x.path.endsWith("/chat"))!.body as { message: { text: string }; additionalContext: Array<{ text: string }>; contextualResources?: unknown };
    assert.equal(chat.message.text, "What is at 9?");
    assert.match(chat.additionalContext[0]!.text, /Answer briefly/);
    assert.match(chat.additionalContext[1]!.text, /User: hi\n\nAssistant: hello/);
    assert.deepEqual(chat.contextualResources, { webContext: { isWebEnabled: false } });
  } finally {
    ms.server.close();
  }
});

test("cleanCopilotText drops Copilot's inline tags", () => {
  assert.equal(cleanCopilotText("<Person>Dana</Person> wrote[^2^]"), "Dana wrote[2]");
});

test("business mode turns off every connection but the allowed ones; an administrator's policy.json locks it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-biz-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "echo", type: "echo" } }).catch(() => undefined);
    const on = await server.app.inject({ method: "PUT", url: "/api/business", payload: { enabled: true, allowed: ["copilot"] } });
    assert.equal(on.statusCode, 200);
    assert.equal(server.services.registry.permitted("llamacpp"), false);
    assert.equal(server.services.registry.permitted("copilot"), true);
    assert.throws(() => server.services.registry.resolve("sdcpp/x"), /business mode/);
    const list = (await server.app.inject({ method: "GET", url: "/api/business" })).json() as { providers: Array<{ id: string; on: boolean }> };
    assert.equal(list.providers.find((p) => p.id === "sdcpp")?.on, false);
    assert.notEqual((await server.app.inject({ method: "PUT", url: "/api/business", payload: { enabled: false }, remoteAddress: "192.168.1.9" })).statusCode, 200);

    await writeFile(join(dataDir, "policy.json"), JSON.stringify({ business: { enabled: true, allowed: ["copilot"] } }));
    assert.equal((await server.app.inject({ method: "PUT", url: "/api/business", payload: { enabled: false } })).statusCode, 423);
    assert.equal(((await server.app.inject({ method: "GET", url: "/api/business" })).json() as { managed: boolean }).managed, true);
  } finally {
    await server.app.close();
  }
});
