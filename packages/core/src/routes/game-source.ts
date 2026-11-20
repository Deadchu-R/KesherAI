import type { FastifyInstance } from "fastify";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { symbolsWithLines } from "@kesher/agent";
import type { KesherServices } from "../services.js";
import type { GameProject } from "../game-projects.js";
import { definitionsOf } from "../game-index.js";
import { projectPath } from "../unity-tools.js";
import { lintUnrealSource } from "../unreal-lint.js";
import { sameFolder } from "../unity-cli.js";
import { pruneGameBackups } from "../game-backups.js";

/**
 * One Source view for every engine (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20, step 4):
 * a project's C# (Unity), C++ and Verse (Unreal, UEFN), GDScript and C# (Godot) files, listed, read with an outline
 * of their classes and functions, written back and searched for a definition, all with the engine closed. The write
 * rules are the Unreal source routes': only inside the project's code folders and code files, not when the file
 * changed since it was opened, and the old text kept in KesherAI's folder first. Compiling stays with each engine's
 * own route (Unreal: /api/unreal/source/compile; Unity: /api/unity/scripts/compile for the project on the Unity page).
 */

/** Where each engine keeps code, and which files are code. */
const RULES: Record<GameProject["kind"], { roots: readonly string[] | "top"; ext: RegExp }> = {
  unity: { roots: ["Assets"], ext: /\.cs$/i },
  // Verse lives under Content/ (UEFN) or a plugin's Content/; C++ under Source/ and Plugins/*/Source/.
  unreal: { roots: ["Source", "Config", "Plugins", "Content"], ext: /\.(h|hpp|cpp|inl|cs|ini|verse)$/i },
  // Godot: anywhere in the project but its hidden folders (.godot, .import).
  godot: { roots: "top", ext: /\.(gd|cs|gdshader)$/i },
};
/** Folders that are never code (engine caches, builds). */
const SKIP = /^(Intermediate|Binaries|Saved|DerivedDataCache|Library|Temp|Logs|obj|Build|Builds|node_modules|addons_cache)$/i;
const MAX = 400_000;
const MAX_FILES = 3000;

/** Unreal's Content/ holds only Verse as code (a stray .cpp or .ini there is not the project's code). */
const verseOnly = (kind: GameProject["kind"], rel: string) => kind === "unreal" && /^Content\//.test(rel) && !/\.verse$/i.test(rel);

/**
 * The language of a file, for the list and the editor.
 *
 * @param path - The file's path.
 */
export function sourceLang(path: string): "csharp" | "cpp" | "gdscript" | "verse" | "ini" | "shader" {
  const e = extname(path).toLowerCase();
  if (e === ".cs") return "csharp";
  if (e === ".gd") return "gdscript";
  if (e === ".verse") return "verse";
  if (e === ".ini") return "ini";
  if (e === ".gdshader") return "shader";
  return "cpp";
}

/**
 * A code file's place in a project, checked: inside the project (links too), in the engine's code folders, a code file.
 *
 * @param p - The project.
 * @param given - The path the page sent (relative, with / or \).
 * @returns The full path and the relative one.
 * @throws When the path is outside, in a hidden folder, or not a code file.
 */
export function sourcePath(p: Pick<GameProject, "kind" | "path">, given: string): { abs: string; rel: string } {
  const rule = RULES[p.kind];
  const first = String(given ?? "").replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0] ?? "";
  if (rule.roots === "top" && (!first || first.startsWith("."))) throw new Error("Only the project's own files can be used here.");
  const { abs, rel } = projectPath(p.path, given, rule.roots === "top" ? [first] : rule.roots);
  if (!rule.ext.test(rel) || verseOnly(p.kind, rel) || rel.split("/").some((part) => part.startsWith(".") || SKIP.test(part))) throw new Error("Only code files of the project (C#, C++, GDScript, Verse) can be used here.");
  return { abs, rel };
}

/**
 * The code files of a project, sorted by path (at most 3,000).
 *
 * @param p - The project.
 */
export async function listSource(p: Pick<GameProject, "kind" | "path">): Promise<Array<{ path: string; size: number; lang: string }>> {
  const rule = RULES[p.kind];
  const files: Array<{ path: string; size: number; lang: string }> = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(join(p.path, rel), { withFileTypes: true }).catch(() => []);
    for (const d of entries) {
      if (files.length >= MAX_FILES) return;
      if (d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth < 10 && !SKIP.test(d.name)) await walk(r, depth + 1);
      } else if (d.isFile() && rule.ext.test(d.name)) {
        if (verseOnly(p.kind, r)) continue;
        const st = await stat(join(p.path, r)).catch(() => undefined);
        if (st) files.push({ path: r, size: st.size, lang: sourceLang(r) });
      }
    }
  };
  if (rule.roots === "top") await walk("", 0);
  else for (const r of rule.roots) await walk(r, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The Source view's routes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param findOne - A project found on this computer, by engine and folder (the phone can only name those).
 */
export function gameSourceRoutes(app: FastifyInstance, s: KesherServices, findOne: (engine: unknown, path: unknown) => Promise<GameProject | undefined>): void {
  const known = async (engine: unknown, project: unknown) => {
    const p = await findOne(engine, project);
    if (!p) throw Object.assign(new Error("Choose one of the projects found on this computer."), { code: 400 });
    return p;
  };
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => reply.code((err as { code?: number }).code === 409 ? 409 : 400).send({ error: (err as Error).message });
  /** How the page compiles this project here: Unreal always; Unity only the project chosen on the Unity page. */
  const compileOf = (p: GameProject): "unreal" | "unity" | null => (p.kind === "unreal" ? "unreal" : p.kind === "unity" && !!s.unity.activeProject && sameFolder(s.unity.activeProject, p.path) ? "unity" : null);

  app.get<{ Querystring: { engine?: string; project?: string } }>("/api/games/source/files", async (req, reply) => {
    try {
      const p = await known(req.query.engine, req.query.project);
      return { files: await listSource(p), compile: compileOf(p) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { engine?: string; project?: string; path?: string } }>("/api/games/source/file", async (req, reply) => {
    try {
      const p = await known(req.query.engine, req.query.project);
      const { abs, rel } = sourcePath(p, String(req.query.path ?? ""));
      const st = await stat(abs);
      if (st.size > MAX) return reply.code(400).send({ error: "The file is too big to edit here." });
      const text = await readFile(abs, "utf8");
      const { symbols, lines } = symbolsWithLines(text, extname(rel));
      return { path: rel, text, mtime: st.mtimeMs, lang: sourceLang(rel), outline: symbols.map((symbol, i) => ({ symbol, line: lines[i]! })) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Body: { engine?: string; project?: string; path?: string; text?: string; mtime?: number } }>("/api/games/source/file", async (req, reply) => {
    try {
      const p = await known(req.body?.engine, req.body?.project);
      const { abs, rel } = sourcePath(p, String(req.body?.path ?? ""));
      const text = String(req.body?.text ?? "");
      if (!text.trim() || text.length > MAX) return reply.code(400).send({ error: "Send the file's text, under 400 KB." });
      const st = await stat(abs).catch(() => undefined);
      // An existing file is written only with the time it had when it was opened (security scan 168: a save without
      // one overwrote whatever the engine or an editor had written since).
      if (st && !(Math.abs(st.mtimeMs - Number(req.body?.mtime)) <= 1)) return reply.code(409).send({ error: "The file changed since it was opened (in the engine, your editor or a chat). Open it again." });
      // A checkpoint of the file first (Game projects → Checkpoints), then the old text as before.
      await s.gameCheckpoints?.beforeSave(p.kind, p.path, "source", `Save ${rel}`, [abs]);
      if (st) {
        // The old text first, in KesherAI's folder (never in the project).
        const backups = join(s.paths.root, "game-backups", p.kind);
        await mkdir(backups, { recursive: true });
        await writeFile(join(backups, `${p.name}_${rel.replace(/[\\/]/g, "_")}-${Date.now()}`), await readFile(abs));
        // Old backups go by age and total size (like checkpoints).
        void pruneGameBackups(join(s.paths.root, "game-backups"));
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
      let issues: string[] = [];
      if (p.kind === "unreal" && /\.(h|hpp|cpp)$/i.test(rel)) {
        const mod = rel.startsWith("Source/") ? rel.split("/")[1] : undefined;
        const buildCs = mod ? await readFile(join(p.path, "Source", mod, `${mod}.Build.cs`), "utf8").catch(() => undefined) : undefined;
        issues = lintUnrealSource(rel, text, buildCs);
      }
      // Unity compiles when it notices; ask now when it is the project on the Unity page (a failure is fine).
      if (compileOf(p) === "unity") void s.unity.cliRaw(["recompile", "--project-path", p.path], 120_000).catch(() => undefined);
      return { path: rel, mtime: (await stat(abs)).mtimeMs, issues };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Go to definition: where a name is defined in the project's code (from the index, with the engine closed). */
  app.get<{ Querystring: { engine?: string; project?: string; name?: string } }>("/api/games/source/definition", async (req, reply) => {
    try {
      const p = await known(req.query.engine, req.query.project);
      const name = String(req.query.name ?? "").slice(0, 120);
      if (!/^[\w:]+$/.test(name)) return { definitions: [] };
      return { definitions: await definitionsOf(p.path, name) };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
