/**
 * What the chat's live task list card shows (TodoCard.tsx): the agent's newest `todo` list (todo-list.ts in
 * @kesher/shared), one line per step with its mark, and the count ("3/7") for the card's header and the turn's status
 * line. Pure, so it is tested without a page.
 */
import { latestTodo, todoProgress, type TodoItem } from "@kesher/shared";

/** One line of the card. */
export interface TodoLine {
  id: string;
  /** The step as shown: its active form while it runs ("Writing the tests"), otherwise its title. */
  text: string;
  state: TodoItem["state"];
  /** ✅ done, 🔄 in progress, ⬜ not started. */
  mark: string;
}

/** The card's view of the list. */
export interface TodoView {
  lines: TodoLine[];
  done: number;
  total: number;
  /** Every step is done: the card folds to "7/7 steps". */
  finished: boolean;
  /** The list was written in the turn of the user's last message (an older one is not shown in the live area). */
  current: boolean;
}

const MARKS: Record<TodoItem["state"], string> = { done: "✅", in_progress: "🔄", pending: "⬜" };

/**
 * The list to show, from the chat's events.
 *
 * @param events - The chat's events (`todo` ones carry the whole list in `items`).
 * @returns The view, or undefined when the agent wrote no list or cleared it.
 */
export function todoView(events: readonly { type: string; items?: unknown; steered?: boolean }[]): TodoView | undefined {
  const items = latestTodo(events);
  if (!items?.length) return undefined;
  let lastUser = -1;
  let lastTodo = -1;
  for (let i = events.length - 1; i >= 0 && (lastUser < 0 || lastTodo < 0); i--) {
    const e = events[i]!;
    if (lastUser < 0 && e.type === "user" && !e.steered) lastUser = i;
    if (lastTodo < 0 && e.type === "todo") lastTodo = i;
  }
  const p = todoProgress(items);
  return {
    lines: items.map((i) => ({ id: i.id, text: i.state === "in_progress" && i.activeForm ? i.activeForm : i.title, state: i.state, mark: MARKS[i.state] })),
    done: p.done,
    total: p.total,
    finished: p.finished,
    current: lastTodo > lastUser,
  };
}

/**
 * The count for the turn's status line ("3/7"), while the list of this turn has steps left.
 *
 * @param view - The list's view.
 * @returns The done and total steps, or undefined when there is nothing to count.
 */
export function todoCount(view: TodoView | undefined): { done: number; total: number } | undefined {
  return view?.current && !view.finished ? { done: view.done, total: view.total } : undefined;
}
