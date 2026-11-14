/**
 * The Game Helper (as Xbox's Gaming Copilot and NVIDIA's G-Assist, but on the user's own models and nothing leaves the
 * computer): a key (Ctrl+Shift+G, or a handheld's back button mapped to it) takes a picture of the game in front and
 * opens a small window over it. The question goes to the chat model with the picture, in one chat per game, so it
 * remembers where the player was ("I'm stuck at the second boss" last night). The web search finds guides.
 *
 * The picture is taken only when the key is pressed, and kept in that game's chat folder.
 */
import type { FastifyInstance } from "fastify";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLocalRequest } from "../auth.js";
import { foregroundWindow } from "../journal.js";
import type { KesherServices } from "../services.js";

/** A screenshot waiting to go with the next message in a game's chat (sent with the question, not on its own). */
const pending = new Map<string, string>();

/**
 * Takes the screenshot a game chat's next message carries, if one waits.
 *
 * @param chatId - The chat.
 * @returns The attachment line to put before the message, or "".
 */
export function takeGameShot(chatId: string): string {
  const f = pending.get(chatId);
  if (!f) return "";
  pending.delete(chatId);
  return `[Attached: ${f}]\n`;
}

/** Programs in front that are not games (the helper then names the window, not "a game"). */
const NOT_GAMES = /^(explorer|kesherai|electron|chrome|msedge|firefox|code|devenv|rider64|unity|unrealeditor|steamwebhelper|discord|powershell|windowsterminal|cmd)$/i;

/**
 * A game's name from the window in front: its title without the engine's and launcher's additions.
 *
 * @param app - The program's name ("EldenRing").
 * @param title - Its window title ("ELDEN RING™").
 */
export function gameName(app: string, title: string): string {
  const t = title
    .replace(/[™®©]/g, "")
    .replace(/\s+[-–|]\s+(DirectX ?1[12]|D3D1[12]|Vulkan|OpenGL|Unreal Engine.*|Unity.*|Steam|Epic Games.*)$/i, "")
    .replace(/\s*\((DX1[12]|64-bit|Shipping)\)$/i, "")
    .trim();
  if (t && !/^(Program Manager|)$/.test(t)) return t.slice(0, 80);
  return app.replace(/([-_](Win64|Shipping|x64))+$/gi, "").replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 80) || "Game";
}

/**
 * Routes for the Game Helper.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function gameRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const mapFile = join(s.paths.root, "game-helper.json");
  const readMap = async (): Promise<Record<string, string>> => JSON.parse(await readFile(mapFile, "utf8").catch(() => "{}")) as Record<string, string>;

  /** The key was pressed: the game in front, its picture, and its chat (made the first time). Only from this computer. */
  app.post("/api/game-helper/capture", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only from this computer." });
    const front = await foregroundWindow().catch(() => ({ app: "", title: "" }));
    const isGame = !!front.app && !NOT_GAMES.test(front.app);
    const game = isGame ? gameName(front.app, front.title) : "";
    const shot = isGame ? await s.screen?.shot().catch(() => undefined) : undefined;
    const key = (game || "general").toLowerCase();
    const map = await readMap();
    let chat = map[key] ? await s.library.getConversation(map[key]!) : undefined;
    if (!chat) {
      chat = await s.conversations.create({ kind: "chat", title: game ? `🎮 ${game}` : "🎮 Game Helper" });
      map[key] = chat.id;
      await writeFile(mapFile, JSON.stringify(map, null, 2));
    }
    let file: string | undefined;
    if (shot) {
      const dir = s.conversations.workspaceOf(chat);
      if (dir) {
        await mkdir(dir, { recursive: true });
        file = `game-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
        await writeFile(join(dir, file), shot.jpeg);
        pending.set(chat.id, file);
      }
    }
    return { chatId: chat.id, game, ...(file ? { file } : {}) };
  });

  /** The game's latest picture (for the window's header). */
  app.get<{ Params: { id: string; file: string } }>("/api/game-helper/:id/shot/:file", async (req, reply) => {
    const chat = await s.library.getConversation(req.params.id);
    const dir = chat ? s.conversations.workspaceOf(chat) : undefined;
    if (!dir || !/^game-[\w-]+\.jpg$/.test(req.params.file)) return reply.code(404).send({ error: "Not found" });
    const data = await readFile(join(dir, req.params.file)).catch(() => undefined);
    if (!data) return reply.code(404).send({ error: "Not found" });
    return reply.type("image/jpeg").header("cache-control", "private, max-age=3600").send(data);
  });

  /** Whether a picture waits for this chat's next message. */
  app.get<{ Params: { id: string } }>("/api/game-helper/:id", async (req) => ({ waiting: pending.get(req.params.id) ?? null }));
}
