/**
 * "Who works on what" on the hub page's Tasks tab and the phone's Cloud tab (the same page): the Now strip (one row
 * per worker), the Next list (by priority), the Active · Done · Failed tabs with their counts, and the filter chips by
 * agent, model and kind (kept per device). Layout: the design doc's HubNowNext, HubWorkTabs and HubWorkFilters boards.
 *
 * The grouping, ordering and filtering are pure (packages/shared/src/hub-work.ts, tested in Node); this file only
 * draws them. Everything shown came sealed from the PCs, and every button is the one the page already had: Run (with
 * its 5-second undo), "Next in line: Start?", a higher board priority, and the sealed `assign` command for Retry and
 * Move to Antigravity. Nothing here is stored except the filters, in this browser.
 */
import { assignOfExecutor, assignQuestion } from "../../../packages/shared/src/task-assign.js";
import { describeStep } from "../../../packages/shared/src/task-steps.js";
import { cleanFilters, filtersOn, leavers, modelsOf, nextEntries, nowRows, NO_FILTERS, passes, phaseCounts, WORKERS, type NextEntry, type NowRow, type WorkFilters, type WorkPhase, type WorkTask } from "../../../packages/shared/src/hub-work.js";
import type { HubBoardItem, HubWorkKind } from "../../../packages/shared/src/hub-protocol.js";
import { h, L, when } from "./dom.js";
import type { HubDevice, PageTask } from "./device.js";
import { get, put } from "./kv.js";
import { runAllButton, runWithUndo } from "./run-button.js";
import { waitingEntries } from "./waiting.js";

/** What the section needs from the page. */
export interface WorkView {
  device: HubDevice;
  render: () => void;
  /** Opens a live agent card on the Agents tab. */
  openAgent: (key: string) => void;
  /** Every page task (this device's, the PCs' inbox and Google Drive) as work tasks, newest state. */
  tasks: () => Array<{ task: PageTask; work: WorkTask }>;
}

/** The page's choices here: the tab (in memory) and the filters (saved in this browser). */
export const workState: { phase: WorkPhase; filters: WorkFilters; loaded: boolean } = { phase: "active", filters: { ...NO_FILTERS, who: [] }, loaded: false };

/**
 * Loads the filters saved in this browser (once), then redraws.
 *
 * @param render - Redraws the page.
 */
export function loadWorkFilters(render: () => void): void {
  if (workState.loaded) return;
  workState.loaded = true;
  void get<unknown>("workFilters")
    .then((x) => {
      workState.filters = cleanFilters(x);
      render();
    })
    .catch(() => undefined);
}

/** Changes the filters and keeps them for this browser. */
function setFilters(v: Pick<WorkView, "render">, f: WorkFilters): void {
  workState.filters = f;
  void put("workFilters", f).catch(() => undefined);
  v.render();
}

const WORKER: Record<string, [string, string]> = {
  antigravity: ["✦ Antigravity", "✦ Antigravity"],
  gemini: ["✧ Gemini (חינמי)", "✧ Gemini (free)"],
  opencode: ["◈ OpenCode Go", "◈ OpenCode Go"],
  ghostcli: ["👻 GhostCLI", "👻 GhostCLI"],
  local: ["◆ סוכן מקומי", "◆ Local agent"],
  claude: ["✷ Claude", "✷ Claude"],
};

/** A worker's name; one a newer PC reports is shown as written. */
const workerName = (w: string): string => (WORKER[w] ? L(...WORKER[w]!) : w);

const KIND: Record<HubWorkKind, [string, string]> = { research: ["מחקר", "Research"], code: ["קוד", "Code"], conversion: ["המרה", "Conversion"] };

/** "step 3/8" or "step 3" (an estimate is "~"). */
function stepText(step: number | undefined, of: number | undefined): string {
  if (!step && !of) return "";
  if (step && of) return step > of ? L(`צעד ${step} (הערכה ~${of})`, `step ${step} (est. ~${of})`) : L(`צעד ${step} מתוך ~${of}`, `step ${step} of ~${of}`);
  return step ? L(`צעד ${step}`, `step ${step}`) : L(`~${of} צעדים`, `~${of} steps`);
}

/** The board items of every PC, and which PC has each (to raise a priority). */
function boardOf(device: HubDevice): { items: HubBoardItem[]; pcOf: Map<string, string> } {
  const items: HubBoardItem[] = [];
  const pcOf = new Map<string, string>();
  for (const [pc, snap] of device.boards) {
    for (const i of snap.items) {
      items.push(i);
      pcOf.set(i.id, pc);
    }
  }
  return { items, pcOf };
}

/** One row of the Now strip. */
function nowRow(v: WorkView, r: NowRow, pcsOn: boolean): HTMLElement {
  const open = r.runKey ? () => v.openAgent(r.runKey!) : undefined;
  const body = r.free
    ? [h("span", { class: "mut sm grow" }, pcsOn ? L("פנוי", "Free") : L("המחשב כבוי", "The PC is off"))]
    : [
        h("span", { class: "grow min0 wrapl nw-title", dir: "auto" }, r.title ?? ""),
        r.flag === "waiting" ? h("span", { class: "tag t-ask" }, L("מחכה לך", "Waits for you")) : r.flag === "stale" ? h("span", { class: "tag t-wait" }, L("לא עונה", "Not answering")) : null,
      ];
  // What it is doing now, in plain words (task-steps.ts): "Reading …", "Running the tests".
  const doing = !r.free && r.now ? h("div", { class: "xs nw-now", dir: "auto" }, describeStep(r.now, L("he", "en") === "he")) : null;
  // Progress: steps done of the estimate (capped short of full while it still runs).
  const bar = !r.free && r.step && r.of ? h("div", { class: "nw-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(r.of), "aria-valuenow": String(Math.min(r.step, r.of)) }, h("i", { style: `width:${Math.min(95, Math.round((r.step / r.of) * 100))}%` })) : null;
  const facts = r.free ? null : h("div", { class: "row wrap xs mut nw-facts" }, stepText(r.step, r.of) ? h("span", { class: "chip steps" }, stepText(r.step, r.of)) : null, r.model ? h("span", { class: "chip" }, r.model) : null, r.since ? h("span", null, L("מ-", "since ") + when(r.since)) : null);
  return h(
    open ? "button" : "div",
    { ...(open ? { type: "button", onclick: open } : {}), class: `nowrow${r.free ? " free" : ""}`, "aria-label": `${workerName(r.worker)}: ${r.free ? L("פנוי", "free") : r.title ?? ""}` },
    h("div", { class: "row nw-top" }, h("b", { class: "nw-who" }, workerName(r.worker)), ...body),
    bar,
    doing,
    facts,
  );
}

/** The Now strip: who works on what right now, one row per worker. */
function nowStrip(v: WorkView, all: WorkTask[], board: HubBoardItem[]): HTMLElement {
  const d = v.device;
  const keyOf = (id: string) => {
    const t = v.tasks().find((x) => x.task.taskId === id)?.task;
    const key = t?.inbox?.runId ? `${t.inbox.deviceId}/${t.inbox.runId}` : undefined;
    return key && d.agents.has(key) ? key : undefined;
  };
  const rows = nowRows(all, d.agents.values(), board, Date.now(), keyOf);
  const busy = rows.filter((r) => !r.free).length;
  return h(
    "section",
    { class: "card clip nowstrip", "aria-label": L("עובדים עכשיו", "Working now"), "aria-live": "polite" },
    h("div", { class: "row head" }, h("b", null, L("▶ עובדים עכשיו", "▶ Working now")), h("span", { class: busy ? "tag t-run" : "tag t-off" }, String(busy)), h("span", { class: "grow" }), h("span", { class: "mut xs" }, L("מהמחשב, חי", "From the PC, live"))),
    rows.map((r) => nowRow(v, r, d.onlinePcs().length > 0)),
  );
}

/** "Next in line: Start?" asks (the PC's own question after a task ended), by task title. */
function nextInLineAsk(v: WorkView, title: string): ReturnType<typeof waitingEntries>[number] | undefined {
  const cut = title.slice(0, 40);
  return waitingEntries(v.device).find((e) => e.item?.kind === "run" && e.item.next && e.item.title.includes(cut));
}

/** The buttons of one Next entry: Run, "Next in line — Start?", or a higher priority for a board item. */
function nextActions(v: WorkView, e: NextEntry, pcOf: Map<string, string>, first: boolean): HTMLElement | null {
  const d = v.device;
  if (e.from === "board") {
    const pc = d.presence.find((p) => p.id === pcOf.get(e.id));
    if (!pc) return null;
    return h("button", { type: "button", class: "btn sm-btn", disabled: !d.connected || !pc.online, title: L("עדיפות גבוהה יותר", "Higher priority"), onclick: () => void d.boardCommand(pc, e.id, { op: "raise" }).then((ok) => !ok && v.render()) }, `↑ p${e.priority ?? ""}`);
  }
  const t = v.tasks().find((x) => x.task.taskId === e.id)?.task;
  if (!t) return null;
  // The PC's own "Next in line: Start?" ask for the task at the head of the list.
  const ask = first ? nextInLineAsk(v, e.title) : undefined;
  if (ask?.item) {
    const a = ask.item;
    const go = runWithUndo(d, a.requestId, L("▶ הבא בתור: להתחיל?", "▶ Next in line: Start?"), () => void d.answerApproval(ask.pc.id, a, "allow"), { off: !d.connected });
    return h("span", { class: "row runacts" }, go);
  }
  if (d.runStarting(t)) return h("span", { class: "tag t-run runbtn" }, L("מתחיל…", "Starting…"));
  const sent = d.taskActions.get(t.taskId);
  if (sent && !sent.result) return h("span", { class: "tag t-run runbtn" }, L("נשלח למחשב…", "Sent to the PC…"));
  if (!d.canRun(t)) return null;
  return runWithUndo(d, t.taskId, L("▶ הרץ", "▶ Run"), () => void d.inboxCommand(t, "inbox-run"));
}

/** The Next list: waiting tasks by priority, numbered, with who takes each and its buttons. */
function nextList(v: WorkView, all: WorkTask[], board: HubBoardItem[], pcOf: Map<string, string>): HTMLElement | null {
  const list = nextEntries(all, board).filter((e) => passes({ worker: e.worker, ...(e.model ? { model: e.model } : {}), ...(e.kind ? { kind: e.kind } : {}) }, workState.filters));
  const key = "next";
  const open = expanded.has(key);
  const shown = open ? list : list.slice(0, FIRST_NEXT);
  return h(
    "section",
    { class: "card clip nextlist", "aria-label": L("הבא בתור", "Next in line") },
    h("div", { class: "row head wrap" }, h("b", null, L("⏭ הבא בתור", "⏭ Next in line")), h("span", { class: "tag t-off" }, String(list.length)), h("span", { class: "grow" }), runAllButton(v.device), h("span", { class: "mut xs" }, L("לפי עדיפות, ואז לפי סדר התור", "By priority, then queue order"))),
    shown.length
      ? h(
          "ol",
          { class: "nl" },
          shown.map((e, n) =>
            h(
              "li",
              { class: `nl-item${e.deferred ? " deferred" : ""}` },
              h("span", { class: "nl-n mono", "aria-hidden": "true" }, String(n + 1)),
              h(
                "div",
                { class: "grow min0" },
                h("div", { class: "wrapl nw-title", dir: "auto" }, e.title),
                h("div", { class: "row wrap xs mut nw-facts" }, h("span", null, L("יקח: ", "Takes: ") + workerName(e.worker)), e.model ? h("span", { class: "chip" }, e.model) : null, e.priority !== undefined ? h("span", { class: "mono" }, `p${e.priority}`) : null, e.estSteps ? h("span", null, stepText(undefined, e.estSteps)) : null, e.kind ? h("span", null, L(...KIND[e.kind])) : null, e.deferred ? h("span", { class: "tag t-ask" }, L("⏸ ממתין למכסה", "⏸ Waits for quota")) : e.needsRun ? h("span", { class: "tag t-ask" }, L("ממתין ל\"הפעל\"", "Waiting for Run")) : null),
              ),
              nextActions(v, e, pcOf, n === 0),
            ),
          ),
        )
      : h("div", { class: "trow mut sm" }, filtersOn(workState.filters) ? L("אין משימות כאלה בתור.", "Nothing in line matches.") : L("אין משימות בתור.", "Nothing is in line.")),
    list.length > FIRST_NEXT ? h("div", { class: "trow" }, h("button", { type: "button", class: "btn sm-btn", onclick: () => { if (open) expanded.delete(key); else expanded.add(key); v.render(); } }, open ? L("הצג פחות", "Show fewer") : L(`הצג הכול (${list.length})`, `Show all (${list.length})`))) : null,
  );
}

/** Rows of the Next list shown before "Show all" (a phone's screen is short). */
const FIRST_NEXT = 5;
const expanded = new Set<string>();

/**
 * The Now strip and the Next list.
 *
 * @param v - The page's parts.
 * @returns The two sections, or nothing when no PC is paired.
 */
export function nowNextSections(v: WorkView): Array<HTMLElement | null> {
  if (!v.device.presence.some((p) => p.kind === "pc")) return [];
  const all = v.tasks().map((x) => x.work);
  const { items, pcOf } = boardOf(v.device);
  return [nowStrip(v, all, items), nextList(v, all, items, pcOf)];
}

/** An agent chip (several can be on) with the number of tasks it would show. */
function whoChip(v: WorkView, w: string, n: number): HTMLElement {
  const f = workState.filters;
  const on = f.who.includes(w);
  return h("button", { type: "button", class: `chip${on ? " chip-on" : ""}`, "aria-pressed": String(on), onclick: () => setFilters(v, { ...f, who: on ? f.who.filter((x) => x !== w) : [...f.who, w] }) }, `${workerName(w)} ${n}`);
}

/**
 * The tabs Active · Done · Failed with their counts, and the filter chips (agent, kind, and a model menu). Counts and
 * chips follow the other filters, so a chip says how many it would show.
 *
 * @param v - The page's parts.
 * @param items - Every work task and run (all phases).
 * @returns The two rows.
 */
export function workTabs(v: WorkView, items: WorkTask[]): HTMLElement {
  const f = workState.filters;
  const inTab = (x: WorkTask, skip?: "who" | "model" | "kind") => passes(x, f, skip);
  const counts = phaseCounts(items.filter((x) => inTab(x)));
  const tab = (p: WorkPhase, he: string, en: string, cls: string) => h("button", { type: "button", role: "tab", class: `wtab ${cls}${workState.phase === p ? " on" : ""}`, "aria-selected": String(workState.phase === p), onclick: () => { workState.phase = p; v.render(); } }, `${L(he, en)} `, h("span", { class: "wcount" }, String(counts[p])));
  const ofPhase = items.filter((x) => x.phase === workState.phase);
  const present = [...new Set([...WORKERS, ...items.map((x) => x.worker)])].filter((w) => (WORKERS as readonly string[]).includes(w) ? w !== "claude" || items.some((x) => x.worker === "claude") : true);
  const kinds: HubWorkKind[] = ["research", "code", "conversion"];
  const models = modelsOf(items);
  return h(
    "div",
    { class: "worktabs" },
    h("div", { class: "row wtabs", role: "tablist", "aria-label": L("מצב המשימות", "Task state") }, tab("active", "פעילות", "Active", "w-active"), tab("done", "הושלמו", "Done", "w-done"), tab("failed", "נכשלו", "Failed", "w-failed")),
    h("div", { class: "row wrap filters wfilters", role: "group", "aria-label": L("סינון לפי מודל וסוכן", "Filter by agent and model") }, present.map((w) => whoChip(v, w, ofPhase.filter((x) => x.worker === w && inTab(x, "who")).length)), models.length ? h("select", { class: "inp wmodel", "aria-label": L("מודל", "Model"), onchange: (e: Event) => setFilters(v, { ...f, model: (e.target as HTMLSelectElement).value }) }, h("option", { value: "", selected: !f.model }, L("כל המודלים", "All models")), models.map((m) => h("option", { value: m, selected: m === f.model }, m))) : null),
    h("div", { class: "row wrap filters wfilters", role: "group", "aria-label": L("סינון לפי סוג", "Filter by kind") }, kinds.map((k) => { const on = f.kind === k; return h("button", { type: "button", class: `chip${on ? " chip-on" : ""}`, "aria-pressed": String(on), onclick: () => setFilters(v, { ...f, kind: on ? "" : k }) }, `${L(...KIND[k])} ${ofPhase.filter((x) => x.kind === k && inTab(x, "kind")).length}`); }), filtersOn(f) ? h("button", { type: "button", class: "link sm", onclick: () => setFilters(v, { ...NO_FILTERS, who: [] }) }, L("נקה סינון", "Clear filters")) : null),
  );
}

/** Done: the result line and where to open it. */
export function doneLine(t: PageTask): HTMLElement | null {
  const text = t.line;
  if (!text && !t.branch) return null;
  return h("div", { class: "sm wdone wrapl", dir: "auto" }, text ?? "", t.branch ? h("span", { class: "mono xs mut" }, ` ${t.branch}`) : null);
}

/**
 * Failed: the one-line cause, then Retry (the task again by the same worker) and Move to Antigravity (a sealed `assign`
 * command; the PC answers, or asks first when it must stop or rerun something).
 *
 * @param v - The page's parts.
 * @param t - The failed page task.
 * @param work - Its work task (the cause).
 * @returns The cause and buttons.
 */
export function failedBlock(v: WorkView, t: PageTask, work: WorkTask): HTMLElement {
  const d = v.device;
  const pcs = d.assignTargets(t);
  const sent = d.assignActions.get(t.taskId);
  const off = !d.connected || !pcs.length;
  const cur = t.inbox ? assignOfExecutor(t.inbox.executor === "claude" ? "opus" : t.inbox.executor) : undefined;
  const send = (to: Parameters<HubDevice["assign"]>[2]) => (e: Event) => { e.stopPropagation(); void d.assign(t.taskId, pcs, to).then(() => v.render()); };
  const answer = !sent ? null : !sent.result ? h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…")) : sent.result.ask ? h("div", { class: "stack assign-ask", onclick: (e: Event) => e.stopPropagation() }, h("span", { class: "sm warn wrapl", dir: "auto" }, L(assignQuestion(sent.result.ask, sent.to).he, assignQuestion(sent.result.ask, sent.to).en)), h("div", { class: "row wrap" }, h("button", { type: "button", class: "btn sm-btn pri", disabled: off, onclick: (e: Event) => { e.stopPropagation(); void d.assign(t.taskId, pcs.filter((p) => sent.pcs.includes(p.id)), sent.to, true).then(() => v.render()); } }, L("כן", "Yes")), h("button", { type: "button", class: "btn sm-btn", onclick: (e: Event) => { e.stopPropagation(); d.assignActions.delete(t.taskId); v.render(); } }, L("לא", "No")))) : h("span", { class: `xs ${sent.result.ok ? "mut" : "warn"} wrapl`, dir: "auto" }, sent.result.text);
  return h(
    "div",
    { class: "wfail stack" },
    h("div", { class: "sm warn wrapl", dir: "auto" }, work.expired ? L("לא נמסרה בזמן (פג תוקף).", "Not delivered in time (expired).") : work.cause || L("נכשלה, בלי סיבה מהמחשב.", "Failed, with no cause from the PC.")),
    t.inbox
      ? h("div", { class: "row wrap" }, cur ? h("button", { type: "button", class: "btn sm-btn pri", disabled: off, onclick: send(cur) }, L("↻ נסה שוב", "↻ Retry")) : null, cur !== "antigravity" ? h("button", { type: "button", class: "btn sm-btn", disabled: off, onclick: send("antigravity") }, L("✦ העבר ל-Antigravity", "✦ Move to Antigravity")) : null, answer)
      : null,
  );
}

// ---- tasks that end while the owner looks ----

/** How long an ended task stays (shown as done or failed) before it folds away (ms); the fold itself is 0.4 s of it. */
const LEAVE_MS = 1600;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the Active list showed at the last draw, and the rows folding away. */
const seen: { key: string; rows: Map<string, { group: string; index: number; build: () => HTMLElement }>; leaving: Map<string, { until: number; group: string; index: number; build: () => HTMLElement }> } = { key: "", rows: new Map(), leaving: new Map() };

/**
 * Keeps the rows that ended since the last draw of the same Active list for {@link LEAVE_MS}, so each folds away in
 * place instead of the list jumping under the finger. A change of tab, filter or search starts fresh.
 *
 * @param key - What the list shows (tab, filters, search).
 * @param rows - The rows now: id, group, build.
 * @param render - Redraws the page (when a fold ends).
 * @returns The rows that are folding away, with the index they had in their group.
 */
export function foldingRows(key: string, rows: Array<{ id: string; group: string; build: () => HTMLElement }>, render: () => void): Array<{ id: string; group: string; index: number; build: () => HTMLElement }> {
  const now = Date.now();
  const cur = new Map<string, { group: string; index: number; build: () => HTMLElement }>();
  const perGroup = new Map<string, number>();
  for (const r of rows) {
    const index = perGroup.get(r.group) ?? 0;
    perGroup.set(r.group, index + 1);
    cur.set(r.id, { group: r.group, index, build: r.build });
  }
  if (seen.key !== key || reduced()) {
    seen.key = key;
    seen.rows = cur;
    seen.leaving.clear();
    return [];
  }
  for (const id of leavers(new Set(seen.rows.keys()), new Set(cur.keys()))) {
    if (seen.leaving.has(id)) continue;
    const old = seen.rows.get(id)!;
    seen.leaving.set(id, { until: now + LEAVE_MS, ...old });
    setTimeout(render, LEAVE_MS + 20);
  }
  seen.rows = cur;
  for (const [id, l] of seen.leaving) if (l.until <= now || cur.has(id)) seen.leaving.delete(id);
  return [...seen.leaving].map(([id, l]) => ({ id, ...l }));
}

/**
 * A row that is folding away: the row as it was (it shows its new state), not clickable, folding after a moment.
 *
 * @param el - The row.
 * @returns The wrapper.
 */
export function leavingRow(el: HTMLElement): HTMLElement {
  return h("div", { class: "leaving", "aria-hidden": "true", inert: true }, h("div", { class: "leaving-in" }, el));
}
