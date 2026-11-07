import type { Conversation, Project } from "@kesher/shared";
import type { GoogleConfig, GoogleDrive } from "./google.js";
import type { Library, LibraryKind } from "./library.js";

/** Result of a full sync. */
export interface SyncResult {
  downloaded: number;
  uploaded: number;
}

/**
 * Keeps the library and the KesherAI folder in Google Drive in step:
 * every local save is uploaded a moment later, and {@link syncNow} brings
 * both sides up to date (the newer `updatedAt` wins).
 */
export class DriveSync {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running?: Promise<SyncResult>;

  /**
   * @param drive - The Google Drive client.
   * @param library - The local library.
   * @param config - The `google` config section (for the status shown in Settings).
   * @param save - Persists the config.
   */
  constructor(
    private readonly drive: GoogleDrive,
    private readonly library: Library,
    private readonly config: GoogleConfig,
    private readonly save: () => Promise<void>,
  ) {
    library.onChange(({ kind, id, deleted }) => {
      if (!this.drive.connected) return;
      const key = `${kind}/${id}`;
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          void this.pushOne(kind, id, deleted);
        }, 2000),
      );
    });
  }

  private async record(error?: unknown): Promise<void> {
    if (error) this.config.lastError = error instanceof Error ? error.message : String(error);
    else {
      delete this.config.lastError;
      this.config.lastSync = new Date().toISOString();
    }
    await this.save();
  }

  private async pushOne(kind: LibraryKind, id: string, deleted: boolean): Promise<void> {
    try {
      if (deleted) await this.drive.remove(kind, id);
      else {
        const value = await this.library.read(kind, id);
        if (value) await this.drive.upload(kind, id, value);
      }
      await this.record();
    } catch (err) {
      await this.record(err);
    }
  }

  /**
   * Downloads what is newer in Drive and uploads what is newer here.
   *
   * @returns How many items moved each way.
   */
  syncNow(): Promise<SyncResult> {
    this.running ??= (async () => {
      try {
        const remote = await this.drive.list();
        const local = new Map(this.library.items().map((i) => [`${i.kind}/${i.id}`, i]));
        let downloaded = 0;
        let uploaded = 0;
        for (const r of remote) {
          const l = local.get(`${r.kind}/${r.id}`);
          if (!l || l.updatedAt < r.updatedAt) {
            await this.library.applyRemote(r.kind, (await this.drive.download(r.fileId)) as Project | Conversation);
            downloaded++;
          }
        }
        const remoteKeys = new Map(remote.map((r) => [`${r.kind}/${r.id}`, r.updatedAt]));
        for (const [key, l] of local) {
          const r = remoteKeys.get(key);
          if (!r || r < l.updatedAt) {
            const value = await this.library.read(l.kind, l.id);
            if (value) {
              await this.drive.upload(l.kind, l.id, value);
              uploaded++;
            }
          }
        }
        await this.record();
        return { downloaded, uploaded };
      } catch (err) {
        await this.record(err);
        throw err;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
