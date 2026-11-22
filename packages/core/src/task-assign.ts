/**
 * "Who does it" on this PC (shared task-assign.ts): gives a task of the task inbox, or an item of Claude's work list,
 * to another executor. Used by the app's routes and by the sealed `assign` command from the owner's phone or hub page
 * (hub-client.ts checks the sender), so both act the same way. The PC is the source of truth.
 *
 * - An inbox task goes back in the queue for the new executor (inbox-runner.ts `reassign`).
 * - A work-list item becomes a new inbox task for it.
 * - A chat role: a new code chat on the inbox's project, whose lead hands the task to one sub-agent of that role;
 *   an inbox task then ends here as moved.
 * - A running task is stopped, and a finished one run again, only after the user's yes (`confirm`); without it the
 *   answer is a question (`ask`).
 */
import { ASSIGN_CHOICES, inboxExecutorOf, roleOf, type AssignResult, type AssignRole, type AssignTo, type InboxTaskView, type SpecialistId } from "@kesher/shared";

/** What an assignment needs from the app. */
export interface AssignDeps {
  /** An inbox task by its id, or undefined. */
  task: (id: string) => Promise<InboxTaskView | undefined>;
  /** The inbox id of a task another device wrote to Google Drive, by its record id. */
  fromDrive?: (recordId: string) => Promise<string | undefined>;
  /** A work-list item by its id (`w-…`): its title and whole text. */
  workItem?: (id: string) => Promise<{ title: string; text: string } | undefined>;
  stop: (id: string) => Promise<boolean>;
  reassign: (id: string, to: "opus" | "antigravity" | "local" | "gemini" | "opencode", again: boolean) => Promise<unknown>;
  add: (input: { title: string; goal: string; executor: string }) => Promise<{ id: string }>;
  /** Opens a code chat whose lead hands the task to a sub-agent of the role; returns the chat's title. */
  toChat?: (role: AssignRole | SpecialistId, title: string, text: string) => Promise<string>;
  movedOut: (id: string, where: string) => Promise<unknown>;
}

const nameOf = (to: AssignTo) => ASSIGN_CHOICES.find((c) => c.to === to)!.en;

/**
 * Gives a task or a work-list item to `to`.
 *
 * @param d - The inbox, the work list and the chats.
 * @param taskId - An inbox id, a Drive record id of an inbox task, or a work-list item id (`w-…`).
 * @param to - The new executor.
 * @param confirm - The user said yes to stopping a running task or running a finished one again.
 * @returns Done, a question (`ask`), or why not.
 */
export async function assignTask(d: AssignDeps, taskId: string, to: AssignTo, confirm = false): Promise<AssignResult> {
  const role = roleOf(to);
  const exec = inboxExecutorOf(to);
  try {
    if (taskId.startsWith("w-")) {
      const item = await d.workItem?.(taskId);
      if (!item) return { ok: false, text: "This PC does not have that work-list item." };
      if (role) {
        if (!d.toChat) return { ok: false, text: "This PC cannot open a chat for it (no project for the task inbox)." };
        return { ok: true, text: `Sent to a new chat: ${await d.toChat(role, item.title, item.text)}.` };
      }
      if (exec === "gemini") return { ok: false, text: "Free Gemini does only research tasks; add this one as research first." };
      const t = await d.add({ title: item.title, goal: item.text, executor: exec! });
      return { ok: true, text: `Added to the task inbox for ${nameOf(to)} (${t.id}).` };
    }
    const id = (await d.task(taskId)) ? taskId : await d.fromDrive?.(taskId);
    const t = id ? await d.task(id) : undefined;
    if (!id || !t) return { ok: false, text: "This PC does not have that task." };
    const running = t.status === "running" || t.status === "needs-approval";
    const finished = t.status === "done" || t.status === "partial";
    if (exec && exec === t.runBy && !running && !finished) return { ok: true, text: `It is already with ${nameOf(to)}.` };
    if (running && !confirm) return { ok: false, text: "It is running now.", ask: "running" };
    if (finished && !confirm) return { ok: false, text: "It has finished.", ask: "finished" };
    if (running && !(await d.stop(id))) return { ok: false, text: "It could not be stopped." };
    if (role) {
      if (!d.toChat) return { ok: false, text: "This PC cannot open a chat for it (no project for the task inbox)." };
      const chat = await d.toChat(role, t.title, t.goal);
      await d.movedOut(id, `to a ${role} agent in the chat "${chat}"`);
      return { ok: true, text: `Sent to a new chat: ${chat}.` };
    }
    await d.reassign(id, exec!, finished || running);
    return { ok: true, text: `Given to ${nameOf(to)}.` };
  } catch (e) {
    return { ok: false, text: ((e as Error).message || "It did not work.").slice(0, 300) };
  }
}
