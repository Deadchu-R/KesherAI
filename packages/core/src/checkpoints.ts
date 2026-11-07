import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Checkpoints for coding sessions: before each message, KesherAI saves the
 * project folder's state, so any point can be restored with one click.
 *
 * They live in a separate git store inside KesherAI's data folder (never in
 * the project's own .git, so the project's history stays untouched). The
 * project's .gitignore files apply, plus the usual build and cache folders
 * of Unity, Unreal, Node and .NET.
 */

/** One saved state. */
export interface Checkpoint {
  id: string;
  /** The message it was taken before. */
  label: string;
  at: string;
  /** Files changed since the previous checkpoint. */
  files: number;
}

const EXCLUDES = [
  ".git/",
  "node_modules/",
  "Library/",
  "Temp/",
  "Logs/",
  "obj/",
  "Obj/",
  "Build/",
  "Builds/",
  "UserSettings/",
  "Binaries/",
  "Intermediate/",
  "DerivedDataCache/",
  "Saved/",
  ".vs/",
  "dist/",
  "*.tmp",
];

function git(args: string[], env: Record<string, string>, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split("\n").slice(-2).join(" ")));
      else resolve(stdout.toString().trim());
    });
  });
}

/** Saves and restores project states for coding sessions. */
export class Checkpoints {
  private available?: Promise<boolean>;

  /** @param dir - KesherAI's checkpoints folder (one store per conversation). */
  constructor(private readonly dir: string) {}

  /** @returns Whether git is installed (checkpoints need it). */
  hasGit(): Promise<boolean> {
    this.available ??= git(["--version"], {}).then(
      () => true,
      () => false,
    );
    return this.available;
  }

  private store(convId: string) {
    return join(this.dir, `${convId.replace(/[^a-zA-Z0-9-]/g, "")}.git`);
  }

  private env(convId: string, workspace: string): Record<string, string> {
    return { GIT_DIR: this.store(convId), GIT_WORK_TREE: workspace, GIT_AUTHOR_NAME: "KesherAI", GIT_AUTHOR_EMAIL: "checkpoints@kesher.local", GIT_COMMITTER_NAME: "KesherAI", GIT_COMMITTER_EMAIL: "checkpoints@kesher.local" };
  }

  private async ensure(convId: string, workspace: string): Promise<Record<string, string>> {
    const env = this.env(convId, workspace);
    const store = this.store(convId);
    if (!existsSync(join(store, "HEAD"))) {
      await mkdir(this.dir, { recursive: true });
      await git(["init", "--quiet"], env);
      await git(["config", "core.autocrlf", "false"], env);
      await git(["config", "core.quotepath", "false"], env);
      await mkdir(join(store, "info"), { recursive: true });
      await writeFile(join(store, "info", "exclude"), EXCLUDES.join("\n") + "\n");
    }
    return env;
  }

  private async index(convId: string): Promise<Checkpoint[]> {
    try {
      return JSON.parse(await readFile(join(this.store(convId), "kesher-checkpoints.json"), "utf8")) as Checkpoint[];
    } catch {
      return [];
    }
  }

  private async saveIndex(convId: string, list: Checkpoint[]) {
    await writeFile(join(this.store(convId), "kesher-checkpoints.json"), JSON.stringify(list.slice(-200), null, 2));
  }

  /**
   * Saves the folder's state (cheap when little changed).
   *
   * @param convId - The conversation.
   * @param workspace - The project folder.
   * @param label - What it is before (the user's message).
   * @returns The checkpoint, or undefined when git is missing.
   */
  async snapshot(convId: string, workspace: string, label: string): Promise<Checkpoint | undefined> {
    if (!(await this.hasGit()) || !existsSync(workspace)) return undefined;
    const env = await this.ensure(convId, workspace);
    await git(["add", "-A", "."], env, 600_000);
    const hasHead = await git(["rev-parse", "--verify", "HEAD"], env).then(() => true, () => false);
    const changed = hasHead ? (await git(["diff", "--cached", "--name-only", "HEAD"], env)).split("\n").filter(Boolean).length : -1;
    const list = await this.index(convId);
    if (hasHead && changed === 0 && list.length) {
      // Nothing changed since the last one: point this message at the same state.
      const id = await git(["rev-parse", "HEAD"], env);
      const cp = { id, label: label.slice(0, 200), at: new Date().toISOString(), files: 0 };
      await this.saveIndex(convId, [...list, cp]);
      return cp;
    }
    await git(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", label.slice(0, 200) || "checkpoint"], env, 600_000);
    const id = await git(["rev-parse", "HEAD"], env);
    // A name for every checkpoint, so restoring an older one never lets git throw newer ones away.
    await git(["update-ref", `refs/kesher/${id}`, id], env);
    const cp = { id, label: label.slice(0, 200), at: new Date().toISOString(), files: Math.max(0, changed) };
    await this.saveIndex(convId, [...list, cp]);
    return cp;
  }

  /** @returns A conversation's checkpoints, oldest first. */
  async list(convId: string): Promise<Checkpoint[]> {
    return this.index(convId);
  }

  /**
   * Puts the folder back as it was at a checkpoint. The current state is
   * saved first, so restoring can itself be undone.
   *
   * @param convId - The conversation.
   * @param workspace - The project folder.
   * @param id - The checkpoint.
   * @returns The checkpoint saved just before restoring.
   */
  async restore(convId: string, workspace: string, id: string): Promise<Checkpoint | undefined> {
    const list = await this.index(convId);
    const target = list.find((c) => c.id === id);
    if (!target) throw new Error("No such checkpoint.");
    const before = await this.snapshot(convId, workspace, `Before restoring to: ${target.label}`);
    const env = this.env(convId, workspace);
    // The current state is committed, so a hard reset also removes files created since the checkpoint.
    await git(["reset", "--hard", "--quiet", target.id], env, 600_000);
    // Keep the store's latest commit as the restored state for the next diff.
    return before;
  }
}
