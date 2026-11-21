import { useEffect, useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from "./ui/Menu";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** GET /api/comfy/live (packages/core/src/comfy-live.ts). */
interface Live {
  installed: boolean;
  up: boolean;
  managed: boolean;
  phase?: "installing" | "starting" | "error";
  running: number;
  pending: number;
}

/**
 * In every chat box: ComfyUI's state (up, starting, off) and its queue, live while the page is shown (one small
 * call every 5 s, none while the page is hidden). Start or stop it from the menu, also from the phone. Shown only
 * when ComfyUI is installed or answers on its port, so a computer without it sees nothing.
 */
export function ComfyChip() {
  const [st, setSt] = useState<Live | null>(null);
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const load = () => void api<Live>("/api/comfy/live").then(setSt, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open]);
  if (!st || (!st.installed && !st.up)) return null;
  const jobs = st.running + st.pending;
  const act = (what: "start" | "stop") => {
    setActing(true);
    void api(`/api/comfy/${what}`, { method: "POST" })
      .then(() => toast(what === "start" ? L("ComfyUI עולה…", "Starting ComfyUI…") : L("ComfyUI נעצר", "ComfyUI stopped")), (e: Error) => toast(e.message))
      .finally(() => { setActing(false); load(); });
  };
  const state = st.up
    ? jobs ? L(`🟢 פועל · ${st.running} רץ, ${st.pending} ממתינים`, `🟢 Running · ${st.running} running, ${st.pending} waiting`) : L("🟢 פועל, פנוי", "🟢 Running, idle")
    : st.phase === "starting" ? L("⏳ עולה…", "⏳ Starting…")
    : st.phase === "installing" ? L("⏳ מותקן…", "⏳ Installing…")
    : st.phase === "error" ? L("⚠ נכשל בפעם האחרונה", "⚠ Failed last time")
    : L("כבוי", "Off");
  return (
    <Menu
      className="model-menu comfy-chip"
      triggerClassName="model-chip"
      aria-label="ComfyUI"
      title={L("ComfyUI: מצב ותור", "ComfyUI: state and queue")}
      open={open}
      onOpenChange={setOpen}
      trigger={<><span className={`where-dot ${st.up ? "local" : "off"}`} aria-hidden="true" />🎨<span className="comfy-name"> ComfyUI</span>{jobs ? <span className="comfy-jobs" aria-label={L(`${jobs} עבודות`, `${jobs} jobs`)}> · {jobs}</span> : null}</>}
    >
      <MenuLabel end={<span className="muted small" aria-live="polite">{state}</span>}>ComfyUI</MenuLabel>
      <MenuNote>{st.up ? L("תמונות, וידאו, סאונד ותלת־ממד מהצ'אט עוברים דרכו.", "Pictures, video, sound and 3D from the chat go through it.") : L("כבוי: עבודת מדיה מהצ'אט תפעיל אותו לבד, או הפעילו עכשיו.", "Off: a media job from the chat starts it by itself, or start it now.")}</MenuNote>
      <MenuSeparator />
      {!st.up && st.installed && st.phase !== "starting" && st.phase !== "installing" && (
        <MenuItem icon="▶" disabled={acting} onSelect={() => act("start")}>{L("הפעל את ComfyUI", "Start ComfyUI")}</MenuItem>
      )}
      {st.up && st.managed && (
        <MenuItem icon="■" disabled={acting} onSelect={() => act("stop")} title={jobs ? L("עוצר גם את העבודות שרצות", "Also stops the running jobs") : undefined}>{L("עצור את ComfyUI", "Stop ComfyUI")}</MenuItem>
      )}
      <MenuItem icon="🧩" href="#/nodes">{L("נודים וזרימות", "Nodes and flows")}</MenuItem>
    </Menu>
  );
}
