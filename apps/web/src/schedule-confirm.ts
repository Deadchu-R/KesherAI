/**
 * The confirm card for `schedule_task`: reads the approval card's preview that the server writes
 * (packages/core/src/chat-schedule.ts `schedulePreview`): `key: value` lines, then `---` and the instructions.
 */

/** What the confirm card shows. */
export interface ScheduleConfirm {
  name: string;
  /** The schedule in the fixed grammar ("daily 08:30"). */
  when: string;
  /** The next run (ms). */
  next: number;
  /** Each run goes into a fresh chat. */
  newChat: boolean;
  /** The instructions each run gets. */
  prompt: string;
}

/**
 * @param preview - The approval request's preview.
 * @returns The fields, or undefined when it is not a schedule preview.
 */
export function parseSchedulePreview(preview: string): ScheduleConfirm | undefined {
  if (!preview.startsWith("schedule\n")) return undefined;
  const cut = preview.indexOf("\n---\n");
  if (cut < 0) return undefined;
  const f = new Map<string, string>();
  for (const line of preview.slice(9, cut).split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) f.set(line.slice(0, i), line.slice(i + 2));
  }
  const next = Number(f.get("next"));
  const when = f.get("when");
  const name = f.get("name");
  if (!when || !name || !Number.isFinite(next)) return undefined;
  return { name, when, next, newChat: f.get("newChat") === "true", prompt: preview.slice(cut + 5) };
}

/**
 * The note the model gets when the user chose Edit: what to change, with the values as they are now.
 *
 * @param c - The values after the user's changes.
 * @returns A feedback text for the denial.
 */
export function scheduleEditNote(c: Pick<ScheduleConfirm, "name" | "when" | "prompt" | "newChat">): string {
  return `The user wants changes before it is saved. Call schedule_task again with exactly these values: name=${JSON.stringify(c.name)}, when=${JSON.stringify(c.when)}, new_chat=${c.newChat}, prompt=${JSON.stringify(c.prompt)}`;
}
