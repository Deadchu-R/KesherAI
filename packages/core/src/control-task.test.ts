import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { AgentTool } from "@kesher/agent";
import { encodePng } from "./flat-image.js";
import { ControlTasks, toTool, type ControlPlanner, type ControlTaskHost } from "./control-task.js";
import type { ControlTaskRequest } from "./control-task-rules.js";
import { controlTaskRoutes } from "./routes/control-tasks.js";
import type { KesherServices } from "./services.js";

const png = (w: number, h: number, v: number) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([v, v, v, 255], i * 4);
  return encodePng({ width: w, height: h, data });
};

const RICH_TREE = [
  'Window 1 epicgameslauncher "Epic Games Launcher". 6 controls:',
  '  u1 Button "Store" [invoke]',
  '  u2 Button "Library" [invoke]',
  '  u3 Edit "Search" [set_value]',
  '  u4 Button "Install" [invoke]',
  '  u5 Edit "Password" (password field) [set_value]',
  '  u6 Button "Settings" [invoke]',
].join("\n");

interface FakeOpts {
  tree?: () => string;
  front?: () => { app: string; title: string };
  shot?: () => Buffer;
  gemini?: ControlPlanner | null;
  local?: ControlPlanner;
}

/** A computer with a UIA tree, tools that record their calls, and scripted planners. */
function fake(o: FakeOpts = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const log: string[] = [];
  const allowed: string[] = [];
  const tool = (name: string, output = "ok", extra: Partial<AgentTool> = {}): AgentTool => ({
    risk: "read",
    spec: { name, description: "", inputSchema: {} },
    run: async (input) => {
      calls.push({ name, input });
      if (name === "computer_tree") return { output: o.tree?.() ?? RICH_TREE };
      if (name === "computer_screenshot") return { output: "shot", images: [{ mimeType: "image/png", data: (o.shot?.() ?? png(64, 36, 100)).toString("base64") }] };
      return { output };
    },
    ...extra,
  });
  const host: ControlTaskHost = {
    enabled: () => true,
    uia: () => true,
    paused: () => false,
    tools: () => [
      tool("computer_tree"),
      tool("computer_screenshot"),
      tool("computer_invoke", "Done: pressed"),
      tool("computer_set_value"),
      tool("computer_click"),
      tool("computer_key", "ok", { askFirst: (i) => (/delete/.test(String(i.keys)) ? "These keys delete files, so they are asked every time." : undefined) }),
      tool("computer_open_app"),
    ],
    allow: (_c, a) => void allowed.push(a),
    front: async () => o.front?.() ?? { app: "EpicGamesLauncher", title: "Epic Games Launcher" },
    watch: async () => png(64, 36, 50),
    planners: () => ({ ...(o.gemini === null ? {} : { gemini: o.gemini ?? (async () => '{"do":"done","summary":"ok"}') }), ...(o.local ? { local: o.local } : {}) }),
    log: (l) => void log.push(l),
  };
  return { host, calls, log, allowed };
}

/** A planner that answers from a script and records what it saw. */
function script(answers: string[]) {
  const seen: Array<{ user: string; image: boolean }> = [];
  const p: ControlPlanner = async (q) => {
    seen.push({ user: q.user, image: !!q.image });
    return answers.shift() ?? '{"do":"fail","summary":"script ended"}';
  };
  return { p, seen };
}

const req = (over: Partial<ControlTaskRequest> = {}): ControlTaskRequest => ({ goal: "install Unreal 5.5 from the Epic launcher", apps: ["EpicGamesLauncher"], maxSteps: 40, maxMinutes: 15, model: "auto", ...over });
const instant = async () => undefined;

async function until(t: ControlTasks, id: string, status: string) {
  for (let i = 0; i < 200; i++) {
    if (t.get(id)?.status === status) return t.get(id)!;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`task never reached ${status}: ${JSON.stringify(t.get(id)?.status)} ${t.get(id)?.summary}`);
}

test("the tree is enough for a normal app: no picture, actions by ref, a summary and a last screenshot", async () => {
  const s = script(['{"do":"invoke","ref":"u2","note":"open the library"}', '{"do":"done","summary":"Unreal 5.5 is installing."}']);
  const f = fake({ gemini: s.p });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req(), "pc");
  const v = await until(tasks, id, "done");
  assert.equal(v.summary, "Unreal 5.5 is installing.");
  assert.deepEqual(f.allowed, ["EpicGamesLauncher"]);
  assert.ok(!f.calls.some((c) => c.name === "computer_screenshot"), "no screenshot while the tree is enough");
  assert.ok(s.seen.every((x) => !x.image));
  assert.match(s.seen[0]!.user, /u2 Button "Library"/);
  assert.deepEqual(f.calls.find((c) => c.name === "computer_invoke")?.input, { ref: "u2", action: "invoke" });
  assert.deepEqual(v.steps.map((x) => x.action), ['press Button "Library"', "done"]);
  for (let i = 0; i < 50 && !tasks.get(id)!.lastShot; i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(tasks.get(id)!.lastShot ?? "", /^data:image\/jpeg;base64,/);
  assert.ok(f.log.some((l) => l.includes(`${id} done`)));
  assert.ok(f.log.every((l) => !l.includes("Unreal 5.5 from the Epic launcher") || l.includes("start")));
});

test("a custom-drawn app gets a picture only when the screen changed, and clicks are scaled back", async () => {
  const s = script(['{"do":"click","x":100,"y":50}', '{"do":"click","x":10,"y":10}', '{"do":"done","summary":"ok"}']);
  const f = fake({ gemini: s.p, tree: () => 'Window 1 x "Unreal Editor". 1 controls:\n  u1 Pane "Viewport"', shot: () => png(2048, 1152, 120) });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req({ apps: ["EpicGamesLauncher"] }), "pc");
  await until(tasks, id, "done");
  assert.equal(f.calls.filter((c) => c.name === "computer_screenshot").length, 3);
  assert.deepEqual(s.seen.map((x) => x.image), [true, false, false]);
  assert.match(s.seen[1]!.user, /has not changed/);
  // The model saw 1024 px; the screenshot is 2048 px.
  assert.deepEqual(f.calls.find((c) => c.name === "computer_click")?.input, { x: 200, y: 100 });
  assert.match(tasks.get(id)!.steps[0]!.shotThumb ?? "", /^data:image\/jpeg/);
});

test("typing into a password field is refused, and after three tries the task asks you; Stop ends it", async () => {
  const pw = '{"do":"set_value","ref":"u5","value":"hunter2"}';
  const s = script([pw, pw, pw]);
  const f = fake({ gemini: s.p });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req(), "pc");
  const v = await until(tasks, id, "needs-you");
  assert.ok(!f.calls.some((c) => c.name === "computer_set_value"), "the value is never typed");
  assert.match(v.question ?? "", /not allowed/);
  assert.ok(f.log.every((l) => !l.includes("hunter2")), "typed text never reaches the log");
  assert.ok(tasks.stop(id));
  assert.equal((await until(tasks, id, "stopped")).summary, "Stopped by the user.");
});

test("a purchase button is refused; an install the goal did not ask for is asked, and yes lets it run", async () => {
  const s = script(['{"do":"invoke","ref":"u4"}', '{"do":"done","summary":"installed"}']);
  const f = fake({ gemini: s.p, tree: () => RICH_TREE });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req({ goal: "open the library in the Epic launcher" }), "pc");
  const v = await until(tasks, id, "needs-you");
  assert.match(v.question ?? "", /downloads or installs/);
  assert.ok(tasks.answer(id, "yes"));
  await until(tasks, id, "done");
  assert.ok(f.calls.some((c) => c.name === "computer_invoke" && c.input.ref === "u4"));

  const buy = script(['{"do":"invoke","ref":"u1"}', '{"do":"done","summary":"no"}']);
  const g = fake({ gemini: buy.p, tree: () => RICH_TREE.replace('"Store"', '"Buy now"') });
  const t2 = new ControlTasks(g.host, Date.now, instant);
  const b = t2.start(req(), "pc");
  const bv = await until(t2, b.id, "done");
  assert.ok(!g.calls.some((c) => c.name === "computer_invoke"));
  assert.equal(bv.steps[0]!.ok, false);
  assert.match(buy.seen[1]!.user, /REFUSED .*never/);
});

test("computer control's own always-ask becomes a question; a UAC window waits for you", async () => {
  const s = script(['{"do":"key","keys":"delete"}', '{"do":"done","summary":"ok"}']);
  const f = fake({ gemini: s.p });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req(), "pc");
  assert.match((await until(tasks, id, "needs-you")).question ?? "", /delete files/);
  tasks.answer(id, "no, leave it");
  await until(tasks, id, "done");
  assert.ok(!f.calls.some((c) => c.name === "computer_key"));
  assert.match(s.seen[1]!.user, /said no .*leave it/);

  let uac = true;
  const u = fake({ gemini: script(['{"do":"done","summary":"ok"}']).p, front: () => (uac ? { app: "consent", title: "User Account Control" } : { app: "EpicGamesLauncher", title: "Epic" }) });
  const t2 = new ControlTasks(u.host, Date.now, instant);
  const r = t2.start(req(), "pc");
  assert.match((await until(t2, r.id, "needs-you")).question ?? "", /User Account Control/);
  uac = false;
  t2.answer(r.id, "done");
  await until(t2, r.id, "done");
});

test("when the free Gemini key is at its limit, auto falls back to the local model; one task at a time", async () => {
  const local = script(['{"do":"done","summary":"done locally"}']);
  const f = fake({ gemini: async () => { throw new Error("429 RESOURCE_EXHAUSTED"); }, local: local.p });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const { id } = tasks.start(req(), "pc");
  assert.throws(() => tasks.start(req(), "pc"), /running already/);
  const v = await until(tasks, id, "done");
  assert.equal(v.planner, "local");
  assert.equal(v.summary, "done locally");
  // No planner at all: refused at start.
  const none = new ControlTasks(fake({ gemini: null }).host, Date.now, instant);
  assert.throws(() => none.start(req(), "pc"), (e: Error & { code?: number }) => e.code === 503);
});

test("steps map to computer control's tools", () => {
  assert.deepEqual(toTool({ do: "set_value", ref: "u3", value: "Unreal" }), { name: "computer_set_value", input: { ref: "u3", value: "Unreal" } });
  assert.deepEqual(toTool({ do: "scroll", x: 5, y: 6, amount: -2 }, 2), { name: "computer_scroll", input: { x: 10, y: 12, amount: -2 } });
  assert.throws(() => toTool({ do: "done" }));
});

test("the routes run a task from this computer and refuse other devices and bad goals", async () => {
  const s = script(['{"do":"done","summary":"All set."}']);
  const f = fake({ gemini: s.p });
  const tasks = new ControlTasks(f.host, Date.now, instant);
  const app = Fastify();
  await controlTaskRoutes(app, { controlTasks: tasks } as unknown as KesherServices);
  await app.ready();
  const away = { remoteAddress: "203.0.113.7", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.7" } };
  assert.equal((await app.inject({ method: "POST", url: "/api/control/tasks", ...away, payload: { goal: "open notepad" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/control/tasks", payload: { goal: "buy Unity Pro" } })).statusCode, 400);
  const start = await app.inject({ method: "POST", url: "/api/control/tasks", payload: { goal: "open the library", apps: ["EpicGamesLauncher"] } });
  assert.equal(start.statusCode, 200);
  const { id } = start.json() as { id: string };
  await until(tasks, id, "done");
  const got = (await app.inject({ url: `/api/control/tasks/${id}` })).json() as { status: string; summary: string; steps: unknown[] };
  assert.equal(got.status, "done");
  assert.equal(got.summary, "All set.");
  assert.equal((await app.inject({ url: `/api/control/tasks/${id}`, ...away })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/api/control/tasks/${id}/stop` })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: `/api/control/tasks/${id}/answer`, payload: { text: "yes" } })).statusCode, 409);
  assert.equal((await app.inject({ url: "/api/control/tasks/nope" })).statusCode, 404);
  assert.equal(((await app.inject({ url: "/api/control/tasks" })).json() as { current: { id: string } }).current.id, id);
  await app.close();
});

const hang: ControlPlanner = (_q, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
const short = { gemini: 30, local: 60, uia: 30 };

test("a planner that hangs: each call is cut at its limit, written in the steps and the log, and twice in a row fails the task with the reason", async () => {
  const f = fake({ gemini: hang });
  const tasks = new ControlTasks(f.host, Date.now, instant, short);
  const { id } = tasks.start(req({ model: "gemini" }), "pc");
  const v = await until(tasks, id, "failed");
  const cut = v.steps.filter((s) => s.action === "timed out");
  assert.equal(cut.length, 2);
  assert.match(cut[0]!.note, /free Gemini key.*did not answer in 0 s/);
  assert.match(v.summary, /Twice in a row.*Gemini key/);
  assert.ok(f.log.some((l) => /timed out/.test(l)));
});

test("auto mode: a Gemini call that hangs moves on to the local model at once", async () => {
  const s = script(['{"do":"done","summary":"Chrome is on the page."}']);
  const f = fake({ gemini: hang, local: s.p });
  const tasks = new ControlTasks(f.host, Date.now, instant, short);
  const { id } = tasks.start(req(), "pc");
  const v = await until(tasks, id, "done");
  assert.equal(v.planner, "local");
  assert.equal(v.steps.filter((x) => x.action === "timed out").length, 0);
});

test("UI Automation that hangs (the window in front) fails the task with the reason instead of sitting at step 1", async () => {
  const f = fake();
  f.host.front = () => new Promise(() => undefined);
  const tasks = new ControlTasks(f.host, Date.now, instant, short);
  const { id } = tasks.start(req(), "pc");
  const v = await until(tasks, id, "failed");
  assert.match(v.summary, /UI Automation.*restart KesherAI/);
  assert.equal(v.steps.length, 2);
});

test("a stuck action is cut and listed as failed; the task goes on", async () => {
  const s = script(['{"do":"invoke","ref":"u2","note":"open the library"}', '{"do":"done","summary":"ok"}']);
  const f = fake({ gemini: s.p });
  const base = f.host.tools;
  f.host.tools = (c) => base(c).map((t) => (t.spec.name === "computer_invoke" ? { ...t, run: () => new Promise<never>(() => undefined) } : t));
  const tasks = new ControlTasks(f.host, Date.now, instant, short);
  const { id } = tasks.start(req(), "pc");
  const v = await until(tasks, id, "done");
  const act = v.steps.find((x) => x.action.includes("Library"));
  assert.ok(act && !act.ok && /did not answer/.test(act.note));
});
