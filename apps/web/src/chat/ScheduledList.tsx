/**
 * Scheduled tasks (the model's `schedule_task`, packages/core/src/chat-schedule.ts): the "Scheduled" list in a chat's
 * header menu and the Settings › Scheduled page. Both read /api/scheduled, so the phone (remote) shows the same list.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { Menu, MenuItem, MenuLabel } from "../ui/Menu";
import { LineIcon } from "../ui/Glyph";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One scheduled task as the computer lists it. */
export interface ScheduledItem {
  id: string;
  convId: string;
  convTitle: string;
  name: string;
  prompt: string;
  /** The schedule in the fixed grammar ("daily 08:30"). */
  when: string;
  /** Next run (ms). */
  due: number;
  paused?: boolean;
  newChat?: boolean;
  lastRun?: number;
  lastResult?: string;
}

const DAYS_HE: Record<string, string> = { sun: "ראשון", mon: "שני", tue: "שלישי", wed: "רביעי", thu: "חמישי", fri: "שישי", sat: "שבת" };

/** @returns The schedule in words ("every day 08:30", "כל יום 08:30"). */
export function describeWhen(when: string): string {
  const he = getLocale() === "he";
  let m: RegExpExecArray | null;
  if ((m = /^daily (\S+)$/.exec(when))) return he ? `כל יום ${m[1]}` : `every day ${m[1]}`;
  if ((m = /^weekdays (\S+)$/.exec(when))) return he ? `ימי חול ${m[1]}` : `weekdays ${m[1]}`;
  if ((m = /^weekly (\w+) (\S+)$/.exec(when))) return he ? `כל יום ${DAYS_HE[m[1]!] ?? m[1]} ${m[2]}` : `every ${m[1]} ${m[2]}`;
  if ((m = /^every (\d+) hours$/.exec(when))) return he ? `כל ${m[1]} שעות` : `every ${m[1]} h`;
  return new Date(when).toLocaleString(he ? "he-IL" : undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** @returns A time as "today 08:30" / "Mon 08:30" in the interface language. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `${L("היום", "today")} ${time}`;
  return `${d.toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** @returns "OK" / "Late" / "Failed" for a last result. */
function resultText(r?: string): string {
  if (!r) return L("עוד לא רץ", "not run yet");
  if (r === "ok") return L("הצליח", "ran");
  if (r === "late") return L("רץ באיחור", "ran late");
  return L("נכשל", "failed");
}

/**
 * The scheduled tasks of one chat (or all), kept fresh, with the actions.
 *
 * @param convId - A chat's id; none for all of them.
 */
export function useScheduled(convId?: string) {
  const [items, setItems] = useState<ScheduledItem[] | undefined>();
  const load = useCallback(
    () => void api<{ scheduled: ScheduledItem[] }>(`/api/scheduled${convId ? `?conv=${encodeURIComponent(convId)}` : ""}`).then((r) => setItems(r.scheduled), () => undefined),
    [convId],
  );
  useEffect(() => {
    const tick = () => !document.hidden && load();
    load();
    const t = window.setInterval(tick, 30_000);
    addEventListener("focus", tick);
    return () => (window.clearInterval(t), removeEventListener("focus", tick));
  }, [load]);
  /** Pause, resume, run now or delete one; then look again. */
  const act = (id: string, action: "pause" | "resume" | "run" | "delete") =>
    void (action === "delete" ? api(`/api/scheduled/${encodeURIComponent(id)}`, { method: "DELETE" }) : api(`/api/scheduled/${encodeURIComponent(id)}/${action}`, { method: "POST" })).then(
      () => (action === "run" && toast(L("רץ עכשיו", "Running now")), load()),
      (e: Error) => toast(e.message),
    );
  return { items, act };
}

/**
 * The chat header's "Scheduled" list, next to the timers' bell: shown only when the chat has scheduled tasks.
 *
 * @param props.convId - The chat.
 */
export function ScheduledButton({ convId }: { convId: string }) {
  const { items, act } = useScheduled(convId);
  if (!items?.length) return null;
  return (
    <Menu
      trigger={<><LineIcon name="calendar" size={16} /> {items.length}</>}
      triggerClassName="pane-btn scheduled-btn"
      title={L("משימות מתוזמנות בצ'אט הזה", "Scheduled tasks in this chat")}
      aria-label={L("משימות מתוזמנות", "Scheduled tasks")}
      popClassName="bar-pop"
    >
      <MenuLabel>{L("משימות מתוזמנות", "Scheduled")}</MenuLabel>
      {items.map((x) => (
        <MenuItem key={x.id} keepOpen icon={<LineIcon name={x.paused ? "play" : "stop"} size={14} />} title={x.paused ? L("המשך", "Resume") : L("השהיה", "Pause")} end={x.paused ? L("מושהה", "paused") : stamp(x.due)} onSelect={() => act(x.id, x.paused ? "resume" : "pause")} dir="auto">
          {x.name} · {describeWhen(x.when)}
        </MenuItem>
      ))}
      <MenuItem href="#/settings/scheduled" icon={<LineIcon name="calendar" size={14} />}>
        {L("כל המשימות המתוזמנות", "All scheduled tasks")}
      </MenuItem>
    </Menu>
  );
}

/**
 * Settings › Scheduled: every scheduled task (name, chat, next run, last result) with Pause / Resume / Run now / Delete.
 * Works on the phone too (the buttons wrap under the name).
 */
export function ScheduledSection() {
  const { items, act } = useScheduled();
  const [sure, setSure] = useState<string>();
  return (
    <section className="card scheduled-page">
      <h3>{L("משימות מתוזמנות", "Scheduled tasks")}</h3>
      <p className="muted small">{L("משימות שביקשת מצ'אט (\"כל בוקר…\"): בכל פעם הן רצות בצ'אט ומעדכנות את הטלפון בסיום. אם המחשב היה כבוי הן רצות פעם אחת כשהוא עולה.", "Tasks you asked a chat for (\"every morning…\"): each run is a turn in the chat, and the phone is told when it ends. If the computer was off they run once when it starts.")}</p>
      {items && !items.length && <p className="muted">{L("אין משימות מתוזמנות. בקש מצ'אט: \"כל בוקר ב-8:30 סכם לי את החדשות\".", "Nothing scheduled. Ask a chat: \"every morning at 8:30 summarise the news\".")}</p>}
      {items?.map((x) => (
        <div key={x.id} className="scheduled-row" data-paused={x.paused ? "1" : undefined}>
          <div className="scheduled-main">
            <b dir="auto">{x.name}</b>
            <span className="muted small"> · {describeWhen(x.when)}{x.newChat ? ` · ${L("צ'אט חדש בכל פעם", "new chat each time")}` : ""}</span>
            <div className="small muted" dir="auto">
              <a href={`#/c/${x.convId}`}>{x.convTitle || L("צ'אט", "Chat")}</a>
              {" · "}
              {x.paused ? L("מושהה", "paused") : `${L("הבא", "next")}: ${stamp(x.due)}`}
              {" · "}
              {L("אחרון", "last")}: {resultText(x.lastResult)}{x.lastRun ? ` (${stamp(x.lastRun)})` : ""}
            </div>
          </div>
          <div className="scheduled-actions">
            <button type="button" onClick={() => act(x.id, x.paused ? "resume" : "pause")}>{x.paused ? L("המשך", "Resume") : L("השהיה", "Pause")}</button>
            <button type="button" onClick={() => act(x.id, "run")}>{L("הרץ עכשיו", "Run now")}</button>
            <button type="button" className="danger" onClick={() => (sure === x.id ? (setSure(undefined), act(x.id, "delete")) : setSure(x.id))}>
              {sure === x.id ? L("בטוח? מחיקה", "Sure? Delete") : L("מחיקה", "Delete")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
