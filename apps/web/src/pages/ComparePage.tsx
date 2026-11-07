import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { refreshLibrary, toast } from "../library";
import { ModelMenu } from "../ModelMenu";
import { PromptTextarea, expandSlash } from "../SlashMenu";
import { useModels } from "../useModels";
import { RichText } from "../RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Turn { seq: number; role: "user" | "assistant"; text: string }

/** One pane: a conversation, live. */
function Pane({ id, model, onRemove }: { id: string; model: string; onRemove?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState<{ t0: number; chars: number } | null>(null);
  const [took, setTook] = useState<string>("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const es = new EventSource(withToken(`/api/conversations/${id}/events?after=0`));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as { type: string; seq: number; text?: string; status?: string };
      if (e.type === "user") {
        setTurns((t) => (t.some((x) => x.seq === e.seq) ? t : [...t, { seq: e.seq, role: "user", text: e.text ?? "" }]));
        setSpeed({ t0: Date.now(), chars: 0 });
      } else if (e.type === "assistant_delta") {
        setLive((v) => v + (e.text ?? ""));
        setSpeed((s) => (s ? { ...s, chars: s.chars + (e.text?.length ?? 0) } : s));
      } else if (e.type === "assistant") {
        setLive("");
        setTurns((t) => (t.some((x) => x.seq === e.seq) ? t : [...t, { seq: e.seq, role: "assistant", text: e.text ?? "" }]));
        setSpeed((s) => {
          if (s) setTook(`${((Date.now() - s.t0) / 1000).toFixed(1)}s`);
          return null;
        });
      } else if (e.type === "info") setBusy(e.status === "running" || e.status === "waiting");
    };
    return () => es.close();
  }, [id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, live]);
  return (
    <div className="cmp-pane">
      <div className="cmp-head">
        <a href={`#/c/${id}`} dir="ltr" title={L("פתיחה כשיחה רגילה", "Open as a normal chat")}>{model.split("/").slice(-1)[0]}</a>
        <span className="grow" />
        {busy ? <span className="muted small">{speed && speed.chars > 20 ? `~${Math.round(speed.chars / 4 / Math.max(0.5, (Date.now() - speed.t0) / 1000))} tok/s` : L("כותב…", "Writing…")}</span> : took ? <span className="muted small">{took}</span> : null}
        {onRemove && <button type="button" className="as-link" onClick={onRemove} aria-label={L("הסרה", "Remove")}>✕</button>}
      </div>
      <div className="cmp-body">
        {turns.map((t) => (t.role === "user" ? <div key={t.seq} className="msg user">{t.text}</div> : <div key={t.seq} className="msg"><RichText text={t.text} /></div>))}
        {live && <div className="msg streaming"><RichText text={live} /></div>}
        <div ref={end} />
      </div>
    </div>
  );
}

/**
 * Split chat: the same question to two to four models side by side, each
 * in its own conversation (so any one can be continued alone).
 */
export function ComparePage() {
  const { models } = useModels("chat");
  const [picked, setPicked] = useState<string[]>([]);
  const [panes, setPanes] = useState<Array<{ id: string; model: string }>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("kesher-compare") ?? "[]") as Array<{ id: string; model: string }>;
    } catch {
      return [];
    }
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      sessionStorage.setItem("kesher-compare", JSON.stringify(panes));
    } catch {
      /* fine */
    }
  }, [panes]);
  useEffect(() => {
    if (!picked.length && models.length) setPicked(models.slice(0, 2).map((m) => m.id));
  }, [models.length]);
  const send = async () => {
    const value = expandSlash(text.trim());
    if (!value || busy) return;
    setBusy(true);
    setText("");
    try {
      let current = panes;
      if (!current.length) {
        current = [];
        for (const m of picked) {
          const c = await api<{ id: string }>("/api/conversations", { method: "POST", body: { kind: "chat", modelId: m } });
          current.push({ id: c.id, model: m });
        }
        setPanes(current);
      }
      await Promise.all(current.map((p) => api(`/api/conversations/${p.id}/messages`, { method: "POST", body: { text: value } })));
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page compare">
      <div className="row">
        <h1 className="grow">{L("השוואת מודלים", "Compare models")}</h1>
        {panes.length > 0 && <button type="button" onClick={() => setPanes([])}>{L("השוואה חדשה", "New comparison")}</button>}
      </div>
      {!panes.length && (
        <section className="card stack">
          <p className="muted">{L("אותה שאלה לכמה מודלים, זה לצד זה. כל מודל מקבל שיחה משלו, כך שאפשר להמשיך עם המנצח.", "The same question to several models, side by side. Each gets its own chat, so you can carry on with the winner.")}</p>
          <div className="row">
            {picked.map((m, i) => (
              <span key={i} className="row cmp-pick">
                <ModelMenu models={models} value={m} onChange={(id) => setPicked(picked.map((x, j) => (j === i ? id : x)))} />
                {picked.length > 2 && <button type="button" className="as-link" onClick={() => setPicked(picked.filter((_, j) => j !== i))}>✕</button>}
              </span>
            ))}
            {picked.length < 4 && models.length > picked.length && <button type="button" onClick={() => setPicked([...picked, models.find((m) => !picked.includes(m.id))?.id ?? models[0]!.id])}>{L("+ מודל", "+ Model")}</button>}
          </div>
        </section>
      )}
      {panes.length > 0 && (
        <div className={`cmp-grid n${panes.length}`}>
          {panes.map((p) => <Pane key={p.id} id={p.id} model={p.model} {...(panes.length > 2 ? { onRemove: () => setPanes(panes.filter((x) => x.id !== p.id)) } : {})} />)}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className="box">
          <PromptTextarea rows={2} value={text} onValue={setText} placeholder={L("שאלה לכל המודלים…", "A question for all the models…")} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div className="box-bar"><span className="grow" /><button type="submit" className="primary send" disabled={!text.trim() || busy || picked.length < 2} aria-label={L("שליחה", "Send")}>↑</button></div>
        </div>
      </form>
    </div>
  );
}
