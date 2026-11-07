import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { buildExecutableTool, resolveInWorkspace } from "@kesher/agent";
import type { KesherServices } from "../services.js";

/** Folders that are build caches or dependencies, not things the user made. */
const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "build", ".next", ".cache"]);
const MAX_FILES = 2000;
/** The ZIP is built in memory; bigger folders are downloaded file by file. */
const MAX_ZIP_BYTES = 1024 ** 3;

/** A file in a conversation's folder. */
export interface ConversationFile {
  /** Relative path with forward slashes. */
  path: string;
  size: number;
  modifiedAt: string;
}

async function listFiles(root: string): Promise<ConversationFile[]> {
  const out: ConversationFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const st = await stat(full);
        out.push({ path: relative(root, full).split(sep).join("/"), size: st.size, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * The files a conversation made or works on, for the Files panel: list,
 * download one, or download all as a ZIP. Code sessions show their project
 * folder; chats show their own outputs folder.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function fileRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const folderOf = async (id: string): Promise<string | undefined> => {
    const c = await s.library.getConversation(id);
    return c ? s.conversations.workspaceOf(c) : undefined;
  };

  app.get<{ Params: { id: string } }>("/api/conversations/:id/files", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    return { folder: root, files: await listFiles(root) };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/conversations/:id/files/download", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    let full: string;
    try {
      full = await resolveInWorkspace(root, req.query.path ?? "");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const st = await stat(full).catch(() => undefined);
    if (!st?.isFile()) return reply.code(404).send({ error: "File not found" });
    const name = basename(full);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", st.size)
      .header("content-disposition", `attachment; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(createReadStream(full));
  });

  /**
   * Builds a Python file into a program (.exe on Windows), for the "Build"
   * button next to .py files. The click is the approval. Can take minutes.
   */
  app.post<{ Params: { id: string }; Body: { path?: string; windowed?: boolean } }>("/api/conversations/:id/files/build", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    const entry = req.body?.path ?? "";
    try {
      const out = await buildExecutableTool.run(
        { entry, ...(req.body?.windowed !== undefined ? { windowed: req.body.windowed } : {}) },
        { workspace: root, signal: AbortSignal.timeout(20 * 60_000), recordChange() {} },
      );
      return { ok: true, output: out.output };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/files/zip", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    const files = await listFiles(root);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_ZIP_BYTES) return reply.code(413).send({ error: "Too big for one ZIP. Download the files one by one." });
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[f.path] = await readFile(join(root, f.path));
    const zip = zipSync(entries, { level: 6 });
    const c = await s.library.getConversation(req.params.id);
    const name = `${(c?.title ?? "files").replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "files"}.zip`;
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="files.zip"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(Buffer.from(zip));
  });
}
