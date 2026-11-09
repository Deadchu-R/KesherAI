import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { GoogleDrive, SERVICE_SCOPES, type GoogleConfig } from "./google.js";
import { gmailText, googleTools, rawEmail } from "./google-tools.js";

const read = async (req: IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return raw;
};

test("sign-in asks for Gmail and Calendar only when wanted, and keeps what was granted", async () => {
  let granted = "";
  const srv = createServer(async (req, res) => {
    await read(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", scope: granted }));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const config: GoogleConfig = { clientId: "cid" };
  const g = new GoogleDrive(config, async () => undefined, { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: base, upload: base });

  const plain = new URL(g.authUrl("http://127.0.0.1:7420/api/google/callback"));
  assert.doesNotMatch(plain.searchParams.get("scope")!, /gmail|calendar/);

  const u = new URL(g.authUrl("http://127.0.0.1:7420/api/google/callback", ["gmail", "calendar"]));
  assert.match(u.searchParams.get("scope")!, /gmail\.readonly.*gmail\.compose.*calendar\.events/);
  assert.equal(u.searchParams.get("include_granted_scopes"), "true");
  // The user unticked Calendar on Google's page: only Gmail counts.
  granted = ["https://www.googleapis.com/auth/drive.file", ...SERVICE_SCOPES.gmail].join(" ");
  await g.finish("code", u.searchParams.get("state")!);
  assert.deepEqual(config.services, ["gmail"]);
  assert.ok(g.has("gmail"));
  assert.ok(!g.has("calendar"));
  srv.closeAllConnections();
  srv.close();
});

test("Gmail and Calendar tools: search, read, draft (never send), events", async () => {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const msg = {
    id: "m1",
    threadId: "t1",
    snippet: "Please send the Q3 report",
    labelIds: ["UNREAD"],
    payload: {
      headers: [{ name: "From", value: "Dana <dana@x.com>" }, { name: "Subject", value: "Q3" }, { name: "Date", value: "Fri" }, { name: "Message-ID", value: "<abc@x>" }],
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from("שלום, תשלח את הדוח").toString("base64url") } }],
    },
  };
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const body = await read(req);
    calls.push({ method: req.method!, path: url.pathname + url.search, ...(body ? { body } : {}) });
    const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/token") return json({ access_token: "at", expires_in: 3600 });
    if (url.pathname === "/gmail/users/me/messages") return json({ messages: [{ id: "m1" }] });
    if (url.pathname === "/gmail/users/me/messages/m1") return json(msg);
    if (url.pathname === "/gmail/users/me/drafts") return json({ id: "d1" });
    if (url.pathname === "/cal/calendars/primary/events" && req.method === "GET") return json({ items: [{ id: "e1", summary: "Sync", start: { dateTime: "2026-11-09T10:00:00+02:00" }, end: { dateTime: "2026-11-09T10:30:00+02:00" } }] });
    if (url.pathname === "/cal/calendars/primary/events") return json({ id: "e2", htmlLink: "https://calendar/e2" });
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const g = new GoogleDrive({ clientId: "c", refreshToken: "rt", services: ["gmail", "calendar"] }, async () => undefined, { auth: "", token: `${base}/token`, revoke: "", api: base, upload: base, gmail: `${base}/gmail`, calendar: `${base}/cal` });
  const tools = Object.fromEntries(googleTools(g).map((t) => [t.spec.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ["calendar_add_event", "calendar_events", "drive_upload_file", "gmail_draft", "gmail_read", "gmail_search"]);
  assert.equal(tools.gmail_search!.risk, "read");
  assert.equal(tools.gmail_draft!.risk, "exec");
  const ctx = {} as never;

  assert.match((await tools.gmail_search!.run({ query: "from:dana" }, ctx)).output, /Dana.*\n.*Q3[\s\S]*unread/);
  assert.match((await tools.gmail_read!.run({ id: "m1" }, ctx)).output, /תשלח את הדוח/);
  const d = await tools.gmail_draft!.run({ to: "dana@x.com", subject: "דוח Q3", body: "מצורף", reply_to: "m1" }, ctx);
  assert.match(d.output, /not sent/);
  const draft = JSON.parse(calls.find((c) => c.path === "/gmail/users/me/drafts")!.body!) as { message: { raw: string; threadId: string } };
  assert.equal(draft.message.threadId, "t1");
  assert.match(Buffer.from(draft.message.raw, "base64url").toString(), /In-Reply-To: <abc@x>/);
  assert.ok(!calls.some((c) => /send/.test(c.path)));

  assert.match((await tools.calendar_events!.run({ from: "2026-11-09", to: "2026-11-10" }, ctx)).output, /Sync/);
  await tools.calendar_add_event!.run({ title: "פגישה", start: "2026-11-10T14:00", end: "2026-11-10T15:00", guests: ["a@x.com"] }, ctx);
  assert.ok(calls.some((c) => c.method === "POST" && c.path.includes("sendUpdates=none")));
  srv.closeAllConnections();
  srv.close();
});

test("with only the Google sign-in (no Gmail, Calendar or Drive reading), only saving a file to Drive", () => {
  const g = new GoogleDrive({ clientId: "c", refreshToken: "rt" }, async () => undefined);
  assert.deepEqual(googleTools(g).map((t) => t.spec.name), ["drive_upload_file"]);
  // Not signed in at all: nothing.
  assert.equal(googleTools(new GoogleDrive({ clientId: "c" }, async () => undefined)).length, 0);
});

test("email helpers", () => {
  assert.equal(gmailText({ mimeType: "text/html", body: { data: Buffer.from("<p>Hi&nbsp;there</p><br>Bye").toString("base64url") } }), "Hi there\n\nBye");
  const raw = Buffer.from(rawEmail({ to: "a@b.c", subject: "שלום", body: "x" }), "base64url").toString();
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
});

test("Drive tools: search, read a Doc as text, list a folder, create a Doc", async () => {
  const calls: string[] = [];
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const body = await read(req);
    calls.push(`${req.method} ${url.pathname}${url.search}${body ? ` ${body.slice(0, 200)}` : ""}`);
    const json = (v: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/token") return json({ access_token: "at", expires_in: 3600 });
    if (url.pathname === "/api/files" && url.searchParams.get("q")?.includes("in parents")) return json({ files: [{ id: "d1", name: "Plan", mimeType: "application/vnd.google-apps.document" }] });
    if (url.pathname === "/api/files") return json({ files: [{ id: "d1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-01", webViewLink: "https://docs/d1" }] });
    if (url.pathname === "/api/files/d1" ) return json({ name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs/d1" });
    if (url.pathname === "/api/files/f1") return json({ name: "Work", mimeType: "application/vnd.google-apps.folder" });
    if (url.pathname === "/api/files/d1/export") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("תוכנית העבודה"); }
    if (url.pathname === "/upload/files") return json({ id: "n1", webViewLink: "https://docs/n1" });
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const g = new GoogleDrive({ clientId: "c", refreshToken: "rt", services: ["drive"] }, async () => undefined, { auth: "", token: `${base}/token`, revoke: "", api: `${base}/api`, upload: `${base}/upload` });
  const tools = Object.fromEntries(googleTools(g).map((t) => [t.spec.name, t]));
  const ctx = {} as never;
  assert.match((await tools.drive_search!.run({ query: "Roee's plan", type: "doc" }, ctx)).output, /Plan[\s\S]*docs\/d1/);
  assert.ok(calls.some((c) => decodeURIComponent(c).includes("name contains 'Roee\\'s plan'")));
  assert.match((await tools.drive_read!.run({ id: "d1" }, ctx)).output, /תוכנית העבודה/);
  assert.match((await tools.drive_read!.run({ id: "f1" }, ctx)).output, /Folder Work:[\s\S]*Plan/);
  assert.equal(tools.drive_create_doc!.risk, "exec");
  assert.match((await tools.drive_create_doc!.run({ title: "Notes", content: "hello" }, ctx)).output, /docs\/n1/);
  srv.closeAllConnections();
  srv.close();
});
