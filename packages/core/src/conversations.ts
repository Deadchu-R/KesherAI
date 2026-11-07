import { randomInt, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AgentSession, CODE_TOOLS, buildSystemPrompt, webSearchTool, type AgentTool, type ModelTurn, type TeamMember } from "@kesher/agent";
import { branding, type Conversation, type ConversationKind, type PermissionMode, type Teammate } from "@kesher/shared";
import type { ProviderRegistry } from "@kesher/providers";
import type { KesherConfig } from "./config.js";
import type { AssetStore } from "./assets.js";
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
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();

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
      /**
       * Finds an image model that runs on this computer when none usable is
       * active: uses a downloaded one, or starts downloading the best fit.
       */
      ensureImageModel?(): Promise<{ modelId?: string; message?: string }>;
      /** Computer-control tools for a conversation (empty when the user has not turned it on). */
      computerTools?(conversationId: string): AgentTool[];
      /** Notes the coach learned about how the user works, added to every system prompt. */
      userNotes?(): Promise<string[]>;
    },
  ) {}

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
    if (usable(active) || this.deps.ensureImageModel) {
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
          return { output: `Generated ${assets.length} image(s); the user can see them.${switched}`, assetIds: assets.map((a) => a.id) };
        },
      });
    }
    return { tools, notes };
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
        "You can see and control this computer: first computer_use_app (the user approves each app), then computer_screenshot → one action → computer_screenshot to check. Prefer your other tools (files, run_command, build_executable) when they can do the job; use the screen for apps that have no other way in (Unity, Blender, Office, settings dialogs). Browsers are view-only, terminals click-only, and you never type passwords or payment details.",
      );
    }
    // Chats get the file tools too, inside their own outputs folder, so they can make real files and programs.
    const hasImages = media.tools.some((t) => t.spec.name === "generate_image");
    const code = kind === "chat" && hasImages ? CODE_TOOLS.map(steerImagesToEngine) : CODE_TOOLS;
    return { tools: [...code, ...media.tools, ...computer, ...this.pluginTools()], notes: media.notes };
  }

  private teamCache = new Map<string, Teammate[]>();

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

  private async promptFor(c: Pick<Conversation, "id" | "kind" | "workspace" | "projectId">, notes: string[]): Promise<string> {
    const project = c.projectId ? this.deps.library.getProject(c.projectId) : undefined;
    const workspace = this.workspaceOf(c);
    return buildSystemPrompt({
      productName: branding.productName,
      ...(workspace ? (c.kind === "code" ? { workspace } : { outputsFolder: workspace }) : {}),
      ...(project?.instructions ? { projectInstructions: project.instructions } : {}),
      toolNotes: [...notes, ...(await this.learnedNotes())],
    });
  }

  private async learnedNotes(): Promise<string[]> {
    const learned = (await this.deps.userNotes?.().catch(() => [])) ?? [];
    return learned.length ? [`About this user (learned from how they use KesherAI; follow it unless they say otherwise): ${learned.join("; ")}`] : [];
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
    const modelId = opts.modelId ?? this.defaultChatModel();
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
      kind: opts.kind,
      modelId,
      // A chat writes only into its own outputs folder, so file edits need no approval there; commands still ask.
      mode: opts.mode ?? (opts.kind === "code" ? "ask" : "auto-edit"),
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
      isAlwaysAllowed: (tool, modelId) =>
        this.deps.config.permissions.some(
          (r) =>
            (r.tool === tool || r.tool === "*") &&
            (r.scope === "everywhere" || (r.scope === "model" && r.modelId === modelId) || (r.scope === "conversation" && r.conversationId === id)),
        ),
    });
    this.sessions.set(id, session);
    return { session, conversation };
  }

  /**
   * Sends a user message. The first message also titles the conversation.
   *
   * @param id - Conversation id.
   * @param text - Message.
   * @throws Error if the conversation does not exist or is busy.
   */
  async send(id: string, text: string, opts: { web?: boolean } = {}): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session, conversation } = opened;
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
    if (opts.web) {
      const query = text.replace(/\s+/g, " ").slice(0, 200);
      try {
        const r = await webSearchTool.run({ query }, { signal: AbortSignal.timeout(20_000), recordChange: () => undefined });
        context = `Web search results for "${query}" (searched just now). Use them for current facts, say which ones you used, and give their links:\n${r.output}`;
        note = `Searched the web: ${r.output === "No results." ? "no results" : `${r.output.split("\n").filter((l) => /^\d+\. /.test(l)).length} results`}.`;
      } catch (err) {
        context = `(A web search was asked for but failed: ${(err as Error).message}. Say so if it matters.)`;
      }
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
  async update(id: string, patch: Partial<Pick<Conversation, "title" | "modelId" | "mode" | "projectId" | "team">>): Promise<Conversation | undefined> {
    const opened = await this.open(id);
    if (!opened) return undefined;
    const { session, conversation } = opened;
    if (patch.team) this.teamCache.set(id, patch.team);
    if (patch.modelId && patch.modelId !== session.modelId) session.setModel(patch.modelId, modelTurnFor(this.deps.registry, patch.modelId));
    if (patch.mode) session.setMode(patch.mode);
    return this.deps.library.saveConversation({
      ...conversation,
      ...patch,
      modelId: session.modelId,
      mode: session.mode,
      messages: session.messages,
      events: session.events,
    });
  }

  /**
   * Stops a conversation's work (like pressing Stop in it).
   *
   * @param id - Conversation.
   */
  stop(id: string): void {
    this.sessions.get(id)?.stop();
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
   * What every live session is doing, so the sidebar can show which chats
   * are working or waiting for the user. Sessions run independently, so
   * many conversations (each with its own model) can work at once.
   *
   * @returns Conversation id → status, for sessions that are not idle.
   */
  activity(): Record<string, "running" | "waiting"> {
    const out: Record<string, "running" | "waiting"> = {};
    for (const [id, s] of this.sessions) {
      const st = s.info().status;
      if (st === "running" || st === "waiting") out[id] = st;
    }
    return out;
  }

  /** Saves every session and stops running ones; call on shutdown. */
  async closeAll(): Promise<void> {
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
