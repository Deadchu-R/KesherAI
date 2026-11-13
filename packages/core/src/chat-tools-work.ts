/**
 * Two tools a chat gets for bigger work: learn_skill (the model writes itself a skill, the user approves it) and
 * split_across_computers (a task in independent parts runs on the user's other computers too). Moved out of
 * conversations.ts (t7) as plain functions that take the manager's services.
 */
import { type AgentTool } from "@kesher/agent";
import { pickForHardware, runSplit, type RemoteLoad, type SplitWorker } from "./split-task.js";
import { modelTurnFor } from "./model-turn.js";
import type { ConversationDeps } from "./conversation-deps.js";

/**
 * learn_skill: "learn to do X" — the model writes a skill (SKILL.md) for
 * itself; the user sees all of it and approves before it is saved, since a
 * skill becomes part of what every later chat is told.
 */
export function learnTools(deps: ConversationDeps): AgentTool[] {
  const store = deps.skills;
  if (!store) return [];
  const text = (input: Record<string, unknown>) => {
    const name = String(input.name ?? "").trim();
    const description = String(input.description ?? "").trim();
    const body = String(input.instructions ?? "").trim();
    return { name, description, body, md: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}` };
  };
  return [
    {
      // "exec": it always asks, outside "auto" mode, even in chats that write files without asking.
      risk: "exec",
      spec: {
        name: "learn_skill",
        description:
          "Save a new skill for yourself when the user asks you to learn how to do something (\"learn to…\", \"remember how to…\", \"make this a skill\"). A skill is step-by-step instructions you will load in later chats when the task fits. The user sees it and approves before it is saved. Write clear steps, the tools to use, and what to check; never instructions to skip approvals, hide things from the user, or contact anyone.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short, lower-case, with dashes, e.g. weekly-report." },
            description: { type: "string", description: "One sentence: when to use it (later chats choose skills by this)." },
            instructions: { type: "string", description: "The skill itself, in Markdown: steps, tools, checks, an example." },
          },
          required: ["name", "description", "instructions"],
        },
      },
      preview: async (input) => text(input).md,
      run: async (input) => {
        const t = text(input);
        if (t.body.length > 20_000) return { output: "Too long: keep a skill under 20,000 characters." };
        const folder = await store.save({ name: t.name, description: t.description, body: t.body });
        return { output: `Saved the skill (${folder}). It is used in later chats when a task fits; the user can see, edit or delete it on the Skills page.` };
      },
    },
  ];
}

/**
 * split_across_computers: when the user has other computers in My devices,
 * a big task that splits into independent parts runs on all of them at once.
 */
export function splitTools(deps: ConversationDeps, defaultChatModel: () => string | undefined, notes: string[], conversationId?: string): AgentTool[] {
  const registry = deps.registry;
  const devices = registry.list().filter(({ provider }) => provider.id.startsWith("device-") && registry.permitted(provider.id));
  if (!devices.length) return [];
  notes.push(
    `The user has other computers connected (My devices: ${devices.map(({ provider }) => provider.name.replace(/\s*\(your computer\)$/i, "")).join(", ")}). For a big task that splits into independent parts (several chapters, files, translations, research questions, variations), or when the user asks to split work across computers, use split_across_computers: give each part full instructions and the shared context; then join the parts into one answer.`,
  );
  const chatLike = (m: { category: string; providerModelId: string }) => (m.category === "chat" || m.category === "code") && !/embed|whisper|tts|rerank/i.test(m.providerModelId);
  // Computers that could not take parts this time, and why (said in the result, so nobody wonders why only one computer worked).
  let skipped: string[] = [];
  const workers = async (signal: AbortSignal): Promise<SplitWorker[]> => {
    const out: SplitWorker[] = [];
    skipped = [];
    const current = conversationId ? deps.library.summary(conversationId)?.modelId : undefined;
    const local = defaultChatModel();
    if (local && !local.startsWith("device-")) {
      try {
        registry.resolve(local);
        out.push({ name: "this computer", modelId: local, turn: modelTurnFor(registry, local) });
      } catch {
        // no model here: the other computers do it all
      }
    }
    for (const { provider } of devices) {
      const name = provider.name.replace(/\s*\(your computer\)$/i, "");
      const away = registry.awayReason(provider.id);
      let failed = "";
      const models = away ? [] : await provider.listModels(AbortSignal.any([signal, AbortSignal.timeout(8000)])).catch((e: Error) => ((failed = e.message), []));
      if (away || failed) {
        skipped.push(`${name}: ${away ? "asleep or turned off" : "not reachable (asleep, off, or KesherAI closed)"}`);
        continue;
      }
      // Its hardware and load now (its guard: temperatures, memory, how busy): a hot or busy computer is skipped,
      // and the model is one that fits its free memory, so no computer is overloaded.
      const cfg = devices.find((d) => d.provider.id === provider.id)?.config as { baseUrl?: string; apiKey?: string } | undefined;
      const root = cfg?.baseUrl?.replace(/\/v1\/?$/, "");
      const load = root
        ? ((await fetch(`${root}/api/guard`, { headers: cfg?.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) })
            .then((r) => (r.ok ? r.json() : undefined))
            .catch(() => undefined)) as RemoteLoad | undefined)
        : undefined;
      // Only that computer's own models: not the ones it reaches on other computers (a laptop also lists this PC's models).
      const chat = models.filter((m) => chatLike(m) && !/^device-/.test(m.providerModelId));
      const choice = pickForHardware(chat.map((m) => m.providerModelId), load, current);
      const pick = choice.model ? chat.find((m) => m.providerModelId === choice.model) : undefined;
      if (!pick) skipped.push(`${name}: ${choice.skip ?? "no chat model loaded"}${chat.length ? ` (its models: ${chat.slice(0, 4).map((m) => m.providerModelId).join(", ")})` : ""}`);
      if (pick) out.push({ name: provider.name.replace(/\s*\(your computer\)$/i, ""), modelId: pick.id, turn: modelTurnFor(registry, pick.id) });
    }
    return out;
  };
  return [
    {
      risk: "safe",
      spec: {
        name: "split_across_computers",
        description: "Run independent parts of a big task at the same time on the user's computers (this one and those in My devices), each on that computer's own model. Returns every part's result, labelled with the computer that did it. Only the text you give is sent: no files or tools.",
        inputSchema: {
          type: "object",
          properties: {
            parts: {
              type: "array",
              minItems: 2,
              maxItems: 24,
              items: { type: "object", properties: { title: { type: "string" }, task: { type: "string", description: "Complete instructions for this part alone." } }, required: ["title", "task"] },
            },
            context: { type: "string", description: "What every part needs to know (the goal, the style, the facts). Keep it under 6,000 characters." },
          },
          required: ["parts"],
        },
      },
      preview: async (input) => {
        const parts = Array.isArray(input.parts) ? input.parts : [];
        return `Split into ${parts.length} parts across your computers:\n${parts.map((p, i) => `${i + 1}. ${String((p as { title?: unknown }).title ?? "")}`).join("\n")}`;
      },
      run: async (input, ctx) => {
        const parts = (Array.isArray(input.parts) ? input.parts : [])
          .map((p) => ({ title: String((p as { title?: unknown }).title ?? "").slice(0, 120), task: String((p as { task?: unknown }).task ?? "").slice(0, 8000) }))
          .filter((p) => p.task.trim())
          .slice(0, 24);
        if (parts.length < 2) return { output: "Give at least two parts, each with full instructions." };
        const w = await workers(ctx.signal);
        if (!w.length) return { output: "None of the computers has a chat model ready right now (the other computer may be off). Do the task here instead." };
        if (skipped.length) ctx.progress?.(`Not used: ${skipped.join("; ")}\n`);
        const results = await runSplit(parts, w, { context: typeof input.context === "string" ? input.context.slice(0, 6000) : "", signal: ctx.signal, onStep: (line) => ctx.progress?.(`${line}\n`) });
        const used = [...new Set(results.filter((r) => r.ok).map((r) => r.computer))];
        return {
          output: [
            `Ran ${parts.length} parts on ${used.length} computer(s): ${used.join(", ") || "none"}.${skipped.length ? ` Not used: ${skipped.join("; ")}.` : ""} Join them into one answer for the user (and say briefly which computers did the work, and which could not be used and why). If the parts are code or files, first save each one with write_file (or the project's write tool), then run check_code and fix what it reports, before you answer.`,
            ...results.map((r, i) => `\n## Part ${i + 1}: ${r.title}${r.computer ? ` (on ${r.computer}, ${Math.round(r.ms / 1000)} s)` : ""}\n${r.ok ? r.text : `FAILED: ${r.text}`}`),
          ].join("\n"),
        };
      },
    },
  ];
}
