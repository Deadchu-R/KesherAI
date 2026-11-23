import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@kesher/shared";
import { checkText, guardMessages, isPrivacySkip, setPrivacyGuard } from "./privacy-guard.js";

// Built from parts, so no scanner mistakes this test file for a real token.
const key = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const msgs: AgentMessage[] = [
  { role: "system", content: "You are a coder." },
  { role: "user", content: `use ${key} to push` },
  { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "/home/dana/app/.env" } }] },
  { role: "tool", toolCallId: "1", content: "DB_PASSWORD=hunter2hunter" },
];
const set = (mode: "ask" | "auto-hide" | "block-training-providers") => setPrivacyGuard(() => ({ mode, neverSend: [], username: "dana", home: "/home/dana" }));

test("models that do not train get the messages unchanged", () => {
  set("ask");
  const r = guardMessages("llamacpp/qwen", msgs);
  assert.equal(r.hidden, 0);
  assert.deepEqual(r.messages, msgs);
});

test("training services get the secrets hidden, tool calls and results included", () => {
  set("auto-hide");
  const r = guardMessages("gemini/gemini-2.5-flash", msgs);
  assert.equal(r.hidden, 3);
  const all = JSON.stringify(r.messages);
  assert.ok(!all.includes(key) && !all.includes("hunter2hunter") && !all.includes("/home/dana"));
  assert.match(r.messages[0]!.content, /privacy guard/);
  assert.equal(r.messages[3]!.content, "DB_PASSWORD=[password hidden]");
  assert.equal((r.messages[2]!.toolCalls![0]!.arguments as { path: string }).path, "[home hidden]/app/.env");
  // The caller's messages are never changed.
  assert.equal(msgs[1]!.content, `use ${key} to push`);
});

test("block mode stops the request; unattended runs skip when a file they read holds a secret", () => {
  set("block-training-providers");
  assert.throws(() => guardMessages("nvidia-nim/x", msgs), /Privacy guard: blocked/);
  set("ask");
  try {
    guardMessages("opencode-go/big-pickle-contributor-free", msgs, { unattended: true });
    assert.fail("should skip");
  } catch (e) {
    assert.ok(isPrivacySkip((e as Error).message));
  }
  // Only the user's prompt holds a secret: an unattended run hides it and goes on.
  const r = guardMessages("opencode-go/big-pickle-contributor-free", msgs.slice(0, 2), { unattended: true });
  assert.equal(r.hidden, 1);
});

test("the chat's check says what was found and gives the hidden text", () => {
  set("ask");
  const c = checkText("mistral/devstral", `my key ${key}, mail me at dana.levi@gmail.com`);
  assert.equal(c.risk, "may");
  assert.equal(c.mode, "ask");
  assert.deepEqual(c.found.map((f) => f.kind).sort(), ["email", "key"]);
  assert.equal(c.hidden, "my key [key hidden], mail me at [email hidden]");
  assert.deepEqual(checkText("ollama/llama3", key).found, []);
  setPrivacyGuard(undefined);
});
