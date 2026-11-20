import { useEffect, useState } from "react";
import { api, withToken } from "../api";
import { openCanvas } from "../ArtifactPanel";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { diffVersions, imageHistory } from "./canvas-items";
import { JobProgressView, useChatLive } from "./ChatLive";
import { directResults, type ResultAction } from "./result-actions";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/*
 * The inline action buttons under a result (design ChatQuickActions). A button with a tool runs it at once with the
 * inputs it already has (`POST /api/conversations/:id/quick-actions`, no model turn, no tokens; the approval rules
 * still apply) and its results show right under the buttons: new pictures, the first line of a text, or why it failed,
 * with the job's progress and Cancel while it runs. The others open the side canvas, the engine's page, save the file
 * into the chat's folder, or undo the run. Everything goes through the server, so the phone works the same.
 */

/** Each chat's runnable button tools, asked once per chat while the page is open. */
const known = new Map<string, Promise<string[]>>();

/**
 * The tools this chat's buttons can run (`GET …/quick-actions`), asked once per chat.
 *
 * @param convId - The chat, or undefined outside one (no runnable buttons then).
 * @returns The names; empty until the answer comes.
 */
export function useQuickNames(convId: string | undefined): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!convId) return;
    let live = true;
    let p = known.get(convId);
    if (!p) {
      p = api<{ names: string[] }>(`/api/conversations/${encodeURIComponent(convId)}/quick-actions`).then((r) => r.names, () => []);
      known.set(convId, p);
      // Unity connecting or a part switched on changes the list: ask again next time after a minute.
      setTimeout(() => known.delete(convId), 60_000);
    }
    void p.then((n) => live && setNames(n));
    return () => {
      live = false;
    };
  }, [convId]);
  return names;
}

/**
 * A row of action buttons, with the results of the ones pressed here.
 *
 * @param props.actions - The buttons (result-actions.ts).
 * @param props.label - What they act on, for screen readers ("Actions for the picture").
 */
export function ResultActions({ actions, label }: { actions: ResultAction[]; label: string }) {
  const live = useChatLive();
  const [pressed, setPressed] = useState<Array<{ key: string; tool: string; fromSeq: number }>>([]);
  const [busy, setBusy] = useState("");
  if (!actions.length) return null;
  const convId = live?.convId;
  const press = async (a: ResultAction) => {
    const d = a.do;
    if ("tool" in d) {
      if (!convId) return;
      const fromSeq = live?.events.at(-1)?.seq ?? 0;
      setBusy(a.id);
      try {
        await api(`/api/conversations/${encodeURIComponent(convId)}/quick-actions`, { method: "POST", body: { name: d.tool, input: d.input, ...(d.times ? { times: d.times } : {}) } });
        setPressed((p) => [...p, { key: `${a.id}-${fromSeq}`, tool: d.tool, fromSeq }]);
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy("");
      }
      return;
    }
    switch (d.page) {
      case "canvas-image":
        openCanvas({ kind: "image", assetId: d.assetId, history: imageHistory(live?.events ?? [], d.assetId), ...(convId ? { convId } : {}) });
        return;
      case "canvas-diff": {
        const v = diffVersions((live?.events ?? []) as Parameters<typeof diffVersions>[0], d.title, d.diff);
        openCanvas({ kind: "diff", title: d.title, ...v });
        return;
      }
      case "canvas-pbr":
        openCanvas({ kind: "pbr", title: d.title, maps: d.maps });
        return;
      case "engine":
        location.hash = d.hash;
        return;
      case "save":
        if (!convId) return;
        setBusy(a.id);
        try {
          // Into the chat's shared/ folder (as the phone's shares and "Open in the editor" do), so Files has it.
          const bytes = await (await fetch(withToken(`/api/assets/${d.assetId}`))).blob();
          const ext = d.kind === "audio" ? (bytes.type === "audio/mpeg" ? "mp3" : bytes.type.split("/")[1] ?? "audio") : bytes.type.split("/")[1] ?? "video";
          const name = `kesher-${d.kind}-${d.assetId.slice(0, 8)}.${ext.replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
          const up = await fetch(withToken(`/api/conversations/${encodeURIComponent(convId)}/files?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
          if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? `${up.status}`);
          toast(L(`נשמר בקבצי הצ'אט: shared/${name}`, `Saved to the chat's files: shared/${name}`));
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy("");
        }
        return;
      case "undo-run":
        if (!convId) return;
        setBusy(a.id);
        try {
          await api(`/api/conversations/${encodeURIComponent(convId)}/runs/${encodeURIComponent(d.run)}/undo`, { method: "POST", body: {} });
          toast(L("השינוי בוטל", "The change was undone"));
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy("");
        }
        return;
    }
  };
  return (
    <div className="result-actions">
      <div className="quick-actions" role="group" aria-label={label}>
        {actions.map((a) => (
          <button key={a.id} type="button" className="chip-text" disabled={!!busy || (("tool" in a.do || a.do.page === "save" || a.do.page === "undo-run") && (!convId || !!live?.busy))} onClick={() => void press(a)}>
            <span aria-hidden>{a.icon}</span> {busy === a.id ? L("רגע…", "One moment…") : L(a.he, a.en)}
          </button>
        ))}
      </div>
      {pressed.map((p) => <PressedResult key={p.key} tool={p.tool} fromSeq={p.fromSeq} />)}
    </div>
  );
}

/** What one press made: its running steps (progress, Cancel) and finished results, right under the buttons. */
function PressedResult({ tool, fromSeq }: { tool: string; fromSeq: number }) {
  const live = useChatLive();
  if (!live) return null;
  const { done, running } = directResults(live.events, fromSeq, tool);
  const results = done.flatMap((e) => (e.type === "tool_result" ? [e] : []));
  const pictures = results.flatMap((r) => (r.ok ? r.assetIds ?? [] : []));
  return (
    <div className="pressed-result" aria-live="polite">
      {running.map((id) => <JobProgressView key={id} callId={id} />)}
      {pictures.length > 0 && (
        <div className="pressed-pictures">
          {pictures.map((id) => (
            <button key={id} type="button" className="canvas-thumb" aria-label={L("פתיחה בקנבס", "Open in canvas")} onClick={() => openCanvas({ kind: "image", assetId: id, history: imageHistory(live.events, id), convId: live.convId })}>
              <img src={withToken(`/api/assets/${id}`)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {results.filter((r) => !r.ok || !r.assetIds?.length).map((r) => {
        const first = r.output.split("\n").find((l) => l.trim())?.slice(0, 200) ?? "";
        // A text result (a transcript): its first line, open for all of it.
        return r.ok && r.output.trim().length > first.length + 1 ? (
          <details key={r.seq} className="pressed-text">
            <summary className="small" dir="auto">✓ {first}</summary>
            <pre dir="auto">{r.output.slice(0, 20_000)}</pre>
          </details>
        ) : (
          <p key={r.seq} className={`small ${r.ok ? "muted" : "error"}`} dir="auto">{r.ok ? "✓" : "✕"} {first}</p>
        );
      })}
      {!running.length && !results.length && <p className="muted small">{L("מתחיל…", "Starting…")}</p>}
    </div>
  );
}
