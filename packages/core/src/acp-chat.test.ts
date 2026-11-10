import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@kesher/agent";
import type { AgentEvent } from "@kesher/shared";
import { AcpAgent } from "./acp.js";
import { fakeAgent } from "./acp-fake.test.js";
import { optionFor, outsideAgent } from "./acp-chat.js";

const until = (s: AgentSession, pred: (e: AgentEvent) => boolean) =>
  new Promise<AgentEvent>((resolve) => {
    const on = (e: AgentEvent) => {
      if (pred(e)) {
        s.off("event", on);
        resolve(e);
      }
    };
    s.on("event", on);
  });

test("a code chat on Antigravity (ACP): its edit asks with a normal approval card, and the diff shows", async () => {
  const seen: { mode?: string } = {};
  const ext = outsideAgent("agent/antigravity", "/p", (h) => AcpAgent.connect(fakeAgent(seen), h), () => "ask")!;
  const s = new AgentSession({ id: "c", modelId: "agent/antigravity", model: async () => { throw new Error("unused"); }, external: ext, mode: "ask", tools: [], systemPrompt: "" });
  try {
    const asked = until(s, (e) => e.type === "approval_request");
    s.send("change a to b");
    const req = (await asked) as Extract<AgentEvent, { type: "approval_request" }>;
    assert.equal(req.name, "Edit a.ts");
    assert.match(req.reason, /Antigravity CLI asks/);
    s.approve(req.requestId, "allow");
    await until(s, (e) => e.type === "status" && e.status === "idle");
    const result = s.events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    assert.equal(result.ok, true);
    assert.match(result.diff ?? "", /^-a$/m);
    assert.match(result.diff ?? "", /^\+b$/m);
    assert.match(result.diff ?? "", /a\.ts/);
    assert.equal((s.events.find((e) => e.type === "assistant") as { text: string }).text, "Done.");
    assert.equal(seen.mode, "default", "KesherAI's \"ask\" puts Antigravity in its asking mode");
  } finally {
    ext.close();
  }
});

test("Deny on Antigravity's question sends its reject option", async () => {
  const p = { toolCallId: "t", title: "x", options: [{ optionId: "y", name: "Allow", kind: "allow_once" as const }, { optionId: "n", name: "No", kind: "reject_once" as const }] };
  assert.equal(optionFor(p, "deny"), "n");
  assert.equal(optionFor(p, "always"), "y", "no 'always' option: once");
  assert.equal(optionFor({ ...p, options: [] }, "allow"), undefined);
  assert.equal(outsideAgent("llamacpp/qwen", "/p"), undefined);
});
