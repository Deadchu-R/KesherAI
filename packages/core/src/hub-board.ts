/**
 * The shared task board on the hub page: the PC's board as a sealed snapshot (metadata only, no details), and the
 * few things the owner may do to a task from there (reopen, a higher priority, "for self-work", a note). Each is
 * applied through the board's own rules (`TaskBoard.change`), as the owner (Roee), exactly like the same buttons on the
 * PC's own board screen. hub-client.ts seals, sends and checks who sent it.
 */
import { fitBoard, HUB_LIMITS, type HubBoardCommand, type HubBoardItem } from "@kesher/shared";
import { categoryOf, sizeOf, type Board, type BoardChange, type TaskBoard } from "./task-board.js";

/**
 * The board as a hub snapshot: every task reduced to metadata, then capped ({@link fitBoard}).
 *
 * @param b - The board.
 * @returns The items and how many done tasks the board holds.
 */
export function hubBoardSnapshot(b: Board): { items: HubBoardItem[]; doneTotal: number } {
  return fitBoard(
    b.tasks.map((t) => {
      const result = t.result?.split("\n")[0]?.replace(/\s+/g, " ").trim().slice(0, 300);
      const fable = categoryOf(t) === "fable";
      return {
        id: t.id,
        title: t.title.replace(/^\s*\[(cool\s*down|fable)\]\s*/i, "").trim() || t.id,
        status: t.status,
        ...(t.owner ? { owner: t.owner } : {}),
        size: sizeOf(t),
        ...(fable ? { fable } : {}),
        priority: t.priority,
        ...(t.forKesher ? { forKesher: true } : {}),
        ...(result ? { result } : {}),
        at: Date.parse(t.updatedAt) || 0,
      };
    }),
  );
}

/**
 * Applies one command from the owner's phone or hub page to a board task.
 *
 * @param board - The PC's board.
 * @param id - The task's id.
 * @param cmd - What to do (already checked by the protocol).
 * @returns Done, or why not in a short line.
 */
export async function boardCommand(board: TaskBoard, id: string, cmd: HubBoardCommand): Promise<{ ok: boolean; text: string }> {
  const t = (await board.read()).tasks.find((x) => x.id === id);
  if (!t) return { ok: false, text: `No task ${id} on the board.` };
  let change: BoardChange;
  let text: string;
  switch (cmd.op) {
    case "reopen":
      if (t.status === "open") return { ok: false, text: "It is open already." };
      change = { op: "reopen", id };
      text = "Reopened.";
      break;
    case "raise":
      if (t.status === "done") return { ok: false, text: "It is done." };
      if (t.priority <= 1) return { ok: false, text: "It is the highest priority already." };
      change = { op: "edit", id, priority: Math.max(1, t.priority - 1) };
      text = `Priority p${Math.max(1, t.priority - 1)}.`;
      break;
    case "for-kesher":
      if (t.status === "done") return { ok: false, text: "It is done." };
      change = { op: "edit", id, forKesher: cmd.on };
      text = cmd.on ? "Handed to the local model." : "Not for the local model any more.";
      break;
    case "note":
      change = { op: "note", text: cmd.text.slice(0, HUB_LIMITS.boardNoteChars), task: id };
      text = "Note added.";
      break;
    default:
      return { ok: false, text: "Unknown board command." };
  }
  await board.change("roee", [change]);
  return { ok: true, text };
}
