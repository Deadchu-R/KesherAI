/**
 * Run and Cancel for the task inbox, pressed on the owner's paired phone or the Kesher Cloud hub page (a sealed
 * `command`; hub-client.ts checks that it came from a paired phone). Run is the user's own press, as the PC's Run
 * button: one press is one run, with every check of `TaskInbox.run` (Antigravity only, one at a time, the daily limit,
 * the quota, the PC not busy). Cancel skips a waiting task, or stops a running one (its work so far is kept).
 */
import type { HubCommandAction } from "@kesher/shared";

/** What a command needs from the app. */
export interface InboxCommandDeps {
  /** The inbox's task ids now. */
  ids: () => Promise<string[]>;
  /** The inbox id of a task another device wrote to Google Drive (tasks-sync.ts), by its Drive record id. */
  fromDrive?: (recordId: string) => Promise<string | undefined>;
  run: (id: string, approvedBy: string) => Promise<unknown>;
  /** Whether the task is running now (Cancel stops it then). */
  running: (id: string) => Promise<boolean>;
  stop: (id: string) => Promise<boolean>;
  skip: (id: string) => Promise<unknown>;
}

/**
 * Carries out Run or Cancel for one inbox task.
 *
 * @param d - The inbox.
 * @param action - Run or Cancel.
 * @param taskId - The inbox id, or the Drive record id of a task another device wrote.
 * @param from - The verified device that pressed it.
 * @returns Done, or why not (the inbox's own words).
 */
export async function inboxCommand(d: InboxCommandDeps, action: HubCommandAction, taskId: string, from: { id: string }): Promise<{ ok: boolean; text: string }> {
  const ids = await d.ids();
  const id = ids.includes(taskId) ? taskId : await d.fromDrive?.(taskId);
  if (!id || !ids.includes(id)) return { ok: false, text: "This PC does not have that task." };
  try {
    if (action === "inbox-run") {
      await d.run(id, `hub:${from.id}`);
      return { ok: true, text: "Started on the PC." };
    }
    if (await d.running(id)) return (await d.stop(id)) ? { ok: true, text: "Stopped; the work so far is kept." } : { ok: false, text: "It could not be stopped." };
    await d.skip(id);
    return { ok: true, text: "Cancelled." };
  } catch (e) {
    return { ok: false, text: ((e as Error).message || "It did not work.").slice(0, 300) };
  }
}
