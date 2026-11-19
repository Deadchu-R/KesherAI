const COST_PC = { he: "חינם: רץ על המחשב שלך", en: "Free: runs on your PC" };
const COST_CLAUDE = { he: "נספר במכסת ה-Max שלך (עד 30 בשעה)", en: "Counts against your Max usage (up to 30 an hour)" };
const COST_WAIT = { he: "חינם: מחכה עד שמחשב יידלק", en: "Free: waits until a PC is on" };
const COST_NONE = { he: "—", en: "—" };
/** Whether a PC takes this executor at all (its opt-in). */
function accepts(d, executor) {
    if (d.kind !== "pc" || !d.optIn.appear || !d.optIn.acceptTasks)
        return false;
    if (executor === "pc-local")
        return d.optIn.acceptLocal;
    if (executor === "pc-antigravity")
        return d.optIn.acceptAntigravity;
    return true;
}
/**
 * Chooses the route for a task (research entry, section 5, as changed by the addendum).
 *
 * 1. `claude-cloud`: the hub, when the cloud path is available.
 * 2. Otherwise a PC that is on and takes this kind of task (not busy first, then the preferred one).
 * 3. No such PC: `ifOffline: "cloud"` sends `auto`/`pc-any` tasks to Claude cloud (never local-model or Antigravity
 *    tasks, which need a PC); else the task waits for a PC that takes it when it comes back.
 *
 * @param task - The executor and the if-offline choice.
 * @param presence - The devices as the hub shows them.
 * @param opts - Whether the cloud path is available, and a preferred PC.
 * @returns The decision with its reason and cost.
 */
export function chooseRoute(task, presence, opts) {
    const cloud = (reason) => ({ route: "claude-cloud", to: "hub", kind: "cloud", reason, cost: COST_CLAUDE });
    const none = (reason) => ({ route: "none", to: null, kind: "task", reason, cost: COST_NONE });
    if (task.executor === "claude-cloud") {
        return opts.cloudAvailable ? cloud({ he: "נבחר Claude בענן", en: "Claude cloud was chosen" }) : none({ he: "המסלול לענן של Claude לא מוגדר או כבוי", en: "The Claude cloud path is not set up or is off" });
    }
    const takers = presence.filter((d) => accepts(d, task.executor));
    const on = takers
        .filter((d) => d.online)
        .sort((a, b) => Number(a.busy) - Number(b.busy) || Number(b.id === opts.preferredPc) - Number(a.id === opts.preferredPc) || a.name.localeCompare(b.name));
    const pc = on[0];
    if (pc) {
        return { route: "pc", to: pc.id, kind: "task", reason: pc.busy ? { he: `${pc.name} דלוק (עסוק, ייכנס לתור שלו)`, en: `${pc.name} is on (busy, it joins its queue)` } : { he: `${pc.name} דלוק`, en: `${pc.name} is on` }, cost: COST_PC };
    }
    const needsPc = task.executor === "pc-local" || task.executor === "pc-antigravity";
    if (!needsPc && task.ifOffline === "cloud" && opts.cloudAvailable) {
        return cloud({ he: "אין מחשב דלוק שמקבל משימות, אז: Claude בענן", en: "No PC that takes tasks is on, so: Claude cloud" });
    }
    const later = takers.find((d) => d.id === opts.preferredPc) ?? takers[0];
    if (later)
        return { route: "wait", to: later.id, kind: "task", reason: { he: `${later.name} כבוי; המשימה תחכה לו`, en: `${later.name} is off; the task waits for it` }, cost: COST_WAIT };
    return none({ he: "אין מחשב שמקבל משימות כאלה", en: "No PC accepts this kind of task" });
}
