import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ModelTurn } from "./session.js";
import { CODE_TOOLS } from "./tools.js";
import { SAY_ONLY_NUDGE } from "./turn-shape.js";

/**
 * A local-model chat ("Keep answers short" on) whose model starts with a bare write_file call. `reply` answers the
 * one-sentence question; the log counts every model step (the cost the say-first check adds).
 */
async function run(reply: (asked: boolean) => { text: string; toolCalls: [] }) {
  const workspace = await mkdtemp(join(tmpdir(), "kesher-say-"));
  const steps: Array<{ say: boolean; calls: number }> = [];
  let wrote = false;
  const model: ModelTurn = async (req) => {
    const say = String(req.messages.at(-1)?.content).includes(SAY_ONLY_NUDGE);
    steps.push({ say, calls: 0 });
    if (say) return reply(true);
    if (!wrote) {
      wrote = true;
      return { text: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "a.txt", content: "hello" } }] };
    }
    return { text: "Done.", toolCalls: [] };
  };
  const session = new AgentSession({ id: "s", modelId: "m", model, mode: "auto", workspace, tools: [...CODE_TOOLS], systemPrompt: "sys", shortAnswers: () => ({ maxLines: 8 }) });
  session.send("write hello into a.txt");
  await new Promise<void>((resolve) => {
    const on = (e: { type: string }) => {
      if (e.type === "assistant" && session.events.some((x) => x.type === "tool_result")) {
        session.off("event", on);
        resolve();
      }
    };
    session.on("event", on);
  });
  return { session, steps, workspace };
}

test("say-first: a bare first tool call is kept; one short side question gets the sentence before it", async () => {
  const { session, steps, workspace } = await run(() => ({ text: "I'll write hello into a.txt.\nExtra line", toolCalls: [] }));
  // Three model steps in all (the call, the sentence, the final answer): the call is not generated twice.
  assert.deepEqual(steps.map((s) => s.say), [false, true, false]);
  const kinds = session.events.map((e) => e.type);
  const said = kinds.indexOf("assistant");
  assert.ok(said >= 0 && said < kinds.indexOf("tool_call"), "words come before the first tool call");
  const first = session.events.find((e) => e.type === "assistant") as { text: string };
  assert.equal(first.text, "I'll write hello into a.txt.");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "hello", "the kept call ran with its own arguments");
  // The question is not kept in the conversation.
  assert.ok(!session.events.some((e) => e.type === "user" && String((e as { text: string }).text).includes("Before you make the tool call")));
});

test("say-first: when the model gives no sentence the call still runs, with no made-up words", async () => {
  const { session, steps } = await run(() => ({ text: "  ", toolCalls: [] }));
  assert.deepEqual(steps.map((s) => s.say), [false, true, false]);
  const call = session.events.findIndex((e) => e.type === "tool_call");
  assert.ok(!session.events.slice(0, call).some((e) => e.type === "assistant"), "nothing is invented");
  assert.ok(session.events.some((e) => e.type === "tool_result"));
});
