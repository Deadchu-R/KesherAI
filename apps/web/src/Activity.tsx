import type { AgentEvent } from "@kesher/shared";
import { withToken } from "./api";
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
    request_access: "stepAccess",
  };
  const what = arg(step, "path", "command", "entry", "name", "query", "url", "pattern", "prompt", "reason") || (n === "list_files" ? t("theFolder") : "");
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
export function ActivityGroup({ steps, live, renderStep }: { steps: Step[]; live: boolean; renderStep: (s: Step) => React.ReactNode }) {
  const current = live ? [...steps].reverse().find((s) => !s.result) ?? steps.at(-1) : undefined;
  const failed = steps.filter((s) => s.result && !s.result.ok).length;
  const images = steps.flatMap((s) => s.result?.assetIds ?? []);
  return (
    <div className="activity">
      <details>
        <summary>
          {live && <span className="spinner" aria-hidden />}
          <span className="activity-sum">{groupSummary(steps)}</span>
          {failed > 0 && <span className="pill bad">{t("stepsFailed", { n: failed })}</span>}
          <span className="chev" aria-hidden>▾</span>
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
      {images.length > 0 && (
        <div className="activity-images">
          {images.map((id) => <img key={id} src={withToken(`/api/assets/${id}`)} alt="" className="asset" />)}
        </div>
      )}
    </div>
  );
}
