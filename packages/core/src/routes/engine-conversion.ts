import type { FastifyInstance } from "fastify";
import { projectFileInFolder, samePath } from "../project-path.js";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { isLocalRequest } from "../auth.js";
import { ConvertedCopies, readConvertedMarker, readyCopies, revertConvertedCopy, type ConvertedMarker, type GitBytes } from "../engine-conversion.js";
import { majorMinor, readUnityVersion, type PluginEngine } from "../engine-support.js";
import { findGameProjects } from "../game-projects.js";
import type { KesherServices } from "../services.js";
import { unityCompileState } from "../unity-compile.js";
import type { BridgeInstaller } from "../unreal-install.js";
import { installUnityPackage } from "../unreal-install.js";

/** Runs git with its output as bytes, never through a shell. */
const gitBytes: GitBytes = (cwd, args) =>
  new Promise((done) => execFile("git", args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => done({ code: err ? 1 : 0, out: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) })));

const sameDir = samePath;

/**
 * The rest of "Convert with AI" (docs/WORK_LIST.md, Game engines): whether the Unity package compiled in a project (so the
 * page can offer the conversion), and reviewing, installing and reverting an AI-converted copy. Only projects found on
 * this computer are touched, so all of it works from the phone too; nothing is installed without the user's press.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param installer - Unreal's plugin installer (builds a converted copy for the project's engine).
 */
export async function engineConversionRoutes(app: FastifyInstance, s: KesherServices, installer: BridgeInstaller): Promise<void> {
  /** The projects of one engine on this computer (found by KesherAI, or added to it for Unity), with their engine version. */
  const projectsOf = async (engine: PluginEngine): Promise<Array<{ name: string; path: string; engine?: string }>> => {
    const all = await findGameProjects({ unity: s.config.unity.projects, ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}) });
    return all.filter((p) => p.kind === engine).map((p) => ({ name: p.name, path: p.path, ...(p.engine ? { engine: p.engine } : {}) }));
  };
  const copies = new ConvertedCopies({
    repo: () => s.config.taskInbox?.repo,
    git: gitBytes,
    root: join(s.paths.root, "converted"),
    installUnity: installUnityPackage,
    installUnreal: (project, copy) => installer.install(project, copy),
    unrealJob: () => installer.status(),
  });
  const engineOf = (v: unknown): PluginEngine | undefined => (v === "unity" || v === "unreal" ? v : undefined);
  const unrealOpen = (path: string) => projectFileInFolder(s.unreal.projectFile, path);

  /**
   * Whether the KesherAI package compiled in a Unity project (the active one by default): "failed" carries the package's
   * own compile errors, which "Convert with AI" sends with its task.
   */
  app.get<{ Querystring: { project?: string } }>("/api/engine-plugins/unity-compile", async (req, reply) => {
    const want = req.query.project || s.unity.activeProject;
    if (!want) return { state: "unknown", errors: [] };
    const known = (await projectsOf("unity")).find((p) => sameDir(p.path, want));
    if (!known && !(isLocalRequest(req) && s.config.unity.projects.some((p) => sameDir(p, want)))) return reply.code(403).send({ error: "Choose one of the Unity projects found on this computer." });
    const path = known?.path ?? want;
    return { project: basename(path), editor: await readUnityVersion(path), ...(await unityCompileState(path)) };
  });

  /** The converted copies ready to review for one engine, the install now or last, and what is installed in each project. */
  app.get<{ Querystring: { engine?: string } }>("/api/engine-plugins/converted", async (req, reply) => {
    const engine = engineOf(req.query.engine);
    if (!engine) return reply.code(400).send({ error: "Choose Unity or Unreal." });
    const ready = s.taskInbox ? readyCopies(await s.taskInbox.list()).filter((c) => c.engine === engine) : [];
    const installed: Array<{ path: string; name: string; marker: ConvertedMarker }> = [];
    for (const p of await projectsOf(engine)) {
      const marker = await readConvertedMarker(engine, p.path);
      if (marker) installed.push({ path: p.path, name: p.name, marker });
    }
    const job = copies.current();
    return { ready, installed, job: job && job.engine === engine ? job : null };
  });

  /**
   * Installs a ready copy into a project found on this computer, after the same checks as "Install this copy".
   * @returns undefined when it started, else why not.
   */
  const installInto = async (copy: ReturnType<typeof readyCopies>[number], projectPath: string): Promise<string | undefined> => {
    const project = (await projectsOf(copy.engine)).find((p) => sameDir(p.path, projectPath));
    if (!project) return "Choose one of the projects found on this computer.";
    const version = copy.engine === "unity" ? await readUnityVersion(project.path) : project.engine;
    const want = majorMinor(copy.version);
    const have = majorMinor(version);
    if (!want || !have || want[0] !== have[0] || want[1] !== have[1]) return `This copy was converted for ${copy.engine === "unity" ? "Unity" : "Unreal"} ${copy.version}, and the project uses ${version ?? "an unknown version"}.`;
    if (copy.engine === "unreal") {
      if (process.platform !== "win32") return "Installing from KesherAI works on Windows for now.";
      if (unrealOpen(project.path)) return "Close Unreal first, then install the copy.";
    }
    await copies.install(copy, project.path);
    return undefined;
  };

  /**
   * Converting with AI installs by itself (Roee 2026-11-22): when a conversion task is done, its copy goes into every
   * project on this computer whose engine version it was made for, one at a time, and a phone note says so. A project
   * with Unreal open waits until it is closed; a project already holding this commit is skipped. Every minute, light.
   */
  const tried = new Set<string>();
  const autoInstall = async (): Promise<void> => {
    if (!s.taskInbox || s.config.taskInbox?.autoInstallConverted === false) return;
    const job = copies.current();
    if (job && (job.state === "reading" || job.state === "installing")) return;
    for (const copy of readyCopies(await s.taskInbox.list())) {
      for (const p of await projectsOf(copy.engine)) {
        const want = majorMinor(copy.version);
        const have = majorMinor(copy.engine === "unity" ? await readUnityVersion(p.path) : p.engine);
        if (!want || !have || want[0] !== have[0] || want[1] !== have[1]) continue;
        // The newest fix commit on the copy's branch (a failed build is tried again once a fix is pushed).
        const ref = await copies.newestRef(copy);
        const key = `${copy.taskId}|${p.path}|${ref}`;
        if (tried.has(key)) continue;
        const marker = await readConvertedMarker(copy.engine, p.path);
        if (marker && marker.sha.startsWith(ref.slice(0, 7))) {
          tried.add(key);
          continue;
        }
        if (copy.engine === "unreal" && unrealOpen(p.path)) continue;
        tried.add(key);
        const why = await installInto(copy, p.path).catch((e: unknown) => (e as Error).message);
        void s.notifier
          .send({ title: why ? "✕ ההתקנה של הפלאגין המומר לא התחילה" : "⚙ מתקין את הפלאגין המומר", body: why ? `${p.name}: ${why}` : `${copy.engine === "unity" ? "Unity" : "Unreal"} ${copy.version} → ${p.name}`, path: "#/settings/engines" })
          .catch(() => undefined);
        return;
      }
    }
  };
  const autoTimer = setInterval(() => void autoInstall().catch(() => undefined), 60_000);
  autoTimer.unref?.();
  app.addHook("onClose", async () => clearInterval(autoTimer));

  /** "Install this copy": one reviewed copy into one project found on this computer, for that project's engine version. */
  app.post<{ Body: { engine?: string; taskId?: string; project?: string } }>("/api/engine-plugins/converted/install", async (req, reply) => {
    const engine = engineOf(req.body?.engine);
    if (!engine) return reply.code(400).send({ error: "Choose Unity or Unreal." });
    if (!s.taskInbox) return reply.code(409).send({ error: "The task inbox is off (Settings > Task inbox)." });
    const copy = readyCopies(await s.taskInbox.list()).find((c) => c.engine === engine && c.taskId === req.body?.taskId);
    if (!copy) return reply.code(404).send({ error: "That converted copy is no longer ready. Reload the page." });
    const project = (await projectsOf(engine)).find((p) => sameDir(p.path, String(req.body?.project ?? "")));
    if (!project) return reply.code(403).send({ error: "Choose one of the projects found on this computer." });
    try {
      // A copy made for one engine version is not put into a project of another (checked inside).
      const why = await installInto(copy, project.path);
      if (why) return reply.code(/Close Unreal/.test(why) ? 409 : 400).send({ error: why });
      return { job: copies.current() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** "Revert to none": removes an AI-converted copy from a project (never KesherAI's own plugin). */
  app.post<{ Body: { engine?: string; project?: string } }>("/api/engine-plugins/converted/revert", async (req, reply) => {
    const engine = engineOf(req.body?.engine);
    if (!engine) return reply.code(400).send({ error: "Choose Unity or Unreal." });
    const project = (await projectsOf(engine)).find((p) => sameDir(p.path, String(req.body?.project ?? "")));
    if (!project) return reply.code(403).send({ error: "Choose one of the projects found on this computer." });
    if (engine === "unreal" && unrealOpen(project.path)) return reply.code(409).send({ error: "Close Unreal first, then revert." });
    try {
      if (!(await revertConvertedCopy(engine, project.path))) return reply.code(404).send({ error: "There is no AI-converted copy installed in that project." });
      return { reverted: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
