import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@kesher/shared";
import { SideChats } from "./side-chat.js";

test("a side question reads the chat but never changes it, and keeps its own thread", async () => {
  const main: AgentEvent[] = [
    { type: "user", text: "Plan a trip to Haifa" } as AgentEvent,
    { type: "assistant", turn: 1, text: "Day 1: the Bahai gardens." } as AgentEvent,
  ];
  const before = JSON.stringify(main);
  const seen: string[] = [];
  const side = new SideChats();
  const turn = async (req: { messages: Array<{ role: string; content: unknown }> }) => {
    seen.push(String(req.messages[0]!.content));
    return { text: "<think>hm</think>About 1.5 hours by train.", toolCalls: [] };
  };
  const a = await side.ask("c1", main, "How long is the drive?", turn as never, AbortSignal.timeout(1000));
  assert.equal(a, "About 1.5 hours by train.");
  assert.equal(JSON.stringify(main), before, "the main chat is untouched");
  assert.match(seen[0]!, /Bahai gardens/);
  assert.equal(side.thread("c1").length, 2);
  side.clear("c1");
  assert.equal(side.thread("c1").length, 0);
});
