import type { FastifyInstance } from "fastify";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KesherServices } from "../services.js";
import { findGameProjects } from "../game-projects.js";
import { projectPath } from "../unity-tools.js";
import { findEngines, readProject } from "../unreal-install.js";
import { lintUnrealSource, shortErrors } from "../unreal-lint.js";
import { codeEditPrompt, codeFromAnswer, parseCodeErrors, type CodeError } from "../code-errors.js";
import { modelTurnFor } from "../conversations.js";
import { runProgram } from "../unreal-tools.js";

/** What the page edits: C++ and build files under Source/, settings under Config/. */
const ROOTS = ["Source", "Config"];
const EXT = /\.(h|hpp|cpp|inl|cs|ini)$/i;
const MAX = 400_000;

/** A compile run (one at a time per project), polled by the page. */
interface Build { project: string; state: "running" | "ok" | "failed"; how: "live" | "build"; started: number; errors: string[]; tail: string; problems: CodeError[] }

/**
 * An Unreal project's C++ in the page: the files of Source/ and Config/, read
 * and write one (only there, only code and settings files, not when it changed
 * meanwhile; the old text is kept in KesherAI's folder first), and compile:
 * Live Coding in the open editor (plugin 0.1.9+), or Unreal's Build.bat when
 * the editor is closed. Only projects found on this computer (or the one open
 * in the editor) can be used, also from the phone.
 */
export function unrealSourceRoutes(app: FastifyInstance, s: KesherServices): void {
  const unreal = s.unreal;
  const builds = new Map<string, Build>();
  const projects = async () => {
    const found = (await findGameProjects({ ...(unreal.projectFile ? { unrealFile: unreal.projectFile } : {}) })).filter((p) => p.kind === "unreal");
    const open = unreal.connected && unreal.projectFile ? dirname(unreal.projectFile).toLowerCase() : "";
    return found.map((p) => ({ name: p.name, path: p.path, open: p.path.toLowerCase() === open }));
  };
  const known = async (project: unknown) => {
    const want = String(project ?? "");
    const p = (await projects()).find((x) => x.path === want);
    if (!p) throw Object.assign(new Error("Choose one of the Unreal projects found on this computer."), { code: 400 });
    return p;
  };
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => reply.code((err as { code?: number }).code === 409 ? 409 : 400).send({ error: (err as Error).message });

  app.get("/api/unreal/source/projects", async () => ({ projects: await projects() }));

  app.get<{ Querystring: { project?: string } }>("/api/unreal/source/files", async (req, reply) => {
    try {
      const p = await known(req.query.project);
      const files: Array<{ path: string; size: number }> = [];
      const walk = async (rel: string, depth: number) => {
        for (const d of await readdir(join(p.path, rel), { withFileTypes: true }).catch(() => [])) {
          if (files.length >= 2000) return;
          const r = `${rel}/${d.name}`;
          if (d.isDirectory() && depth < 6 && !/^(Intermediate|Binaries|Saved)$/i.test(d.name)) await walk(r, depth + 1);
          else if (d.isFile() && EXT.test(d.name)) files.push({ path: r, size: (await stat(join(p.path, r))).size });
        }
      };
      for (const r of ROOTS) await walk(r, 0);
      return { files };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { project?: string; path?: string } }>("/api/unreal/source/file", async (req, reply) => {
    try {
      const p = await known(req.query.project);
      const { abs, rel } = projectPath(p.path, String(req.query.path ?? ""), ROOTS);
      if (!EXT.test(rel)) return reply.code(400).send({ error: "Only code and settings files (.h, .cpp, .cs, .ini)." });
      const st = await stat(abs);
      if (st.size > MAX) return reply.code(400).send({ error: "The file is too big to edit here." });
      return { path: rel, text: await readFile(abs, "utf8"), mtime: st.mtimeMs };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Body: { project?: string; path?: string; text?: string; mtime?: number } }>("/api/unreal/source/file", async (req, reply) => {
    try {
      const p = await known(req.body?.project);
      const { abs, rel } = projectPath(p.path, String(req.body?.path ?? ""), ROOTS);
      const text = String(req.body?.text ?? "");
      if (!EXT.test(rel) || !text.trim() || text.length > MAX) return reply.code(400).send({ error: "Send a code or settings file (.h, .cpp, .cs, .ini) under 400 KB." });
      const st = await stat(abs).catch(() => undefined);
      if (st && req.body?.mtime && Math.abs(st.mtimeMs - Number(req.body.mtime)) > 1) return reply.code(409).send({ error: "The file changed since it was opened (in your editor or a chat). Open it again." });
      if (st) {
        const backups = join(s.paths.root, "unreal-backups");
        await mkdir(backups, { recursive: true });
        await writeFile(join(backups, `${p.name}_${rel.replace(/[\\/]/g, "_")}-${Date.now()}`), await readFile(abs));
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
      // The usual compile-breakers, said now rather than after a minute of building.
      const mod = rel.split("/")[1];
      const buildCs = /\.(h|hpp|cpp)$/i.test(rel) && mod ? await readFile(join(p.path, "Source", mod, `${mod}.Build.cs`), "utf8").catch(() => undefined) : undefined;
      return { path: rel, mtime: (await stat(abs)).mtimeMs, issues: /\.(h|hpp|cpp)$/i.test(rel) ? lintUnrealSource(rel, text, buildCs) : [] };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Compile: Live Coding when the project is open in the editor, else Build.bat (the editor must be closed). */
  app.post<{ Body: { project?: string } }>("/api/unreal/source/compile", async (req, reply) => {
    try {
      const p = await known(req.body?.project);
      if (builds.get(p.path)?.state === "running") return { build: builds.get(p.path) };
      const b: Build = { project: p.path, state: "running", how: p.open ? "live" : "build", started: Date.now(), errors: [], tail: "", problems: [] };
      builds.set(p.path, b);
      if (p.open) {
        void unreal.request<{ ok: boolean; result?: string; log?: string }>("live_coding", {}, 600_000).then(
          (r) => Object.assign(b, { state: r.ok ? "ok" : "failed", tail: `${r.result ?? ""}\n${r.log ?? ""}`.trim(), errors: r.ok ? [] : shortErrors(r.log ?? r.result ?? "").lines, problems: parseCodeErrors(r.log ?? "", p.path) }),
          (e: Error) => Object.assign(b, { state: "failed", errors: [/Unknown|live_coding/i.test(e.message) ? "Live Coding from KesherAI needs the plugin 0.1.9: update it from the Unreal page, or press Ctrl+Alt+F11 in the editor." : e.message] }),
        );
      } else {
        const proj = await readProject(p.path);
        const engines = await findEngines();
        const e = engines.find((x) => proj.engine && x.version.startsWith(proj.engine)) ?? engines[0];
        if (!e) throw new Error("No Unreal Engine is installed on this computer.");
        const name = proj.file.replace(/^.*[\\/]/, "").replace(/\.uproject$/i, "");
        const bat = join(e.path, "Engine", "Build", "BatchFiles", "Build.bat");
        void runProgram(bat, [`${name}Editor`, "Win64", "Development", `-Project=${proj.file}`, "-WaitMutex", "-NoHotReload"], { timeoutMs: 3_600_000 }).then((r) => {
          Object.assign(b, { problems: parseCodeErrors(r.out, p.path), state: r.code === 0 ? "ok" : "failed", tail: r.out.split(/\r?\n/).slice(-30).join("\n"), errors: r.code === 0 ? [] : /Live ?Coding/i.test(r.out) ? ["The project is open in Unreal with Live Coding: compile there (Ctrl+Alt+F11), or close the editor and compile again."] : shortErrors(r.out).lines });
        });
      }
      return { build: b };
    } catch (err) {
      return fail(reply, err);
    }
  });
  /** The AI bubble in the C++ editor: the model changes the whole file as asked (or fixes the errors); the page shows it before saving. */
  app.post<{ Body: { project?: string; path?: string; text?: string; request?: string; errors?: CodeError[]; model?: string } }>("/api/unreal/source/ai", async (req, reply) => {
    try {
      const p = await known(req.body?.project);
      const { rel } = projectPath(p.path, String(req.body?.path ?? ""), ROOTS);
      const text = String(req.body?.text ?? "");
      if (!EXT.test(rel) || text.length > MAX) return reply.code(400).send({ error: "Send a code file under 400 KB." });
      const want = typeof req.body?.model === "string" ? req.body.model : "";
      const chat = want && (await s.registry.listAllModels().then((r) => r.models, () => [])).some((m) => m.id === want && m.category === "chat") ? want : s.config.activeModels.chat;
      if (!chat) return reply.code(400).send({ error: "Choose a chat model first (Models & downloads)." });
      // The header next to a .cpp (or the .cpp next to a header) helps the model keep both in step.
      const twin = rel.replace(/\.(h|hpp|cpp)$/i, (_m, e: string) => (e.toLowerCase() === "cpp" ? ".h" : ".cpp"));
      const others = twin !== rel ? await readFile(join(p.path, twin), "utf8").then((t) => `// ${twin}\n${t}`, () => undefined) : undefined;
      const prompt = codeEditPrompt({ language: "cpp", engine: "unreal", path: rel, text, request: String(req.body?.request ?? "").slice(0, 4000), errors: Array.isArray(req.body?.errors) ? req.body.errors.slice(0, 30) : [], ...(others ? { others } : {}) });
      const r = await modelTurnFor(s.registry, chat)({ messages: [{ role: "user", content: prompt }], tools: [] }, AbortSignal.timeout(300_000), () => undefined);
      const note = r.text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```[\s\S]*?```/g, "").trim().split("\n").filter(Boolean).pop() ?? "";
      return { code: codeFromAnswer(r.text), note: note.slice(0, 400), model: chat };
    } catch (err) {
      return reply.code((err as { code?: number }).code === 400 ? 400 : 502).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { project?: string } }>("/api/unreal/source/compile", async (req) => ({ build: builds.get(String(req.query.project ?? "")) ?? null }));
}
