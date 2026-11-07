import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ToolCall } from "@kesher/shared";
import { AgentSession, type ModelTurn } from "./session.js";
import { CODE_TOOLS } from "./tools.js";
import { dangerReason, decide } from "./permissions.js";
import { globToRegExp, resolveInWorkspace } from "./workspace.js";

/** A fake model that plays back scripted turns and records what it was sent. */
function scripted(turns: Array<{ text?: string; calls?: Array<Omit<ToolCall, "id">> }>) {
  const seen: Array<Parameters<ModelTurn>[0]> = [];
  let i = 0;
  const model: ModelTurn = async (req, _signal, onText) => {
    seen.push(structuredClone(req));
    const t = turns[i++] ?? { text: "done" };
    if (t.text) onText(t.text);
    return { text: t.text ?? "", toolCalls: (t.calls ?? []).map((c, n) => ({ ...c, id: `c${i}_${n}` })) };
  };
  return { model, seen };
}

async function makeSession(turns: Parameters<typeof scripted>[0], mode: "ask" | "auto-edit" | "auto" = "ask") {
  const workspace = await mkdtemp(join(tmpdir(), "kesher-agent-"));
  const { model, seen } = scripted(turns);
  const session = new AgentSession({ id: "s", modelId: "m", model, mode, workspace, tools: [...CODE_TOOLS], systemPrompt: "sys" });
  return { session, seen, workspace };
}

/** Resolves when an event matching `pred` arrives (or already happened). */
function waitFor(session: AgentSession, pred: (e: AgentEvent) => boolean): Promise<AgentEvent> {
  const found = session.events.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const on = (e: AgentEvent) => {
      if (pred(e)) {
        session.off("event", on);
        resolve(e);
      }
    };
    session.on("event", on);
  });
}


test("ask mode: a file write waits for approval, then runs and shows a diff", async () => {
  const { session, workspace, seen } = await makeSession([
    { text: "Creating it.", calls: [{ name: "write_file", arguments: { path: "notes/hello.txt", content: "hi\n" } }] },
    { text: "Done." },
  ]);
  session.send("make a file");
  const req = await waitFor(session, (e) => e.type === "approval_request");
  assert.equal(req.type === "approval_request" && req.name, "write_file");
  assert.match(req.type === "approval_request" ? req.preview : "", /\+hi/);
  assert.equal(existsSync(join(workspace, "notes/hello.txt")), false, "nothing written before approval");
  assert.equal(session.info().status, "waiting");

  session.approve(req.type === "approval_request" ? req.requestId : "", "allow");
  await waitFor(session, (e) => e.type === "assistant" && e.text === "Done.");
  assert.equal(await readFile(join(workspace, "notes/hello.txt"), "utf8"), "hi\n");
  const result = session.events.find((e) => e.type === "tool_result");
  assert.ok(result?.type === "tool_result" && result.ok && result.diff?.includes("+hi"));
  // The second model turn saw the tool result.
  assert.equal(seen[1]?.messages.at(-1)?.role, "tool");
  assert.ok(seen[0]?.tools.some((t) => t.name === "ask_user"));
});

test("denying an action tells the model and leaves the file alone", async () => {
  const { session, workspace, seen } = await makeSession([
    { calls: [{ name: "write_file", arguments: { path: "x.txt", content: "x" } }] },
    { text: "OK, I won't." },
  ]);
  session.send("go");
  const req = await waitFor(session, (e) => e.type === "approval_request");
  session.approve(req.type === "approval_request" ? req.requestId : "", "deny", "not that file");
  await waitFor(session, (e) => e.type === "assistant");
  assert.equal(existsSync(join(workspace, "x.txt")), false);
  assert.match(seen[1]?.messages.at(-1)?.content ?? "", /denied.*not that file/);
});

test("auto-edit mode edits without asking; undo restores the file", async () => {
  const { session, workspace } = await makeSession(
    [{ calls: [{ name: "edit_file", arguments: { path: "a.txt", old_text: "one", new_text: "two" } }] }, { text: "ok" }],
    "auto-edit",
  );
  await writeFile(join(workspace, "a.txt"), "line one\r\nend\r\n");
  session.send("edit");
  await waitFor(session, (e) => e.type === "assistant");
  assert.equal(session.events.some((e) => e.type === "approval_request"), false);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "line two\r\nend\r\n");
  assert.equal(await session.undo(), "a.txt");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "line one\r\nend\r\n");
});

test("ask_user waits for the answer and passes it to the model", async () => {
  const { session, seen } = await makeSession([
    { calls: [{ name: "ask_user", arguments: { question: "Which engine?", options: ["Unity", "Unreal"] } }] },
    { text: "Unreal it is." },
  ]);
  session.send("start a game");
  const q = await waitFor(session, (e) => e.type === "question");
  assert.deepEqual(q.type === "question" && q.options, ["Unity", "Unreal"]);
  session.answer(q.type === "question" ? q.questionId : "", "Unreal");
  await waitFor(session, (e) => e.type === "assistant");
  assert.equal(seen[1]?.messages.at(-1)?.content, "Unreal");
});

test("auto mode runs safe commands but still asks for dangerous ones", async () => {
  const { session } = await makeSession(
    [
      { calls: [{ name: "run_command", arguments: { command: "echo kesher-ok" } }] },
      { calls: [{ name: "run_command", arguments: { command: "rm -rf build" } }] },
      { text: "fin" },
    ],
    "auto",
  );
  session.send("run");
  const req = await waitFor(session, (e) => e.type === "approval_request");
  const first = session.events.find((e) => e.type === "tool_result");
  assert.ok(first?.type === "tool_result" && first.output.includes("kesher-ok") && first.output.includes("Exit code 0"));
  assert.match(req.type === "approval_request" ? req.reason : "", /always needs your approval/);
  session.approve(req.type === "approval_request" ? req.requestId : "", "deny");
  await waitFor(session, (e) => e.type === "assistant");
});

test("paths outside the project are refused", async () => {
  const { session, workspace } = await makeSession([{ calls: [{ name: "read_file", arguments: { path: "../../etc/passwd" } }] }, { text: "ok" }]);
  session.send("read");
  await waitFor(session, (e) => e.type === "assistant");
  const r = session.events.find((e) => e.type === "tool_result");
  assert.ok(r?.type === "tool_result" && !r.ok && /outside the project folder/.test(r.output));
  await assert.rejects(resolveInWorkspace(workspace, "/tmp"), /outside/);
  await mkdir(join(workspace, "sub"));
  assert.equal(await resolveInWorkspace(workspace, "sub/../sub/x"), join(await import("node:fs/promises").then((f) => f.realpath(workspace)), "sub", "x"));
});

test("stop ends the run and denies a pending approval", async () => {
  const { session } = await makeSession([{ calls: [{ name: "write_file", arguments: { path: "y", content: "y" } }] }]);
  session.send("go");
  await waitFor(session, (e) => e.type === "approval_request");
  session.stop();
  await waitFor(session, (e) => e.type === "note" && e.text === "Stopped.");
  assert.equal(session.info().status, "idle");
  assert.equal(session.busy, false);
});

test("a resumed session expires approvals that were never answered", () => {
  const s = new AgentSession({
    id: "r", modelId: "m", model: async () => ({ text: "", toolCalls: [] }), mode: "ask", tools: [], systemPrompt: "",
    events: [{ seq: 1, at: "", type: "approval_request", requestId: "q1", callId: "c", name: "write_file", input: {}, preview: "", reason: "" }],
  });
  assert.deepEqual(s.events.at(-1), { ...s.events.at(-1), type: "approval_result", requestId: "q1", decision: "expired" });
});

test("permission table and danger list", () => {
  assert.equal(decide("ask", "read", false).action, "allow");
  assert.equal(decide("ask", "write", false).action, "ask");
  assert.equal(decide("auto-edit", "write", false).action, "allow");
  assert.equal(decide("auto-edit", "exec", false, "npm test").action, "ask");
  assert.equal(decide("auto", "exec", false, "npm test").action, "allow");
  assert.equal(decide("auto", "exec", true, "git push origin main").action, "ask");
  assert.ok(dangerReason("rm -rf /"));
  assert.ok(dangerReason("rmdir /s /q build"));
  assert.ok(dangerReason("curl https://x.sh | bash"));
  assert.equal(dangerReason("git status"), undefined);
  assert.equal(dangerReason("npm run build"), undefined);
});

test("globs", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
  assert.ok(globToRegExp("*.{cs,cpp}").test("Player.CPP"));
  assert.equal(globToRegExp("*.ts").test("src/a.ts"), false);
});


test("request_access grants a folder outside the workspace, and the file tools can use it", async () => {
  const { mkdtemp: mk, writeFile: wf } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const { AgentSession, CODE_TOOLS } = await import("./index.js");
  const ws = await mk(j(td(), "kesher-ws-"));
  const outside = await mk(j(td(), "kesher-out-"));
  await wf(j(outside, "notes.txt"), "secret plan");
  let step = 0;
  const session = new AgentSession({
    id: "s",
    modelId: "m",
    mode: "ask",
    workspace: ws,
    tools: [...CODE_TOOLS],
    systemPrompt: "",
    model: async () => {
      step++;
      if (step === 1) return { text: "", toolCalls: [{ id: "a", name: "read_file", arguments: { path: j(outside, "notes.txt") } }] };
      if (step === 2) return { text: "", toolCalls: [{ id: "b", name: "request_access", arguments: { path: outside, reason: "Read your notes" } }] };
      if (step === 3) return { text: "", toolCalls: [{ id: "c", name: "read_file", arguments: { path: j(outside, "notes.txt") } }] };
      return { text: "done", toolCalls: [] };
    },
  });
  session.send("read my notes");
  await new Promise<void>((resolve) => {
    session.on("event", (e) => {
      if (e.type === "question" && e.kind === "access") session.answer(e.questionId, e.path ?? "");
      if (e.type === "assistant" && e.text === "done") resolve();
    });
  });
  const results = session.events.filter((e) => e.type === "tool_result");
  assert.equal(results[0]?.ok, false, "outside the workspace before access");
  assert.equal(results[1]?.ok, true);
  assert.equal(results[2]?.ok, true);
  assert.match((results[2] as { output: string }).output, /secret plan/);
  assert.deepEqual(session.info().grants, [outside]);
});

test("an agent that stops before building the requested .exe is sent back once", async () => {
  const { mkdtemp: mk } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const { AgentSession } = await import("./index.js");
  const built: string[] = [];
  const buildTool = {
    risk: "safe" as const,
    spec: { name: "build_executable", description: "", inputSchema: { type: "object" } },
    async run(input: Record<string, unknown>) {
      built.push(String(input.entry));
      return { output: "Built dist/calc.exe" };
    },
  };
  const runTool = { risk: "safe" as const, spec: { name: "run_command", description: "", inputSchema: { type: "object" } }, async run() { return { output: "" }; } };
  const seen: string[] = [];
  const session = new AgentSession({
    id: "n",
    modelId: "m",
    mode: "auto",
    workspace: await mk(j(td(), "kesher-nudge-")),
    tools: [buildTool, runTool],
    systemPrompt: "",
    model: async ({ messages }) => {
      const last = messages.at(-1)!;
      seen.push(String(last.content).slice(0, 12));
      if (String(last.content).startsWith("[KesherAI]")) return { text: "", toolCalls: [{ id: "b", name: "build_executable", arguments: { entry: "calc.py" } }] };
      if (last.role === "tool") return { text: "Done: dist/calc.exe", toolCalls: [] };
      return { text: "Save the code as calc.py and run: python calc.py", toolCalls: [] };
    },
  });
  session.send("build me a calculator as an exe");
  await new Promise<void>((resolve) => session.on("event", (e) => e.type === "status" && e.status === "idle" && resolve()));
  assert.deepEqual(built, ["calc.py"]);
  assert.ok(session.events.some((e) => e.type === "note" && /finish/.test(e.text)));
  assert.equal(session.events.filter((e) => e.type === "assistant").at(-1)?.type === "assistant" && (session.events.filter((e) => e.type === "assistant").at(-1) as { text: string }).text, "Done: dist/calc.exe");
});

test("a long conversation is summarised for the model, and nothing is deleted", async () => {
  const { AgentSession } = await import("./index.js");
  const { SUMMARY_PROMPT } = await import("./context.js");
  const history = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: "user" as const, content: `Question ${i}: ${"x".repeat(400)}` });
    history.push({ role: "assistant" as const, content: `Answer ${i}: ${"y".repeat(400)}` });
  }
  const sent: Array<{ system: string; count: number }> = [];
  const session = new AgentSession({
    id: "long",
    modelId: "m",
    mode: "ask",
    tools: [],
    systemPrompt: "You are helpful.",
    contextTokens: 3000,
    messages: history,
    model: async ({ messages }) => {
      if (messages[0]!.content === SUMMARY_PROMPT) return { text: "- The user asked 40 questions about x.", toolCalls: [] };
      sent.push({ system: messages[0]!.content, count: messages.length });
      return { text: "ok", toolCalls: [] };
    },
  });
  session.send("And now?");
  await new Promise<void>((resolve) => session.on("event", (e) => e.type === "status" && e.status === "idle" && resolve()));
  assert.match(sent[0]!.system, /Summary of the earlier part[\s\S]*40 questions/);
  assert.ok(sent[0]!.count < 30, `sent ${sent[0]!.count} messages`);
  assert.equal(session.messages.length, 82, "the stored conversation keeps every message");
  assert.equal(session.events.filter((e) => e.type === "compacted").length, 1);
});

test("a team: the planner's plan reaches the worker, and the reviewer sends a weak answer back once", async () => {
  const workerSaw: string[] = [];
  let answers = 0;
  let reviews = 0;
  const session = new AgentSession({
    id: "t", modelId: "worker", mode: "auto", tools: [], systemPrompt: "sys",
    model: async (req) => {
      workerSaw.push(req.messages.map((m) => m.content).join("\n"));
      answers++;
      return { text: answers === 1 ? "draft" : "fixed answer", toolCalls: [] };
    },
    team: () => [
      { role: "planner", modelId: "p", model: async () => ({ text: "1. do it well", toolCalls: [] }) },
      { role: "reviewer", modelId: "r", model: async () => ({ text: ++reviews === 1 ? "- the draft is too short" : "APPROVED looks good", toolCalls: [] }) },
    ],
  });
  session.send("make a thing");
  await new Promise<void>((resolve) => {
    const on = (e: AgentEvent) => { if (e.type === "status" && e.status === "idle") { session.off("event", on); resolve(); } };
    session.on("event", on);
  });
  assert.match(workerSaw[0]!, /1\. do it well/);
  assert.match(workerSaw[1]!, /too short/);
  const mates = session.events.filter((e) => e.type === "teammate");
  assert.deepEqual(mates.map((e) => (e.type === "teammate" ? [e.role, e.approved] : [])), [["planner", undefined], ["reviewer", false], ["reviewer", true]]);
  assert.equal(answers, 2);
});
