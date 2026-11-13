import type { AgentTool } from "@kesher/agent";

/**
 * The task's steps, as the model writes and ticks them (the Steps pane beside the chat, like the task list
 * Claude shows beside a conversation). The whole list is sent each time; the app shows the latest one. The list
 * lives in the conversation's own events (the tool call), so it is saved with the chat and shows on every
 * device with nothing else to store.
 */

/** One step. */
export interface TaskStep {
  text: string;
  status: "pending" | "doing" | "done";
}

/** What the model is told about the tool. */
export const STEPS_NOTE =
  "For work with three stages or more, call set_steps first with the steps (short, in the user's language), and call it again whenever one is done or the plan changes: the user watches this list. Exactly one step is \"doing\" while you work; the last call marks every step \"done\". Do not use it for a quick answer or a single action.";

/**
 * Checks a list the model sent.
 *
 * @param raw - The `steps` argument.
 * @returns The clean list.
 */
export function cleanSteps(raw: unknown): TaskStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('set_steps needs "steps": a list of { text, status }.');
  if (raw.length > 12) throw new Error("At most 12 steps: merge the small ones.");
  const steps = raw.map((s): TaskStep => {
    const text = String((s as { text?: unknown })?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 140);
    const status = String((s as { status?: unknown })?.status ?? "pending");
    if (!text) throw new Error("Every step needs a text.");
    return { text, status: status === "done" || status === "completed" ? "done" : status === "doing" || status === "in_progress" ? "doing" : "pending" };
  });
  if (steps.filter((s) => s.status === "doing").length > 1) throw new Error('Only one step can be "doing" at a time.');
  return steps;
}

/** @returns The set_steps tool. */
export function stepsTool(): AgentTool {
  return {
    risk: "read",
    spec: {
      name: "set_steps",
      description: "Show the user the steps of the task you are working on, and update them as you go. Send the whole list every time.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Every step of the task, in order (at most 12).",
            items: {
              type: "object",
              properties: { text: { type: "string", description: "The step, in a few words." }, status: { type: "string", enum: ["pending", "doing", "done"] } },
              required: ["text", "status"],
            },
          },
        },
        required: ["steps"],
      },
    },
    async run(input) {
      const steps = cleanSteps(input.steps);
      const done = steps.filter((s) => s.status === "done").length;
      const now = steps.find((s) => s.status === "doing");
      return { output: `Steps shown to the user: ${done}/${steps.length} done${now ? `; now: ${now.text}` : ""}.` };
    },
  };
}
