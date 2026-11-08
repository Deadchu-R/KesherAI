import { test } from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "@kesher/shared";
import { conversationHtml, conversationMarkdown, exportFileName, markdownToHtml } from "./chat-export.js";

const conv = {
  id: "c1",
  projectId: null,
  title: "שאלה על <קוד>: לולאות",
  kind: "chat",
  modelId: "local/qwen",
  mode: "auto-edit",
  messages: [],
  createdAt: "2026-11-08T10:00:00Z",
  updatedAt: "2026-11-08T10:01:00Z",
  events: [
    { seq: 1, at: "2026-11-08T10:00:00Z", type: "user", text: "איך כותבים לולאה?" },
    { seq: 2, at: "2026-11-08T10:00:01Z", type: "tool_call", callId: "x", name: "web_search", input: {} },
    { seq: 3, at: "2026-11-08T10:00:02Z", type: "assistant", turn: 1, text: "כך:\n\n```js\nfor (let i = 0; i < 3; i++) {}\n```\n\n- **אחת**\n- שתיים" },
  ],
} as unknown as Conversation;

test("a chat as Markdown", () => {
  const md = conversationMarkdown(conv);
  assert.match(md, /^# שאלה על <קוד>: לולאות/);
  assert.match(md, /### אני\n\nאיך כותבים לולאה\?/);
  assert.match(md, /> כלים: web_search/);
  assert.match(md, /```js\nfor/);
});

test("a chat as a print-ready page, right to left, escaped", () => {
  const html = conversationHtml(conv, true);
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /שאלה על &lt;קוד&gt;/);
  assert.match(html, /<pre dir="ltr"><code>for \(let i = 0; i &lt; 3; i\+\+\) \{\}<\/code><\/pre>/);
  assert.match(html, /<li><strong>אחת<\/strong><\/li>/);
  assert.match(html, /print\(\)/);
  assert.doesNotMatch(conversationHtml(conv), /print\(\)/);
  assert.equal(exportFileName(conv, "pdf"), "שאלה על  קוד  לולאות.pdf".replace(/\s+/g, " "));
  assert.equal(markdownToHtml("<script>x</script>"), '<p dir="auto">&lt;script&gt;x&lt;/script&gt;</p>');
});
