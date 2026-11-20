import { join } from "node:path";
import { ResumeBoard } from "../resume-board.js";
import { chatResumeSource, engineSyncResumeSource, helperResumeSource, inboxResumeSource, selfWorkResumeSource } from "../resume-sources.js";
import type { KesherServices } from "../services.js";
import { sameFolder } from "../unity-cli.js";

/**
 * Builds the "Continue what was running" card's board with the areas the server owns (chats and their media jobs and
 * renders, helpers, the task inbox, self-work, engine syncs). Downloads add themselves in routes/downloads.ts.
 *
 * @param root - The data folder.
 * @param s - The services (read when the board asks, so later-set ones such as the task inbox are seen).
 * @returns The board.
 */
export function buildResume(root: string, s: KesherServices): ResumeBoard {
  const board = new ResumeBoard(join(root, "resume.json"));
  const selfWorkChat = () => {
    const r = s.selfWork?.current;
    return r && (r.status === "running" || r.status === "waiting") ? r.convId : undefined;
  };
  board.add("chat", chatResumeSource({
    working: () => Object.keys(s.conversations.activity()),
    runningTool: (id) => s.conversations.runningTool(id),
    interrupted: () => s.conversations.interrupted(),
    resume: (id, dismiss) => s.conversations.resumeInterrupted(id, dismiss),
    title: (id) => s.library.summary(id)?.title,
    skip: selfWorkChat,
  }));
  board.add("helper", helperResumeSource({
    resumed: () => s.conversations.helpers.resumed,
    state: (id) => s.conversations.helpers.runs.get(id)?.state,
    stop: (id) => s.conversations.helpers.runs.stop(id),
  }));
  board.add("inbox", inboxResumeSource({
    running: () => s.taskInbox?.runningTask(),
    status: async (id) => (s.taskInbox ? (await s.taskInbox.task(id)).status : undefined),
    runHere: async (id) => {
      if (!s.taskInbox) throw new Error("The task inbox is not available.");
      return s.taskInbox.run(id, { here: true });
    },
    ask: async (id) => {
      if (!s.taskInbox) throw new Error("The task inbox is not available.");
      return s.taskInbox.askRun(id);
    },
  }));
  board.add("self-work", selfWorkResumeSource({
    current: () => s.selfWork?.current,
    resume: async () => {
      if (!s.selfWork) throw new Error("Self-work is not available.");
      return s.selfWork.resume(2);
    },
    stop: async () => s.selfWork?.stop(),
  }));
  board.add("engine-sync", engineSyncResumeSource({
    running: async () => [
      ...(s.unreal.syncState.running ? [{ engine: "unreal" as const, project: (await s.unreal.project().catch(() => undefined)) ?? "Unreal" }] : []),
      ...[...s.unity.syncState].filter(([, st]) => st.running).map(([folder]) => ({ engine: "unity" as const, project: folder })),
    ],
    waiting: async (engine, project) =>
      engine === "unreal" ? (await s.unreal.queue()).filter((q) => q.decision !== "skip" && q.project.toLowerCase() === project.toLowerCase()).length : (await s.unity.queue()).filter((q) => sameFolder(q.project, project)).length,
    sync: (engine, project) => (engine === "unreal" ? s.unreal.syncNow() : s.unity.syncNow(project)),
  }));
  return board;
}
