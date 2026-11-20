import { useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { findFact, type MemoryTopicView } from "./chat-inline";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * "Saved to memory" under the answer when the model kept a fact (its `remember` tool), like Claude's "Saved memory":
 * the fact, a link to the Memory page, and Undo, which deletes just that fact (found again by its text, so it works
 * after a reload and from the phone).
 *
 * @param props.note - The fact as the call gave it.
 * @param props.topic - The topic the call named, if any.
 */
export function MemoryChip({ note, topic }: { note: string; topic?: string }) {
  const [state, setState] = useState<"kept" | "busy" | "undone">("kept");
  const undo = async () => {
    setState("busy");
    try {
      const d = await api<{ topics: MemoryTopicView[] }>("/api/memory");
      const at = findFact(d.topics, note, topic);
      if (at) await api(`/api/memory/topics/${encodeURIComponent(at.topicId)}/facts/${at.index}`, { method: "PUT", body: { text: "" } });
      setState("undone");
    } catch (e) {
      toast((e as Error).message);
      setState("kept");
    }
  };
  return (
    <div className={`memory-chip${state === "undone" ? " undone" : ""}`} role="status">
      <span aria-hidden>🧠</span>
      <span className="grow memory-chip-text" dir="auto">
        <strong>{state === "undone" ? L("הוסר מהזיכרון", "Removed from memory") : L("נשמר בזיכרון", "Saved to memory")}</strong>
        {state !== "undone" && <span className="muted"> · {note}</span>}
      </span>
      {state !== "undone" && (
        <>
          <a className="chip-text" href="#/memory">{L("ניהול", "Manage")}</a>
          <button type="button" className="chip-text" disabled={state === "busy"} onClick={() => void undo()}>↶ {L("ביטול", "Undo")}</button>
        </>
      )}
    </div>
  );
}
