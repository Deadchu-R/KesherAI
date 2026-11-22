#!/usr/bin/env node
/* global document, localStorage, sessionStorage, NodeFilter -- the functions passed to page.evaluate run in the browser */
/**
 * The release end-to-end suite (docs/TESTING.md): starts the built server with a throw-away data folder, a throw-away
 * home folder holding a Unity and an Unreal fixture project, and a fake model (scripts/e2e/fake-model.mjs), then
 * drives the real web interface with Playwright through the key flows, at computer width and at phone width (390 px,
 * through the computer's network address with the pairing token, like the phone app), and checks the security
 * promises. Any failed check, page error or server crash fails the run (exit 1); a picture of every step is saved.
 *
 * Flows: open the app, new chat, send a message, the streamed answer with the live turn line, a tool card, a second
 * message queued while the first is answered, the document panel (select text, "Edit this", the mock rewrite, accept),
 * Downloads, the Unity and Unreal stand-in pages with their fixture projects, Settings > Hugging Face token saved.
 * Security: a foreign website is refused on /api (GET, POST, preflight, Origin null, DNS rebinding); the token is
 * needed from another device; the phone cannot change the token or read arbitrary paths; a saved key or token never
 * shows in any response, the page, the storage, the server's output or (in plain text) the data folder.
 *
 * Usage: node scripts/e2e.mjs [outDir]   (needs `pnpm build:packages` and the web build; `pnpm e2e` does both.)
 * Playwright is found as a dependency, or set PLAYWRIGHT_MODULE to its index.js.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeModel } from "./e2e/fake-model.mjs";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "e2e-shots"));
const started = Date.now();

/** Made-up secrets: they must never come back out of the server or show on a page. */
const HF_TOKEN = "hf_E2ESecretToken0123456789abcdef";
const API_KEY = "sk-e2e-SecretProviderKey-9876543210";
const REMOTE_TOKEN = "e2e-remote-token-0a1b2c3d4e5f6a7b8c9d";

const results = [];
const problems = [];
/** Records one check: printed at once, and any failure fails the run. */
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `  (${detail})` : ""}`);
  results.push({ ok, what });
  if (!ok) problems.push(`${what}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free TCP port on this computer. */
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

/** The computer's own network address that is not the loopback (where a phone would reach it), if it has one. */
const lanAddress = () => Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;

const load = async () => {
  if (process.env.PLAYWRIGHT_MODULE) return (await import(process.env.PLAYWRIGHT_MODULE)).default;
  return createRequire(join(root, "package.json"))("playwright");
};

/** The fixture projects (what a Unity and an Unreal project look like on disk) under a throw-away home folder. */
async function makeFixtures(home) {
  const unity = join(home, "Unity Projects", "E2EUnity");
  await mkdir(join(unity, "Assets", "Scenes"), { recursive: true });
  await mkdir(join(unity, "ProjectSettings"), { recursive: true });
  await writeFile(join(unity, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.30f1\n");
  await writeFile(join(unity, "Assets", "Scenes", "Main.unity"), [
    "%YAML 1.1", "%TAG !u! tag:unity3d.com,2011:",
    "--- !u!1 &100", "GameObject:", "  m_Component:", "  - component: {fileID: 101}", "  m_Name: E2ECrate",
    "--- !u!4 &101", "Transform:", "  m_GameObject: {fileID: 100}", "  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}",
    "  m_LocalPosition: {x: 2, y: 0, z: -1.5}", "  m_LocalScale: {x: 1, y: 1, z: 1}", "  m_Father: {fileID: 0}", "",
  ].join("\n"));
  const unreal = join(home, "Documents", "Unreal Projects", "E2EUnreal");
  await mkdir(join(unreal, "Content", "Maps"), { recursive: true });
  await writeFile(join(unreal, "E2EUnreal.uproject"), JSON.stringify({ FileVersion: 3, EngineAssociation: "5.4", Category: "", Description: "" }));
  // A level file starts with Unreal's package magic number; the stand-in lists it by name from the disk.
  await writeFile(join(unreal, "Content", "Maps", "E2ELevel.umap"), Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0, 0, 0, 0, 0, 0, 0]));
  return { unity, unreal };
}

/** Every file under a folder (paths), for the "no secret in plain text on disk" check. */
async function filesUnder(dir) {
  const list = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) list.push(...(await filesUnder(p)));
    else list.push(p);
  }
  return list;
}

/** A raw HTTP request (fetch may not set Host or send an unnormalised path). Resolves `{ status, body }`. */
const raw = (host, port, path, headers = {}) => new Promise((res) => {
  const req = request({ host, port, path, headers }, (r) => {
    let body = "";
    r.on("data", (d) => (body += d));
    r.on("end", () => res({ status: r.statusCode ?? 0, body }));
  });
  req.on("error", () => res({ status: 0, body: "" }));
  req.end();
});

const pw = await load();
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "kesher-e2e-home-"));
const data = await mkdtemp(join(tmpdir(), "kesher e2e data "));
const fixtures = await makeFixtures(home);
const fake = await startFakeModel();
const port = await freePort();
const lan = lanAddress();
const local = `http://127.0.0.1:${port}`;
const remote = lan ? `http://${lan}:${port}` : "";

// Remote access on, with a known token, from the start: the server then listens on every address, as for a phone.
await writeFile(join(data, "config.json"), JSON.stringify({ remote: { enabled: true, token: REMOTE_TOKEN } }));
let serverLog = "";
const server = spawn(process.execPath, [join(root, "packages/core/dist/main.js"), "--port", String(port), "--data-dir", data, "--no-autodetect"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOME: home, USERPROFILE: home, KESHER_NO_BEACON: "1" },
});
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
let serverDied = false;
server.on("exit", (code) => { if (code) serverDied = true; });

/** JSON to the server from this computer (the page's own address). */
const api = async (path, method = "GET", body, headers = {}) => {
  const r = await fetch(local + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};

/** Everything every page was sent back, to look for secrets in. */
const seen = [];
let browser;
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await sleep(500);
    up = await fetch(`${local}/api/health`).then((r) => r.ok, () => false);
  }
  if (!up) throw new Error(`The server did not start.\n${serverLog.slice(-2000)}`);
  check(true, "the server starts with the fake model, the fixtures and a clean data folder");

  // Setup through the API: the fake model as the chat model, a second provider that has a key, the welcome done.
  check((await api("/api/providers", "POST", { id: "fake", type: "openai-compatible", baseUrl: fake.url })).status === 200, "the fake model is added as a provider");
  check((await api("/api/providers", "POST", { id: "keyed", type: "openai-compatible", baseUrl: fake.url, apiKey: API_KEY })).status === 200, "a provider with an API key is added");
  check((await api("/api/settings", "PUT", { activeModels: { chat: "fake/fake-1" } })).status === 200, "the fake model is the chat model");
  await api("/api/onboarding", "PUT", { done: true, simple: false });

  // ---------------------------------------------------------------- security, from outside the browser
  console.log("\n-- security");
  const probe = async (what, path, init, want) => {
    const r = await fetch(local + path, init).catch(() => undefined);
    check(!!r && want.includes(r.status), what, `got ${r?.status}`);
    return r;
  };
  const evil = { origin: "https://evil.example" };
  await probe("a foreign website cannot read the chats", "/api/conversations", { headers: evil }, [401, 403]);
  await probe("a foreign website cannot change settings (POST)", "/api/settings", { method: "PUT", headers: { ...evil, "content-type": "application/json" }, body: JSON.stringify({ activeModels: { chat: "x/y" } }) }, [401, 403]);
  await probe("a foreign website cannot set the Hugging Face token", "/api/hf-token", { method: "PUT", headers: { ...evil, "content-type": "application/json" }, body: JSON.stringify({ token: "hf_AAAAAAAAAAAA" }) }, [401, 403]);
  await probe("Origin: null is refused", "/api/conversations", { headers: { origin: "null" } }, [401, 403]);
  const pre = await fetch(`${local}/api/conversations`, { method: "OPTIONS", headers: { ...evil, "access-control-request-method": "GET" } }).catch(() => undefined);
  const acao = pre?.headers.get("access-control-allow-origin") ?? "";
  check(!!pre && acao !== "*" && !acao.includes("evil"), "a preflight from a foreign website is not allowed (no CORS header for it)", `allow-origin: ${acao}`);
  const rebind = await raw("127.0.0.1", port, "/api/conversations", { host: `evil.example:${port}` });
  check([401, 403].includes(rebind.status), "a request naming another host (DNS rebinding) is refused", `got ${rebind.status}`);
  check((await fetch(`${local}/api/conversations`)).status === 200, "this computer itself still gets its chats");
  // The settings and provider answers never carry a saved key.
  const providers = await api("/api/providers");
  check(!providers.text.includes(API_KEY), "the providers list does not show the API key");
  const models = await api("/api/models");
  check(models.status === 200 && !models.text.includes(API_KEY), "the models list does not show the API key");
  check(!(await api("/api/settings")).text.includes(API_KEY), "the settings do not show the API key");

  // Paths that must not be read: the interface server, the assets, a chat's files, a guest's scene files.
  const passwd = (r) => /root:.*:0:0/.test(r.body ?? r.text ?? "");
  for (const p of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2f..%2fetc/passwd", "/assets/..%2f..%2f..%2f..%2fetc%2fpasswd", "/api/assets/..%2f..%2f..%2fetc%2fpasswd"]) {
    const r = await raw("127.0.0.1", port, p);
    check(!passwd(r), `the path ${p} does not read a system file`, `got ${r.status}`);
  }
  const dl = await api("/api/conversations/nope/files/download?path=/etc/passwd");
  check(dl.status >= 400 && !passwd(dl), "a chat's file download refuses an arbitrary path", `got ${dl.status}`);
  const ua = await api(`/api/unity/asset?project=${encodeURIComponent(fixtures.unity)}&path=${encodeURIComponent("Assets/../../../../etc/passwd")}`);
  check(ua.status === 400 && !passwd(ua), "the Unity asset route refuses a path that climbs out of Assets", `got ${ua.status}`);
  const ua2 = await api(`/api/unity/asset?project=${encodeURIComponent(fixtures.unity)}&path=${encodeURIComponent("/etc/passwd")}`);
  check(ua2.status === 400 && !passwd(ua2), "the Unity asset route refuses an absolute path", `got ${ua2.status}`);
  const ul = await api(`/api/unreal/levels?project=${encodeURIComponent("/etc")}`);
  check(ul.status === 403, "the Unreal levels route refuses a folder that is not a found project", `got ${ul.status}`);
  // A guest (a person invited to one project) has no session here: the guest routes refuse everything, whatever the path.
  const guestPaths = [
    "/api/guest/me", "/api/guest/chats", "/api/guest/scenes",
    `/api/guest/scene?engine=unity&project=${encodeURIComponent(fixtures.unity)}&scene=Assets/Scenes/Main.unity`,
    `/api/guest/scene/asset?engine=unity&project=${encodeURIComponent(fixtures.unity)}&scene=x&path=${encodeURIComponent("../../../../etc/passwd")}`,
  ];
  for (const p of guestPaths) {
    const r = await api(p);
    check([401, 403, 404].includes(r.status) && !passwd(r), `the guest route ${p.split("?")[0]} refuses without a guest session`, `got ${r.status}`);
  }
  check([401, 403, 404].includes((await api("/api/join/not-a-real-invite")).status), "an invite link that does not exist is refused");

  // From another device (the computer's own network address): the token is needed, and some things stay on the computer.
  if (remote) {
    console.log("\n-- security from another device");
    const rem = (path, init = {}) => fetch(remote + path, init).catch(() => undefined);
    const auth = { authorization: `Bearer ${REMOTE_TOKEN}` };
    check((await rem("/api/conversations"))?.status === 401, "another device without the token is refused (chats)");
    check((await rem("/api/conversations", { headers: { authorization: "Bearer wrong-token" } }))?.status === 401, "another device with a wrong token is refused");
    check((await rem("/api/assets/x?token=wrong"))?.status === 401, "an asset link with a wrong token is refused");
    check((await rem("/api/conversations", { headers: auth }))?.status === 200, "another device with the token gets its chats");
    check((await rem("/api/remote", { headers: auth }))?.status === 403, "the pairing token is shown only on the computer itself");
    const put = await rem("/api/hf-token", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ token: HF_TOKEN }) });
    check(put?.status === 403, "the phone cannot set the Hugging Face token", `got ${put?.status}`);
    const rs = await rem(`/api/unity/scenes?project=${encodeURIComponent("/etc")}`, { headers: auth });
    check(!!rs && rs.status >= 400, "the phone cannot list scenes of a folder that is not a found project", `got ${rs?.status}`);
    const page = await rem("/", {});
    check(page?.status === 200 && /<html/i.test(await page.text()), "the interface files load on another device without the token (the page asks for it)");
  } else {
    console.log("\n(no network address on this computer: the checks from another device are skipped)");
  }

  // ---------------------------------------------------------------- the browser flows
  browser = await pw.chromium.launch();

  /**
   * Opens a page for one viewport: records page errors and console errors, and scans every answer for the secrets.
   *
   * @param name - "desktop" or "phone".
   * @param opts - `width`, `height`, `base` (the address to open), `token` (a phone's pairing token), `locale`.
   */
  const open = async (name, { width, height, base, token, locale = "en" }) => {
    const ctx = await browser.newContext({ viewport: { width, height }, locale: locale === "he" ? "he-IL" : "en-US" });
    await ctx.addInitScript(({ t, loc }) => {
      try {
        localStorage.setItem("locale", loc);
        if (t) localStorage.setItem("kesher-token", t);
      } catch { /* private mode */ }
    }, { t: token ?? "", loc: locale });
    ctx.on("response", async (r) => {
      try {
        const ct = r.headers()["content-type"] ?? "";
        if (/event-stream/.test(ct) || !/json|text|javascript|html/.test(ct) || r.url().includes("/assets/")) return;
        const url = r.url();
        const body = await r.text();
        seen.push({ url, body: body.slice(0, 200_000) });
        if (r.status() >= 500 && r.status() !== 503) problems.push(`${name}: ${r.status()} from ${url.replace(/\?.*/, "")}`);
      } catch { /* the page moved on */ }
    });
    const page = await ctx.newPage();
    let at = "start";
    page.on("pageerror", (e) => problems.push(`${name} ${at}: page error: ${e.message}`));
    page.on("console", (m) => {
      // Failed fetches of what an empty KesherAI does not have are not interface bugs (same filter as ui-check).
      if (m.type() === "error" && !/Failed to load resource|favicon|404|503/.test(m.text())) problems.push(`${name} ${at}: console: ${m.text().slice(0, 200)}`);
    });
    const shot = (what) => page.screenshot({ path: join(out, `${name}-${what}.png`) }).catch(() => undefined);
    /** Runs one named step; a failure is recorded with a picture and the run goes on to the next step. */
    const step = async (what, fn) => {
      at = what;
      try {
        await fn();
        check(true, `${name}: ${what}`);
      } catch (e) {
        check(false, `${name}: ${what}`, String(e.message ?? e).split("\n")[0].slice(0, 220));
        await shot(`FAILED-${what.replace(/\W+/g, "-")}`);
      }
      await shot(what.replace(/\W+/g, "-"));
    };
    return { ctx, page, step, base };
  };

  /** No horizontal scroll: nothing is wider than the screen. */
  const fits = async (page, width) => {
    const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    if (w > width + 1) throw new Error(`the page is ${w} px wide on a ${width} px screen`);
  };

  /** No translation key shows as text (a word like "downloads.title" means a text is missing from the word lists). */
  const noKeys = async (page) => {
    const keys = await page.evaluate(() => {
      const found = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+){1,3}$/.test(t) && !/\.(png|jpg|json|md|exe|txt|js|ts|gguf|com|app|dev|io)$/.test(t) && !n.parentElement?.closest("code,pre")) found.push(t.slice(0, 40));
      }
      return found;
    });
    if (keys.length) throw new Error(`a text key shows on the page: ${keys.slice(0, 3).join(", ")}`);
  };

  /**
   * The whole set of flows, for one viewport.
   *
   * @param v - What `open` returned.
   * @param width - The viewport width.
   * @param tag - Text that makes this pass's messages different from the other pass's.
   */
  const flows = async ({ page, step, base }, width, tag) => {
    const phone = width < 600;
    const composer = () => page.locator("textarea").last();
    const first = `hello there ${tag}`;
    const second = `second message ${tag}`;

    await step("open the app", async () => {
      await page.goto(`${base}/#/`);
      await composer().waitFor({ timeout: 20_000 });
      await fits(page, width);
    });
    await step("new chat: send a message", async () => {
      await composer().fill(first);
      await composer().press("Enter");
      await page.waitForURL(/#\/c\//, { timeout: 15_000 });
    });
    await step("the answer streams with the live turn line", async () => {
      await page.locator(".turn-status:not(.done)").first().waitFor({ timeout: 15_000 });
      await page.locator(".msg.streaming").first().waitFor({ timeout: 15_000 });
    });
    await step("a second message is queued while the first is answered", async () => {
      await composer().fill(second);
      await composer().press("Enter");
      await page.locator(".queue").filter({ hasText: second }).first().waitFor({ timeout: 10_000 });
      await fits(page, width);
    });
    await step("both answers finish, in order, with the done line", async () => {
      await page.locator(".turn-status.done").first().waitFor({ timeout: 40_000 });
      await page.waitForFunction((t) => document.body.innerText.split("Hello from the fake model").length - 1 >= 2 && document.body.innerText.includes(t), second, { timeout: 40_000 });
      const i = fake.heard.findIndex((h) => h.includes(first));
      const j = fake.heard.findIndex((h) => h.includes(second));
      if (i < 0 || j < 0 || i > j) throw new Error(`the model heard them in the wrong order (${i}, ${j})`);
      await fits(page, width);
    });
    await step("a tool card and the document it wrote", async () => {
      await composer().fill(`TOOL: write a document, a short report ${tag}`);
      await composer().press("Enter");
      await page.locator(".item-card").first().waitFor({ timeout: 30_000 });
      // The steps are folded under "used a tool"; opened, they show the tool card.
      await page.getByText(/used a tool/).first().click();
      await page.locator(".tool-card").first().waitFor({ timeout: 10_000 });
      await page.getByText("TOOL-DONE").first().waitFor({ timeout: 30_000 });
      await fits(page, width);
    });
    await step("the document panel: select text, Edit this, the mock rewrite, accept", async () => {
      // On a computer the panel opens by itself; on a phone the card opens it as a sheet.
      const para = page.getByText("The quick brown fox jumps over the lazy dog.").first();
      if (!(await para.isVisible().catch(() => false))) await page.locator(".item-card").last().click();
      await para.waitFor({ timeout: 15_000 });
      await para.click({ clickCount: 3 });
      await page.getByRole("button", { name: /Edit this/ }).first().click({ timeout: 10_000 });
      await page.getByLabel("What to change in the selected part").fill("REWRITE this sentence");
      await page.getByRole("button", { name: /Rewrite/ }).last().click();
      await page.getByRole("button", { name: /Accept/ }).click({ timeout: 20_000 });
      await page.getByText("Saved as a new version").first().waitFor({ timeout: 15_000 });
      const docs = (await api("/api/docs")).json?.docs ?? [];
      const mine = docs.find((d) => d.title === "E2E report");
      const body = mine ? (await api(`/api/docs/${mine.id}`)).json?.body ?? "" : "";
      if (!body.includes("REWRITTEN-BY-FAKE") || !body.includes("This second paragraph stays as it is.")) throw new Error(`the saved document is: ${body.slice(0, 120)}`);
    });
    await step("Downloads page loads", async () => {
      await page.goto(`${base}/#/downloads`);
      await page.waitForFunction(() => /download|הורדות/i.test(document.body.innerText), undefined, { timeout: 15_000 });
      await fits(page, width);
    });
    await step("Unity stand-in lists the fixture project and its scene", async () => {
      await page.goto(`${base}/#/unity`);
      await page.getByRole("listitem").filter({ hasText: "E2EUnity" }).first().click({ timeout: 20_000 });
      await page.getByRole("link", { name: /Scenes\/Main\.unity/ }).waitFor({ timeout: 15_000 });
      await fits(page, width);
      // The scene opens in the 3D editor page without an error.
      await page.getByRole("link", { name: /Scenes\/Main\.unity/ }).click();
      await page.waitForURL(/model-editor/, { timeout: 10_000 });
      await page.locator("iframe").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      await fits(page, width);
    });
    await step("Unreal stand-in lists the fixture project and its level", async () => {
      await page.goto(`${base}/#/unreal`);
      await page.getByRole("listitem").filter({ hasText: "E2EUnreal" }).first().click({ timeout: 20_000 });
      await page.getByText("E2ELevel").first().waitFor({ timeout: 20_000 });
      await fits(page, width);
    });
    await step("Settings: the Hugging Face token", async () => {
      await page.goto(`${base}/#/settings/accounts`);
      const card = page.locator("#hf-token");
      await card.waitFor({ timeout: 15_000 });
      if (phone) {
        // The phone sees whether it is set, and changes it on the computer.
        if (await card.locator("input").count()) throw new Error("the phone shows a token box");
        await page.getByText(/saved ✓/).first().waitFor({ timeout: 10_000 });
      } else {
        await card.locator("input[type=password]").fill(HF_TOKEN);
        await card.getByRole("button", { name: /^Save$/ }).click();
        await card.getByText(/saved ✓/).waitFor({ timeout: 10_000 });
        const left = await card.locator("input[type=password]").inputValue();
        if (left) throw new Error("the token box still holds the token after saving");
      }
      await fits(page, width);
      const html = await page.content();
      const stored = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
      if (html.includes(HF_TOKEN) || stored.includes(HF_TOKEN)) throw new Error("the token is in the page or its storage");
    });
  };

  // Desktop first (it saves the Hugging Face token), then the phone pass through the network address.
  const desktop = await open("desktop", { width: 1280, height: 800, base: local });
  await flows(desktop, 1280, "d");
  await desktop.ctx.close();

  const phoneBase = remote || local;
  const phone = await open("phone", { width: 390, height: 844, base: phoneBase, token: REMOTE_TOKEN });
  await flows(phone, 390, "p");
  await phone.ctx.close();

  // The same pages in Hebrew on the phone: right to left, nothing wider than the screen, no text key showing.
  const he = await open("phone-he", { width: 390, height: 844, base: phoneBase, token: REMOTE_TOKEN, locale: "he" });
  for (const p of ["#/", "#/downloads", "#/unity", "#/unreal", "#/settings/accounts", "#/models", "#/health", "#/games", "#/plugins", "#/docs"]) {
    await he.step(`Hebrew ${p}`, async () => {
      await he.page.goto(`${phoneBase}/${p}`);
      await he.page.waitForTimeout(1500);
      if ((await he.page.evaluate(() => document.documentElement.dir)) !== "rtl") throw new Error("the page is not right to left");
      await fits(he.page, 390);
      await noKeys(he.page);
    });
  }
  await he.ctx.close();

  // ---------------------------------------------------------------- the secrets, everywhere
  console.log("\n-- secrets");
  const accessLog = (await api("/api/access-log")).text;
  const hfState = await api("/api/hf-token");
  check(hfState.json?.set === true && !hfState.text.includes(HF_TOKEN), "the token is saved and the server only says that it is set");
  for (const [name, secret] of [["Hugging Face token", HF_TOKEN], ["provider API key", API_KEY]]) {
    const leak = seen.find((s) => s.body.includes(secret));
    check(!leak, `the ${name} is in no answer the pages received`, leak?.url);
    check(!serverLog.includes(secret), `the ${name} is not in the server's output`);
    check(!accessLog.includes(secret), `the ${name} is not in the access log`);
  }
  check(!serverLog.includes(REMOTE_TOKEN), "the pairing token is not in the server's output");
  check(!accessLog.includes(REMOTE_TOKEN), "the pairing token is not in the access log");
  // On disk: no file but the config (logs, chats, documents) holds one in plain text. The config seals them only with the
  // desktop app's secret box (config.ts useSecretBox), which a headless server does not have, so it is left out here.
  const plain = [];
  for (const f of await filesUnder(data)) {
    if (f.endsWith("config.json")) continue;
    const text = await readFile(f, "latin1").catch(() => "");
    if (text.includes(HF_TOKEN) || text.includes(API_KEY)) plain.push(f.slice(data.length));
  }
  check(plain.length === 0, "no saved key or token sits in plain text in the data folder (besides the config)", plain.join(", "));

  check(!serverDied && server.exitCode === null, "the server is still running after every flow");
} catch (e) {
  check(false, "the suite ran to the end", String(e.message ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => undefined);
  server.kill();
  await fake.close().catch(() => undefined);
  await sleep(800);
  await rm(data, { recursive: true, force: true }).catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

const seconds = Math.round((Date.now() - started) / 1000);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed in ${seconds} s.`);
// Page errors and server errors that no single step owns.
const extra = problems.filter((p) => !results.some((r) => !r.ok && p.startsWith(r.what)));
if (failed || extra.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log(` - ${p}`);
  console.log(`\nServer output (end):\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
console.log("End-to-end suite passed.");
process.exit(0);
