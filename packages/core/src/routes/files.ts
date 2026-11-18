import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { buildExecutableTool, csvRows, docxHtml, documentText, pptxSlides, resolveInWorkspace, xlsxSheets } from "@kesher/agent";
import type { KesherServices } from "../services.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import { checkSegments, cutVideo, srtOf } from "../video-cut.js";
import { toWav } from "../speech-tools.js";

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
  let cutting = false;
  const folderOf = async (id: string): Promise<string | undefined> => {
    const c = await s.library.getConversation(id);
    return c ? s.conversations.workspaceOf(c) : undefined;
  };

  app.get<{ Params: { id: string } }>("/api/conversations/:id/files", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    return { folder: root, files: await listFiles(root) };
  });

  /**
   * The video editor's export: keeps the stretches of a video of the chat's folder, in their order, as a new .mp4 in
   * `shared/` (body `{ path, segments: [{ from, to }] }`, seconds). Returns the new file's path.
   */
  app.post<{ Params: { id: string }; Body: { path?: string; segments?: unknown; name?: string; captions?: unknown } }>("/api/conversations/:id/files/cut", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    let full: string;
    let segments;
    try {
      full = await resolveInWorkspace(root, req.body?.path ?? "");
      segments = checkSegments(req.body?.segments);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!/\.(mp4|webm|mov|m4v|mkv)$/i.test(full) || !(await stat(full).catch(() => undefined))?.isFile()) return reply.code(404).send({ error: "Video not found" });
    const dir = join(root, "shared");
    await mkdir(dir, { recursive: true });
    const base = (String(req.body?.name ?? basename(full).replace(/\.[^.]+$/, "") + "-edited").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 100) || "edited").replace(/\.mp4$/i, "");
    let out = join(dir, `${base}.mp4`);
    for (let i = 2; existsSync(out); i++) out = join(dir, `${base} (${i}).mp4`);
    // One cut at a time: each one keeps the computer's processor busy (security review, scan 146).
    if (cutting) return reply.code(429).send({ error: "Another video is being cut; try again when it is done." });
    cutting = true;
    try {
      await cutVideo(await ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }), full, out, segments);
    } catch (err) {
      return reply.code(500).send({ error: `The video could not be cut: ${(err as Error).message}` });
    } finally {
      cutting = false;
    }
    // Captions (from the transcript, in the cut's times) as an .srt of the same name, which players read beside it.
    const srt = srtOf(req.body?.captions);
    if (srt) await writeFile(out.replace(/\.mp4$/, ".srt"), srt, "utf8");
    return { path: relative(root, out).split(sep).join("/"), ...(srt ? { captions: relative(root, out.replace(/\.mp4$/, ".srt")).split(sep).join("/") } : {}) };
  });

  /**
   * The video editor's transcript: what is said in a video (or sound) of the chat's folder, in pieces with their
   * times in seconds (whisper on this computer). 409 `needs-setup` when speech to text is not set up.
   */
  app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/conversations/:id/files/transcript", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    let full: string;
    try {
      full = await resolveInWorkspace(root, req.body?.path ?? "");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!/\.(mp4|webm|mov|m4v|mkv|mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(full) || !(await stat(full).catch(() => undefined))?.isFile()) return reply.code(404).send({ error: "Video or sound not found" });
    const local = await s.whisper.status();
    if (!local.engine || !local.model) return reply.code(409).send({ error: "needs-setup", code: "needs-setup" });
    try {
      const wav = await toWav(full, () => ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }));
      return { parts: await s.whisper.transcribeParts(wav, s.config.speech?.language ?? "auto") };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
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
   * A file shown in the chat (an attachment chip, as LM Studio Bionic and Claude preview them): a table for Excel,
   * CSV and TSV, the slides' text for PowerPoint, a page for Word and HTML (the page draws them in a frame with no
   * scripts), text for the rest. Only files in the chat's folder, up to 50 MB.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/conversations/:id/files/preview", async (req, reply) => {
    const root = await folderOf(req.params.id);
    if (!root) return reply.code(404).send({ error: "Conversation not found" });
    let full: string;
    try {
      full = await resolveInWorkspace(root, (req.query.path ?? "").replace(/^\[?(?:Attached|קובץ מצורף|מצורף)\s*:\s*/i, "").replace(/\]$/, "").trim());
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const st = await stat(full).catch(() => undefined);
    if (!st?.isFile()) return reply.code(404).send({ error: "File not found" });
    if (st.size > 50 * 1024 ** 2) return reply.code(413).send({ error: "This file is too big to show here (over 50 MB). Download it instead." });
    const name = basename(full);
    const ext = extname(name).toLowerCase();
    const rel = relative(root, full).split(sep).join("/");
    try {
      if (/^\.(png|jpe?g|webp|gif|bmp)$/.test(ext)) return { kind: "image", name, path: rel };
      // A 3D model: the page draws it (three.js) from the download address.
      if (ext === ".glb" || ext === ".gltf") return { kind: "model", name, path: rel };
      const data = await readFile(full);
      if (ext === ".xlsx") return { kind: "table", name, sheets: xlsxSheets(data, 300) };
      if (ext === ".csv" || ext === ".tsv") {
        const { rows, more } = csvRows(data.toString("utf8"), 300, ext === ".tsv" ? "\t" : undefined);
        return { kind: "table", name, sheets: [{ name, rows, more }] };
      }
      if (ext === ".pptx") return { kind: "slides", name, slides: pptxSlides(data) };
      if (ext === ".docx") return { kind: "html", name, html: await docxHtml(data) };
      if (ext === ".html" || ext === ".htm") return { kind: "html", name, html: data.toString("utf8").slice(0, 2_000_000) };
      if (ext === ".pdf") return { kind: "text", name, text: (await documentText(data, name)).pages.map((p, i) => `— ${i + 1} —\n${p}`).join("\n\n").slice(0, 300_000) };
      // Text, or a file with no preview (binary).
      const sample = data.subarray(0, 8000);
      if (sample.includes(0)) return { kind: "none", name, path: rel };
      return { kind: "text", name, text: data.toString("utf8").slice(0, 300_000) };
    } catch (err) {
      return reply.code(422).send({ error: `This file could not be read: ${(err as Error).message}` });
    }
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
