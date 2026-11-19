/**
 * The agents view of the hub page and of the phone's Cloud tab (the same page): every agent run of the owner's PCs,
 * live (docs/RESEARCH_LOG.md, "Live agent activity in the Kesher Cloud hub", plan step 5). Layout: the design doc's
 * HubAgents / HubAgentDetail and PhoneHubAgents / PhoneHubAgentDetail boards.
 *
 * - List: waiting runs pinned on top ("waiting for you"), then one group per device (PC on or off, last seen), and
 *   Claude cloud runs from this device's own task list. Each card: state dot, title, source, current step, elapsed,
 *   steps, tokens when known.
 * - Detail: the step timeline (newest first), files touched, and the buttons: Stop (a sealed `cancel`), Approve /
 *   Deny / Run (the sealed `approval_answer`), Open in Claude for a cloud run.
 *
 * Everything shown came sealed from the PC (titles, steps, tool names, counts); the hub cannot read it.
 */
import { isGoing, shownState, sortedCards, type AgentCard } from "../../../packages/shared/src/hub-agents.js";
import { isSafeLink, type ActivityEvent, type AgentRunStateName, type AgentSource, type HubPresence } from "../../../packages/shared/src/hub-protocol.js";
import { h, L, when } from "./dom.js";
import type { HubDevice, PageTask } from "./device.js";

/** What the agents view needs from the page. */
export interface AgentsView {
  device: HubDevice;
  devices: () => HubPresence[];
  /** The open card's key, or a cloud task's `cloud:<taskId>`. */
  open: string | undefined;
  setOpen: (key: string | undefined) => void;
  render: () => void;
}

const STATE: Record<AgentRunStateName, { dot: string; tag: string; he: string; en: string }> = {
  queued: { dot: "off", tag: "t-off", he: "בתור", en: "Queued" },
  running: { dot: "on", tag: "t-run", he: "רץ", en: "Running" },
  waiting: { dot: "ask", tag: "t-ask", he: "מחכה לך", en: "Waiting for you" },
  done: { dot: "on", tag: "t-ok", he: "✓ הסתיים", en: "✓ Done" },
  failed: { dot: "bad", tag: "t-bad", he: "✕ נכשל", en: "✕ Failed" },
  cancelled: { dot: "off", tag: "t-off", he: "נעצר", en: "Stopped" },
  stale: { dot: "busy", tag: "t-wait", he: "לא עונה", en: "Not answering" },
};

const SOURCE: Record<AgentSource, { icon: string; he: string; en: string }> = {
  "chat-helper": { icon: "🤖", he: "סוכן עוזר בצ׳אט", en: "Chat helper" },
  inbox: { icon: "📥", he: "תיבת משימות", en: "Task inbox" },
  antigravity: { icon: "✦", he: "Antigravity", en: "Antigravity" },
  "claude-cloud": { icon: "✷", he: "Claude בענן", en: "Claude cloud" },
};

const OP: Record<string, [string, string]> = { read: ["קרא", "read"], edit: ["ערך", "edited"], create: ["יצר", "created"], delete: ["מחק", "deleted"] };

/** A duration as `m:ss` or `h:mm:ss`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** A state tag (with a spinner while running). */
function stateTag(st: AgentRunStateName): HTMLElement {
  const s = STATE[st];
  return h("span", { class: `tag ${s.tag}` }, st === "running" ? h("span", { class: "spin", "aria-hidden": "true" }) : null, L(s.he, s.en));
}

/** The short facts line of a run: step, elapsed, tokens, files. */
function facts(c: AgentCard, now: number): string {
  const s = c.state;
  const end = s.endedAt ?? (isGoing(c) ? now : s.lastEventAt);
  return [
    s.of ? L(`צעד ${s.step}/${s.of}`, `step ${s.step}/${s.of}`) : s.step ? L(`צעד ${s.step}`, `step ${s.step}`) : "",
    s.startedAt ? `⏱ ${duration(end - s.startedAt)}` : "",
    s.tokensIn !== undefined ? L(`${tokens(s.tokensIn + (s.tokensOut ?? 0))} טוקנים`, `${tokens(s.tokensIn + (s.tokensOut ?? 0))} tokens`) : "",
    s.files ? L(`${s.files} קבצים`, `${s.files} files`) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a waiting run waits for, in words. */
function waitText(c: AgentCard): string {
  const w = c.state.waiting;
  if (!w) return "";
  if (w.reason === "run-press") return L("מחכה ללחיצה על הרצה ב-Antigravity", "Waiting for Run in Antigravity");
  if (w.reason === "approval") return L(`מבקש אישור: ${w.summary}`, `Asks for approval: ${w.summary}`);
  return w.summary ? L(`שואל: ${w.summary}`, `Asks: ${w.summary}`) : L("מחכה לתשובה שלך", "Waiting for your answer");
}

/** The buttons of a run: answer what it waits for, or Stop. Disabled while its PC is off. */
function actions(v: AgentsView, c: AgentCard, pc: HubPresence | undefined): HTMLElement | null {
  const key = `${c.deviceId}/${c.runId}`;
  const sent = v.device.agentActions.get(key);
  if (sent) return h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…"));
  if (!isGoing(c)) return null;
  const off = !pc?.online || !v.device.connected;
  const btn = (label: string, cls: string, run: () => Promise<boolean>) =>
    h("button", { type: "button", class: `btn sm-btn ${cls}`, disabled: off, onclick: (e: Event) => { e.stopPropagation(); void run().then((ok) => !ok && v.render()); } }, label);
  const w = c.state.state === "waiting" ? c.state.waiting : undefined;
  const answer = w
    ? w.reason === "run-press"
      ? [btn(L("▶ הרץ", "▶ Run"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("לא עכשיו", "Not now"), "", () => v.device.answerAgent(c, "deny"))]
      : w.reason === "ask"
        ? [btn(L("כן", "Yes"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("לא", "No"), "", () => v.device.answerAgent(c, "deny"))]
        : [btn(L("✓ אשר", "✓ Approve"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("דחה", "Deny"), "", () => v.device.answerAgent(c, "deny"))]
    : [];
  const stop = btn(L("■ עצור", "■ Stop"), "bad", async () => (confirm(L(`לעצור את "${c.state.title}"?`, `Stop "${c.state.title}"?`)) ? v.device.stopAgent(c) : true));
  return h("div", { class: "row wrap acts" }, ...answer, stop, off ? h("span", { class: "mut xs" }, L("המחשב כבוי", "The PC is off")) : null);
}

/** One card of the list. */
function card(v: AgentsView, c: AgentCard, now: number, pc: HubPresence | undefined): HTMLElement {
  const st = shownState(c, now);
  const src = SOURCE[c.state.source];
  const key = `${c.deviceId}/${c.runId}`;
  const line = st === "waiting" ? waitText(c) : st === "stale" ? L(`אין דופק מ-${when(c.at)}`, `No heartbeat since ${when(c.at)}`) : c.state.label && isGoing(c) ? L(`עכשיו: ${c.state.label}`, `Now: ${c.state.label}`) : "";
  return h(
    "div",
    { class: `acard${st === "waiting" ? " wait" : ""}`, role: "button", tabindex: 0, "aria-label": c.state.title, onclick: () => v.setOpen(key), onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && v.setOpen(key) },
    h("div", { class: "row" }, h("span", { class: `dot ${STATE[st].dot}`, "aria-hidden": "true" }), h("b", { class: "grow ell1" }, c.state.title), stateTag(st)),
    h("div", { class: "row wrap mut sm" }, h("span", { title: L(src.he, src.en) }, `${src.icon} ${L(src.he, src.en)}`), c.state.model ? h("span", { class: "chip" }, c.state.model) : null, h("span", { class: "grow" }), h("span", { class: "mono xs" }, facts(c, now))),
    line ? h("div", { class: `sm ell${st === "waiting" ? " warn" : ""}` }, line) : null,
    st === "waiting" ? actions(v, c, pc) : null,
  );
}

/** Claude cloud runs this device started (from its own task list): the hub fired them, so only "started" is known. */
function cloudTasks(v: AgentsView, now: number): PageTask[] {
  return v.device.tasks.filter((t) => t.route === "claude-cloud" && t.status !== "outbox" && now - t.createdAt < 7 * 86_400_000);
}

function cloudCard(v: AgentsView, t: PageTask): HTMLElement {
  const st = t.status === "done" ? "done" : t.status === "failed" || t.status === "blocked" ? "failed" : t.status === "cancelled" ? "cancelled" : undefined;
  return h(
    "div",
    { class: "acard", role: "button", tabindex: 0, "aria-label": t.title, onclick: () => v.setOpen(`cloud:${t.taskId}`), onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && v.setOpen(`cloud:${t.taskId}`) },
    h("div", { class: "row" }, h("span", { class: `dot ${st ? STATE[st].dot : "busy"}`, "aria-hidden": "true" }), h("b", { class: "grow ell1" }, t.title), st ? stateTag(st) : h("span", { class: "tag t-off" }, L("מצב לא ידוע", "Status unknown"))),
    h("div", { class: "row wrap mut sm" }, h("span", null, `✷ ${L("Claude בענן", "Claude cloud")}`), h("span", { class: "grow" }), h("span", { class: "xs" }, L("התחיל ", "Started ") + when(t.createdAt))),
    h("div", { class: "row wrap" }, h("span", { class: "sm mut grow" }, L("רץ ב-Claude. פתחו כדי לצפות.", "Runs in Claude. Open it to watch.")), t.link && isSafeLink(t.link) ? h("a", { class: "btn sm-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", onclick: (e: Event) => e.stopPropagation() }, L("פתח ב-Claude ↗", "Open in Claude ↗")) : null),
  );
}

/** A device's group header: name, on/off, last seen. */
function groupHead(name: string, icon: string, pc: HubPresence | undefined, count: number): HTMLElement {
  const on = pc?.online;
  return h(
    "div",
    { class: "row head wrap" },
    h("span", { "aria-hidden": "true" }, icon),
    h("b", null, name),
    pc ? h("span", { class: `dot ${on ? (pc.busy ? "busy" : "on") : "off"}`, "aria-hidden": "true" }) : null,
    pc ? h("span", { class: `sm ${on ? "ok" : "mut"}` }, on ? L("מחובר", "Online") : L("כבוי", "Off") + (pc.lastSeen ? L(" · נראה לאחרונה ", " · last seen ") + when(pc.lastSeen) : "")) : null,
    h("span", { class: "grow" }),
    h("span", { class: "tag t-off" }, String(count)),
  );
}

/**
 * The agents list (HubAgents / PhoneHubAgents), or the open run's detail.
 *
 * @param v - The page's device, devices and open card.
 * @returns The tab's content.
 */
export function agentsTab(v: AgentsView): HTMLElement {
  const now = Date.now();
  const open = v.open;
  if (open?.startsWith("cloud:")) {
    const t = v.device.tasks.find((x) => x.taskId === open.slice(6));
    if (t) return cloudDetail(v, t);
  } else if (open) {
    const c = v.device.agents.get(open);
    if (c) return agentDetail(v, c, now);
  }
  const cards = sortedCards(v.device.agents.values(), now);
  const pcOf = (id: string) => v.devices().find((d) => d.id === id);
  const waiting = cards.filter((c) => c.state.state === "waiting");
  const rest = cards.filter((c) => c.state.state !== "waiting");
  const going = cards.filter(isGoing).length;
  const pcs = v.devices().filter((d) => d.kind === "pc");
  const ids = [...new Set([...pcs.map((d) => d.id), ...rest.map((c) => c.deviceId)])];
  const cloud = cloudTasks(v, now);
  const empty = !cards.length && !cloud.length;
  return h(
    "main",
    { class: "page" },
    h("div", { class: "row wrap" }, h("h1", null, L("סוכנים", "Agents")), h("span", { class: "mut" }, L(`· ${going} פעילים${waiting.length ? ` · ${waiting.length} מחכים לך` : ""}`, `· ${going} active${waiting.length ? ` · ${waiting.length} waiting for you` : ""}`)), h("span", { class: "grow" }), v.device.connected ? h("span", { class: "chip" }, h("span", { class: "dot on", "aria-hidden": "true" }), L(" חי", " Live")) : h("span", { class: "chip" }, h("span", { class: "dot off", "aria-hidden": "true" }), L(" לא מחובר", " Not connected"))),
    h("div", { class: "relay" }, "🔐 ", h("span", null, L("נעול במחשב: כותרות, צעדים ושמות כלים בלבד. בלי הנחיות, בלי תוכן קבצים ובלי תשובות. המרכז שומר 50 אירועים אחרונים לכל סוכן, 7 ימים.", "Sealed on the PC: titles, steps and tool names only. No prompts, file contents or answers. The hub keeps the last 50 events per agent, 7 days."))),
    waiting.length ? h("section", { class: "card clip pin" }, h("div", { class: "row head" }, h("b", null, L("⏳ מחכים לך", "⏳ Waiting for you")), h("span", { class: "grow" }), h("span", { class: "tag t-ask" }, String(waiting.length))), h("div", { class: "alist" }, waiting.map((c) => card(v, c, now, pcOf(c.deviceId))))) : null,
    ...ids.map((id) => {
      const pc = pcOf(id);
      const list = rest.filter((c) => c.deviceId === id);
      return h(
        "section",
        { class: "card clip" },
        groupHead(pc?.name ?? L("מחשב", "PC"), "🖥", pc, list.length),
        list.length ? h("div", { class: "alist" }, list.map((c) => card(v, c, now, pc))) : h("div", { class: "trow mut sm" }, pc && !pc.optIn.reportActivity ? L("המחשב הזה לא משתף פעילות סוכנים. במחשב: הגדרות › ענן Kesher › לשתף מה הסוכנים עושים.", "This PC does not share agent activity. On the PC: Settings › Kesher Cloud › Share what the agents do.") : L("אין סוכנים פעילים עכשיו.", "No agents running now.")),
      );
    }),
    cloud.length ? h("section", { class: "card clip" }, groupHead(L("Claude בענן", "Claude cloud"), "✷", undefined, cloud.length), h("div", { class: "alist" }, cloud.map((t) => cloudCard(v, t)))) : null,
    empty && !pcs.length ? h("p", { class: "mut sm" }, L("עוד אין מחשבים מחוברים. לשונית חיבור ›", "No PCs are paired yet. Pair tab ›")) : null,
  );
}

/** One timeline row. */
function eventRow(e: ActivityEvent): HTMLElement {
  const [icon, text]: [string, string] = (() => {
    switch (e.type) {
      case "started":
        return ["▶", L(`התחיל · ${SOURCE[e.source].he}${e.model ? ` · ${e.model}` : ""}`, `Started · ${SOURCE[e.source].en}${e.model ? ` · ${e.model}` : ""}`)];
      case "step":
        return ["•", L(`צעד ${e.n}${e.of ? `/${e.of}` : ""}${e.label ? ` · ${e.label}` : ""}`, `Step ${e.n}${e.of ? `/${e.of}` : ""}${e.label ? ` · ${e.label}` : ""}`)];
      case "tool":
        return [e.ok ? "🔧" : "⚠", `${e.name}${e.ms !== undefined ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}`];
      case "file":
        return ["📄", `${L(...(OP[e.op] ?? OP.read!))} ${e.path}`];
      case "usage":
        return ["Σ", L(`${tokens(e.tokensIn)} נכנסו · ${tokens(e.tokensOut)} יצאו`, `${tokens(e.tokensIn)} in · ${tokens(e.tokensOut)} out`)];
      case "waiting":
        return ["⏳", e.reason === "run-press" ? L("מחכה להרצה", "Waiting for Run") : L(`מחכה: ${e.summary}`, `Waiting: ${e.summary}`)];
      case "done":
        return ["✓", L(`הסתיים · ${e.steps} צעדים${e.branch ? ` · ${e.branch}` : ""}`, `Done · ${e.steps} steps${e.branch ? ` · ${e.branch}` : ""}`)];
      case "failed":
        return ["✕", L(`נכשל${e.reason ? ` · ${e.reason}` : ""}`, `Failed${e.reason ? ` · ${e.reason}` : ""}`)];
      case "cancelled":
        return ["■", L("נעצר", "Stopped")];
    }
  })();
  return h("li", { class: `tl-${e.type}` }, h("span", { class: "tl-ic", "aria-hidden": "true" }, icon), h("span", { class: "grow min0 ell" }, text), h("span", { class: "mut xs mono" }, new Date(e.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
}

const back = (v: AgentsView) => h("button", { type: "button", class: "link back", onclick: () => v.setOpen(undefined) }, L("› כל הסוכנים", "‹ All agents"));

/** One run's detail (HubAgentDetail / PhoneHubAgentDetail). */
function agentDetail(v: AgentsView, c: AgentCard, now: number): HTMLElement {
  const st = shownState(c, now);
  const s = c.state;
  const pc = v.devices().find((d) => d.id === c.deviceId);
  const src = SOURCE[s.source];
  const fact = (he: string, en: string, value: string) => h("div", { class: "card stat" }, h("b", null, value), h("div", { class: "mut xs" }, L(he, en)));
  const end = s.endedAt ?? (isGoing(c) ? now : s.lastEventAt);
  return h(
    "main",
    { class: "page" },
    back(v),
    h("div", { class: "row wrap" }, h("span", { class: `dot ${STATE[st].dot}`, "aria-hidden": "true" }), h("h1", { class: "grow" }, s.title), stateTag(st)),
    h("div", { class: "row wrap mut sm" }, `${src.icon} ${L(src.he, src.en)}`, " · ", `🖥 ${pc?.name ?? L("מחשב", "PC")}`, s.model ? h("span", { class: "chip" }, s.model) : null, " · ", L("התחיל ", "started ") + when(s.startedAt)),
    st === "waiting" ? h("section", { class: "card pad stack pin" }, h("b", { class: "warn" }, waitText(c)), actions(v, c, pc)) : st === "stale" ? h("div", { class: "note bad-note" }, L(`לא הגיע דופק מהסוכן מאז ${when(c.at)}. ייתכן שנתקע או שהמחשב נרדם.`, `No heartbeat from the agent since ${when(c.at)}. It may be stuck, or the PC is asleep.`)) : null,
    st !== "waiting" ? actions(v, c, pc) : null,
    h(
      "div",
      { class: "grid4" },
      fact("צעדים", "Steps", s.of ? `${s.step}/${s.of}` : String(s.step)),
      fact("זמן", "Elapsed", s.startedAt ? duration(end - s.startedAt) : "–"),
      fact("טוקנים", "Tokens", s.tokensIn !== undefined ? tokens(s.tokensIn + (s.tokensOut ?? 0)) : "–"),
      fact("קבצים", "Files", String(s.files)),
    ),
    s.label && isGoing(c) ? h("div", { class: "sm" }, L("עכשיו: ", "Now: "), h("span", { class: "mono" }, s.label)) : null,
    s.fileNames.length ? h("section", { class: "sec" }, h("h3", { class: "sm" }, L(`קבצים שנגעו בהם (${s.files})`, `Files touched (${s.files})`)), h("ul", { class: "files" }, s.fileNames.map((f) => h("li", { class: "mono xs ell", dir: "ltr" }, f)))) : s.files ? h("div", { class: "mut sm" }, L(`נגע ב-${s.files} קבצים (השמות לא משותפים; במחשב: הגדרות › ענן Kesher).`, `Touched ${s.files} files (names are not shared; on the PC: Settings › Kesher Cloud).`)) : null,
    s.branch ? h("div", { class: "sm" }, L("ענף ", "Branch "), h("span", { class: "mono", dir: "ltr" }, s.branch)) : null,
    s.link && isSafeLink(s.link) ? h("a", { class: "btn", href: s.link, target: "_blank", rel: "noopener noreferrer" }, L("פתח ↗", "Open ↗")) : null,
    h(
      "section",
      { class: "card clip" },
      h("div", { class: "row head" }, h("b", null, L("ציר זמן", "Timeline")), h("span", { class: "grow" }), h("span", { class: "mut xs" }, L(`${c.events.length} אחרונים`, `last ${c.events.length}`))),
      c.events.length ? h("ul", { class: "tl" }, [...c.events].reverse().map(eventRow)) : h("div", { class: "trow mut sm" }, L("האירועים הקודמים כבר לא שמורים במרכז.", "Earlier events are no longer kept at the hub.")),
    ),
  );
}

/** A Claude cloud run's detail: started, the link, and an honest "status unknown". */
function cloudDetail(v: AgentsView, t: PageTask): HTMLElement {
  return h(
    "main",
    { class: "page" },
    back(v),
    h("div", { class: "row wrap" }, h("span", { "aria-hidden": "true" }, "✷"), h("h1", { class: "grow" }, t.title), h("span", { class: "tag t-off" }, L("מצב לא ידוע", "Status unknown"))),
    h("div", { class: "mut sm" }, L("התחיל ", "Started ") + when(t.createdAt), " · ", L("Claude בענן", "Claude cloud")),
    h("section", { class: "card pad stack" }, h("span", { class: "sm" }, L("המרכז רק הפעיל את המשימה ב-Claude. Claude לא מדווח מצב חי למרכז, אז את ההתקדמות רואים בשיחה עצמה.", "The hub only started the task in Claude. Claude does not report live status to the hub, so the progress is seen in the session itself.")), t.link && isSafeLink(t.link) ? h("a", { class: "btn pri", href: t.link, target: "_blank", rel: "noopener noreferrer" }, L("פתח ב-Claude ↗", "Open in Claude ↗")) : h("span", { class: "mut sm" }, L("אין קישור לשיחה.", "No session link."))),
    h("div", { class: "pl" }, t.history.map((x) => `${when(x.t)} ${L(x.he, x.en)}`).join(" · ")),
  );
}

/**
 * A short "agents now" block for the dashboard: what waits, then what runs (at most 3).
 *
 * @param v - The view.
 * @returns The block, or null when nothing is going.
 */
export function agentsSummary(v: AgentsView): HTMLElement | null {
  const now = Date.now();
  const going = sortedCards(v.device.agents.values(), now).filter(isGoing);
  if (!going.length) return null;
  return h(
    "section",
    { class: "card clip" },
    h("div", { class: "row head" }, h("b", null, L("סוכנים עכשיו", "Agents now")), h("span", { class: "tag t-run" }, String(going.length)), h("span", { class: "grow" }), h("a", { class: "mut sm", href: "#agents" }, L("הכול ›", "All ›"))),
    going.slice(0, 3).map((c) => {
      const st = shownState(c, now);
      return h("a", { class: "trow sm", href: "#agents", onclick: () => v.setOpen(`${c.deviceId}/${c.runId}`) }, h("span", { class: `dot ${STATE[st].dot}`, "aria-hidden": "true" }), h("span", { class: "grow ell" }, c.state.title), stateTag(st));
    }),
  );
}
