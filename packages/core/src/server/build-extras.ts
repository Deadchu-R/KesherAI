/**
 * The parts that work on their own (docs/ARCHITECTURE_REVIEW.md B6, first part): routines (at a time, every few
 * minutes, at start, or when a page, a folder or a download changes) that run a prompt, a pipeline or self-work.
 * Journal, computer control, Unreal, Unity and self-work follow.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { htmlToText } from "@kesher/agent";
import type { DataPaths, KesherConfig } from "../config.js";
import type { ConversationManager } from "../conversations.js";
import type { Notifier } from "../notify.js";
import type { Pipelines } from "../pipelines.js";
import { Routines } from "../routines.js";
import type { TelegramBridge } from "../telegram.js";

/** The server, once made: a routine starts self-work through its route (same checks as the panel's Start). */
export interface InjectRef {
  app?: { inject: (o: { method: "POST"; url: string; payload: unknown; remoteAddress: string; headers: Record<string, string> }) => Promise<{ statusCode: number; json: () => unknown }> };
}

/**
 * The routines (not started).
 *
 * @param p - The data folders, pipelines, the server (for self-work's route), the chats (made later: read when a
 *   routine runs), the notifier, the settings and Telegram.
 * @returns The routines.
 */
export function buildRoutines(p: { paths: DataPaths; pipelines: Pipelines; injectRef: InjectRef; chats: () => ConversationManager; notifier: Notifier; config: KesherConfig; telegram: TelegramBridge }): Routines {
  const { paths, pipelines, injectRef, chats, notifier, config, telegram } = p;
  return new Routines(join(paths.root, "routines.json"), {
    runPipeline: async (id, inputs) => {
      const run = await pipelines.start(id, inputs);
      const done = await pipelines.wait(run.id);
      const files = done?.files.length ? ` Files: ${done.files.join(", ")}.` : "";
      return { ok: done?.status === "done", message: done?.status === "done" ? `Finished.${files}` : done?.error ?? "Stopped.", link: "#/pipelines" };
    },
    // The same checks as the panel's Start (through the route, so a worker is used when there is one).
    startSelfWork: async (o) => {
      if (!injectRef.app) return { ok: false, message: "KesherAI is still starting.", link: "#/code" };
      const r = await injectRef.app.inject({ method: "POST", url: "/api/self-work/start", payload: o, remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1" } });
      const body = r.json() as { run?: { branch?: string; convId?: string }; error?: string };
      return r.statusCode === 200 && body.run ? { ok: true, message: `Self-work started on ${body.run.branch ?? "a new branch"}.`, link: "#/code" } : { ok: false, message: body.error ?? `It did not start (${r.statusCode}).`, link: "#/code" };
    },
    runPrompt: async (name, prompt, modelId, personaId, opts = {}) => {
      const c = await chats().create({ kind: "chat", title: `${name} · ${new Date().toLocaleDateString()}`, ...(modelId ? { modelId } : {}), ...(personaId ? { personaId } : {}) });
      // A routine's folder (e.g. a list it keeps): created if missing, then opened to this chat's file tools.
      if (opts.folder) {
        await mkdir(opts.folder, { recursive: true });
        await (await chats().open(c.id))?.session.grant(opts.folder);
      }
      await chats().send(c.id, opts.folder ? `${prompt}\n\n(Your folder for this: ${opts.folder})` : prompt, opts.web ? { web: true } : {});
      const end = Date.now() + 30 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const opened = await chats().open(c.id);
        const st = opened?.session.info().status;
        if (st === "waiting") return { ok: true, message: "Waiting for your approval.", link: `#/c/${c.id}` };
        if (st !== "running" || Date.now() > end) {
          const last = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "assistant");
          const lastErr = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "status" && e.status === "error");
          const err = st === "error" && lastErr?.type === "status" ? lastErr.message : undefined;
          return { ok: st !== "error" && !!last, message: last && last.type === "assistant" ? last.text.replace(/\s+/g, " ").slice(0, 300) : err ? `It stopped: ${err.slice(0, 280)}` : "No answer.", link: `#/c/${c.id}` };
        }
      }
    },
    notify: async (title, body, path) => void (await notifier.send({ title, body: config.notifications.includeText ? body : body.length > 80 ? "Done — open KesherAI to read it." : body, path, tags: ["alarm_clock"] })),
    discard: async (link) => {
      const id = /^#\/c\/([\w-]+)$/.exec(link)?.[1];
      if (id) await chats().delete(id);
    },
    telegram: async (text) => telegram.broadcast(text),
    // Page routines: the page's readable text (20 s, 3 MB at most; http and https only, checked when saved).
    pageText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "KesherAI page check" }, redirect: "follow" });
      if (!res.ok) throw new Error(`The page answered ${res.status}.`);
      const body = (await res.text()).slice(0, 3_000_000);
      return /html/i.test(res.headers.get("content-type") ?? "") ? htmlToText(body) : body;
    },
    busy: () => Object.keys(chats().activity()).length > 0,
  });
}
