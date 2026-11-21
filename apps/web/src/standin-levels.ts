/** Pure helpers of the "A level without Unreal" card (StandInScenes.tsx): plugin versions, card order, install state. */

/** An Unreal project as the page lists it (GET /api/unreal/projects). */
export interface StandInProject {
  name: string;
  path: string;
  engine?: string;
  /** The KesherAI Bridge version inside the project; null when it has none. */
  plugin: string | null;
}

/**
 * Compares two dotted versions ("0.1.30" against "0.1.23").
 *
 * @param a - The first version.
 * @param b - The second version.
 * @returns Negative when a is older, 0 when equal, positive when a is newer. A missing or odd part counts as 0.
 */
export function cmpVersion(a: string, b: string): number {
  const x = a.split(".").map((n) => Number(n) || 0);
  const y = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Whether the project's plugin is at least a version.
 *
 * @param plugin - The project's plugin version, or null for none.
 * @param min - The version needed.
 */
export const pluginAtLeast = (plugin: string | null, min: string): boolean => !!plugin && plugin !== "?" && cmpVersion(plugin, min) >= 0;

/**
 * The cards' order: projects whose levels are known to exist and whose plugin is ready first, then the other ready
 * ones, then the rest (no plugin or an old one). Ties keep the incoming order (the server's, newest first).
 *
 * @param projects - The projects.
 * @param counts - How many levels each project's path is known to have (those not opened yet are missing).
 * @param need - The plugin version that opens levels.
 * @returns A new, ordered list.
 */
export function orderProjects<T extends StandInProject>(projects: T[], counts: ReadonlyMap<string, number>, need: string): T[] {
  const rank = (p: T) => (pluginAtLeast(p.plugin, need) ? ((counts.get(p.path) ?? 0) > 0 ? 0 : 1) : 2);
  return projects.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/** What GET /api/unreal/engines says about installs (only the parts used here). */
export interface InstallPoll {
  job?: { state: string; project: string; message?: string } | null;
  batch?: { running: boolean; items: Array<{ path: string; state: string; message?: string }> } | null;
}

/**
 * Where one project's plugin install stands, from the engines answer (a single install's job or "install in all").
 *
 * @param poll - The answer of GET /api/unreal/engines.
 * @param path - The project folder.
 * @returns "running" (build or copy going, or queued), "done", "failed" (with the server's message) or "idle" (nothing of this project).
 */
export function installOf(poll: InstallPoll, path: string): { state: "running" | "done" | "failed" | "idle"; message?: string } {
  const same = (a: string) => a.replace(/[\\/]+$/, "").toLowerCase() === path.replace(/[\\/]+$/, "").toLowerCase();
  const item = poll.batch?.items.find((i) => same(i.path));
  const job = poll.job && same(poll.job.project) ? poll.job : undefined;
  // A single install's job is the newer word when both exist; a batch item is the project's state in "install in all".
  if (job) {
    if (["building", "waiting", "copying"].includes(job.state)) return { state: "running" };
    if (job.state === "done") return { state: "done" };
    if (job.state === "failed") return { state: "failed", ...(job.message ? { message: job.message } : {}) };
  }
  if (item) {
    if (item.state === "queued" || item.state === "installing") return { state: "running" };
    if (item.state === "done" || item.state === "skipped") return { state: "done" };
    if (item.state === "failed" || item.state === "unsupported") return { state: "failed", ...(item.message ? { message: item.message } : {}) };
  }
  return { state: "idle" };
}
