import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The self-work worker: a second, window-less KesherAI that runs the long
 * self-work jobs, so updating or restarting the app never stops them.
 *
 * It does not run from the install folder (an updater cannot replace files a
 * running program holds, and a failed update can leave a broken install):
 * each version is copied once to `<data>/worker-app/<version>` and the worker
 * runs from that copy, the way Chrome, Slack and VS Code keep versions side
 * by side. After the app updates, the worker finishes its current item and
 * then moves to the new version on its own (its run is saved and continues).
 */

/** The worker's port on this computer (only 127.0.0.1). */
export const WORKER_PORT = 7461;
const URL_ = `http://127.0.0.1:${WORKER_PORT}`;

interface Health { run: { status: string } | null; version?: string }

async function health(): Promise<Health | undefined> {
  const r = await fetch(`${URL_}/api/self-work`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  if (!r?.ok) return undefined;
  return (await r.json().catch(() => undefined)) as Health | undefined;
}

/**
 * Starts and watches the worker.
 *
 * @param o.dataDir - KesherAI's data folder (the worker's own data is in `<dataDir>/worker`).
 * @param o.version - This app's version.
 * @param o.exe - This app's program file (its folder is copied).
 * @param o.mainUrl - This app's local address (the worker uses its models).
 */
export function workerHost(o: { dataDir: string; version: string; exe: string; mainUrl: () => string }): { ensure: () => Promise<string>; url: () => string | undefined; watch: () => void } {
  let up = false;
  let starting: Promise<string> | undefined;
  let asked = "";
  const appDir = join(o.dataDir, "worker-app");
  const state = join(o.dataDir, "worker", "self-work.json");

  /** This version's own copy, made once (copied aside, then renamed, so a half copy is never used). */
  const copy = async (): Promise<string> => {
    const dest = join(appDir, o.version);
    const exe = join(dest, basename(o.exe));
    if (existsSync(exe)) return exe;
    const tmp = `${dest}.copying-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await cp(dirname(o.exe), tmp, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
    // Older copies are removed when nothing runs from them (a running one is skipped: Windows keeps it locked).
    for (const v of await readdir(appDir).catch(() => [])) {
      if (v !== o.version) await rm(join(appDir, v), { recursive: true, force: true }).catch(() => undefined);
    }
    return exe;
  };

  const start = async (): Promise<string> => {
    if (await health()) {
      up = true;
      return URL_;
    }
    const exe = await copy();
    const child = spawn(exe, ["--worker", `--main-url=${o.mainUrl()}`], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, KESHER_DATA_DIR: join(o.dataDir, "worker"), KESHER_MAIN_ROOT: o.dataDir } });
    child.unref();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await health()) {
        up = true;
        return URL_;
      }
    }
    throw new Error("The self-work worker did not start (it has a minute and a half).");
  };

  const ensure = () => (starting ??= start().finally(() => (starting = undefined)));

  /** Every minute: a run that should be working gets its worker back; an old version is asked to move on. */
  const watch = () => {
    const tick = async () => {
      const h = await health();
      up = !!h;
      if (h) {
        if (h.version && h.version !== o.version && asked !== h.version) {
          asked = h.version;
          await fetch(`${URL_}/api/self-work/upgrade`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
        }
        return;
      }
      const saved = await readFile(state, "utf8").then((t) => JSON.parse(t) as { status?: string }, () => undefined);
      if (saved && (saved.status === "running" || saved.status === "waiting")) await ensure().catch(() => undefined);
    };
    setTimeout(() => void tick(), 5000);
    setInterval(() => void tick(), 60_000).unref();
  };

  return { ensure, url: () => (up ? URL_ : undefined), watch };
}
