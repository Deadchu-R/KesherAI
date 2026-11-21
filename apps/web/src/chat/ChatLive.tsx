import { createContext, useContext } from "react";
import type { AgentEvent, JobProgress } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
export { MEDIA_JOB, mergeProgress } from "./job-progress";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/*
 * What a chat page knows live, for the cards deep inside its messages (the inline action buttons and the media job
 * progress): the chat, its events, each running media job's progress (`tool_progress`, not saved) and whether it is
 * working. One context, so the cards need no props threaded through ActivityGroup.
 */

/** The chat page's live state. */
export interface ChatLive {
  convId: string;
  events: readonly AgentEvent[];
  progress: Readonly<Record<string, JobProgress>>;
  busy: boolean;
}

/** The chat page provides it; cards outside a chat page get undefined. */
export const ChatLiveContext = createContext<ChatLive | undefined>(undefined);

/** @returns The chat page's live state, or undefined outside one. */
export function useChatLive(): ChatLive | undefined {
  return useContext(ChatLiveContext);
}

/** A phase's words (ComfyUI's and the button tools'; anything else is shown as the engine said it). */
function phaseText(phase: string | undefined): string {
  switch (phase) {
    case "queued": return L("בתור", "Queued");
    case "loading": return L("טוען מודל", "Loading the model");
    case "encoding": return L("קורא את הבקשה", "Reading the prompt");
    case "sampling": return L("יוצר", "Making it");
    case "decoding": return L("מסיים", "Finishing");
    case "upscaling": return L("מגדיל", "Upscaling");
    case "cutting out": return L("מסיר רקע", "Removing the background");
    case "seam check": return L("בודק שהטקסטורה חוזרת בלי תפר", "Checking that it tiles");
    case "fixing seam": return L("מתקן את התפר", "Fixing the seam");
    case "maps": return L("מכין מפות נורמל, חספוס ו-AO", "Making normal, roughness and AO maps");
    default: return phase ?? L("מתחיל", "Starting");
  }
}

/**
 * A running media job inside the chat bubble (design ChatJobProgress, as ComfyUI's queue and SwarmUI show it): what
 * it does, step x of y with a bar, the newest preview frame, and Cancel (stops the chat's turn; the server takes the
 * job off ComfyUI's queue or interrupts it). Everything comes over the chat's event stream, so the phone sees it too.
 *
 * Before any update comes (the built-in image engine, whose own line shows its steps) only Cancel shows.
 *
 * @param props.callId - The step.
 */
export function JobProgressView({ callId }: { callId: string }) {
  const live = useChatLive();
  const p = live?.progress[callId];
  if (!live) return null;
  const pct = p?.step && p.steps ? Math.min(100, Math.round((p.step / p.steps) * 100)) : undefined;
  const cancel = () => void api(`/api/conversations/${encodeURIComponent(live.convId)}/stop`, { method: "POST" }).then(() => toast(L("בוטל", "Cancelled")), (e: Error) => toast(e.message));
  return (
    <div className="job-progress" role="status">
      {p?.preview && <img className="job-preview" src={p.preview} alt={L("תצוגה מקדימה של מה שנוצר", "A preview of what is being made")} />}
      <div className="job-line">
        {p && (
          <span className="job-text" dir="auto">
            {phaseText(p.phase)}
            {p?.step && p.steps ? ` · ${L(`צעד ${p.step} מתוך ${p.steps}`, `step ${p.step} of ${p.steps}`)}` : ""}
          </span>
        )}
        <button type="button" className="chip-text job-cancel" onClick={cancel} disabled={!live.busy}>✕ {L("ביטול", "Cancel")}</button>
      </div>
      {pct !== undefined && <span className="bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>}
    </div>
  );
}
