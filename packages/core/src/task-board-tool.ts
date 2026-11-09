import type { AgentTool } from "@kesher/agent";
import { boardText, type BoardChange, type TaskBoard } from "./task-board.js";

/**
 * `task_board`: the self-work agent reads and updates the task board it shares
 * with Claude (on this computer only). It claims a task before working on it,
 * marks it done with what it did and how it was checked, and leaves notes.
 */
export function taskBoardTool(board: TaskBoard): AgentTool {
  return {
    risk: "safe",
    spec: {
      name: "task_board",
      description:
        "The task board you share with Claude (and Roee) on this computer. action 'read' shows the tasks and the latest notes. Before you work on a task, 'claim' it (it fails if Claude took it: pick another). When finished: 'done' with result = what changed, the commit, and how you checked it (tests). 'block' with result = why, when you need Roee or Claude. 'note' leaves a message (e.g. a question for Claude). 'add' adds a task you found. Never take a task someone else claimed.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "claim", "release", "done", "block", "note", "add"] },
          id: { type: "string", description: "The task, e.g. t3." },
          result: { type: "string", description: "For done/block." },
          text: { type: "string", description: "For note; for add: the title." },
          details: { type: "string", description: "For add." },
        },
        required: ["action"],
      },
    },
    async run(input) {
      const action = String(input.action ?? "read");
      if (action === "read") return { output: boardText(await board.read(), 15) };
      const id = String(input.id ?? "");
      const change: BoardChange | undefined =
        action === "claim" ? { op: "claim", id }
        : action === "release" ? { op: "release", id }
        : action === "done" ? { op: "done", id, result: String(input.result ?? "") }
        : action === "block" ? { op: "block", id, result: String(input.result ?? "") }
        : action === "note" ? { op: "note", text: String(input.text ?? ""), ...(id ? { task: id } : {}) }
        : action === "add" ? { op: "add", title: String(input.text ?? ""), ...(input.details ? { details: String(input.details) } : {}) }
        : undefined;
      if (!change) return { output: "Unknown action." };
      try {
        const b = await board.change("kesher", [change]);
        return { output: `Done (board revision ${b.rev}).\n${boardText(b, 5)}` };
      } catch (e) {
        return { output: `Not changed: ${(e as Error).message}` };
      }
    },
  };
}
