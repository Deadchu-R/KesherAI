import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHubKeys, openEnvelope, sealMessage } from "./hub-crypto.js";
import { parseEnvelope, parseSealedBody, ttlFor } from "./hub-protocol.js";
import { TASK_CHAT_LIMITS, boardContext, parseModelReply, parseTaskChatAnswer, parseTaskChatAsk, taskChatStale, type ChatBoardTask } from "./hub-task-chat.js";

const BOARD: ChatBoardTask[] = [
  { taskId: "r-1", title: "Fix the hub page", state: "waiting", executor: "antigravity" },
  { taskId: "r-2", title: "Port plugin", state: "running", executor: "local" },
  { taskId: "r-3", title: "Fix the hub page again", state: "queued", executor: "local" },
  { taskId: "r-4", title: "Old", state: "done", executor: "gemini" },
];

test("board context: open tasks first, numbered, capped in size", () => {
  const c = boardContext([BOARD[3]!, ...BOARD.slice(0, 3)]);
  assert.deepEqual(c.ids, ["r-1", "r-2", "r-3", "r-4"]);
  assert.match(c.text.split("\n")[0]!, /^1 \| Fix the hub page \| antigravity \| waiting$/);
  const many = Array.from({ length: 100 }, (_, i) => ({ taskId: `t-${i}`, title: "x".repeat(300), state: "waiting", executor: "auto" }));
  const big = boardContext(many);
  assert.ok(big.text.length <= TASK_CHAT_LIMITS.boardChars && big.ids.length <= TASK_CHAT_LIMITS.boardTasks);
  assert.equal(boardContext([]).ids.length, 0);
});

test("model reply: valid actions map to ids and state rules; the rest is refused", () => {
  const raw = 'Sure!\n```json\n{"reply":"Done","actions":[{"op":"add","title":" New  task ","executor":"local"},{"op":"split","id":1,"parts":["a","b"]},{"op":"assign","id":3,"to":"gemini"},{"op":"skip","id":3},{"op":"skip","id":2},{"op":"queue","id":9},{"op":"add","title":"x","executor":"rm -rf"},{"op":"shell","cmd":"ls"},{"op":"unqueue","id":3},{"op":"queue","id":1},{"op":"queue","id":1}]}\n```';
  const r = parseModelReply(raw, BOARD);
  assert.equal(r.ok, true);
  assert.equal(r.reply, "Done");
  assert.deepEqual(
    r.actions.map((a) => [a.op, "taskId" in a ? a.taskId : a.title]),
    [["add", "New task"], ["split", "r-1"], ["assign", "r-3"], ["skip", "r-3"], ["unqueue", "r-3"], ["queue", "r-1"]],
  );
  assert.equal(r.refused, 4, "running skip, unknown id, bad executor, unknown op");
});

test("model reply: invalid JSON is refused, a split needs two parts, at most 8 actions", () => {
  assert.equal(parseModelReply("not json at all", BOARD).ok, false);
  assert.equal(parseModelReply('{"reply": "cut off', BOARD).ok, false);
  assert.equal(parseModelReply("[1,2]", BOARD).ok, false);
  const one = parseModelReply('{"reply":"r","actions":[{"op":"split","id":1,"parts":["only"]}]}', BOARD);
  assert.deepEqual([one.ok, one.actions.length, one.refused], [true, 0, 1]);
  const many = parseModelReply(JSON.stringify({ reply: "r", actions: Array.from({ length: 20 }, (_, i) => ({ op: "add", title: `t${i}` })) }), BOARD);
  assert.equal(many.actions.length, TASK_CHAT_LIMITS.actions);
  assert.equal(parseModelReply('{"reply":"hi","actions":"nope"}', BOARD).actions.length, 0);
});

test("asks and answers: validated, a proposal's actions re-checked", () => {
  assert.equal(parseTaskChatAsk({ chatId: "c1", op: "say", text: "   " }), undefined);
  assert.equal(parseTaskChatAsk({ chatId: "c 1", op: "say", text: "hi" }), undefined);
  assert.equal(parseTaskChatAsk({ chatId: "c1", op: "apply" }), undefined);
  assert.deepEqual(parseTaskChatAsk({ chatId: "c1", op: "apply", proposalId: "p-1", at: 5 }), { chatId: "c1", op: "apply", proposalId: "p-1", at: 5 });
  assert.equal(parseTaskChatAsk({ chatId: "c1", op: "say", text: "x".repeat(2000), at: 1 })!.text!.length, TASK_CHAT_LIMITS.textChars);
  const a = parseTaskChatAnswer({ chatId: "c1", kind: "reply", text: "ok", proposal: { id: "p1", actions: [{ op: "skip", taskId: "r-1", title: "T" }, { op: "skip", taskId: "../x", title: "T" }, { op: "rm", title: "T" }] } })!;
  assert.deepEqual(a.proposal, { id: "p1", actions: [{ op: "skip", taskId: "r-1", title: "T" }] });
  assert.equal(parseTaskChatAnswer({ chatId: "c1", kind: "weird", text: "x" }), undefined);
  assert.equal(taskChatStale(0, 1000), true);
  assert.equal(taskChatStale(1000, 1000 + 6 * 60_000), true);
  assert.equal(taskChatStale(1000, 5000), false);
});

test("sealing round trip: the chat's messages ride sealed, a kind cannot be swapped, ttl is short", async () => {
  const page = await generateHubKeys(true);
  const pc = await generateHubKeys(true);
  const body = { type: "taskchat" as const, chatId: "c1", op: "say" as const, text: "פצל את משימה 3", at: 7 };
  const env = await sealMessage({ from: "page", to: "pc", kind: "taskchat" }, body, page.privateKey, pc.publicKey);
  assert.ok(!JSON.stringify(env).includes("משימה"), "the hub sees only ciphertext");
  assert.ok(parseEnvelope(JSON.parse(JSON.stringify(env))));
  assert.deepEqual(await openEnvelope(env, pc.privateKey, page.publicKey), body);
  await assert.rejects(openEnvelope(env, page.privateKey, page.publicKey));
  assert.equal(parseSealedBody({ ...body }, "taskchat_answer"), null, "a kind cannot be swapped");
  assert.deepEqual(parseSealedBody({ type: "taskchat_answer", chatId: "c1", kind: "refused", text: "no" }, "taskchat_answer"), { type: "taskchat_answer", chatId: "c1", kind: "refused", text: "no" });
  assert.ok(ttlFor("taskchat", 999_999) <= 1800);
});
