/**
 * The chat's live task list (as Claude's TaskCreate/TaskUpdate and TodoWrite): the agent writes a short list of the
 * steps of the current job with the `todo` tool and marks each one as it goes; the chat shows it as a checklist card
 * ("✅ done · 🔄 now · ⬜ next") and the turn's status line counts it ("3/7"). One list per chat: the newest `todo`
 * event holds the whole list, so it is saved with the chat's events and comes back when the chat is opened again.
 * Pure helpers, used by the agent loop (session.ts), its tool reply, and the page's card (TodoCard.tsx).
 */
/** The most steps a list keeps (a longer list is cut; weak local models wrote 30-line lists). */
export const TODO_MAX_ITEMS = 12;
/** The longest title or active form kept, in characters. */
export const TODO_MAX_TITLE = 120;
/** Words weak models use for a state, mapped to the three states (as Claude's and ACP's names too). */
const STATE_WORDS = {
    pending: "pending", todo: "pending", open: "pending", not_started: "pending",
    in_progress: "in_progress", "in-progress": "in_progress", active: "in_progress", doing: "in_progress", running: "in_progress", current: "in_progress",
    done: "done", completed: "done", complete: "done", finished: "done",
};
/**
 * Reads a state the model wrote, in any of the usual spellings.
 *
 * @param v - The model's value ("completed", "in-progress", "Done").
 * @returns The state, or undefined when it is not one.
 */
export function todoState(v) {
    return typeof v === "string" ? STATE_WORDS[v.trim().toLowerCase().replace(/\s+/g, "_")] : undefined;
}
const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, TODO_MAX_TITLE) : "");
/**
 * Applies one `todo` call to the chat's list. `items` writes the whole list (an empty list clears it); `set` changes
 * the state of steps already in it, by id (cheaper for the model than writing the list again). Both may come together:
 * `items` first, then `set`.
 *
 * @param prev - The list before the call (empty when there is none).
 * @param input - The call's arguments: `{ items?: [{ id?, title, state, activeForm? }], set?: [{ id, state }] }`.
 *   `content` and `status` are taken for `title` and `state` too.
 * @returns The new list (the old one is not changed), or an error naming what to fix.
 */
export function applyTodo(prev, input) {
    let items = prev.map((i) => ({ ...i }));
    if (input.items !== undefined) {
        if (!Array.isArray(input.items))
            return { error: 'todo: "items" must be a list of steps.' };
        const used = new Set();
        items = [];
        for (const [n, raw] of input.items.slice(0, TODO_MAX_ITEMS).entries()) {
            const r = (raw && typeof raw === "object" ? raw : { title: raw });
            const title = text(r.title ?? r.content);
            if (!title)
                return { error: `todo: step ${n + 1} has no title.` };
            let id = text(r.id).slice(0, 20) || String(n + 1);
            if (used.has(id))
                id = `${id}-${n + 1}`;
            used.add(id);
            const active = text(r.activeForm);
            items.push({ id, title, state: todoState(r.state ?? r.status) ?? "pending", ...(active && active !== title ? { activeForm: active } : {}) });
        }
    }
    if (input.set !== undefined) {
        const changes = Array.isArray(input.set) ? input.set : [input.set];
        for (const raw of changes) {
            const r = (raw && typeof raw === "object" ? raw : {});
            const id = text(r.id);
            const state = todoState(r.state ?? r.status);
            const item = items.find((i) => i.id === id);
            if (!item)
                return { error: `todo: there is no step "${id}". Steps: ${items.map((i) => i.id).join(", ") || "(none yet: send items)"}.` };
            if (!state)
                return { error: `todo: step "${id}" needs a state: pending, in_progress or done.` };
            item.state = state;
        }
    }
    if (input.items === undefined && input.set === undefined)
        return { error: 'todo needs "items" (the whole list) or "set" (state changes by id).' };
    return { items };
}
/**
 * Counts the list for the card's header and the status line.
 *
 * @param items - The list.
 * @returns Done and total steps, the current step, and whether all are done.
 */
export function todoProgress(items) {
    const done = items.filter((i) => i.state === "done").length;
    const current = items.find((i) => i.state === "in_progress");
    return { done, total: items.length, ...(current ? { current } : {}), finished: items.length > 0 && done === items.length };
}
/**
 * The chat's list: the one in its newest `todo` event.
 *
 * @param events - The chat's events (any objects with a `type`; `todo` ones carry `items`).
 * @returns The list, or undefined when the agent never wrote one.
 */
export function latestTodo(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === "todo" && Array.isArray(e.items))
            return e.items;
    }
    return undefined;
}
/**
 * What the `todo` tool answers the model: the list as it now stands, short, and what to do next.
 *
 * @param items - The new list.
 * @returns One or two lines.
 */
export function todoReply(items) {
    if (!items.length)
        return "The list is cleared.";
    const p = todoProgress(items);
    const mark = (i) => (i.state === "done" ? "[x]" : i.state === "in_progress" ? "[>]" : "[ ]");
    const list = items.map((i) => `${mark(i)} ${i.id}. ${i.title}`).join("\n");
    const next = p.finished ? "All steps are done: give the user a short summary."
        : p.current ? `Now: ${p.current.id}. Mark it done as soon as it is finished.`
            : "Mark the next step in_progress before you start it.";
    return `${p.done}/${p.total} done.\n${list}\n${next}`;
}
/** The longest "Open steps" line appended to a tool result, in characters. */
export const TODO_OPEN_LINE_MAX = 120;
/**
 * The steps still open (pending or in progress), in list order.
 *
 * @param items - The list (may be undefined).
 */
export function openTodoSteps(items) {
    return (items ?? []).filter((i) => i.state !== "done");
}
/**
 * One short line for the end of a tool result while the list has open steps ("Open steps: 2/5 — Tests; Docs"), so a small
 * model keeps its plan in view (Manus-style recitation). At most {@link TODO_OPEN_LINE_MAX} characters.
 *
 * @param items - The chat's list.
 * @returns The line, or undefined when nothing is open.
 */
export function todoOpenLine(items) {
    const open = openTodoSteps(items);
    if (!items || !open.length)
        return undefined;
    const head = `Open steps: ${open.length}/${items.length} — `;
    const line = head + open.map((i) => i.title).join("; ");
    return line.length <= TODO_OPEN_LINE_MAX ? line : `${line.slice(0, TODO_OPEN_LINE_MAX - 1)}…`;
}
/**
 * The done-gate message: sent once when the model gives a final answer while the list still has open steps.
 *
 * @param items - The chat's list.
 * @returns The message, or undefined when nothing is open.
 */
export function todoOpenNudge(items) {
    const open = openTodoSteps(items);
    if (!open.length)
        return undefined;
    return `[KesherAI] These steps are still open: ${open.map((i) => `${i.id}. ${i.title}`).join("; ")}. Continue, or mark them done/dropped with a reason.`;
}
