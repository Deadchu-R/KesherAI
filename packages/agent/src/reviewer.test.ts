import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@kesher/shared";
import { AgentSession, type ModelTurn } from "./session.js";
import { CODE_TOOLS } from "./tools.js";
import { modelReviewer, parseReview, reviewPrompt, type ReviewRequest, type Reviewer } from "./reviewer.js";

test("only a clear ALLOW lets a command run", () => {
  assert.deepEqual(parseReview("ALLOW: runs the tests the user asked for"), { allow: true, reason: "runs the tests the user asked for" });
  assert.equal(parseReview("<think>maybe ALLOW</think>ASK: deletes files").allow, false);
  assert.equal(parseReview("**ALLOW** - build").allow, true);
  assert.equal(parseReview("Sure, go ahead").allow, false);
  assert.equal(parseReview("").allow, false);
});

test("the reviewer sees what was asked and the command, nothing else", () => {
  const p = reviewPrompt({ tool: "run_command", command: "pnpm test", input: { command: "pnpm test" }, asked: ["fix the failing test"], folder: "/p" });
  assert.match(p, /fix the failing test/);
  assert.match(p, /pnpm test/);
  assert.match(p, /Project folder: \/p/);
});

test("a model reviewer that errors or is slow counts as ask", async () => {
  // A model that never answers (the timer keeps the test alive until the reviewer gives up).
  const slow: ModelTurn = (_req, signal) =>
    new Promise((_ok, fail) => {
      const keep = setTimeout(() => undefined, 5000);
      signal.addEventListener("abort", () => {
        clearTimeout(keep);
        fail(new Error("timeout"));
      });
    });
  const r = modelReviewer(slow, 50);
  await assert.rejects(r({ tool: "run_command", command: "ls", input: {}, asked: [] }, new AbortController().signal));
});

/** A session in auto-edit whose model runs `commands` one after another, then says "fin". */
async function session(commands: string[], reviewer: Reviewer | undefined) {
  const workspace = await mkdtemp(join(tmpdir(), "kesher-review-"));
  let i = 0;
  const model: ModelTurn = async () => {
    const c = commands[i++];
    return c ? { text: "", toolCalls: [{ id: `c${i}`, name: "run_command", arguments: { command: c } }] } : { text: "fin", toolCalls: [] };
  };
  const s = new AgentSession({ id: "s", modelId: "m", model, mode: "auto-edit", workspace, tools: [...CODE_TOOLS], systemPrompt: "sys", reviewer: () => reviewer });
  return s;
}

function next(s: AgentSession, pred: (e: AgentEvent) => boolean): Promise<AgentEvent> {
  const found = s.events.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const on = (e: AgentEvent) => {
      if (pred(e)) {
        s.off("event", on);
        resolve(e);
      }
    };
    s.on("event", on);
  });
}

test("auto-edit: the reviewer's yes runs a command, its no asks you, and dangerous commands never reach it", async () => {
  const seen: ReviewRequest[] = [];
  const reviewer: Reviewer = async (r) => {
    seen.push(r);
    return r.command?.startsWith("echo") ? { allow: true, reason: "prints text" } : { allow: false, reason: "not asked for" };
  };
  const s = await session(["echo kesher-ok", "node -e 1", "rm -rf build"], reviewer);
  s.send("say ok");
  // 1: approved by the reviewer, with a note in the chat.
  const ran = (await next(s, (e) => e.type === "tool_result")) as Extract<AgentEvent, { type: "tool_result" }>;
  assert.match(ran.output, /kesher-ok/);
  assert.ok(s.events.some((e) => e.type === "note" && /Approved by the reviewer/.test(e.text)));
  // 2: the reviewer said no: you are asked, with its reason.
  const ask = (await next(s, (e) => e.type === "approval_request")) as Extract<AgentEvent, { type: "approval_request" }>;
  assert.match(ask.reason, /not asked for/);
  s.approve(ask.requestId, "deny");
  // 3: on the always-ask list: asked without the reviewer.
  const ask2 = (await next(s, (e) => e.type === "approval_request" && e.requestId !== ask.requestId)) as Extract<AgentEvent, { type: "approval_request" }>;
  assert.match(ask2.reason, /always needs your approval/);
  s.approve(ask2.requestId, "deny");
  await next(s, (e) => e.type === "assistant" && e.text === "fin");
  assert.deepEqual(seen.map((r) => r.command), ["echo kesher-ok", "node -e 1"]);
  assert.deepEqual(seen[0]?.asked, ["say ok"]);
});

test("a reviewer that fails leaves the question to you", async () => {
  const s = await session(["echo hi"], async () => {
    throw new Error("model down");
  });
  s.send("go");
  const ask = (await next(s, (e) => e.type === "approval_request")) as Extract<AgentEvent, { type: "approval_request" }>;
  s.approve(ask.requestId, "deny");
  await next(s, (e) => e.type === "assistant" && e.text === "fin");
});
