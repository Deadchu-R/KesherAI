import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, ConversationSummary, Project } from "@kesher/shared";

type Kind = "projects" | "conversations";

/** Name of the folder KesherAI creates inside the user's sync folder. */
export const SYNC_SUBFOLDER = "KesherAI";

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function summarize(c: Conversation): ConversationSummary {
  const { messages: _m, events: _e, ...summary } = c;
  return summary;
}

/**
 * Saved projects and conversations: one JSON file each under
 * `<data>/library/`, kept in memory for fast lists.
 *
 * When the user sets a sync folder (one that Google Drive for desktop,
 * OneDrive or Dropbox keeps in sync), every save is copied to
 * `<syncFolder>/KesherAI/`, and {@link importFromSync} brings in what other
 * computers saved there. The newer `updatedAt` wins.
 */
export class Library {
  private readonly projects = new Map<string, Project>();
  private readonly summaries = new Map<string, ConversationSummary>();

  /**
   * @param dir - The library folder.
   * @param syncFolder - Returns the current sync folder, if any.
   */
  constructor(
    private readonly dir: string,
    private readonly syncFolder: () => string | undefined,
  ) {}

  private path(kind: Kind, id: string, root = this.dir): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid id "${id}"`);
    return join(root, kind, `${id}.json`);
  }

  private syncRoot(): string | undefined {
    const folder = this.syncFolder();
    return folder ? join(folder, SYNC_SUBFOLDER) : undefined;
  }

  /** Reads every saved file into memory. Call once at start-up, after {@link importFromSync}. */
  async load(): Promise<void> {
    for (const kind of ["projects", "conversations"] as const) {
      await mkdir(join(this.dir, kind), { recursive: true });
      for (const file of await readdir(join(this.dir, kind))) {
        if (!file.endsWith(".json")) continue;
        const item = await readJson<Project | Conversation>(join(this.dir, kind, file));
        if (!item?.id) continue;
        if (kind === "projects") this.projects.set(item.id, item as Project);
        else this.summaries.set(item.id, summarize(item as Conversation));
      }
    }
  }

  /**
   * Copies files from the sync folder that are newer than (or missing from)
   * this computer's library.
   *
   * @returns How many files were imported.
   */
  async importFromSync(): Promise<number> {
    const root = this.syncRoot();
    if (!root) return 0;
    let imported = 0;
    for (const kind of ["projects", "conversations"] as const) {
      await mkdir(join(this.dir, kind), { recursive: true });
      const files = await readdir(join(root, kind)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const remote = await readJson<{ id: string; updatedAt: string }>(join(root, kind, file));
        if (!remote?.id) continue;
        const local = await readJson<{ updatedAt: string }>(join(this.dir, kind, file));
        if (!local || local.updatedAt < remote.updatedAt) {
          await copyFile(join(root, kind, file), join(this.dir, kind, file));
          imported++;
        }
      }
    }
    return imported;
  }

  /**
   * Copies the whole library to the sync folder (used when the user first sets one).
   *
   * @returns How many files were copied.
   */
  async exportToSync(): Promise<number> {
    const root = this.syncRoot();
    if (!root) return 0;
    let count = 0;
    for (const kind of ["projects", "conversations"] as const) {
      await mkdir(join(root, kind), { recursive: true });
      for (const file of await readdir(join(this.dir, kind)).catch(() => [])) {
        if (!file.endsWith(".json")) continue;
        await copyFile(join(this.dir, kind, file), join(root, kind, file));
        count++;
      }
    }
    return count;
  }

  private async persist(kind: Kind, id: string, value: unknown): Promise<void> {
    await mkdir(join(this.dir, kind), { recursive: true });
    await writeJsonAtomic(this.path(kind, id), value);
    const root = this.syncRoot();
    if (root) {
      try {
        await mkdir(join(root, kind), { recursive: true });
        await writeJsonAtomic(this.path(kind, id, root), value);
      } catch (err) {
        console.warn(`[library] could not write to the sync folder: ${(err as Error).message}`);
      }
    }
  }

  private async remove(kind: Kind, id: string): Promise<void> {
    await rm(this.path(kind, id), { force: true });
    const root = this.syncRoot();
    if (root) await rm(this.path(kind, id, root), { force: true }).catch(() => undefined);
  }

  /** @returns Projects, by name. */
  listProjects(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * @param id - Project id.
   * @returns The project, or `undefined`.
   */
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /**
   * Creates or updates a project.
   *
   * @param p - Project; `updatedAt` is set here.
   * @returns The saved project.
   */
  async saveProject(p: Project): Promise<Project> {
    const saved = { ...p, updatedAt: new Date().toISOString() };
    this.projects.set(saved.id, saved);
    await this.persist("projects", saved.id, saved);
    return saved;
  }

  /**
   * Deletes a project. Its conversations stay, moved out of the project.
   *
   * @param id - Project id.
   */
  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
    await this.remove("projects", id);
    for (const s of this.summaries.values()) {
      if (s.projectId !== id) continue;
      const c = await this.getConversation(s.id);
      if (c) await this.saveConversation({ ...c, projectId: null });
    }
  }

  /**
   * @param projectId - Only this project's (`null` = conversations without a project); omit for all.
   * @returns Conversation summaries, newest first.
   */
  listConversations(projectId?: string | null): ConversationSummary[] {
    return [...this.summaries.values()]
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * @param id - Conversation id.
   * @returns The full conversation, or `undefined`.
   */
  async getConversation(id: string): Promise<Conversation | undefined> {
    if (!this.summaries.has(id)) return undefined;
    return readJson<Conversation>(this.path("conversations", id));
  }

  /**
   * Saves a conversation.
   *
   * @param c - Conversation; `updatedAt` is set here.
   * @returns The saved conversation.
   */
  async saveConversation(c: Conversation): Promise<Conversation> {
    const saved = { ...c, updatedAt: new Date().toISOString() };
    this.summaries.set(saved.id, summarize(saved));
    await this.persist("conversations", saved.id, saved);
    return saved;
  }

  /** @param id - Conversation to delete. */
  async deleteConversation(id: string): Promise<void> {
    this.summaries.delete(id);
    await this.remove("conversations", id);
  }
}

/**
 * Checks that a folder exists and can be written, for the sync-folder setting.
 *
 * @param folder - Absolute path.
 * @throws Error with a readable message otherwise.
 */
export async function assertWritableFolder(folder: string): Promise<void> {
  const info = await stat(folder).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${folder} is not a folder on this computer.`);
  const probe = join(folder, `.kesher-write-test-${randomUUID()}`);
  await writeFile(probe, "ok").catch(() => {
    throw new Error(`KesherAI cannot write to ${folder}.`);
  });
  await rm(probe, { force: true });
}
