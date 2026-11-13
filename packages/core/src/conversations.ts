import { STEPS_NOTE, stepsTool } from "./steps-tool.js";
import { outsideAgent, type OutsideAgent } from "./acp-chat.js";
import type { AcpOption } from "./acp.js";
import { personaPrompt } from "./personas.js";
import { createHash, randomUUID } from "node:crypto";
import type { ImportedChat } from "./chat-import.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve as resolvePath } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { AgentSession, CODE_TOOLS, buildSystemPrompt, webSearchTool, type AgentTool, type TeamMember } from "@kesher/agent";
import { branding, type AgentEvent, type AgentMessage, type Conversation, type ConversationKind, type PermissionMode, type Teammate } from "@kesher/shared";
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
import { taskBoardTool } from "./task-board-tool.js";
import { modelTurnFor } from "./model-turn.js";
import { ruleAllows } from "./approval-rules.js";
import type { ConversationDeps } from "./conversation-deps.js";
import { lookTools, mediaTools } from "./chat-tools-media.js";
import { learnTools, splitTools } from "./chat-tools-work.js";

export { modelTurnFor, onModelSpeed } from "./model-turn.js";
export { ruleAllows } from "./approval-rules.js";
export type { ConversationDeps } from "./conversation-deps.js";

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


/**
 * The tools a local model always gets in full when tool search is on; the
 * others are listed by name and loaded with find_tools when needed (fewer
 * tokens on every message, faster answers on the computer).
 */
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
  /** The message each conversation is sending right now (read by unityInChat before it becomes an event). */
  private readonly incoming = new Map<string, string>();
  /** Outside agents (their CLI processes) of open conversations. */
  private readonly outside = new Map<string, OutsideAgent>();
  /** Outside agents' session ids, saved with the chat. */
  private readonly agentSessions = new Map<string, string>();
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
    private readonly deps: ConversationDeps,
  ) {
    // Know at start whether Unreal is installed, so the first chat already has the Unreal tools.
    this.checkUnreal();
  }

  /**
   * Tools for the active non-chat models (pictures, video, music, 3D, the app's look): see chat-tools-media.ts.
   *
   * @returns Tools and one line per tool for the system prompt.
   */
  mediaTools(): { tools: AgentTool[]; notes: string[] } {
    return mediaTools(this.deps);
  }

  /** @returns The change_look tool alone, for the design assistant's panel (design-assistant.ts). */
  lookTools(): AgentTool[] {
    return lookTools(this.deps, []);
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
    const skills = [...(this.deps.skills?.count ? [this.deps.skills.tool()] : []), ...learnTools(this.deps)];
    const group = id ? this.groupTools(id) : { tools: [], notes: [] };
    const split = splitTools(this.deps, () => this.defaultChatModel(), media.notes, id);
    // The numbers of an exported chat between people (the relationship analyst persona uses it).
    split.push(analyzeChatTool);
    // Unity through its CLI: when it is installed here, or a Unity project was added (then unity_status explains a missing CLI).
    const unity = this.deps.unity && (this.deps.unity.cliKnown() || this.deps.unity.activeProject)
      ? unityTools(this.deps.unity, join(this.deps.outputsDir, id ?? "unity"), async (data, mimeType) => (await this.deps.assets.save(data, mimeType, { meta: { use: "unity-screenshot" } })).id, () => chosenPhones(this.deps.config.phones?.targets ?? [], (this.deps.config.phones?.custom ?? []) as Phone[]))
      : [];
    // Fewer tokens: the long Unity guide and every Unity tool only while a Unity project is in use.
    if (unity.length && this.unityInChat(id)) media.notes.push(UNITY_NOTE);
    else if (unity.length && this.deps.unity?.activeProject) media.notes.push(`The user's Unity project is ${basename(this.deps.unity.activeProject)}. For Unity work, load its tools with find_tools (unity_status first); their guide comes with them.`);
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
    // Code sessions (self-work among them) share a task board with Claude on this computer.
    if (kind === "code" && this.deps.board) split.push(taskBoardTool(this.deps.board));
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
    // The task's steps, shown beside the chat (every kind of chat).
    media.notes.push(STEPS_NOTE);
    const all = [stepsTool(), ...code, ...media.tools, ...split, ...computer, ...group.tools, ...this.pluginTools(), ...skills, ...(this.deps.memoryTools?.() ?? []), ...(this.deps.mcpTools?.() ?? [])];
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
      const { provider } = this.deps.registry.resolve(modelId);
      // KesherAI's own engine runs with 32K (see LlamaEngine.serverArgs); other local servers may load models smaller.
      // Its real share: with 2 chats at once each gets half of the context (found on the PC: 24,576, and self-work failed
      // three times sending 26K). A little room is kept for the answer.
      // Self-work's worker reaches the main app's engine as `main/llamacpp/…`: the same engine, the same share.
      const viaMain = provider.id === "main" && modelId.startsWith("main/llamacpp/");
      const slot = provider.id === "llamacpp" || viaMain ? this.deps.engineSlotTokens?.() : undefined;
      if (slot) return Math.floor(slot * 0.9);
      return provider.location === "cloud" ? 100_000 : provider.id === "llamacpp" || viaMain ? 22_000 : 12_000;
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
      toolNotes: [...notes, ...(await this.learnedNotes()), ...[(await this.deps.skills?.promptSection(c.kind === "code" ? workspace : undefined)) ?? ""].filter(Boolean), ...(c.kind === "code" && workspace ? [(await this.deps.projectFacts?.note(workspace).catch(() => undefined)) ?? ""].filter(Boolean) : [])],
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
    // A code chat on an outside agent (Antigravity CLI): it answers with its own tools, in the folder.
    const outside =
      conversation.kind === "code"
        ? outsideAgent(conversation.modelId, workspace, undefined, () => this.sessions.get(id)?.mode ?? conversation.mode, {
            get: () => this.agentSessions.get(id) ?? conversation.agentSession,
            set: (sid) => {
              this.agentSessions.set(id, sid);
              this.scheduleSave(id);
            },
          }, this.deps.board ? [dirname(this.deps.board.file)] : [])
        : undefined;
    if (outside) this.outside.set(id, outside);
    const session = new AgentSession({
      id,
      modelId: conversation.modelId,
      ...(outside ? { external: outside } : {}),
      model: modelTurnFor(this.deps.registry, conversation.modelId, this.deps.personas?.get(conversation.personaId)?.params),
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
        // A Unity chat gets every Unity tool in full, so the model never works blind and guesses.
        // Only in a chat that is about Unity: the project is chosen for the whole app, and every other chat paid
        // ~1,600 tokens of Unity tools plus its guide (found on the PC: 8,300 tokens before the first word).
        const unityHere = this.unityInChat(id);
        return [...CORE_TOOLS, ...(unityHere ? UNITY_TOOL_NAMES : this.deps.unity?.activeProject ? ["unity_status"] : []), ...(this.unrealState.project || unityHere ? ["android_run_on_phone"] : []), ...(this.unrealState.project ? UNREAL_TOOL_NAMES : this.unrealEngines ? ["unreal_status", "unreal_create_project", "unreal_use_project"] : []), ...(this.deps.unreal?.connected ? UNREAL_GRAPH_TOOLS : [])];
      },
      isAlwaysAllowed: (tool, modelId, command) => this.deps.config.permissions.some((r) => ruleAllows(r, { tool, modelId, conversationId: id, ...(command !== undefined ? { command } : {}) })),
    });
    this.sessions.set(id, session);
    if (this.deps.onEvent) {
      const title = () => this.deps.library.summary(id)?.title ?? conversation.title;
      const lastAnswer = () => [...session.events].reverse().find((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant")?.text;
      session.on("event", (e: AgentEvent) => this.deps.onEvent?.(id, e, title, lastAnswer));
    }
    // A chat that is working is written down at once, so a restart that gives no time to save (an update's
    // installer closing the app) still leaves "continue where it stopped" (found by Roee: a chat just stopped).
    session.on("event", (e: { type: string; status?: string }) => {
      if (e.type !== "status") return;
      void this.noteWorking(id, e.status === "running" || e.status === "waiting");
    });
    // When the agent is free again, the next queued message goes; with a goal, it is checked first.
    session.on("event", (e: { type: string; status?: string }) => {
      if (e.type !== "status" || (e.status !== "idle" && e.status !== "error")) return;
      // What this chat's commands showed about the project (a form that fails here, a tool that is missing).
      const ws = conversation.kind === "code" ? this.workspaceOf(conversation) : undefined;
      if (ws && this.deps.projectFacts) void this.deps.projectFacts.learn(ws, id, session.events).catch(() => undefined);
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
  /**
   * Whether a chat is about the active Unity project: it works in the project's folder, used a Unity tool, or the
   * user named Unity or the project. Re-read on every message, so naming Unity brings the tools from the next step.
   */
  private unityInChat(id?: string): boolean {
    // (`incoming`: the message being sent right now, before it is an event.)
    const project = this.deps.unity?.activeProject;
    if (!project) return false;
    if (!id) return true;
    const c = this.deps.library.summary(id);
    const norm = (p: string) => resolvePath(p).toLowerCase();
    if (c?.workspace && norm(c.workspace) === norm(project)) return true;
    const name = basename(project).toLowerCase();
    const words = new RegExp(`unity|יוניטי${name.length > 2 ? `|${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : ""}`, "i");
    if (words.test(this.incoming.get(id) ?? "")) return true;
    return (this.sessions.get(id)?.events ?? []).some((e) => (e.type === "tool_call" && e.name.startsWith("unity_")) || (e.type === "user" && words.test(e.text)));
  }

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
    // Rebuild tools and prompt so new active models and project changes apply. The message being sent counts for
    // unityInChat: its first message about Unity already gets the Unity guide, not only the next one.
    this.incoming.set(id, text);
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
      ...(this.agentSessions.has(id) ? { agentSession: this.agentSessions.get(id)! } : {}),
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
  async importChats(chats: ImportedChat[], projectId: string | null = null): Promise<{ added: number; skipped: number; ids: string[] }> {
    const modelId = this.defaultChatModel() ?? "";
    let added = 0;
    let skipped = 0;
    const ids: string[] = [];
    for (const chat of chats) {
      const h = createHash("sha256").update(`${chat.source}:${chat.originalId}`).digest("hex");
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      ids.push(id);
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
      // A coding session (Claude Code) continues as a code chat in its folder, asking before changes.
      // Not the whole home folder or a drive (found on the PC: a session that ran in the user's own home folder): then a plain chat.
      const broad = (p: string) => { const r = resolvePath(p); return r === resolvePath(homedir()) || r === parsePath(r).root; };
      const folder = chat.workspace && !broad(chat.workspace) && (await stat(chat.workspace).catch(() => undefined))?.isDirectory() ? chat.workspace : undefined;
      await this.deps.library.saveConversation({
        id,
        projectId,
        title: chat.title.slice(0, 120),
        kind: folder ? "code" : "chat",
        ...(folder ? { workspace: folder } : {}),
        modelId,
        mode: folder ? "ask" : "auto-edit",
        importedFrom: chat.source,
        messages,
        events,
        createdAt: chat.createdAt,
        updatedAt,
      });
      added++;
    }
    return { added, skipped, ids };
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
   * "Try again" for a stuck or failed answer: stops whatever is running, waits
   * for it to settle, then writes the last answer again.
   *
   * @param id - Conversation.
   */
  async retry(id: string): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    if (opened.session.busy) {
      this.stop(id);
      const until = Date.now() + 15_000;
      while (opened.session.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      if (opened.session.busy) throw new Error("The chat did not stop. Try again in a moment.");
    }
    await this.regenerate(id);
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

  /**
   * An outside agent's choices for its session (Antigravity: model, thinking level). Starts the agent.
   *
   * @param id - A code chat on an outside agent.
   */
  async agentOptions(id: string): Promise<AcpOption[]> {
    if (!(await this.open(id))) throw new Error("Conversation not found");
    const a = this.outside.get(id);
    if (!a) throw new Error("This chat is not on an outside agent.");
    return a.options();
  }

  /** Picks one of an outside agent's choices (see {@link agentOptions}). */
  async setAgentOption(id: string, configId: string, value: string): Promise<AcpOption[]> {
    if (!(await this.open(id))) throw new Error("Conversation not found");
    const a = this.outside.get(id);
    if (!a) throw new Error("This chat is not on an outside agent.");
    return a.setOption(configId, value);
  }

  /** @param id - Conversation to delete; its session is stopped first. */
  async delete(id: string): Promise<void> {
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
    this.outside.get(id)?.close();
    this.outside.delete(id);
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
      ...(this.agentSessions.has(id) ? { agentSession: this.agentSessions.get(id)! } : {}),
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

  /** Chats working right now, on disk (left over after a crash or an update: they were stopped). */
  private get workingFile(): string {
    return join(this.deps.outputsDir, "..", "working.json");
  }

  private workingWrites: Promise<void> = Promise.resolve();
  private recovered = false;

  private async readList(file: string): Promise<Array<{ id: string; at: string }>> {
    try {
      const list = JSON.parse(await readFile(file, "utf8")) as unknown;
      return Array.isArray(list) ? list.filter((x): x is { id: string; at: string } => !!x && typeof (x as { id?: unknown }).id === "string" && typeof (x as { at?: unknown }).at === "string").slice(0, 50) : [];
    } catch {
      return [];
    }
  }

  /** Adds a chat to the working list, or takes it off (one write at a time). */
  private noteWorking(id: string, on: boolean): Promise<void> {
    this.workingWrites = this.workingWrites.then(async () => {
      await this.recover();
      const list = (await this.readList(this.workingFile)).filter((x) => x.id !== id);
      if (on) list.push({ id, at: new Date().toISOString() });
      await writeFile(this.workingFile, JSON.stringify(list)).catch(() => undefined);
    });
    return this.workingWrites;
  }

  /** Once after start: chats still on the working list were stopped by the last close, so they go to the interrupted list. */
  private async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    const left = (await this.readList(this.workingFile)).filter((x) => {
      const st = this.sessions.get(x.id)?.info().status;
      return st !== "running" && st !== "waiting";
    });
    if (!left.length) return;
    const before = (await this.readList(this.interruptedFile)).filter((x) => !left.some((l) => l.id === x.id));
    await writeFile(this.interruptedFile, JSON.stringify([...before, ...left])).catch(() => undefined);
    await writeFile(this.workingFile, "[]").catch(() => undefined);
  }

  /**
   * Chats that were working when KesherAI last closed (an update, a restart):
   * they can continue from where they stopped.
   *
   * @returns Their ids and when they stopped.
   */
  async interrupted(): Promise<Array<{ id: string; at: string }>> {
    await (this.workingWrites = this.workingWrites.then(() => this.recover()));
    return this.readList(this.interruptedFile);
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
    // Outside agents' CLIs (Antigravity) end with KesherAI; their session ids are saved above.
    for (const a of this.outside.values()) a.close();
    this.outside.clear();
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
