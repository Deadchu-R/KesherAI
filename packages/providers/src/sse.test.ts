import { test } from "node:test";
import assert from "node:assert/strict";
import { readSSE } from "./sse.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

test("readSSE yields data payloads across chunk boundaries", async () => {
  const out: string[] = [];
  for await (const d of readSSE(streamOf("data: {\"a\":", "1}\n\n: comment\n", "data: [DONE]\n\n"))) out.push(d);
  assert.deepEqual(out, ['{"a":1}', "[DONE]"]);
});

test("readSSE joins multi-line data and handles CRLF", async () => {
  const out: string[] = [];
  for await (const d of readSSE(streamOf("event: x\r\ndata: one\r\ndata: two\r\n\r\n"))) out.push(d);
  assert.deepEqual(out, ["one\ntwo"]);
});
