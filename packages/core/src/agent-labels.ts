/**
 * The owner's names and notes for agent runs (docs/RESEARCH_LOG.md, "Agent names and notes", 2026-11-20), kept on
 * this PC, which is their source of truth: one small JSON file in the data folder (`agent-labels.json`, never in a
 * project or the logs), read at start and written soon after each change. A label is set from the app (the agents'
 * cards and pages) or from the owner's phone and hub page (a sealed `agent-label` command, hub-client.ts); the PC
 * then sends the run's state again, so every device shows the same name and note.
 *
 * Keyed by run id: a chat helper's id (`h-…`) or an inbox run's (`in-…`). At most {@link MAX_LABELS} are kept; the
 * oldest changed go first.
 */
import { EventEmitter } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import { cleanAgentLabel, type AgentLabel } from "@kesher/shared";

/** How many labels are kept. */
export const MAX_LABELS = 1000;
/** A run id that may be a key (as the hub's ids). */
const RUN_ID = /^[\w-]{1,64}$/;
const WRITE_DELAY_MS = 300;

/** The labels, by run id. Emits `change` with the run id after each set. */
export class AgentLabels extends EventEmitter {
  private readonly labels = new Map<string, AgentLabel>();
  private timer?: NodeJS.Timeout;
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  /**
   * @param file - The JSON file (in the data folder), or undefined to keep them in memory only (tests).
   * @param now - The clock (tests).
   */
  constructor(
    private readonly file: string | undefined,
    now?: () => number,
  ) {
    super();
    this.now = now ?? Date.now;
  }

  /** Reads the saved labels (a missing or broken file is an empty list). */
  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
        if (!RUN_ID.test(id) || !v || typeof v !== "object") continue;
        const l = cleanAgentLabel(v, (v as { at?: unknown }).at as number | undefined);
        if (l.name || l.note) this.labels.set(id, l);
      }
    } catch {
      // No file yet, or a write cut by a crash: start empty (the next write replaces it).
    }
  }

  /**
   * One run's label.
   *
   * @param runId - The run.
   * @returns Its name and note, or undefined.
   */
  get(runId: string): AgentLabel | undefined {
    return this.labels.get(runId);
  }

  /**
   * Sets or clears a run's name and note (empty fields clear them; both empty removes the label).
   *
   * @param runId - The run.
   * @param input - `{ name?, note? }` (untrusted; cleaned here).
   * @returns The label now (with `at`), or undefined when the id is not a run id.
   */
  set(runId: string, input: unknown): AgentLabel | undefined {
    if (!RUN_ID.test(runId)) return undefined;
    const label = cleanAgentLabel(input, this.now());
    this.labels.delete(runId);
    if (label.name || label.note) this.labels.set(runId, label);
    while (this.labels.size > MAX_LABELS) this.labels.delete(this.labels.keys().next().value!);
    this.save();
    this.emit("change", runId);
    return label;
  }

  /** Writes the file soon (one write for a burst of changes). */
  private save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.write(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Queues one write of every label now (a new file is renamed over the old one, so a crash never leaves half). */
  private write(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const file = this.file!;
    const text = JSON.stringify(Object.fromEntries(this.labels));
    this.writes = this.writes
      .then(async () => {
        await writeFile(`${file}.tmp`, text, "utf8");
        await rename(`${file}.tmp`, file);
      })
      .catch((e: Error) => console.warn(`[agents] could not save the agent names: ${e.message}`));
  }

  /** Writes a pending change now and waits for it (tests, and the app closing). */
  async flush(): Promise<void> {
    if (this.timer) this.write();
    await this.writes;
  }
}
