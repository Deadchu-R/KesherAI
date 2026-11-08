import { useEffect, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { api, withToken } from "./api";
import { desktop } from "./library";
import { t, type StringKey } from "./i18n";

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/** One tool call and its result, if it finished. */
export interface Step {
  call: Ev<"tool_call">;
  result?: Ev<"tool_result">;
}

const WRITE = new Set(["write_file", "edit_file"]);
const READ = new Set(["read_file", "list_files", "search"]);
const RUN = new Set(["run_command", "build_executable", "install_tool", "check_tools"]);
const WEB = new Set(["web_search", "web_fetch", "download_file"]);

function arg(step: Step, ...keys: string[]): string {
  for (const k of keys) {
    const v = step.call.input[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** A short, human sentence for one step, e.g. "Edited src/app.py" or "Ran: pip install x". */
export function stepLabel(step: Step): string {
  const n = step.call.name;
  const keyFor: Record<string, StringKey> = {
    read_file: "stepRead",
    list_files: "stepList",
    search: "stepSearch",
    write_file: "stepWrite",
    edit_file: "stepEdit",
    run_command: "stepRun",
    build_executable: "stepBuild",
    install_tool: "stepInstall",
    check_tools: "stepCheck",
    web_search: "stepWebSearch",
    web_fetch: "stepWebFetch",
    download_file: "stepDownload",
    generate_image: "stepImage",
    make_music: "stepMusic",
    make_3d: "stepModel3d",
    request_access: "stepAccess",
  };
  const what = arg(step, "path", "command", "entry", "name", "query", "url", "pattern", "prompt", "reason", "tags", "image") || (n === "list_files" ? t("theFolder") : "");
  const key = keyFor[n];
  return key ? t(key, { what }) : `${n}${what ? `: ${what}` : ""}`;
}

/** "Edited 2 files, ran 3 commands" for a group of steps. */
export function groupSummary(steps: Step[]): string {
  const count = (set: Set<string>) => steps.filter((s) => set.has(s.call.name)).length;
  const parts: string[] = [];
  const w = count(WRITE);
  const r = count(READ);
  const c = count(RUN);
  const web = count(WEB);
  const other = steps.length - w - r - c - web;
  if (w) parts.push(t(w === 1 ? "sumWrite1" : "sumWrite", { n: w }));
  if (c) parts.push(t(c === 1 ? "sumRun1" : "sumRun", { n: c }));
  if (r) parts.push(t(r === 1 ? "sumRead1" : "sumRead", { n: r }));
  if (web) parts.push(t("sumWeb", { n: web }));
  if (other) parts.push(t(other === 1 ? "sumOther1" : "sumOther", { n: other }));
  return parts.join(", ");
}

/**
 * The agent's work between two messages, folded into one line like
 * "Edited 2 files, ran 3 commands ▾". Open it to see every step; while the
 * agent works, the line shows what it is doing right now. Pictures the
 * tools made stay visible below it.
 *
 * @param props.steps - The steps, in order.
 * @param props.live - Whether the agent is still working on this group.
 * @param props.renderStep - Draws one step when the group is open.
 */
export function ActivityGroup({ steps, live, renderStep, convId }: { steps: Step[]; live: boolean; renderStep: (s: Step) => React.ReactNode; convId?: string }) {
  const current = live ? [...steps].reverse().find((s) => !s.result) ?? steps.at(-1) : undefined;
  const failed = steps.filter((s) => s.result && !s.result.ok).length;
  const images = steps.flatMap((s) => s.result?.assetIds ?? []);
  const videos = steps.flatMap((s) => s.result?.videoIds ?? []);
  const sounds = steps.flatMap((s) => s.result?.audioIds ?? []);
  // Older builds only said "Built dist/x.exe." in their output.
  const made = steps.flatMap((s) => s.result?.files ?? (s.call.name === "build_executable" && s.result?.ok ? [/Built (\S+?)\.\s/.exec(`${s.result.output} `)?.[1]].filter((x): x is string => !!x) : []));
  return (
    <div className="activity">
      <details>
        <summary>
          {live && <span className="spinner" aria-hidden />}
          <span className="activity-sum">{groupSummary(steps)}</span>
          {failed > 0 && <span className="pill bad">{t("stepsFailed", { n: failed })}</span>}
          <span className="chev" aria-hidden />
        </summary>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.call.callId} className={!s.result ? "pending" : s.result.ok ? "ok" : "fail"}>
              {renderStep(s)}
            </li>
          ))}
        </ol>
      </details>
      {current && (
        <p className="activity-now" dir="auto">
          {stepLabel(current)}
        </p>
      )}
      {current && !current.result && (current.call.name === "generate_image" || current.call.name === "generate_video") && <ImageProgressLine />}
      {made.length > 0 && convId && <div className="made">{made.map((f) => <FileCard key={f} convId={convId} path={f} />)}</div>}
      {sounds.length > 0 && (
        <div className="activity-audio">
          {sounds.map((id) => (
            <div key={id} className="audio-card">
              <audio src={withToken(`/api/assets/${id}`)} controls preload="metadata" />
              <a href={withToken(`/api/assets/${id}`)} download={`kesher-music-${id.slice(0, 8)}.mp3`}>{t("download")}</a>
            </div>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="activity-images">
          {videos.map((id) => (
            <div key={id} className="video-card">
              <video src={withToken(`/api/assets/${id}`)} controls loop autoPlay muted playsInline className="asset" />
              <a href={withToken(`/api/assets/${id}`)} download={`kesher-video-${id.slice(0, 8)}.webm`}>{t("download")}</a>
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="activity-images">
          {images.map((id) => <img key={id} src={withToken(`/api/assets/${id}`)} alt="" className="asset" />)}
        </div>
      )}
    </div>
  );
}

interface ImageProgress { phase?: "loading" | "encoding" | "sampling" | "decoding"; step?: number; steps?: number; secondsPerStep?: number; startedAt?: number; device?: "gpu" | "cpu" }

/** While a picture is being made: the engine's stage, step x of y, and time left. Polls once a second. */
function ImageProgressLine() {
  const [p, setP] = useState<ImageProgress>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api<ImageProgress>("/api/engines/image/progress").then((x) => {
        if (alive) {
          setP(x);
          setNow(Date.now());
        }
      }, () => undefined);
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!p.phase) return null;
  const elapsed = p.startedAt ? Math.round((now - p.startedAt) / 1000) : 0;
  const left = p.step && p.steps && p.secondsPerStep ? Math.round((p.steps - p.step) * p.secondsPerStep) : undefined;
  const pct = p.step && p.steps ? Math.round((p.step / p.steps) * 100) : undefined;
  return (
    <div className="image-progress" role="status">
      <span dir="auto">
        {t(`imgPhase_${p.phase}` as StringKey)}
        {p.step && p.steps ? ` · ${t("imgStep", { step: p.step, steps: p.steps })}` : ""}
        {p.secondsPerStep ? ` · ${t("imgPerStep", { s: p.secondsPerStep.toFixed(1) })}` : ""}
        {left !== undefined ? ` · ${t("imgLeft", { s: left })}` : ` · ${t("imgElapsed", { s: elapsed })}`}
      </span>
      {p.device === "cpu" && <span className="pill bad">{t("imgOnCpu")}</span>}
      {pct !== undefined && <span className="bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>}
    </div>
  );
}

/**
 * A file the agent made, right in the conversation: download it, open its
 * folder, or (in the desktop app) run it.
 */
export function FileCard({ convId, path }: { convId: string; path: string }) {
  const name = path.split("/").pop() ?? path;
  const runnable = /\.(exe|msi|bat|cmd|app)$/i.test(name);
  const url = withToken(`/api/conversations/${convId}/files/download?path=${encodeURIComponent(path)}`);
  const folder = async () => {
    const d = await api<{ folder: string }>(`/api/conversations/${convId}/files`);
    return `${d.folder.replace(/[\\/]+$/, "")}/${path}`;
  };
  return (
    <div className="file-card card">
      <span className="file-icon" aria-hidden>{runnable ? "▶" : "📄"}</span>
      <div className="grow">
        <strong dir="ltr">{name}</strong>
        <p className="muted small" dir="ltr">{path}</p>
      </div>
      <a className="button primary-link" href={url} download>{t("download")}</a>
      {desktop()?.openPath && (
        <button type="button" onClick={() => void folder().then((p) => desktop()!.openPath!(p.replace(/[\\/][^\\/]+$/, "")))}>{t("openFolder")}</button>
      )}
      {runnable && desktop()?.runFile && (
        <button type="button" onClick={() => void folder().then((p) => desktop()!.runFile!(p))}>{t("runProgram")}</button>
      )}
    </div>
  );
}
