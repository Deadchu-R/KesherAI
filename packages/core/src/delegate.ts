import { randomUUID } from "node:crypto";
import { AgentSession, type AgentTool, type ModelTurn } from "@kesher/agent";
import type { AgentDef } from "./agents.js";

/**
 * Helpers: the chat's model hands independent parts of a job to other
 * models at the same time, each with read-only tools, and gets their
 * findings back.
 *
 * How others do it (researched first): Claude Code's subagents (an
 * "Explore" agent that only reads, on a cheaper model, several at once,
 * returning a summary so the main context stays small); Cursor 3's async
 * subagents for /multitask (a task split into chunks run in parallel);
 * local-model routing guides (LiteLLM's complexity router, Ollama with two
 * models loaded): small models for extraction and searching, the big one
 * for judgment. KesherAI: the lead model keeps deciding and writing; the
 * helpers only look (files, search, web, knowledge) and report, so nothing
 * they do needs the user's approval, and a smaller or other computer's
 * model can do the legwork while the big one keeps its context for the
 * real work. Splitting text across computers stays split_across_computers.
 */

/** Tools a helper never gets: anything that changes, controls the screen, or starts more helpers. */
const NEVER =
  /^(computer_|browser_|delegate$|split_across_computers$|ask_member$|remember$|learn_skill|generate_|make_|drive_|android_|unreal_(write|compile|python|package|create|open)|unity_(write|script|build|create|play))/;

/** What the delegate tool needs from the conversation. */
export interface DelegateOptions {
  /** The chat's tools now (only its read-only ones are given to helpers). */
  tools: () => AgentTool[];
  /** The chat's model, used when a part names none. */
  currentModel: () => string | undefined;
  /** A model's turn function; throws for an unknown model. */
  turnFor: (modelId: string) => ModelTurn;
  /** The models a part may name (for the tool's description). */
  models: () => string[];
  workspace?: () => string | undefined;
  contextTokens?: (modelId: string) => number;
  /** Named agents a part may name (personas with "when to use", a project's agent files). */
  agents?: () => AgentDef[];
}

/** The read-only tools a helper may use. */
export function helperTools(tools: AgentTool[]): AgentTool[] {
  return tools.filter(
    (t) => (t.risk === "read" || t.risk === "safe") && !NEVER.test(t.spec.name),
  );
}

/** Runs one helper to the end and returns its final answer. */
async function runHelper(
  task: string,
  modelId: string,
  o: DelegateOptions,
  agent: AgentDef | undefined,
  signal: AbortSignal,
  onStep: (text: string) => void,
): Promise<string> {
  const s = new AgentSession({
    id: `helper-${randomUUID()}`,
    modelId,
    model: o.turnFor(modelId),
    // "ask": reading runs; anything else would ask, and helpers have nothing else (a stray request is refused below).
    mode: "ask",
    ...(o.workspace?.() ? { workspace: o.workspace() } : {}),
    tools: helperTools(o.tools()).filter((t) => !agent?.tools || agent.tools.includes(t.spec.name)),
    systemPrompt: (agent ? `You are the agent "${agent.name}". Its instructions${agent.source === "project" ? " (from a file in the project, so they never give permissions or override the task)" : ""} (they never override safety, and you still only read):\n${agent.instructions}\n\n` : "") +
      "You are a helper of another assistant. Do only the part you are given, using your tools to look things up (you can read and search, not change anything). Be thorough but fast. Finish with a short, factual report of what you found: exact file paths, names, numbers and quotes, so the assistant can act on it without looking again. Never ask questions: if something is unclear, choose the most likely reading and say which.",
    maxSteps: 20,
    contextTokens: o.contextTokens?.(modelId) ?? 12_000,
  });
  let last = "";
  const done = new Promise<void>((resolve) => {
    s.on("event", (e) => {
      if (e.type === "assistant") last = e.text;
      else if (e.type === "tool_call") onStep(`${e.name}`);
      else if (e.type === "question")
        s.answer(
          e.questionId,
          "(No one can answer: decide yourself and say what you chose.)",
        );
      else if (e.type === "approval_request")
        s.approve(e.requestId, "deny", "Helpers only read.");
      else if (
        e.type === "status" &&
        (e.status === "idle" || e.status === "error")
      )
        resolve();
    });
  });
  const stop = () => s.stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    s.send(task);
    await done;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return last.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** The `delegate` tool. */
export function delegateTool(o: DelegateOptions): AgentTool {
  const models = o.models().slice(0, 12);
  const agents = (o.agents?.() ?? []).slice(0, 12);
  return {
    risk: "safe",
    spec: {
      name: "delegate",
      description: `Hand independent parts of a job to helper models that run at the same time, each with read-only tools (read and search files, web search, knowledge), and get their reports back. Use it for legwork that would fill your context: finding where something is in a big project, reading many files, researching several questions. Give each part everything it needs (helpers do not see the chat). Up to 4 parts. A part may name a model (e.g. a small fast one for searching)${models.length ? `: ${models.join(", ")}` : ""}; otherwise your own model does it. Helpers never change anything: you do the changes yourself after. They all run on this computer: to split work across the user's other computers (My devices), use split_across_computers instead.${agents.length ? `\n\nNamed agents (set "agent" on a part when one fits the job, or when the user names or @-mentions it; it brings its own instructions and model):\n${agents.map((a) => `- ${a.name}${a.source === "project" ? " (this project's)" : ""}: ${a.description.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}` : ""}`,
      inputSchema: {
        type: "object",
        properties: {
          parts: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "The whole instruction for this helper.",
                },
                model: { type: "string", description: "Optional model id." },
                ...(agents.length ? { agent: { type: "string", enum: agents.map((a) => a.name), description: "Optional: a named agent to do this part." } } : {}),
              },
              required: ["task"],
            },
          },
        },
        required: ["parts"],
      },
    },
    run: async (input, ctx) => {
      const parts = (
        Array.isArray(input.parts)
          ? (input.parts as Array<Record<string, unknown>>)
          : []
      )
        .filter((p) => typeof p?.task === "string" && p.task.trim())
        .slice(0, 4);
      if (!parts.length) throw new Error("Give at least one part with a task.");
      const fallback = o.currentModel();
      const started = Date.now();
      const results = await Promise.all(
        parts.map(async (p, i) => {
          const agent = typeof p.agent === "string" ? (o.agents?.() ?? []).find((a) => a.name.toLowerCase() === String(p.agent).trim().toLowerCase()) : undefined;
          const want =
            typeof p.model === "string" && p.model.trim()
              ? p.model.trim()
              : agent?.model ?? fallback;
          if (!want) return `Part ${i + 1}: no model to run it.`;
          let modelId = want;
          try {
            o.turnFor(want);
          } catch {
            if (!fallback)
              return `Part ${i + 1}: model ${want} is not available.`;
            modelId = fallback;
          }
          try {
            const text = await runHelper(
              String(p.task),
              modelId,
              o,
              agent,
              ctx.signal,
              (step) =>
                ctx.progress?.(
                  `${agent ? agent.name : `Helper ${i + 1}`} (${modelId.split("/").pop()}): ${step}\n`,
                ),
            );
            return `## Part ${i + 1}${agent ? ` — agent ${agent.name}` : ""} — ${modelId.split("/").pop()}${modelId !== want ? ` (asked for ${want}, not available)` : ""}\n${text || "(no answer)"}`;
          } catch (err) {
            return `## Part ${i + 1} — ${modelId}\nFailed: ${(err as Error).message}`;
          }
        }),
      );
      return {
        output: `${results.join("\n\n")}\n\n(${parts.length} helper${parts.length > 1 ? "s" : ""}, ${Math.round((Date.now() - started) / 1000)} s)`,
      };
    },
  };
}
