import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalRequest } from "../auth.js";
import type { FastifyInstance } from "fastify";
import { branding } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { speechTools } from "../speech-tools.js";

/**
 * KesherAI as an MCP server, so other AI apps (Claude Code, Claude Desktop,
 * Cursor, VS Code, …) can use what KesherAI has on this computer: its local
 * models, knowledge bases, image models and speech to text.
 *
 * Streamable HTTP at `/mcp` (JSON answers, no streaming needed). Requests
 * from this computer need nothing; from other devices they need the remote
 * access token, like the rest of the API.
 */

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>>;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

function toolsOf(s: KesherServices): Tool[] {
  const chatModel = (id?: unknown) => (typeof id === "string" && id.trim() ? id.trim() : s.config.activeModels.chat);
  const speech = speechTools({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers }).find((t) => t.spec.name === "transcribe_audio")!;
  return [
    {
      name: "list_models",
      description: "List the AI models KesherAI can use on this computer (local engines like llama.cpp, Ollama, LM Studio, and connected cloud services), with their ids.",
      inputSchema: { type: "object", properties: { category: { type: "string", description: "chat, image, video… (default: all)" } } },
      annotations: { readOnlyHint: true },
      async run(args) {
        const { models } = await s.registry.listAllModels(4000);
        const cat = typeof args.category === "string" ? args.category : "";
        const list = models.filter((m) => !cat || m.category === cat);
        const active = s.config.activeModels;
        return text(list.length ? list.map((m) => `${m.id} — ${m.name} (${m.category}, ${m.location})${Object.values(active).includes(m.id) ? " [active]" : ""}`).join("\n") : "No models found. Open KesherAI → Models to add one.");
      },
    },
    {
      name: "ask_model",
      description: "Ask one of KesherAI's models (by default the active local chat model) and get its answer. Use it to hand a task to a private local model, or to get a second opinion.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          system: { type: "string", description: "Optional instructions." },
          model: { type: "string", description: "A model id from list_models; leave out for the active chat model." },
        },
        required: ["prompt"],
      },
      async run(args, signal) {
        const id = chatModel(args.model);
        if (!id) throw new Error("No chat model is active in KesherAI. Pick one on its Models page.");
        const turn = modelTurnFor(s.registry, id);
        const messages = [
          ...(typeof args.system === "string" && args.system.trim() ? [{ role: "system" as const, content: args.system }] : []),
          { role: "user" as const, content: String(args.prompt ?? "") },
        ];
        const r = await turn({ messages, tools: [] }, signal, () => undefined);
        return text(r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim() || "(empty answer)");
      },
    },
    {
      name: "search_knowledge",
      description: "Search the user's KesherAI knowledge bases (their documents and saved web pages). Returns passages with their source and page; cite them.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, base: { type: "string", description: "A knowledge base's name; leave out for all." } }, required: ["query"] },
      annotations: { readOnlyHint: true },
      async run(args) {
        const hits = await s.knowledge.search(String(args.query ?? ""), typeof args.base === "string" ? args.base : undefined);
        const bases = (await s.knowledge.list()).map((b) => b.name);
        if (!bases.length) return text("The user has no knowledge bases yet (KesherAI → Knowledge).");
        if (!hits.length) return text(`Nothing found. Knowledge bases: ${bases.join(", ")}.`);
        return text(hits.map((h, i) => `[${i + 1}] ${h.source}${/^https?:/.test(h.source) ? "" : `, p. ${h.page}`} (${h.base})\n${h.text}`).join("\n\n"));
      },
    },
    {
      name: "generate_image",
      description: "Make an image with KesherAI's active image model (on this computer when it has one). Returns the picture and where it was saved.",
      inputSchema: { type: "object", properties: { prompt: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["prompt"] },
      async run(args, signal) {
        const id = s.config.activeModels.image;
        if (!id) throw new Error("No image model is active in KesherAI. Pick one on its Models page.");
        const { provider, providerModelId } = s.registry.resolve(id);
        if (!provider.generateImage) throw new Error(`${id} does not make images.`);
        const size = (v: unknown) => Math.min(2048, Math.max(256, Math.round((Number(v) || 1024) / 64) * 64));
        const files = await provider.generateImage({ providerModelId, prompt: String(args.prompt ?? ""), width: size(args.width), height: size(args.height), steps: 20, seed: randomInt(2 ** 31) }, signal);
        const dir = join(s.paths.root, "outputs", "mcp");
        await mkdir(dir, { recursive: true });
        const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const f of files) {
          const asset = await s.assets.save(f.data, f.mimeType, { sourceModelId: id });
          const file = join(dir, `${asset.id}.${f.mimeType.split("/")[1] ?? "png"}`);
          await writeFile(file, f.data);
          out.push({ type: "image", data: Buffer.from(f.data).toString("base64"), mimeType: f.mimeType }, { type: "text", text: `Saved to ${file}` });
        }
        return out;
      },
    },
    {
      name: "transcribe_audio",
      description: "Turn an audio or video file on this computer into text with KesherAI's speech engine (whisper, on this computer). Give the file's full path.",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Full path of the file." }, language: { type: "string" }, timestamps: { type: "boolean" } }, required: ["path"] },
      annotations: { readOnlyHint: true },
      async run(args) {
        const path = String(args.path ?? "");
        if (!isAbsolute(path)) throw new Error("Give the file's full path.");
        const r = await speech.run(args, { extraRoots: [path] } as never);
        return text(r.output);
      },
    },
  ];
}

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * The `/mcp` endpoint.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function mcpServerRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** How to add KesherAI to other apps: the address and ready-made settings for each. */
  app.get("/api/mcp-server", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on this computer." });
    const url = `http://127.0.0.1:${s.config.port}/mcp`;
    const resources = (process as { resourcesPath?: string }).resourcesPath;
    const here = dirname(fileURLToPath(import.meta.url));
    const bridge = [resources && join(resources, "mcp-bridge.cjs"), resolve(here, "../../../../apps/desktop/resources/mcp-bridge.cjs")].find((p): p is string => !!p && existsSync(p));
    const electron = !!process.versions.electron;
    const stdio = bridge ? { command: electron ? process.execPath : "node", args: [bridge, url], ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) } : undefined;
    return {
      enabled: s.config.mcpServer.enabled,
      url,
      tools: toolsOf(s).map((t) => t.name),
      snippets: {
        claudeCode: `claude mcp add --transport http kesherai ${url}`,
        cursor: JSON.stringify({ mcpServers: { kesherai: { url } } }, null, 2),
        vscode: JSON.stringify({ servers: { kesherai: { type: "http", url } } }, null, 2),
        ...(stdio ? { claudeDesktop: JSON.stringify({ mcpServers: { kesherai: stdio } }, null, 2) } : {}),
      },
    };
  });
  app.put<{ Body: { enabled?: boolean } }>("/api/mcp-server", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on this computer." });
    s.config.mcpServer.enabled = req.body?.enabled !== false;
    await s.saveConfig();
    return { enabled: s.config.mcpServer.enabled };
  });

  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send({ error: "KesherAI's MCP server answers POST requests (Streamable HTTP)." }));
  app.delete("/mcp", async (_req, reply) => reply.code(405).send());
  app.post<{ Body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> } | unknown[] }>("/mcp", async (req, reply) => {
    if (!s.config.mcpServer.enabled) return reply.code(403).send({ error: "KesherAI's MCP server is turned off (Settings → Use KesherAI from other apps)." });
    const msg = req.body;
    if (Array.isArray(msg) || !msg || typeof msg !== "object") return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC message." } });
    const { id, method, params } = msg as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
    if (id === undefined) return reply.code(202).send(); // a notification
    switch (method) {
      case "initialize": {
        const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: branding.productName, title: branding.productName, version: (await s.updater.version()).version },
          instructions: `${branding.productName} runs AI models on the user's own computer. Use ask_model to hand work to a private local model, search_knowledge for the user's documents, generate_image and transcribe_audio for media.`,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolsOf(s).map(({ run: _r, ...t }) => t) });
      case "tools/call": {
        const tool = toolsOf(s).find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${String(params?.name)}`);
        const abort = new AbortController();
        reply.raw.on("close", () => !reply.raw.writableFinished && abort.abort());
        try {
          return ok({ content: await tool.run((params?.arguments as Record<string, unknown>) ?? {}, abort.signal), isError: false });
        } catch (e) {
          return ok({ content: text((e as Error).message), isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${String(method)}`);
    }
  });
}
