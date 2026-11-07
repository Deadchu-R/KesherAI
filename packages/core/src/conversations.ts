import { randomInt, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AgentSession, CODE_TOOLS, buildSystemPrompt, type AgentTool, type ModelTurn } from "@kesher/agent";
import { branding, type Conversation, type ConversationKind, type PermissionMode } from "@kesher/shared";
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
    const imageModel = this.deps.config.activeModels.image;
    if (imageModel) {
      let supported = false;
      try {
        supported = !!this.deps.registry.resolve(imageModel).provider.generateImage;
      } catch {
        supported = false;
      }
      if (supported) {
        notes.push(`generate_image uses the user's active image model (${imageModel}). Write the prompt in English.`);
        tools.push({
          risk: "safe",
          spec: {
            name: "generate_image",
            description: "Generate an image from a text prompt with the user's active image model. The image is shown to the user.",
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
            const { provider, providerModelId } = this.deps.registry.resolve(imageModel);
            const files = await provider.generateImage!({
              providerModelId,
              prompt: String(input.prompt ?? ""),
              ...(typeof input.negative_prompt === "string" ? { negativePrompt: input.negative_prompt } : {}),
              width: Number(input.width ?? 1024),
              height: Number(input.height ?? 1024),
              steps: 20,
              seed: randomInt(2 ** 31),
            });
            const assets = await Promise.all(
              files.map((f) => this.deps.assets.save(f.data, f.mimeType, { sourceModelId: imageModel, ...(f.meta ? { meta: f.meta } : {}) })),
            );
            return { output: `Generated ${assets.length} image(s); the user can see them.`, assetIds: assets.map((a) => a.id) };
          },
        });
      }
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

  private toolsFor(kind: ConversationKind): { tools: AgentTool[]; notes: string[] } {
    const media = this.mediaTools();
    // Chats get the file tools too, inside their own outputs folder, so they can make real files and programs.
    void kind;
    return { tools: [...CODE_TOOLS, ...media.tools, ...this.pluginTools()], notes: media.notes };
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
      toolNotes: notes,
    });
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
    const live = this.sessions.get(id);
    if (live) return { session: live, conversation };
    const { tools, notes } = this.toolsFor(conversation.kind);
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
  async send(id: string, text: string): Promise<void> {
    const opened = await this.open(id);
    if (!opened) throw new Error("Conversation not found");
    const { session, conversation } = opened;
    // Rebuild tools and prompt so new active models and project changes apply.
    const { tools, notes } = this.toolsFor(conversation.kind);
    session.setTools(tools);
    session.systemPrompt = await this.promptFor(conversation, notes);
    if (session.messages.length === 0 && /^New (chat|code session)$/.test(conversation.title)) {
      await this.deps.library.saveConversation({ ...conversation, title: titleFrom(text), messages: session.messages, events: session.events });
    }
    session.send(text);
  }

  /**
   * Changes a conversation's title, model, mode or project.
   *
   * @param id - Conversation id.
   * @param patch - Fields to change.
   * @returns The updated conversation.
   */
  async update(id: string, patch: Partial<Pick<Conversation, "title" | "modelId" | "mode" | "projectId">>): Promise<Conversation | undefined> {
    const opened = await this.open(id);
    if (!opened) return undefined;
    const { session, conversation } = opened;
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
