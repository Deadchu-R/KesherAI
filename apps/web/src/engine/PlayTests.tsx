import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { createConversation, toast } from "../library";
import { openWithDraft } from "../phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A kept gameplay test (Content/KesherTests/<name>.json). */
interface KeptTest {
  name: string;
  description?: string;
  steps: number;
  map?: string;
}

/** The run in progress or the last one, as the server keeps it. */
interface RunState {
  name?: string;
  running: boolean;
  total?: number;
  steps?: Array<{ index: number; ok: boolean; line: string }>;
  passed?: boolean;
  reason?: string;
  mode?: string;
  pictureIds?: string[];
  log?: string[];
  error?: string;
}

/**
 * Gameplay tests on the Unreal page: the tests kept in the project, a Run button for each (Play In Editor, or a
 * headless editor with Unreal closed), each step's ✓/✗ as it finishes, the pictures and the log, a Functional Test
 * stub to copy, and "Write a test" that asks a chat to write one with unreal_play_test. Works the same from the phone
 * (remote): everything goes through the server, and the run is polled.
 *
 * @param props.ready - Unreal is connected, or a headless editor can run the test.
 */
export function PlayTests({ ready }: { ready: boolean }) {
  const [tests, setTests] = useState<KeptTest[] | undefined>();
  const [run, setRun] = useState<RunState>({ running: false });
  const [stub, setStub] = useState<{ name: string; text: string } | undefined>();
  const timer = useRef<number | undefined>(undefined);

  const load = () => void api<{ tests: KeptTest[] }>("/api/unreal/play-tests").then((r) => setTests(r.tests), () => setTests([]));
  const poll = () => {
    window.clearTimeout(timer.current);
    void api<RunState>("/api/unreal/play-tests/run").then((r) => {
      setRun(r);
      if (r.running) timer.current = window.setTimeout(poll, 600);
    }, () => undefined);
  };
  useEffect(() => {
    load();
    poll();
    return () => window.clearTimeout(timer.current);
  }, []);

  const start = async (name: string) => {
    try {
      await api("/api/unreal/play-tests/run", { method: "POST", body: { name } });
      setRun({ name, running: true, steps: [] });
      poll();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const showStub = async (name: string, kind: "cpp" | "blueprint") => {
    try {
      setStub({ name, text: (await api<{ text: string }>("/api/unreal/play-tests/stub", { method: "POST", body: { name, kind } })).text });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  // The chat writes the plan (it reads the project's input actions first), runs it and keeps it.
  const write = () => {
    const line = L(
      "כתוב בדיקת משחק ל-Unreal עם unreal_play_test: קרא קודם את ה-Input Actions של הפרויקט, ואז: ",
      "Write an Unreal gameplay test with unreal_play_test: read the project's Input Actions first, then: ",
    );
    void createConversation({ kind: "chat" }).then((id) => id && openWithDraft(id, line), (e: Error) => toast(e.message));
  };

  const done = run.steps?.length ?? 0;
  return (
    <details className="card play-tests">
      <summary className="row play-tests-head">
        <strong className="grow">🎮 {L("בדיקות משחק", "Gameplay tests")}</strong>
        {run.running ? <span className="pill">{L(`רץ ${done}/${run.total ?? "?"}`, `Running ${done}/${run.total ?? "?"}`)}</span> : tests ? <span className="muted small">{tests.length}</span> : null}
      </summary>
      <p className="muted small" dir="auto">{L("כל בדיקה לוחצת על פעולות קלט, מחכה לתנאים ובודקת ערכים בתוך Play In Editor בלבד. הרמה והנכסים לא משתנים; הבדיקה נשמרת ב-Content/KesherTests.", "Each test presses input actions, waits for conditions and checks values, only inside Play In Editor. The level and assets don't change; the test is kept in Content/KesherTests.")}</p>
      <div className="row play-tests-actions">
        <button type="button" className="primary" onClick={write}>✍ {L("כתוב בדיקה בצ'אט", "Write a test in chat")}</button>
        <button type="button" onClick={load}>{L("רענן", "Refresh")}</button>
      </div>
      {tests && tests.length === 0 && <p className="muted small" dir="auto">{L("אין עדיין בדיקות שמורות בפרויקט.", "No tests kept in this project yet.")}</p>}
      <ul className="play-tests-list">
        {(tests ?? []).map((t) => (
          <li key={t.name} className="row">
            <span className="grow" dir="auto"><strong dir="ltr">{t.name}</strong> <span className="muted small">· {L(`${t.steps} צעדים`, `${t.steps} steps`)}{t.description ? ` · ${t.description}` : ""}</span></span>
            <button type="button" className="primary" disabled={!ready || run.running} onClick={() => void start(t.name)} title={ready ? undefined : L("פתחו את הפרויקט ב-Unreal פעם אחת עם התוסף", "Open the project in Unreal once with the plugin")}>▶ {L("הרץ", "Run")}</button>
            <button type="button" onClick={() => void showStub(t.name, "cpp")} title={L("Functional Test ב-C++ להעתקה", "A C++ Functional Test to copy")}>C++</button>
            <button type="button" onClick={() => void showStub(t.name, "blueprint")} title={L("המתכון ל-Functional Test ב-Blueprint", "The recipe for a Blueprint Functional Test")}>BP</button>
          </li>
        ))}
      </ul>
      {run.name && (
        <div className="play-tests-run stack" aria-live="polite">
          <div className="row">
            <strong className="grow" dir="ltr">{run.name}</strong>
            {run.running ? <button type="button" onClick={() => void api("/api/unreal/play-tests/stop", { method: "POST" }).then(poll)}>■ {L("עצור", "Stop")}</button> : <span className={`pill ${run.passed ? "good" : ""}`}>{run.passed ? `✓ ${L("עברה", "Passed")}` : `✗ ${L("נכשלה", "Failed")}`}</span>}
          </div>
          {run.mode === "headless" && <p className="muted small">{L("רץ ברקע (Unreal סגור): בלי תמונות.", "Ran in the background (Unreal closed): no pictures.")}</p>}
          {(run.error || run.reason) && <p className="small" dir="auto">⛔ {run.error ?? run.reason}</p>}
          <ol className="play-tests-steps">
            {(run.steps ?? []).map((s) => <li key={s.index} className={s.ok ? "ok" : "bad"} dir="ltr">{s.line}</li>)}
            {run.running && <li className="muted">…</li>}
          </ol>
          {(run.pictureIds ?? []).map((id) => (
            <a key={id} href={withToken(`/api/assets/${id}`)} target="_blank" rel="noreferrer"><img className="ue-test-pic" src={withToken(`/api/assets/${id}`)} alt={L("תמונה מהבדיקה", "A picture from the test")} /></a>
          ))}
          {run.log && run.log.length > 0 && (
            <details className="ue-test-log">
              <summary>{L(`הלוג (${run.log.length} שורות)`, `The log (${run.log.length} lines)`)}</summary>
              <pre dir="ltr">{run.log.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
      {stub && (
        <div className="stack play-tests-stub">
          <div className="row">
            <strong className="grow" dir="ltr">{stub.name}</strong>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(stub.text).then(() => toast(L("הועתק", "Copied")), () => undefined)}>{L("העתק", "Copy")}</button>
            <button type="button" onClick={() => setStub(undefined)} aria-label={L("סגור", "Close")}>✕</button>
          </div>
          <pre dir="ltr">{stub.text}</pre>
        </div>
      )}
    </details>
  );
}
