import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KesherServices } from "../services.js";
import { findGameProjects, type GameProject } from "../game-projects.js";
import { suggestHeavyDir } from "../heavy-folder.js";
import { isLocalRequest } from "../auth.js";
import { sameFolder } from "../unity-cli.js";
import { editorOpen, runningUnity } from "../unity-running.js";
import { buildScorecard, NightBuilds, NightStore, projectKey, projectSlug, readSettings, type NightSettings, type NightPlatform, trimLog } from "../night-build.js";
import { gitChanges, platformsFor, unityRunner, unrealEditorOpenOn, unrealRunner, unityVersionOf } from "../night-build-runners.js";

/**
 * Night builds of game projects (night-build.ts): the setting per project, what waits or runs, the last builds and the
 * morning scorecard, and a build's log trimmed to its errors. From the phone only the on/off and smoke switches and
 * viewing work (and only for projects found on the computer): the time and platforms are changed on the computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function nightBuildRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const found = async (): Promise<GameProject[]> =>
    (await findGameProjects({ unity: s.config.unity.projects, ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}) })).filter((p) => p.kind === "unity" || p.kind === "unreal");
  const store = new NightStore(join(s.paths.root, "night-builds", "state.json"));
  const heavy = () => join(s.config.heavyDir ?? suggestHeavyDir(s.paths.models, s.paths.root) ?? s.paths.root, "night-builds");
  const nb = new NightBuilds({
    store,
    runner: (r) => (r.engine === "unreal" ? unrealRunner({ playTest: (f, plan) => s.unreal.playHeadlessFor(f, plan) })(r) : unityRunner(s.unity)(r)),
    projects: found,
    idle: async (path) => {
      const p = (await found()).find((x) => sameFolder(x.path, path));
      const lock = existsSync(join(path, "Temp", "UnityLockfile"));
      const open = p?.kind === "unreal" ? (s.unreal.connected && !!s.unreal.projectFile && sameFolder(dirname(s.unreal.projectFile), path)) || (await unrealEditorOpenOn(path)) : editorOpen(path, lock, lock ? await runningUnity() : undefined);
      const g = s.guard.status();
      return {
        chats: Object.keys(s.conversations.activity()).length,
        selfWork: s.selfWork?.current?.status === "running",
        downloads: s.downloads.list().filter((j) => j.status === "downloading" || j.status === "queued").length,
        updating: s.updater.status().running,
        study: s.studyBusy?.() ?? 0,
        editorOpen: open,
        guardHold: g.cooling || g.paused || !!g.systemHold,
        playing: !!g.standby,
      };
    },
    changes: gitChanges,
    outDir: (name, project, id) => join(heavy(), projectSlug(name, project), id),
    notify: (card, note) => s.notifier.send({ ...note, path: "#/games?night=1", tags: [card.failed ? "x" : "white_check_mark"], priority: card.failed ? 4 : 3 }),
    active: () => Object.keys(s.conversations.activity()).length > 0,
  });
  nb.start();
  app.addHook("onClose", async () => nb.stop());

  app.get("/api/games/night", async () => {
    const list = await found();
    const status = nb.status();
    const projects = await Promise.all(list.map(async (p) => ({
      engine: p.kind,
      name: p.name,
      path: p.path,
      settings: await store.settings(p.path),
      platforms: await platformsFor(p.kind as "unity" | "unreal", p.kind === "unity" ? await unityVersionOf(p.path) : undefined),
      waiting: status.waiting[projectKey(p.path)],
      running: status.running && projectKey(status.running.project) === projectKey(p.path) ? status.running : undefined,
      last: (await store.results(p.path)).map(({ id, slot, platform, startedAt, durationMs, ok, sizeBytes, warnings, errors, smoke, changes }) => ({ id, slot, platform, startedAt, durationMs, ok, sizeBytes, warnings, errors, smoke, changes })),
    })));
    // The card: the newest night's builds, reported or not (the page keeps showing the last one).
    const all = await store.results();
    const night = all[0]?.slot;
    return { projects, card: buildScorecard(all.filter((r) => r.slot === night)) };
  });

  app.put<{ Body: { project?: string; enabled?: boolean; time?: string; platforms?: NightPlatform[]; smoke?: boolean } }>("/api/games/night", async (req, reply) => {
    const b = req.body ?? {};
    const p = (await found()).find((x) => typeof b.project === "string" && sameFolder(x.path, b.project));
    if (!p) return reply.code(404).send({ error: "Choose a project found on the computer." });
    // From the phone: the switches only.
    const patch = isLocalRequest(req) ? b : { enabled: b.enabled, smoke: b.smoke };
    const can = await platformsFor(p.kind as "unity" | "unreal", p.kind === "unity" ? await unityVersionOf(p.path) : undefined);
    const next: NightSettings = readSettings(patch, await store.settings(p.path), can);
    await store.setSettings(p.path, next);
    return next;
  });

  app.get<{ Params: { id: string }; Querystring: { full?: string } }>("/api/games/night/:id/log", async (req, reply) => {
    const r = (await store.results()).find((x) => x.id === req.params.id);
    if (!r) return reply.code(404).send({ error: "No such build." });
    const log = await readFile(r.logFile, "utf8").catch(() => "");
    if (req.query.full === "1") return { text: log.split(/\r?\n/).slice(-400).join("\n").slice(-60_000), errors: trimLog(log).errors };
    return trimLog(log);
  });
}
