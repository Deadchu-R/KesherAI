/**
 * A tiny fake model server for the end-to-end suite (scripts/e2e.mjs): speaks the OpenAI chat API on 127.0.0.1, answers
 * the same way every time, and records what it was asked. No real model, no network, no key.
 *
 * What it does, by what the last user message says:
 *   - contains "TOOL": the first turn asks for the chat tool `document` (it writes a small document the user sees in the
 *     side panel), and after the tool's answer it says "TOOL-DONE".
 *   - contains "REWRITE" (the docs panel's "Edit this"): answers exactly "REWRITTEN-BY-FAKE".
 *   - anything else: a slow stream of words ("Hello from the fake model ..."), one every `wordMs`, so the live turn line
 *     and a queued second message have time to show.
 * Titles and memory helpers (their prompts start with other words) get a short JSON or text answer at once.
 */
import { createServer } from "node:http";

/**
 * Starts the fake model.
 *
 * @param {{ wordMs?: number }} [opts] - Milliseconds between streamed words (default 120).
 * @returns {Promise<{ url: string, heard: string[], close: () => Promise<void> }>} Its base URL (ends in /v1), every user
 *   message it was asked, and a stop function.
 */
export async function startFakeModel(opts = {}) {
  const wordMs = opts.wordMs ?? 120;
  /** Every user message the model was asked (for the suite to check the order of a queue). */
  const heard = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake-1", owned_by: "e2e" }] }));
      return;
    }
    if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const messages = body.messages ?? [];
      const last = messages.at(-1) ?? {};
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      // On a local model the chat's own instructions ride in front of its first message (session.ts stabilize).
      const text = (typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")).replace(/^\[Instructions and context for this chat\][\s\S]*?\[End of the instructions and context\]\n\n/, "");
      const helper = !body.tools?.length;
      if (!helper || text.includes("REWRITE")) heard.push(text.slice(0, 200));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const end = () => {
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
        res.end();
      };
      if (text.includes("REWRITE")) {
        send({ content: "REWRITTEN-BY-FAKE" }, "stop");
        return end();
      }
      if (text.includes("TOOL") && last.role === "user" && body.tools?.some((t) => t.function?.name === "document")) {
        const args = { action: "write", title: "E2E report", body: "# E2E report\n\nThe quick brown fox jumps over the lazy dog.\n\nThis second paragraph stays as it is." };
        // Like a real model under the say-first rule: one sentence, then the tool call.
        send({ content: "I'll write the report." });
        send({ tool_calls: [{ index: 0, id: "call_e2e", function: { name: "document", arguments: JSON.stringify(args) } }] }, "tool_calls");
        return end();
      }
      if (last.role === "tool") {
        send({ content: "TOOL-DONE" }, "stop");
        return end();
      }
      if (helper) {
        // A helper (title, memory): short and harmless.
        send({ content: '{"add":[],"forget":[],"title":"E2E chat"}' }, "stop");
        return end();
      }
      const words = "Hello from the fake model. This answer streams slowly so the page can show its live turn line.".split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) return void send({ content: (i ? " " : "") + words[i++] });
        clearInterval(timer);
        send({}, "stop");
        end();
      }, wordMs);
      res.on("close", () => clearInterval(timer));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, heard, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
