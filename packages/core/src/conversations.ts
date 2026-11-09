import type { Checkpoints } from "./checkpoints.js";
import { personaPrompt, type Personas } from "./personas.js";
import type { SkillStore } from "./skill-store.js";
import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ImportedChat } from "./chat-import.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { AgentSession, CODE_TOOLS, buildSystemPrompt, webSearchTool, type AgentTool, type ModelTurn, type TeamMember } from "@kesher/agent";
import { APPEARANCE_COLORS, APPEARANCE_FONTS, APPEARANCE_NAV_GROUPS, APPEARANCE_PRESETS, branding, cleanAppearance, type Appearance, type AgentEvent, type AgentMessage, type Conversation, type ConversationKind, type PermissionMode, type Teammate } from "@kesher/shared";
import type { ProviderRegistry } from "@kesher/providers";
import type { KesherConfig } from "./config.js";
import type { AssetStore } from "./assets.js";
import { LOOK_ICON_PAGES, styleLook } from "./look-pictures.js";
import { pickForHardware, runSplit, type RemoteLoad, type SplitWorker } from "./split-task.js";
import type { UnityCli } from "./unity-cli.js";
import { UNITY_NOTE, UNITY_TOOL_NAMES, unityTools } from "./unity-tools.js";
import { UNREAL_NOTE, UNREAL_TOOL_NAMES, unrealTools } from "./unreal-tools.js";
import { androidPhoneTools } from "./android-phone.js";
import { delegateTool } from "./delegate.js";
import { BUILD_RESEARCH_NOTE } from "./known-issues.js";
import { chosenPhones, phoneNote, type Phone } from "./phones.js";
import { findEngines, readProject } from "./unreal-install.js";
import { JobStore } from "./jobs.js";
import { graphTools } from "./graph-edit.js";
import { analyzeChatTool } from "./chat-stats.js";
import type { UnrealBridge } from "./unreal-bridge.js";
import type { PluginHost } from "./plugins.js";
import type { Library } from "./library.js";

/** Options for {@link ConversationManager.create}. */
export interface NewConversation {
  projectId?: string | null;
  kind: ConversationKind;
  modelId?: string;
  mode?: PermissionMode;
  workspace?: string;
  title?: string;
  personaId?: string;
  /** `telegram`: written from Telegram (fewer tools, always asks). */
  source?: "telegram";
}

let speedRecorder: ((modelId: string, tokens: number, ms: number) => void) | undefined;

/**
 * Where measured speeds go (the server keeps them per model, for "measured
 * N tokens/s" next to models instead of an estimate).
 *
 * @param fn - Gets the model, the tokens it wrote (about), and the time it took.
 */
export function onModelSpeed(fn: typeof speedRecorder): void {
  speedRecorder = fn;
}

/**
 * Builds the model function an agent session calls for each turn. Providers
 * with tool calling get the tools; chat-only providers (some plugins) still
 * work, just without tools.
 *
 * @param registry - Provider registry.
 * @param modelId - Global model id.
 * @returns The turn function.
 */
export function modelTurnFor(registry: ProviderRegistry, modelId: string): ModelTurn {
  const inner = rawTurnFor(registry, modelId);
  return async (req, signal, onText) => {
    let first = 0;
    let chars = 0;
    const once = () =>
      inner(req, signal, (t) => {
        if (!first) first = Date.now();
        chars += t.length;
        onText(t);
      });
    let r;
    try {
      r = await once();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // The model server dropped the connection (a local server restarting, or out of memory/context).
      const dropped = /terminated|ECONNRESET|socket hang up|fetch failed|other side closed/i.test(msg);
      if (!dropped || signal?.aborted) throw err;
      // Little or nothing was written yet: try once more, after a moment.
      if (chars < 200) {
        await new Promise((res) => setTimeout(res, 3000));
        try {
          r = await once();
        } catch (again) {
          throw new Error(`The model server closed the connection twice (${(again as Error).message}). This often means the conversation is longer than the model's context: start a new chat, or load the model with a bigger context.`);
        }
      } else {
        throw new Error(`The model server closed the connection while answering (${msg}). This often means the conversation is longer than the model's context: say "continue", start a new chat, or load the model with a bigger context.`);
      }
    }
    // Speed of writing (after the first word), so reading a long prompt does not count against it.
    const ms = first ? Date.now() - first : 0;
    if (chars > 200 && ms > 500) speedRecorder?.(modelId, Math.round(chars / 4), ms);
    return r;
  };
}

function rawTurnFor(registry: ProviderRegistry, modelId: string): ModelTurn {
  return async (req, signal, onText) => {
    const { provider, providerModelId } = registry.resolve(modelId);
    if (provider.chatWithTools) {
      return provider.chatWithTools({ providerModelId, messages: req.messages, tools: req.tools }, signal, onText);
    }
    if (!provider.chat) throw new Error(`${modelId} is not a chat model.`);
    let text = "";
    const messages = req.messages
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));
    for await (const ev of provider.chat({ providerModelId, messages }, signal)) {
      if (ev.type === "delta") {
        text += ev.text;
        onText(ev.text);
      } else if (ev.type === "error") throw new Error(ev.message);
    }
    return { text, toolCalls: [] };
  };
}

/**
 * The tools a local model always gets in full when tool search is on; the
 * others are listed by name and loaded with find_tools when needed (fewer
 * tokens on every message, faster answers on the computer).
 */
/**
 * Whether a saved "always allow" rule covers this call: the tool, the scope
 * (this chat, this model, everywhere), not past its end time, and, for a rule
 * kept for one command, a command that starts with it as a whole word and
 * chains nothing else after it (no ;, &&, |, backticks or $( ) ).
 */
export function ruleAllows(r: { tool: string; scope: string; conversationId?: string; modelId?: string; until?: string; command?: string }, c: { tool: string; modelId: string; conversationId: string; command?: string }, now = Date.now()): boolean {
  if (r.tool !== c.tool && r.tool !== "*") return false;
  if (!(r.scope === "everywhere" || (r.scope === "model" && r.modelId === c.modelId) || (r.scope === "conversation" && r.conversationId === c.conversationId))) return false;
  if (r.until && Date.parse(r.until) <= now) return false;
  if (r.command) {
    const cmd = (c.command ?? "").trim().replace(/\s+/g, " ");
    const want = r.command.trim().replace(/\s+/g, " ");
    if (!(cmd === want || cmd.startsWith(`${want} `))) return false;
    if (/[;&|`\n]|\$\(|>\s*[^&\s]|<\(/.test(cmd.slice(want.length))) return false;
  }
  return true;
}

const CORE_TOOLS = ["read_file", "view_image", "write_file", "edit_file", "list_files", "code_map", "find_symbol", "search", "check_code", "run_command", "web_search", "web_fetch", "read_document", "generate_image", "remember", "recall", "search_knowledge", "use_skill", "ask_member", "delegate", "split_across_computers"] as const;

/** The Blueprint tools: always in full while the Unreal Editor is connected (so a model never misses the Test tool). */
const UNREAL_GRAPH_TOOLS = ["unreal_list_graphs", "unreal_read_graph", "unreal_change_graph", "unreal_test_blueprint"];

/** Thrown when something needs a model of a category and none is chosen. The API answers 400 with `code: "no-model"`. */
export class NoModelError extends Error {
  /** @param category - The category that needs a model, e.g. `chat`. */
  constructor(readonly category: string) {
    super(`Choose a ${category} model first.`);
  }
}

/** Told to the model when the image model is not ready, so it waits instead of improvising. */
const WAIT_NOTE =
  "Tell the user the image model is downloading and that they can follow it in the downloads circle, then stop. Do not try to make the image another way (no torch/diffusers installs, no drawing code).";

const IMAGE_WORKAROUND = /\b(pip3?|py(thon3?)?\s+-m\s+pip)\s+install\b.*\b(torch|diffusers|stable[-_]?diffusion|xformers)\b/i;
const DRAWING_CODE = /^\s*(import\s+turtle|from\s+turtle\s+import|from\s+PIL\s+import\s+.*ImageDraw)/m;

/**
 * In a chat that has generate_image, stops the model from making pictures
 * the long way (installing torch/diffusers, or drawing with turtle/PIL code)
 * and points it at the image tool. Code sessions are left alone.
 *
 * @param tool - A file or command tool.
 * @returns The same tool, guarded.
 */
function steerImagesToEngine(tool: AgentTool): AgentTool {
  if (tool.spec.name !== "run_command" && tool.spec.name !== "write_file") return tool;
  const blocked = (input: Record<string, unknown>) =>
    tool.spec.name === "run_command" ? IMAGE_WORKAROUND.test(String(input.command ?? "")) : DRAWING_CODE.test(String(input.content ?? ""));
  const msg =
    "Not done: in this chat, pictures are made with generate_image (KesherAI's image engine), not by installing image libraries or drawing with code. Call generate_image with an English prompt. If the user really wants code, they will say so.";
  return {
    ...tool,
    ...(tool.preview ? { preview: async (input, ctx) => (blocked(input) ? "(redirected to generate_image)" : tool.preview!(input, ctx)) } : {}),
    run: async (input, ctx) => {
      if (blocked(input)) throw new Error(msg);
      return tool.run(input, ctx);
    },
  };
}

/**
 * Owns the live agent sessions behind conversations: creates them, loads
 * saved ones on first use, gives them the right tools (file and terminal
 * tools in code conversations, a tool per active media model, plugin
 * tools) and saves them as they change.
 */
export class ConversationManager {
  private readonly sessions = new Map<string, AgentSession>();
  /** "Keep going until done": a conversation's goal, and how many times it was sent back to work. */
  private readonly goals = new Map<string, { goal: string; rounds: number; checking?: boolean }>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  /** The Unreal project the chats work on (shared, like Unity's active project). */
  private readonly unrealState: { project?: string } = {};
  /** Whether an Unreal Engine is installed here (checked in the background). */
  private unrealEngines = false;
  private unrealCheckedAt = 0;
  /** Long builds that keep running across a KesherAI restart (~/.kesher/jobs). */
  private jobsStore?: JobStore;
  /** @returns The long-job store (made on first use). */
  jobs(): JobStore {
    this.jobsStore ??= new JobStore(join(this.deps.outputsDir, "..", "jobs"));
    return this.jobsStore;
  }

  /** Looks for installed Unreal engines at most every 5 minutes, without waiting. */
  private checkUnreal(): void {
    if (process.platform !== "win32" || Date.now() - this.unrealCheckedAt < 300_000) return;
    this.unrealCheckedAt = Date.now();
    void findEngines().then((e) => (this.unrealEngines = e.length > 0), () => undefined);
  }

  /** @param deps - Services the manager needs. */
  constructor(
    private readonly deps: {
      registry: ProviderRegistry;
      library: Library;
      assets: AssetStore;
      plugins: PluginHost;
      config: KesherConfig;
      /** Folder for the files chats make (one sub-folder per conversation). */
      outputsDir: string;
      /** Saves the project folder before each message in coding sessions. */
      checkpoints?: Checkpoints;
      /**
       * Finds an image model that runs on this computer when none usable is
       * active: uses a downloaded one, or starts downloading the best fit.
       */
      ensureImageModel?(): Promise<{ modelId?: string; message?: string }>;
      /** Video generation (Wan on stable-diffusion.cpp): finds or downloads the model, and makes a clip. */
      video?: {
        ensure(): Promise<{ path?: string; message?: string }>;
        generate(path: string, req: { prompt: string; negativePrompt?: string; seconds?: number; seed: number }): Promise<{ data: Uint8Array; mimeType: string; meta?: Record<string, unknown> }>;
      };
      /** The ready-made ComfyUI flows (music, 3D), run from the chat. */
      flows?: {
        state(id: string): { ready: boolean; downloading: boolean; missingGb: number; installed: boolean; allowed: boolean };
        setup(id: string): Promise<void>;
        run(
          id: string,
          edit: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, upload: (data: Uint8Array, name: string) => Promise<string>) => Promise<void> | void,
          signal: AbortSignal,
        ): Promise<Array<{ data: Uint8Array; mimeType: string; filename: string }>>;
      };
      /** Unity's CLI: the chat's Unity tools (when the CLI is installed). */
      unity?: UnityCli;
      /** The KesherAI Bridge plugin in Unreal: the chat's Blueprint tools (when the editor is connected). */
      unreal?: UnrealBridge;
      /** How the app looks: the change_look tool reads and changes it (Undo keeps the last looks). */
      look?: {
        get(): Appearance;
        set(next: Appearance): Promise<void>;
        undo(): Promise<boolean>;
      };
      /** Computer-control tools for a conversation (empty when the user has not turned it on). */
      computerTools?(conversationId: string): AgentTool[];
      /** Tools from connected apps: Gmail and Calendar (Google sign-in) and MCP servers. */
      mcpTools?(): AgentTool[];
      /** Notes the coach learned about how the user works, added to every system prompt. */
      userNotes?(): Promise<string[]>;
      /** The remember / forget tools for the user's memory (none when memory is off). */
      memoryTools?(): AgentTool[];
      /** Saved personas. */
      personas?: Personas;
      /** SKILL.md skills, listed in the prompt and loaded with use_skill. */
      skills?: SkillStore;
      /** Every event of every open conversation (for notifications). */
      onEvent?(conversationId: string, event: AgentEvent, title: () => string, lastAnswer: () => string | undefined): void;
    },
  ) {
    // Know at start whether Unreal is installed, so the first chat already has the Unreal tools.
    this.checkUnreal();
  }

  /**
   * Tools for the active non-chat models. Today that is `generate_image`
   * for the active image model; video, speech and music follow the same
   * pattern once their providers exist.
   *
   * @returns Tools and one line per tool for the system prompt.
   */
  mediaTools(): { tools: AgentTool[]; notes: string[] } {
    const tools: AgentTool[] = [];
    const notes: string[] = [];
    const usable = (id: string | undefined): id is string => {
      if (!id || /(^|[-_./ ])mlx([-_./ ]|$)/i.test(id)) return false;
      try {
        return !!this.deps.registry.resolve(id).provider.generateImage;
      } catch {
        return false;
      }
    };
    const active = this.deps.config.activeModels.image;
    const on = (part: string) => this.deps.config.parts?.[part] !== false;
    if (on("images") && (usable(active) || this.deps.ensureImageModel)) {
      notes.push(
        usable(active)
          ? `generate_image uses the user's active image model (${active}). Write the prompt in English.`
          : "generate_image makes pictures with KesherAI's built-in image engine; if no image model is ready it downloads one that fits this computer and says so. Write the prompt in English.",
        "For every request for a picture, photo, drawing, illustration or image, call generate_image. Never make images another way: do not install torch, diffusers or Stable Diffusion, and do not draw with turtle, PIL, matplotlib or SVG code, unless the user explicitly asks for code. If generate_image says the model is still downloading, tell the user that and stop.",
      );
      tools.push({
        risk: "safe",
        spec: {
          name: "generate_image",
          description: "Generate an image from a text prompt. The image is shown to the user. If no image model is ready yet, one is downloaded and the result says how long to wait.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Detailed description of the image, in English." },
              negative_prompt: { type: "string" },
              width: { type: "integer", description: "Default 1024." },
              height: { type: "integer", description: "Default 1024." },
            },
            required: ["prompt"],
          },
        },
        run: async (input) => {
          let imageModel = this.deps.config.activeModels.image;
          let switched = "";
          if (!usable(imageModel)) {
            const before = imageModel;
            const r = (await this.deps.ensureImageModel?.()) ?? {};
            const why = before ? `The user's image model ${before} does not run on this computer${/mlx/i.test(before) ? " (it is an Apple MLX build, for Macs only)" : ""}. ` : "";
            if (!r.modelId) return { output: why + (r.message ?? "No image model is available. Ask the user to pick one under Models → Images.") + ` ${WAIT_NOTE}` };
            imageModel = r.modelId;
            if (before) switched = ` ${why}KesherAI switched to ${r.modelId}, which runs here; tell the user, and that they can change it under Models → Images.`;
          }
          const { provider, providerModelId } = this.deps.registry.resolve(imageModel);
          const files = await provider.generateImage!({
            providerModelId,
            prompt: String(input.prompt ?? ""),
            ...(typeof input.negative_prompt === "string" ? { negativePrompt: input.negative_prompt } : {}),
            width: Number(input.width ?? 1024),
            height: Number(input.height ?? 1024),
            steps: 0, // 0 = the model family's own default (4 for FLUX schnell, 8 for turbo models)
            seed: randomInt(2 ** 31),
          }).catch((err: Error) => {
            if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
            throw err;
          });
          const assets = await Promise.all(
            files.map((f) => this.deps.assets.save(f.data, f.mimeType, { sourceModelId: imageModel, ...(f.meta ? { meta: f.meta } : {}) })),
          );
          return { output: `Generated ${assets.length} image(s); the user can see them (ids: ${assets.map((a) => a.id).join(", ")}).${switched}`, assetIds: assets.map((a) => a.id) };
        },
      });
    }
    if (this.deps.video && on("video")) {
      const video = this.deps.video;
      notes.push("generate_video makes a short video clip (about 2 seconds) from an English description with the built-in video engine; it takes a few minutes. If the model is still downloading, tell the user and stop.");
      tools.push({
        risk: "safe",
        spec: {
          name: "generate_video",
          description: "Generate a short video clip (1–5 seconds) from a text description. The video is shown to the user. Slow (minutes). If no video model is ready, one is downloaded and the result says so.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Detailed description of the scene and the motion, in English." },
              negative_prompt: { type: "string" },
              seconds: { type: "number", description: "Length, 1–5 (default 2)." },
            },
            required: ["prompt"],
          },
        },
        run: async (input) => {
          const r = await video.ensure();
          if (!r.path) return { output: `${r.message ?? "No video model is available."} ${WAIT_NOTE}` };
          const file = await video
            .generate(r.path, { prompt: String(input.prompt ?? ""), ...(typeof input.negative_prompt === "string" ? { negativePrompt: input.negative_prompt } : {}), seconds: Number(input.seconds ?? 2), seed: randomInt(2 ** 31) })
            .catch((err: Error) => {
              if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
              throw err;
            });
          const asset = await this.deps.assets.save(file.data, file.mimeType, { sourceModelId: "sdcpp-video", ...(file.meta ? { meta: file.meta } : {}) });
          return { output: "Generated a video; the user can watch it.", videoIds: [asset.id] };
        },
      });
    }
    tools.push(...this.flowTools(notes));
    tools.push(...this.lookTools(notes));
    return { tools, notes };
  }

  /**
   * learn_skill: "learn to do X" — the model writes a skill (SKILL.md) for
   * itself; the user sees all of it and approves before it is saved, since a
   * skill becomes part of what every later chat is told.
   */
  private learnTools(): AgentTool[] {
    const store = this.deps.skills;
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
  private splitTools(notes: string[], conversationId?: string): AgentTool[] {
    const registry = this.deps.registry;
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
      const current = conversationId ? this.deps.library.summary(conversationId)?.modelId : undefined;
      const local = this.defaultChatModel();
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

  /**
   * change_look: the user asks in words ("make it light", "bigger text",
   * "green accent", "put Work first") and the model changes KesherAI's look.
   * Only looks: checked by cleanAppearance, nothing else can change.
   */
  private lookTools(notes: string[]): AgentTool[] {
    const look = this.deps.look;
    if (!look) return [];
    notes.push(
      "change_look changes how KesherAI itself looks (colours, font, text size, corners, spacing, background, icons, motion and the order of the tool groups) when the user asks for it. When the user names a style (a series, a film, a game, a place: \"like One Piece\"), ALWAYS pass style with its name in English — change_look then finds real pictures of it on the web by itself (a wallpaper as the background, icons for the tools) — and in the same call give colours, font and motion that feel like it. Pass only what should change; undo: true goes back one step. After it, tell the user in one line what changed (and the picture credits it gives) and that they can say \"undo\" or open Settings → Appearance.",
    );
    const fonts = APPEARANCE_FONTS.map((f) => `${f.id}${f.hebrew ? "" : " (no Hebrew letters)"}`).join(", ");
    return [
      {
        risk: "safe",
        spec: {
          name: "change_look",
          description: "Change how the KesherAI app looks. Every field is optional; what is not given stays as it is. The page updates at once.",
          inputSchema: {
            type: "object",
            properties: {
              preset: { type: "string", enum: APPEARANCE_PRESETS.map((p) => p.id), description: "Start from a ready-made look (graphite is the default; paper is light). Clears the user's own colours." },
              colors: {
                type: "object",
                description: "Colours as #rrggbb. bg: page; panel: cards; panel-2: fields and menus; raised: hover; text; muted: secondary text; accent: buttons and what is selected. Keep text readable on bg.",
                properties: Object.fromEntries(APPEARANCE_COLORS.map((c) => [c, { type: "string" }])),
              },
              font: { type: "string", description: `One of: ${fonts}.` },
              fontSize: { type: "number", description: "Text size in px, 12–20 (default 15)." },
              radius: { type: "number", description: "Corner roundness in px, 0 (square) – 28 (very round); default 16." },
              density: { type: "string", enum: ["compact", "normal", "roomy"] },
              background: { type: "object", description: "{ kind: 'plain' }, { kind: 'gradient', from: '#rrggbb', to: '#rrggbb', angle: 0–360 }, or a picture: { kind: 'image', assetId: '<id of a picture made in this chat>', dim: 0–90 (how much the page colour covers it, default 55) }. For a picture background, make the picture first (generate_image, wide), then use its id." },
              navOrder: { type: "array", items: { type: "string", enum: [...APPEARANCE_NAV_GROUPS] }, description: "The tool groups top to bottom (create, work, assistant, system)." },
              navHide: { type: "array", items: { type: "string", enum: [...APPEARANCE_NAV_GROUPS] }, description: "Tool groups to hide from the menus." },
              motion: { type: "string", enum: ["none", "subtle", "lively"], description: "How much moves: lively adds a slowly moving background, cards that lift and page transitions." },
              icons: { type: "object", description: "Icons for tools, by page: { \"#/images\": { \"emoji\": \"🏴‍☠️\" } } or { \"assetId\": \"<id of a picture made in this chat>\" }. Pages: #/images, #/pages, #/knowledge, #/models, #/settings, #/nodes, #/unreal, #/unity, #/day, #/compare, #/pipelines, #/personas, #/memory." },
              css: { type: "string", description: "Extra CSS for looks (replaces the previous extra CSS): rules, @media and @keyframes; no @import, no outside addresses (pictures only as url(\"/api/assets/<id>\")), no position: fixed. Classes: .card, .sidebar, .appbar, .page, .home, .greeting, .composer, .app-tile, .phone-tabs, button.primary. Keep it short." },
              style: { type: "string", description: "A style the user named, in English (\"One Piece\", \"Studio Ghibli\", \"cyberpunk city\"): finds pictures of it on the web (a wallpaper for the background, icons for the tools), unless background or icons are given too." },
              pictures: { type: "string", enum: ["both", "background", "icons", "none"], description: "With style: which pictures to look for (default both)." },
              name: { type: "string", description: "A name for the look." },
              homeOrder: { type: "array", items: { type: "string", enum: ["ideas", "recent", "pins"] }, description: "The start screen under the message box, top to bottom: ideas, recent chats, pinned tools." },
              homeHide: { type: "array", items: { type: "string", enum: ["ideas", "recent", "pins"] }, description: "Start-screen parts to hide." },
              tabsOrder: { type: "array", items: { type: "string", enum: ["chats", "new", "tools", "settings"] }, description: "The phone's bottom bar, start to end." },
              reset: { type: "boolean", description: "Back to the default look." },
              undo: { type: "boolean", description: "Go back one step." },
            },
          },
        },
        run: async (input, ctx) => {
          if (input.undo === true) return { output: (await look.undo()) ? "Went back to the previous look." : "There is nothing to undo." };
          if (input.reset === true) {
            await look.set({});
            return { output: "Back to the default look." };
          }
          const credits: string[] = [];
          let found = "";
          // Small models often give the look a name but forget style: a name with no pictures of its own counts as the style.
          const named = typeof input.name === "string" && !input.background && !input.icons ? input.name.replace(/[-_]+/g, " ").replace(/\b(style|theme|look|inspired|design)\b/gi, "").trim() : "";
          const style = (typeof input.style === "string" ? input.style : named).trim().slice(0, 80);
          const want = typeof input.pictures === "string" ? input.pictures : "both";
          const pics: Record<string, unknown> = {};
          if (style && want !== "none") {
            try {
              const r = await styleLook(style, {
                background: want !== "icons" && !input.background,
                iconPages: want !== "background" && !input.icons ? LOOK_ICON_PAGES : [],
                save: async (p, use) => (await this.deps.assets.save(p.data, p.mimeType, { meta: { use, style, source: p.page, license: p.license, artist: p.artist } })).id,
                signal: ctx.signal,
              });
              if (r.background) pics.background = r.background;
              if (r.icons) pics.icons = r.icons;
              credits.push(...r.credits);
              found = r.background || r.icons ? "" : ` Found no pictures of "${style}" on the web; use emoji icons and a gradient background that fit instead (call again with icons and background).`;
            } catch (err) {
              found = ` Could not search for pictures (${(err as Error).message}); use emoji icons and a gradient instead.`;
            }
          }
          const change = cleanAppearance({ ...input, ...pics });
          if (!Object.keys(change).length) return { output: `Nothing valid to change. Colours must be #rrggbb; fonts and groups must be from the lists.${found}` };
          const cur = look.get();
          const next: Appearance = change.preset ? { ...change } : { ...cur, ...change, colors: { ...cur.colors, ...change.colors }, ...(change.icons ? { icons: { ...cur.icons, ...change.icons } } : {}) };
          if (!next.colors || !Object.keys(next.colors).length) delete next.colors;
          await look.set(next);
          return { output: `Changed the look: ${Object.keys(change).join(", ")}.${credits.length ? ` Pictures: ${credits.join("; ")}.` : ""}${found}` };
        },
      },
    ];
  }

  /**
   * make_music and make_3d: the ready-made ComfyUI flows, from the chat.
   * A missing model (several GB) is downloaded only after the user agrees.
   */
  private flowTools(notes: string[]): AgentTool[] {
    const flows = this.deps.flows;
    if (!flows || this.deps.config.parts?.nodes === false) return [];
    const gate = (id: string, download: unknown): string | undefined => {
      const st = flows.state(id);
      if (!st.allowed) return "ComfyUI is turned off by the organisation's business mode.";
      if (!st.installed) return "ComfyUI is not installed. Tell the user to install it once on the Nodes page (Install ComfyUI), then ask again.";
      if (st.ready) return undefined;
      if (st.downloading) return `The model is still downloading (about ${st.missingGb} GB left in total); the user can follow it in the downloads circle. ${WAIT_NOTE}`;
      if (download === true) {
        void flows.setup(id).catch(() => undefined);
        return `Started downloading the model (about ${st.missingGb} GB); tell the user to follow it in the downloads circle and ask again when it is done.`;
      }
      return `This needs a model download of about ${st.missingGb} GB first. Ask the user whether to download it; only if they agree, call again with download: true.`;
    };
    notes.push(
      "make_music writes a song (style tags and lyrics) with ACE-Step in ComfyUI, and make_3d turns a picture of one object into a 3D model (GLB) with Hunyuan3D 2. Both take minutes. If they say a download is needed, ask the user first.",
    );
    const music: AgentTool = {
      risk: "safe",
      spec: {
        name: "make_music",
        description: "Make a song or a piece of music from style tags and lyrics (ACE-Step in ComfyUI). The user gets a player. Slow (minutes).",
        inputSchema: {
          type: "object",
          properties: {
            tags: { type: "string", description: "Style, comma-separated English words: genre, mood, instruments, voice, tempo. E.g. 'pop, upbeat, female vocals, piano, 120 bpm'." },
            lyrics: { type: "string", description: "Lyrics with [verse], [chorus], [bridge] markers, in English letters (other languages written in Latin letters, with [he] or [ja] at the start of the line). For music without singing use [instrumental]." },
            seconds: { type: "number", description: "Length in seconds, 10–240 (default 60)." },
            download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
          },
          required: ["tags"],
        },
      },
      run: async (input, ctx) => {
        const blocked = gate("music-ace-step", input.download);
        if (blocked) return { output: blocked };
        const files = await flows.run("music-ace-step", (flow) => {
          flow["2"]!.inputs.tags = String(input.tags ?? "");
          flow["2"]!.inputs.lyrics = String(input.lyrics ?? "[instrumental]");
          flow["4"]!.inputs.seconds = Math.min(240, Math.max(10, Number(input.seconds ?? 60) || 60));
          flow["8"]!.inputs.seed = randomInt(2 ** 31);
        }, ctx.signal);
        const audio = files.filter((f) => f.mimeType.startsWith("audio/"));
        if (!audio.length) return { output: "ComfyUI finished but saved no sound." };
        const assets = await Promise.all(audio.map((f) => this.deps.assets.save(f.data, f.mimeType, { sourceModelId: "comfyui/ace-step", meta: { tags: input.tags, lyrics: input.lyrics } })));
        return { output: "Made the song; the user can play and download it.", audioIds: assets.map((a) => a.id) };
      },
    };
    const model3d: AgentTool = {
      risk: "safe",
      spec: {
        name: "make_3d",
        description: "Turn a picture of one object (plain background) into a 3D model (GLB, shape only, no colors) with Hunyuan3D 2 in ComfyUI. The user gets the file. Slow (minutes).",
        inputSchema: {
          type: "object",
          properties: {
            image: { type: "string", description: "The picture: the path the user attached it as (\"[Attached: …]\"), a file in this chat's folder." },
            download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
          },
          required: ["image"],
        },
      },
      run: async (input, ctx) => {
        const blocked = gate("3d-hunyuan3d", input.download);
        if (blocked) return { output: blocked };
        const rel = String(input.image ?? "").replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
        if (!ctx.workspace) return { output: "There is no folder for this chat to read the picture from." };
        const { resolve: resolvePath, relative, join: joinPath, dirname, basename } = await import("node:path");
        const { readFile, writeFile, mkdir } = await import("node:fs/promises");
        const file = resolvePath(ctx.workspace, rel);
        if (relative(ctx.workspace, file).startsWith("..")) return { output: "The picture must be one attached to this chat." };
        const data = await readFile(file).catch(() => undefined);
        if (!data) return { output: `No picture at ${rel}. Ask the user to attach it.` };
        const files = await flows.run("3d-hunyuan3d", async (flow, upload) => {
          flow["2"]!.inputs.image = await upload(new Uint8Array(data), `kesher-${randomInt(1e9)}-${basename(file)}`);
          flow["7"]!.inputs.seed = randomInt(2 ** 31);
        }, ctx.signal);
        const glb = files.find((f) => /\.glb$/i.test(f.filename) || f.mimeType === "model/gltf-binary");
        if (!glb) return { output: "ComfyUI finished but saved no 3D model." };
        const out = joinPath("3d", `${basename(file).replace(/\.[^.]+$/, "")}-${Date.now().toString(36)}.glb`);
        await mkdir(dirname(joinPath(ctx.workspace, out)), { recursive: true });
        await writeFile(joinPath(ctx.workspace, out), glb.data);
        return { output: `Made the 3D model ${out} (GLB, shape only); the user can download it and open it in Blender, Unreal or Unity.`, files: [out.split("\\").join("/")] };
      },
    };
    return [music, model3d];
  }

  private pluginTools(): AgentTool[] {
    return [...this.deps.plugins.tools.values()].map((t) => ({
      risk: "exec" as const,
      spec: { name: t.name, description: t.description, inputSchema: t.inputSchema },
      preview: async (input) => `${t.name} (plugin ${t.pluginId})\n${JSON.stringify(input, null, 2)}`,
      run: async (input, ctx) => {
        const result = await t.run(input, ctx.signal);
        return { output: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
      },
    }));
  }

  private toolsFor(kind: ConversationKind, id?: string): { tools: AgentTool[]; notes: string[] } {
    const media = this.mediaTools();
    const computer = id ? (this.deps.computerTools?.(id) ?? []) : [];
    if (computer.length) {
      media.notes.push(
        "You can see and control this computer: first computer_use_app (the user approves each app), computer_open_app to bring it to the front, then computer_screenshot → act → check. When you can predict several steps (click a field, type, press enter), send them in one computer_batch, which returns one screenshot at the end; use computer_zoom to read small text. Never assume an action worked: look. Prefer your other tools (files, run_command, build_executable) when they can do the job; use the screen for apps that have no other way in (Unity, Blender, Office, settings dialogs). Browsers are view-only, terminals click-only, and you never type passwords or payment details.",
      );
    }
    // Chats get the file tools too, inside their own outputs folder, so they can make real files and programs.
    const hasImages = media.tools.some((t) => t.spec.name === "generate_image");
    const code = kind === "chat" && hasImages ? CODE_TOOLS.map(steerImagesToEngine) : CODE_TOOLS;
    const skills = [...(this.deps.skills?.count ? [this.deps.skills.tool()] : []), ...this.learnTools()];
    const group = id ? this.groupTools(id) : { tools: [], notes: [] };
    const split = this.splitTools(media.notes, id);
    // The numbers of an exported chat between people (the relationship analyst persona uses it).
    split.push(analyzeChatTool);
    // Unity through its CLI: when it is installed here, or a Unity project was added (then unity_status explains a missing CLI).
    const unity = this.deps.unity && (this.deps.unity.cliKnown() || this.deps.unity.activeProject)
      ? unityTools(this.deps.unity, join(this.deps.outputsDir, id ?? "unity"), async (data, mimeType) => (await this.deps.assets.save(data, mimeType, { meta: { use: "unity-screenshot" } })).id, () => chosenPhones(this.deps.config.phones?.targets ?? [], (this.deps.config.phones?.custom ?? []) as Phone[]))
      : [];
    // Fewer tokens: the long Unity guide and every Unity tool only while a Unity project is in use.
    if (unity.length && this.deps.unity?.activeProject) media.notes.push(UNITY_NOTE);
    else if (unity.length) media.notes.push("Unity's CLI is installed here: for Unity work, ask the user to pick or create a Unity project (+ → Project, or the Unity page); unity_status shows what is ready.");
    // Graphs in words from any chat: Unity Script/State Graphs, and Unreal Blueprints (KesherAI Bridge plugin).
    const chatModel = () => this.defaultChatModel();
    if (unity.length && this.deps.unity?.activeProject) {
      split.push(...graphTools("unity", this.deps.unity, this.deps.registry, chatModel));
      media.notes.push("unity_list_graphs, unity_read_graph and unity_change_graph see and change the project's Visual Scripting graphs (Script Graphs and State Graphs) in words; prefer them for graph logic.");
    }
    if (this.deps.unreal?.connected) {
      split.push(...graphTools("unreal", this.deps.unreal, this.deps.registry, chatModel, async (png) => (await this.deps.assets.save(png, "image/png", { meta: { use: "unreal-test" } })).id));
      media.notes.push("The user's Unreal Editor is connected (KesherAI Bridge): unreal_list_graphs, unreal_read_graph and unreal_change_graph see and change Blueprints in words (one undo step, then compiled); unreal_test_blueprint plays the game in the editor for a few seconds and returns the log and a picture, to check a change works.");
    }
    // Unreal 5.8's own MCP server (the "Unreal Engine" connection): how to use it well.
    if ((this.deps.mcpTools?.() ?? []).some((t) => /(^|_)(list_toolsets|describe_toolset)$/.test(t.spec.name))) {
      media.notes.push(
        "Unreal Editor tools (Unreal's own MCP server): first list_toolsets, then describe_toolset on the one you need to read its tools' exact arguments, then call_tool with toolset_name, tool_name and arguments — never guess tool names. Check for project skills with AgentSkillToolset.ListSkills and follow a relevant one. Ask the user to save before a change that touches several assets. Wait for compiles to finish (LiveCodingToolset.CompileLiveCoding for C++). Read every result: anything that is not an explicit success is a stop. If Play-in-Editor is running, asset tools behave differently: stop it first or tell the user.",
      );
    }
    split.push(...(this.deps.unity?.activeProject ? unity : unity.filter((t) => t.spec.name === "unity_status")));
    // Unreal: when an engine is installed here (checked in the background, at most every 5 minutes) or a project is in use.
    this.checkUnreal();
    // Fewer tokens: with no Unreal project in use, only the three entry tools and one line go to the model
    // (the full set and its long guide come once a project is created or opened); every message carried ~1,500
    // tokens of Unreal guidance before, also in chats that had nothing to do with Unreal.
    if (this.unrealState.project) {
      split.push(...unrealTools(this.unrealState, join(this.deps.outputsDir, "..", "logs"), this.jobs(), () => void this.refreshTools(id), () => chosenPhones(this.deps.config.phones?.targets ?? [], (this.deps.config.phones?.custom ?? []) as Phone[])));
      media.notes.push(UNREAL_NOTE);
    } else if (this.unrealEngines) {
      split.push(...unrealTools(this.unrealState, join(this.deps.outputsDir, "..", "logs"), this.jobs(), () => void this.refreshTools(id), () => chosenPhones(this.deps.config.phones?.targets ?? [], (this.deps.config.phones?.custom ?? []) as Phone[])).filter((t) => /^unreal_(status|create_project|use_project)$/.test(t.spec.name)));
      media.notes.push("Unreal Engine is installed here: for Unreal work start with unreal_status, then unreal_create_project or unreal_use_project (the other Unreal tools and their guide come after that).");
    }
    // A game project in use: running its Android build on the user's phone and reading why it closed.
    if (this.unrealState.project || this.deps.unity?.activeProject) {
      split.push(...androidPhoneTools());
      media.notes.push(BUILD_RESEARCH_NOTE);
      // The phones the user builds for (Settings → For developers → Target phones): one short line.
      const phones = chosenPhones(this.deps.config.phones?.targets ?? [], (this.deps.config.phones?.custom ?? []) as Phone[]);
      if (phones.length) media.notes.push(phoneNote(phones));
    }
    const all = [...code, ...media.tools, ...split, ...computer, ...group.tools, ...this.pluginTools(), ...skills, ...(this.deps.memoryTools?.() ?? []), ...(this.deps.mcpTools?.() ?? [])];
    // Helpers: other models (or the same one) do read-only legwork in parallel and report back.
    if (id) all.push(this.delegateFor(id, all));
    // A chat written from Telegram never controls the screen or the browser, whatever else is on.
    const telegram = id ? this.deps.library.summary(id)?.source === "telegram" : false;
    if (telegram) {
      return {
        tools: all.filter((t) => !/^(computer_|browser_|unity_script_eval$|unity_write_script$|unreal_(write_source|python|compile|package|create_project|open_editor|port_plugin)$|android_run_on_phone$)/.test(t.spec.name)),
        notes: [...media.notes.filter((n) => !n.startsWith("You can see and control this computer")), ...group.notes, "This chat is written from Telegram: you cannot control the screen or the browser here, and every change asks the user first."],
      };
    }
    return { tools: all, notes: [...media.notes, ...group.notes] };
  }

  /** Chat models seen on the last listing, for the helpers' description (refreshed in the background). */
  private chatModelIds: string[] = [];
  private chatModelsAt = 0;

  private delegateFor(id: string, tools: AgentTool[]): AgentTool {
    if (Date.now() - this.chatModelsAt > 5 * 60_000) {
      this.chatModelsAt = Date.now();
      void this.deps.registry
        .listAllModels()
        .then((l) => (this.chatModelIds = l.models.filter((m) => (m.category === "chat" || m.category === "code") && !/embed|whisper|tts|rerank|phonon/i.test(m.providerModelId)).map((m) => m.id)))
        .catch(() => undefined);
    }
    return delegateTool({
      tools: () => tools,
      currentModel: () => this.sessions.get(id)?.modelId ?? this.deps.config.activeModels.chat,
      turnFor: (modelId) => {
        this.deps.registry.resolve(modelId);
        return modelTurnFor(this.deps.registry, modelId);
      },
      models: () => this.chatModelIds,
      workspace: () => this.sessions.get(id)?.workspace,
      contextTokens: (m) => this.contextFor(m),
    });
  }

  private teamCache = new Map<string, Teammate[]>();
  private groupCache = new Map<string, string[]>();

  /**
   * Agent group (LobeHub's agent groups): the chat's model leads a group of
   * personas. It asks each member for its part with `ask_member`; the member
   * answers with its own instructions and model; the lead puts it together.
   */
  private groupTools(id: string): { tools: AgentTool[]; notes: string[] } {
    const members = (this.groupCache.get(id) ?? []).flatMap((pid) => {
      const p = this.deps.personas?.get(pid);
      return p ? [p] : [];
    });
    if (!members.length) return { tools: [], notes: [] };
    const conv = () => this.sessions.get(id);
    const tool: AgentTool = {
      spec: {
        name: "ask_member",
        description: `Give one member of your group a part of the task and get its answer. Members: ${members.map((m) => m.name).join(", ")}.`,
        inputSchema: {
          type: "object",
          properties: {
            member: { type: "string", enum: members.map((m) => m.name), description: "Which member." },
            task: { type: "string", description: "What this member should do: its part, with everything it needs to know (it does not see the chat)." },
          },
          required: ["member", "task"],
        },
      },
      risk: "read",
      preview: async (input) => `${String(input.member)}: ${String(input.task)}`,
      run: async (input, ctx) => {
        const member = members.find((m) => m.name === input.member) ?? members.find((m) => m.name.toLowerCase() === String(input.member).toLowerCase());
        if (!member) throw new Error(`No member named ${String(input.member)}. Members: ${members.map((m) => m.name).join(", ")}.`);
        const modelId = member.modelId ?? conv()?.modelId ?? this.deps.config.activeModels.chat;
        if (!modelId) throw new Error("No chat model for this member.");
        const r = await modelTurnFor(this.deps.registry, modelId)(
          {
            messages: [
              { role: "system", content: `${personaPrompt(member)}\n\nYou are ${member.name}, one member of a group working on the user's request. The group's lead gives you a part of it: do that part well and answer with your result only, in the user's language. You do not see the rest of the chat.` },
              { role: "user", content: String(input.task ?? "") },
            ],
            tools: [],
          },
          ctx.signal,
          () => undefined,
        );
        const text = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
        return { output: `${member.icon ?? "👤"} ${member.name} (${modelId.split("/").pop()}):\n${text}` };
      },
    };
    const notes = [
      `You lead a group of assistants: ${members.map((m) => `${m.name}${m.instructions ? ` (${m.instructions.replace(/\s+/g, " ").slice(0, 140)})` : ""}`).join("; ")}. For a request that fits their skills, split it: call ask_member once for each member's part (you can call several at once), with everything that member needs, since they do not see the chat. Then answer the user yourself, combining their work, and say briefly who did what. For small talk or a request no member fits, just answer.`,
    ];
    return { tools: [tool], notes };
  }

  /**
   * @param id - Conversation id.
   * @returns Its teammates, resolved to callable models (unknown models are skipped).
   */
  private teamOf(id: string): TeamMember[] {
    return (this.teamCache.get(id) ?? []).flatMap((m) => {
      try {
        this.deps.registry.resolve(m.modelId);
        return [{ role: m.role, modelId: m.modelId, model: modelTurnFor(this.deps.registry, m.modelId) }];
      } catch {
        return [];
      }
    });
  }

  private contextFor(modelId: string): number {
    try {
      return this.deps.registry.resolve(modelId).provider.location === "cloud" ? 100_000 : 12_000;
    } catch {
      return 12_000;
    }
  }

  private defaultChatModel(): string | undefined {
    return this.deps.config.activeModels.chat;
  }

  /**
   * The folder a conversation works in: the project folder for code
   * sessions, and a private outputs folder for chats.
   *
   * @param c - Conversation.
   * @returns Absolute folder.
   */
  workspaceOf(c: Pick<Conversation, "id" | "kind" | "workspace" | "projectId">): string | undefined {
    if (c.kind !== "code") return join(this.deps.outputsDir, c.id);
    return c.workspace ?? (c.projectId ? this.deps.library.getProject(c.projectId)?.workspace : undefined);
  }

  /**
   * The folders a chat's checkpoints cover: a coding session's folder, and the
   * Unity or Unreal projects given to the chat (so "restore to here" also undoes
   * what the agent changed in the game project).
   *
   * @returns Each folder with the key of its checkpoint store.
   */
  checkpointFolders(c: Pick<Conversation, "id" | "kind" | "workspace" | "projectId">, grants: string[]): Array<{ key: string; folder: string }> {
    const out: Array<{ key: string; folder: string }> = [];
    if (c.kind === "code") {
      const ws = this.workspaceOf(c);
      if (ws) out.push({ key: c.id, folder: ws });
    }
    const game = (dir: string) =>
      (existsSync(join(dir, "Assets")) && existsSync(join(dir, "ProjectSettings"))) || (existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.toLowerCase().endsWith(".uproject")));
    for (const g of grants.slice(-3)) {
      if (out.some((o) => o.folder === g) || !game(g)) continue;
      out.push({ key: `${c.id}-g${createHash("sha1").update(g.toLowerCase()).digest("hex").slice(0, 10)}`, folder: g });
    }
    return out;
  }

  private async promptFor(c: Pick<Conversation, "id" | "kind" | "workspace" | "projectId" | "personaId">, notes: string[]): Promise<string> {
    const project = c.projectId ? this.deps.library.getProject(c.projectId) : undefined;
    const persona = this.deps.personas?.get(c.personaId);
    const workspace = this.workspaceOf(c);
    return buildSystemPrompt({
      productName: branding.productName,
      ...(workspace ? (c.kind === "code" ? { workspace } : { outputsFolder: workspace }) : {}),
      ...(project?.instructions ? { projectInstructions: project.instructions } : {}),
      toolNotes: [...notes, ...(await this.learnedNotes()), ...[(await this.deps.skills?.promptSection(c.kind === "code" ? workspace : undefined)) ?? ""].filter(Boolean)],
      ...(persona ? { persona: personaPrompt(persona) } : {}),
    });
  }

  private async learnedNotes(): Promise<string[]> {
    const learned = (await this.deps.userNotes?.().catch(() => [])) ?? [];
    return learned.length ? [`About this user (their memory in KesherAI, which they can see and edit; follow it unless they say otherwise): ${learned.join("; ")}`] : [];
  }

  /**
   * What a coach needs to know about a conversation's setup.
   *
   * @param c - The conversation.
   * @returns Tool and plugin names, the main model and teammates.
   */
  setupOf(c: Conversation): { tools: string[]; plugins: string[]; mainModel: string; team: string[] } {
    const { tools } = this.toolsFor(c.kind, c.id);
    return {
      tools: tools.map((t) => t.spec.name),
      plugins: [...new Set([...this.deps.plugins.tools.values()].map((t) => t.pluginId))],
      mainModel: c.modelId,
      team: (c.team ?? []).map((m) => `${m.role} ${m.modelId}`),
    };
  }

  /**
   * Creates and saves a conversation.
   *
   * @param opts - Kind, project, model, folder.
   * @returns The new conversation.
   * @throws Error if no model is given and no chat model is active, or a code conversation has no valid folder.
   */
  async create(opts: NewConversation): Promise<Conversation> {
    await this.deps.personas?.load();
    const persona = this.deps.personas?.get(opts.personaId);
    const modelId = opts.modelId ?? persona?.modelId ?? this.defaultChatModel();
    if (!modelId) throw new NoModelError("chat");
    const projectId = opts.projectId ?? null;
    if (projectId && !this.deps.library.getProject(projectId)) throw new Error("That project does not exist.");
    if (opts.kind === "code") {
      const folder = opts.workspace ?? (projectId ? this.deps.library.getProject(projectId)?.workspace : undefined);
      if (!folder) throw new Error("A code conversation needs a project folder.");
      await assertFolder(folder);
    }
    const now = new Date().toISOString();
    return this.deps.library.saveConversation({
      id: randomUUID(),
      projectId,
      title: opts.title ?? (opts.kind === "code" ? "New code session" : "New chat"),
      ...(persona ? { personaId: persona.id } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      kind: opts.kind,
      modelId,
      // A chat writes only into its own outputs folder, so file edits need no approval there; commands still ask.
      // Telegram chats always ask (a message from far away should not change files by itself).
      mode: opts.source === "telegram" ? "ask" : (opts.mode ?? (opts.kind === "code" ? "ask" : "auto-edit")),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      messages: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Returns the live session for a conversation, loading it if needed.
   *
   * @param id - Conversation id.
   * @returns The session and the conversation record, or `undefined`.
   */
  async open(id: string): Promise<{ session: AgentSession; conversation: Conversation } | undefined> {
    const conversation = await this.deps.library.getConversation(id);
    if (!conversation) return undefined;
    this.teamCache.set(id, conversation.team ?? []);
    this.groupCache.set(id, conversation.group ?? []);
    const live = this.sessions.get(id);
    if (live) return { session: live, conversation };
    const { tools, notes } = this.toolsFor(conversation.kind, conversation.id);
    const workspace = this.workspaceOf(conversation);
    if (workspace && conversation.kind !== "code") await mkdir(workspace, { recursive: true });
    const session = new AgentSession({
      id,
      modelId: conversation.modelId,
      model: modelTurnFor(this.deps.registry, conversation.modelId),
      mode: conversation.mode,
      ...(workspace ? { workspace } : {}),
      tools,
      systemPrompt: await this.promptFor(conversation, notes),
      messages: conversation.messages,
      events: conversation.events,
      onChange: () => this.scheduleSave(id),
      // Cloud models read far more than a 16k-context local model.
      contextTokens: this.contextFor(conversation.modelId),
      // Read on every request, so adding or removing a teammate applies to the next message.
      team: () => this.teamOf(id),
      // Tool search for local models with many tools: the everyday tools in full, the rest loaded on demand.
      toolSearch: () => {
        const c = this.deps.library.summary(id);
        const model = c?.modelId ?? "";
        let local = true;
        try {
          local = this.deps.registry.resolve(model).provider.location !== "cloud";
        } catch {
          local = true;
        }
        if (!(local && this.deps.config.toolSearch !== false)) return undefined;
        // A Unity project in use: its tools are always sent in full, so the model never works blind and guesses.
        return [...CORE_TOOLS, ...(this.deps.unity?.activeProject ? UNITY_TOOL_NAMES : []), ...(this.unrealState.project || this.deps.unity?.activeProject ? ["android_run_on_phone"] : []), ...(this.unrealState.project ? UNREAL_TOOL_NAMES : this.unrealEngines ? ["unreal_status", "unreal_create_project", "unreal_use_project"] : []), ...(this.deps.unreal?.connected ? UNREAL_GRAPH_TOOLS : [])];
      },
      isAlwaysAllowed: (tool, modelId, command) => this.deps.config.permissions.some((r) => ruleAllows(r, { tool, modelId, conversationId: id, ...(command !== undefined ? { command } : {}) })),
    });
    this.sessions.set(id, session);
    if (this.deps.onEvent) {
      const title = () => this.deps.library.summary(id)?.title ?? conversation.title;
      const lastAnswer = () => [...session.events].reverse().find((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant")?.text;
      session.on("event", (e: AgentEvent) => this.deps.onEvent?.(id, e, title, lastAnswer));
    }
    // When the agent is free again, the next queued message goes; with a goal, it is checked first.
    session.on("event", (e: { type: string; status?: string }) => {
      if (e.type !== "status" || (e.status !== "idle" && e.status !== "error")) return;
      if (e.status === "idle" && this.goals.has(id) && !session.queued.length) void this.checkGoal(id);
      else setTimeout(() => void this.drain(id), 50);
    });
    return { session, conversation };
  }

  /**
   * "Keep going until done": sets a goal for a conversation and sends it.
   * Each time the agent stops, a reviewer pass (the same model) checks the
   * goal against what was done; while something is missing, the agent is
   * sent back to finish it (at most 6 times). An empty goal stops it.
   *
   * @param id - Conversation.
   * @param goal - What must be true when it is done.
   */
  async setGoal(id: string, goal: string): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const g = goal.trim();
    if (!g) {
      if (this.goals.delete(id)) opened.session.note("Goal stopped.");
      return;
    }
    this.goals.set(id, { goal: g.slice(0, 2000), rounds: 0 });
    opened.session.note(`Goal: ${g.slice(0, 300)} (KesherAI checks it each time the agent stops, and sends it back until it is done.)`);
    await this.send(id, `Goal: ${g}\n\nWork until this goal is fully met. When you think it is done, say what you did and how you checked it.`);
  }

  /** @returns The conversation's goal, if one is set. */
  goalOf(id: string): { goal: string; rounds: number } | undefined {
    const g = this.goals.get(id);
    return g ? { goal: g.goal, rounds: g.rounds } : undefined;
  }

  private async checkGoal(id: string): Promise<void> {
    const g = this.goals.get(id);
    const opened = await this.open(id);
    if (!g || g.checking || !opened) return;
    const { session, conversation } = opened;
    g.checking = true;
    try {
      const recent = session.events
        .slice(-40)
        .map((e) => (e.type === "assistant" ? `Assistant: ${e.text}` : e.type === "tool_call" ? `Tool: ${e.name}` : e.type === "tool_result" ? `Result of ${e.name}: ${e.ok ? "ok" : "failed"} ${e.output.slice(0, 300)}` : e.type === "user" ? `User: ${e.text}` : ""))
        .filter(Boolean)
        .join("\n")
        .slice(-12_000);
      const review = await modelTurnFor(this.deps.registry, conversation.modelId)(
        {
          messages: [
            { role: "system", content: 'You check whether a goal is fully done, strictly, from the work shown. Reply with JSON only: {"done": true|false, "missing": "what is still missing, in one sentence"}.' },
            { role: "user", content: `Goal: ${g.goal}\n\nThe work so far (latest last):\n${recent}` },
          ],
          tools: [],
        },
        AbortSignal.timeout(180_000),
        () => undefined,
      );
      const m = /\{[\s\S]*\}/.exec(review.text.replace(/<think>[\s\S]*?<\/think>/g, ""));
      const verdict = m ? (JSON.parse(m[0]) as { done?: boolean; missing?: string }) : { done: false, missing: "" };
      if (verdict.done) {
        this.goals.delete(id);
        session.note(`Goal reached ✓ (checked after ${g.rounds + 1} ${g.rounds ? "rounds" : "round"}).`);
        return;
      }
      if (++g.rounds > 6) {
        this.goals.delete(id);
        session.note(`Stopped after 7 rounds; the goal is not met yet${verdict.missing ? `: ${verdict.missing}` : "."} Say how to go on.`);
        return;
      }
      const missing = String(verdict.missing ?? "").slice(0, 500) || "the check did not find it done";
      session.note(`Goal check ${g.rounds}: not done yet. ${missing}`);
      await this.send(id, `[KesherAI goal check] The goal is not met yet: ${missing}\nKeep going until it is: ${g.goal}`);
    } catch (err) {
      session.note(`The goal check failed (${(err as Error).message}); stopped the goal.`);
      this.goals.delete(id);
    } finally {
      g.checking = false;
    }
  }

  /**
   * Sends a user message. The first message also titles the conversation.
   *
   * @param id - Conversation id.
   * @param text - Message.
   * @throws Error if the conversation does not exist or is busy.
   */
  async send(id: string, text: string, opts: { web?: boolean } = {}): Promise<{ queued?: number }> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session } = opened;
    // Busy: the message waits in the queue and goes as soon as the agent is free, like in Claude.
    if (session.busy || session.queued.length) {
      session.queued.push({ id: randomUUID(), text, data: opts });
      session.queuePaused = false;
      session.queueChanged();
      if (!session.busy) await this.drain(id);
      return { queued: session.queued.length };
    }
    session.queuePaused = false;
    await this.sendNow(id, text, opts);
    return {};
  }

  /**
   * Puts a coding session's folder back as it was before a message.
   *
   * @param id - The conversation.
   * @param checkpoint - The checkpoint id.
   */
  async restoreCheckpoint(id: string, checkpoint: string): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const folders = this.checkpointFolders(opened.conversation, opened.session.grants);
    if (!folders.length || !this.deps.checkpoints) throw new Error("This conversation has no project folder.");
    if (opened.session.busy) throw new Error("Stop the agent first.");
    // One message may have saved several folders ("a+b"): each is restored in its own store.
    let restored = 0;
    for (const part of checkpoint.split("+")) {
      for (const t of folders) {
        if (!(await this.deps.checkpoints.has(t.key, part))) continue;
        await this.deps.checkpoints.restore(t.key, t.folder, part);
        restored++;
        break;
      }
    }
    if (!restored) throw new Error("No such checkpoint.");
    opened.session.note(restored > 1 ? "Restored the project folders to this checkpoint." : "Restored the project folder to this checkpoint.");
  }

  /** Sends the next queued message, if the agent is free and the queue is not paused. */
  private async drain(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.queuePaused || !session.queued.length) return;
    if (session.busy) {
      setTimeout(() => void this.drain(id), 250);
      return;
    }
    const next = session.queued.shift();
    if (!next) return;
    session.queueChanged();
    await this.sendNow(id, next.text, (next.data as { web?: boolean }) ?? {}).catch((err: Error) => {
      session.queued.unshift(next);
      session.queueChanged();
      console.warn(`[queue] ${id}: ${err.message}`);
    });
  }

  /**
   * Lets a paused queue (after Stop) go on.
   *
   * @param id - Conversation.
   */
  async resumeQueue(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.queuePaused = false;
    session.queueChanged();
    await this.drain(id);
  }

  /**
   * Removes a queued message.
   *
   * @param id - Conversation.
   * @param queuedId - The queued message.
   * @returns Whether it was there.
   */
  unqueue(id: string, queuedId: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const before = session.queued.length;
    session.queued = session.queued.filter((q) => q.id !== queuedId);
    if (session.queued.length !== before) session.queueChanged();
    return session.queued.length !== before;
  }

  /**
   * Gives a running session its tools and prompt again, mid-answer (an Unreal project was just created or
   * opened, so its full tools come now, not only from the next message).
   */
  private async refreshTools(id?: string): Promise<void> {
    if (!id) return;
    const session = this.sessions.get(id);
    const conversation = this.deps.library.summary(id);
    if (!session || !conversation) return;
    const { tools, notes } = this.toolsFor(conversation.kind, id);
    session.setTools(tools);
    session.systemPrompt = await this.promptFor(conversation, notes);
  }

  private async sendNow(id: string, text: string, opts: { web?: boolean }): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session, conversation } = opened;
    // "[Unreal project: Name, UE 5.8 — C:\path; …]" (Unreal page → Open in chat): the Unreal tools work on that project.
    const unrealHeader = /^\s*\[Unreal project: [^\]\n]*? — ([^;\]\n]+)[;\]]/.exec(text);
    let unrealDir = unrealHeader ? await readProject(unrealHeader[1]!.trim()).then((p) => p.dir, () => undefined) : undefined;
    // "[Unreal project: Name — the editor is connected]": the project the connected editor has open, or one of that name
    // in the usual folders (before 0.5.97 the header had no path, so the chat got no project and the small model stalled).
    const unrealName = /^\s*\[Unreal project: ([\w-]+)/.exec(text)?.[1];
    if (!unrealDir && unrealName) {
      const home = homedir();
      for (const c of [this.deps.unreal?.projectFile, join(home, "Documents", "Unreal Projects", unrealName), join(home, "Unreal Projects", unrealName)]) {
        if (!c) continue;
        const p = await readProject(c).catch(() => undefined);
        if (p && basename(p.file).toLowerCase() === `${unrealName.toLowerCase()}.uproject`) {
          unrealDir = p.dir;
          break;
        }
      }
    }
    if (unrealDir) this.unrealState.project = unrealDir;
    // Rebuild tools and prompt so new active models and project changes apply.
    const { tools, notes } = this.toolsFor(conversation.kind, conversation.id);
    session.setTools(tools);
    session.systemPrompt = await this.promptFor(conversation, notes);
    if (session.messages.length === 0 && /^New (chat|code session)$/.test(conversation.title)) {
      await this.deps.library.saveConversation({ ...conversation, title: titleFrom(text), messages: session.messages, events: session.events });
    }
    // "Search the web" in the composer: KesherAI searches first and gives the model the results, so even
    // models without tool calling answer from current information (models with tools can also search themselves).
    let context: string | undefined;
    let note: string | undefined;
    // "[Unity project: Name — C:\path]" (Unity page → Open in chat): that project, already on the user's list, is opened
    // to the chat's file tools too, so list_files/read_file see it like the unity_* tools do.
    const unityHeader = /^\s*\[Unity project: [^\]\n]*? — ([^\]\n]+)\]/.exec(text);
    if (unityHeader && this.deps.unity?.hasProject(unityHeader[1]!.trim())) await session.grant(unityHeader[1]!.trim()).catch(() => undefined);
    // A message about a project the user attached ("[Unity project: …]"): no search first — it fills a local
    // model's context with unrelated pages; the model can still search with its web_search tool when it needs to.
    const aboutProject = /^\s*\[[^\]\n]{0,40}project:/i.test(text);
    if (opts.web && !aboutProject) {
      // The words the user typed, without the "[Unity project: …]" header a project adds.
      const query = text.replace(/^\s*\[[^\]\n]{1,300}\]\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200);
      try {
        const r = await webSearchTool.run({ query }, { signal: AbortSignal.timeout(20_000), recordChange: () => undefined });
        context = `Web search results for "${query}" (searched just now). Use them for current facts, say which ones you used, and give their links:\n${r.output}`;
        note = `Searched the web: ${r.output === "No results." ? "no results" : `${r.output.split("\n").filter((l) => /^\d+\. /.test(l)).length} results`}.`;
      } catch (err) {
        context = `(A web search was asked for but failed: ${(err as Error).message}. Say so if it matters.)`;
      }
    }
    // Save the folders first (a coding session's folder, and a chat's Unity/Unreal projects), so this point can be restored with one click.
    if (this.deps.checkpoints && !session.busy) {
      let first: { id: string; files: number } | undefined;
      for (const t of this.checkpointFolders(conversation, session.grants)) {
        const cp = await this.deps.checkpoints.snapshot(t.key, t.folder, text).catch(() => undefined);
        if (cp && !first) first = cp;
        else if (cp && first) first = { id: `${first.id}+${cp.id}`, files: first.files + cp.files };
      }
      if (first) session.checkpoint(first.id, first.files);
    }
    session.send(text, context, note);
  }

  /**
   * Changes a conversation's title, model, mode or project.
   *
   * @param id - Conversation id.
   * @param patch - Fields to change.
   * @returns The updated conversation.
   */
  async update(id: string, patch: Partial<Pick<Conversation, "title" | "modelId" | "mode" | "projectId" | "team" | "group">> & { personaId?: string | null }): Promise<Conversation | undefined> {
    const opened = await this.open(id);
    if (!opened) return undefined;
    const { session, conversation } = opened;
    const { personaId, ...rest } = patch;
    let next: Conversation = { ...conversation, ...rest };
    if (personaId !== undefined) {
      const { personaId: _old, ...without } = next;
      next = personaId ? { ...without, personaId } : without;
      session.systemPrompt = await this.promptFor(next, this.toolsFor(next.kind, next.id).notes);
    }
    if (patch.team) this.teamCache.set(id, patch.team);
    if (patch.group) {
      await this.deps.personas?.load();
      // A new group: new tools, and the lead's instructions say who is in it.
      this.groupCache.set(id, patch.group);
      const { tools, notes } = this.toolsFor(next.kind, id);
      session.setTools(tools);
      session.systemPrompt = await this.promptFor(next, notes);
    }
    if (patch.modelId && patch.modelId !== session.modelId) session.setModel(patch.modelId, modelTurnFor(this.deps.registry, patch.modelId));
    if (patch.mode) session.setMode(patch.mode);
    return this.deps.library.saveConversation({
      ...next,
      modelId: session.modelId,
      mode: session.mode,
      messages: session.messages,
      events: session.events,
    });
  }

  /**
   * Branches a conversation: a new conversation with everything up to an
   * event, which then goes its own way. With `edit`, the event must be one
   * of the user's messages; the branch starts just before it and sends the
   * edited message instead ("edit and resend").
   *
   * The branch's model memory is rebuilt from what the user saw (messages,
   * answers, short tool results), so it works however the original was
   * summarized. Files are not copied: a code session's branch works in the
   * same folder.
   *
   * @param id - The conversation.
   * @param seq - The event to branch at.
   * @param edit - New text for the user's message at `seq`.
   * @returns The new conversation.
   */
  async branch(id: string, seq: number, edit?: string): Promise<Conversation> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session, conversation } = opened;
    const at = session.events.find((e) => e.seq === seq);
    if (!at) throw new Error("That message is not in this conversation.");
    if (edit !== undefined && at.type !== "user") throw new Error("Only your own messages can be edited.");
    const keep = session.events.filter((e) => e.seq > 0 && (edit !== undefined ? e.seq < seq : e.seq <= seq));
    const messages: AgentMessage[] = [];
    let tools: string[] = [];
    const say = (role: "user" | "assistant", content: string) => {
      const last = messages.at(-1);
      if (last && last.role === role && typeof last.content === "string") last.content = `${last.content}\n\n${content}`;
      else messages.push({ role, content } as AgentMessage);
    };
    for (const e of keep) {
      if (e.type === "user") {
        tools = [];
        say("user", e.text);
      } else if (e.type === "answer") say("user", e.text);
      else if (e.type === "compacted") say("user", `(Summary of the conversation so far: ${e.summary})`);
      else if (e.type === "tool_result") tools.push(`[${e.name} ${e.ok ? "→" : "failed:"} ${e.output.replace(/\s+/g, " ").slice(0, 300)}]`);
      else if (e.type === "assistant" && e.text.trim()) {
        say("assistant", tools.length ? `${tools.join("\n")}\n\n${e.text}` : e.text);
        tools = [];
      }
    }
    const now = new Date().toISOString();
    const { messages: _m, events: _e, branchOf: _b, ...rest } = conversation;
    const created = await this.deps.library.saveConversation({
      ...rest,
      id: randomUUID(),
      title: `${conversation.title.replace(/ ↳\d*$/, "")} ↳`,
      branchOf: { id, seq, title: conversation.title },
      messages,
      events: keep,
      createdAt: now,
      updatedAt: now,
    });
    if (edit?.trim()) await this.send(created.id, edit.trim());
    return created;
  }

  /**
   * Saves chats imported from another assistant (see `chat-import.ts`) as
   * KesherAI chats you can read and continue. A chat imported before is
   * skipped (its id comes from where it came from).
   *
   * @param chats - The chats.
   * @param projectId - A project to put them in, or none.
   * @returns How many were added and how many were there already.
   */
  async importChats(chats: ImportedChat[], projectId: string | null = null): Promise<{ added: number; skipped: number }> {
    const modelId = this.defaultChatModel() ?? "";
    let added = 0;
    let skipped = 0;
    for (const chat of chats) {
      const h = createHash("sha256").update(`${chat.source}:${chat.originalId}`).digest("hex");
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      if (await this.deps.library.getConversation(id)) {
        skipped++;
        continue;
      }
      const events: AgentEvent[] = [];
      const messages: AgentMessage[] = [];
      let turn = 0;
      for (const m of chat.messages) {
        const at = m.at ?? chat.createdAt;
        if (m.role === "user") events.push({ seq: events.length + 1, at, type: "user", text: m.text });
        else events.push({ seq: events.length + 1, at, type: "assistant", turn: ++turn, text: m.text });
        const last = messages.at(-1);
        if (last && last.role === m.role && typeof last.content === "string") last.content = `${last.content}\n\n${m.text}`;
        else messages.push({ role: m.role, content: m.text } as AgentMessage);
      }
      const updatedAt = chat.messages.at(-1)?.at ?? chat.createdAt;
      await this.deps.library.saveConversation({
        id,
        projectId,
        title: chat.title.slice(0, 120),
        kind: "chat",
        modelId,
        mode: "auto-edit",
        importedFrom: chat.source,
        messages,
        events,
        createdAt: chat.createdAt,
        updatedAt,
      });
      added++;
    }
    return { added, skipped };
  }

  /**
   * "Another answer": writes the last answer again with the conversation's
   * current tools and prompt; the earlier answer stays as a version.
   *
   * @param id - Conversation.
   */
  async regenerate(id: string): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session, conversation } = opened;
    const { tools, notes } = this.toolsFor(conversation.kind, conversation.id);
    session.setTools(tools);
    session.systemPrompt = await this.promptFor(conversation, notes);
    session.regenerate();
  }

  /**
   * Stops a conversation's work (like pressing Stop in it).
   *
   * @param id - Conversation.
   */
  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    // After Stop, queued messages wait until the user sends again (or removes them).
    if (s.queued.length) {
      s.queuePaused = true;
      s.queueChanged();
    }
    s.stop();
  }

  /** @param id - Conversation to delete; its session is stopped first. */
  async delete(id: string): Promise<void> {
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
    clearTimeout(this.saveTimers.get(id));
    await this.deps.library.deleteConversation(id);
  }

  private scheduleSave(id: string): void {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(
      id,
      setTimeout(() => void this.saveNow(id), 300),
    );
  }

  /**
   * Writes a session's state to the library now.
   *
   * @param id - Conversation id.
   */
  async saveNow(id: string): Promise<void> {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    const session = this.sessions.get(id);
    const conversation = await this.deps.library.getConversation(id);
    if (!session || !conversation) return;
    await this.deps.library.saveConversation({
      ...conversation,
      modelId: session.modelId,
      mode: session.mode,
      messages: session.messages,
      events: session.events,
    });
  }

  /**
   * Everything waiting for the user's approval, in every open conversation
   * (the phone's "watch and approve" view).
   *
   * @returns Oldest first.
   */
  pendingApprovals(): Array<{ conversationId: string; title: string; requestId: string; tool: string; preview: string; reason: string; purpose?: string; at: string }> {
    const out: Array<{ conversationId: string; title: string; requestId: string; tool: string; preview: string; reason: string; purpose?: string; at: string }> = [];
    const titles = new Map(this.deps.library.listConversations().map((c) => [c.id, c.title]));
    for (const [id, s] of this.sessions) {
      const pending = new Set(s.info().pendingApprovals);
      if (!pending.size) continue;
      for (const e of s.events) {
        if (e.type !== "approval_request" || !pending.has(e.requestId)) continue;
        out.push({ conversationId: id, title: titles.get(id) ?? "", requestId: e.requestId, tool: e.name, preview: e.preview.slice(0, 4000), reason: e.reason, ...(e.purpose ? { purpose: e.purpose } : {}), at: e.at });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** @returns Which conversations are working or waiting. */
  activity(): Record<string, "running" | "waiting"> {
    const out: Record<string, "running" | "waiting"> = {};
    for (const [id, s] of this.sessions) {
      const st = s.info().status;
      if (st === "running" || st === "waiting") out[id] = st;
    }
    return out;
  }

  /** Where the chats stopped by a restart are kept (so they can continue after it). */
  private get interruptedFile(): string {
    return join(this.deps.outputsDir, "..", "interrupted.json");
  }

  /**
   * Chats that were working when KesherAI last closed (an update, a restart):
   * they can continue from where they stopped.
   *
   * @returns Their ids and when they stopped.
   */
  async interrupted(): Promise<Array<{ id: string; at: string }>> {
    try {
      const list = JSON.parse(await readFile(this.interruptedFile, "utf8")) as unknown;
      return Array.isArray(list) ? list.filter((x): x is { id: string; at: string } => !!x && typeof (x as { id?: unknown }).id === "string").slice(0, 50) : [];
    } catch {
      return [];
    }
  }

  /**
   * Continues a chat that a restart stopped: the agent is told what happened and
   * to check what was already done before going on (like "resume" in coding agents).
   * With `dismiss`, it is only taken off the list.
   */
  async resumeInterrupted(id: string, dismiss = false): Promise<boolean> {
    const list = await this.interrupted();
    if (!list.some((x) => x.id === id)) return false;
    await writeFile(this.interruptedFile, JSON.stringify(list.filter((x) => x.id !== id)));
    if (!dismiss)
      await this.send(id, "KesherAI restarted (an update or a restart) while you were working on this. Continue the task from where you stopped. First look at the last tool results above to see what was already done, and do not repeat finished steps.");
    return true;
  }

  /** Saves every session and stops running ones; call on shutdown. Chats that were working are remembered, so they can continue. */
  async closeAll(): Promise<void> {
    const working = [...this.sessions].filter(([, s]) => {
      const st = s.info().status;
      return st === "running" || st === "waiting";
    });
    if (working.length) {
      const before = (await this.interrupted()).filter((x) => !working.some(([id]) => id === x.id));
      await writeFile(this.interruptedFile, JSON.stringify([...before, ...working.map(([id]) => ({ id, at: new Date().toISOString() }))])).catch(() => undefined);
    }
    for (const [id, s] of this.sessions) {
      s.stop();
      await this.saveNow(id);
    }
  }
}

function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Conversation";
}

/**
 * Checks that a project folder is an absolute path to an existing folder.
 *
 * @param folder - Path from the user.
 * @throws Error otherwise.
 */
export async function assertFolder(folder: string): Promise<void> {
  if (!isAbsolute(folder)) throw new Error("Use the full path of the folder, e.g. C:\\Users\\you\\Projects\\game.");
  const info = await stat(folder).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${folder} is not a folder on this computer.`);
}
