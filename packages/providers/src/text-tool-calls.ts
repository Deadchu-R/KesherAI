import type { ToolCall } from "@kesher/shared";

/**
 * Some local models (Qwen3-Coder, Hermes-style fine-tunes) sometimes write a
 * tool call as text instead of in the API's `tool_calls` field, when the
 * server's chat template does not turn it into one. Without this the turn ends
 * with the call printed in the chat and nothing done. Two shapes are read:
 *
 * - Qwen3-Coder XML: `<function=name><parameter=key>value</parameter></function>`
 *   (the `<tool_call>` wrapper is optional; models often drop the opening tag).
 * - Hermes JSON: `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`.
 *
 * @param text - The model's answer text.
 * @returns The calls found (empty when none) and the text without them.
 */
export function textToolCalls(text: string): { calls: ToolCall[]; text: string } {
  if (!/<function=|<tool_call>/.test(text)) return { calls: [], text };
  const calls: ToolCall[] = [];
  let rest = text;
  // Qwen3-Coder XML.
  rest = rest.replace(/(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)(?:\s*<\/tool_call>)?/g, (_m, name: string, body: string) => {
    const args: Record<string, unknown> = {};
    for (const p of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      const raw = p[2]!;
      let value: unknown = raw;
      if (/^\s*(\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(\.\d+)?|true|false|null)\s*$/.test(raw)) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
      }
      args[p[1]!] = value;
    }
    calls.push({ id: `text_call_${calls.length}`, name, arguments: args });
    return "";
  });
  // Hermes JSON.
  rest = rest.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (m, json: string) => {
    try {
      const o = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof o.name !== "string") return m;
      const a = o.arguments ?? o.parameters ?? {};
      const args = typeof a === "string" ? (JSON.parse(a) as Record<string, unknown>) : (a as Record<string, unknown>);
      calls.push({ id: `text_call_${calls.length}`, name: o.name, arguments: args && typeof args === "object" ? args : {} });
      return "";
    } catch {
      return m;
    }
  });
  rest = rest.replace(/<\/?tool_call>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return { calls, text: calls.length ? rest : text };
}
