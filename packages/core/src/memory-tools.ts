import type { AgentTool } from "@kesher/agent";
import type { ConversationSummary } from "@kesher/shared";
import type { MemoryStore } from "./memory-store.js";

/**
 * The user's memory as tools: `remember` when the user asks to keep something for next time, `forget` when they
 * ask to drop it. Facts go under a topic, in the general memory or the chat's project. Shown and edited on the
 * Memory page. None in an incognito chat or while memory is paused (the store refuses then).
 *
 * @param memory - The memory store.
 * @param chat - The chat the tools are for (its project, whether it is incognito).
 * @returns The tools.
 */
export function memoryTools(memory: MemoryStore, chat: () => Pick<ConversationSummary, "projectId" | "incognito"> | undefined): AgentTool[] {
  const c = chat();
  if (c?.incognito) return [];
  const project = c?.projectId ?? undefined;
  return [
    {
      risk: "read",
      spec: {
        name: "remember",
        description:
          "Keep a fact about the user for future chats, when they ask you to remember something (their name, a preference, how they work, a person in their life). One fact per call, in their words; no passwords, keys, card/account/ID numbers or health details." +
          (project ? " project: true keeps it only for this chat's project." : ""),
        inputSchema: {
          type: "object",
          properties: {
            note: { type: "string", description: "The fact, in a short sentence." },
            topic: { type: "string", description: 'A short topic title, e.g. "Work", "Preferences", "Family". Reuse an existing one.' },
            ...(project ? { project: { type: "boolean" } } : {}),
          },
          required: ["note"],
        },
      },
      async run(input) {
        if ((await memory.data()).paused) return { output: "Memory is paused (on the Memory page), so nothing was kept. Tell the user." };
        const t = await memory.add({ topic: String(input.topic ?? "About you"), text: String(input.note ?? ""), source: "you", ...(input.project === true && project ? { project } : {}) });
        return { output: `Remembered under "${t.title}"${t.project ? " (this project)" : ""}. The user can see and edit it on the Memory page.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "forget",
        description: "Remove facts about the user from memory when they ask you to forget something. Removes every fact (and topic) containing the given words.",
        inputSchema: { type: "object", properties: { about: { type: "string", description: "Words from the fact(s) to forget." } }, required: ["about"] },
      },
      async run(input) {
        const n = await memory.forget(String(input.about ?? ""));
        return { output: n ? `Forgot ${n} fact(s).` : "No fact matched." };
      },
    },
  ];
}
