import { useEffect, useState } from "react";
import { FileChips, MadeMedia, MediaView, fileUrl } from "./MediaView";
import { MemoryChip } from "./chat/MemoryChip";
import { InstallOffer } from "./chat/InstallOffer";
import { mediaKindOf } from "./chat/chat-inline";
import { JobProgressView, MEDIA_JOB, useChatLive } from "./chat/ChatLive";
import { ResultActions, useQuickNames } from "./chat/ResultActions";
import { imageActions, playerActions, stepActions } from "./chat/result-actions";
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

// What each tool does, for the folded line ("Wrote 2 files, ran 3 commands, used your computer 4×").
// Game-engine tools count like the code tools they resemble (they were all "used a tool" before).
const WRITE = /^(write_file|edit_file|unreal_write_source|unity_write_script|unity_create_gameobject|unity_add_component|unity_modify_scene|unreal_apply_material|godot_edit|(unreal|unity)_change_graph)$/;
const READ = /^(read_file|list_files|search|unreal_(read_source|list_source|status|plugins|read_graph|list_graphs|inspect_level)|unity_(read_script|list_scripts|status|scene|console|find_commands|read_graph|list_graphs))$/;
const RUN = /^(run_command|build_executable|install_tool|check_tools|unreal_(compile|python|package|open_editor|port_plugin|create_project)|unity_(build|command|script_eval|install_platform)|android_run_on_phone)$/;
const WEB = /^(web_search|web_fetch|download_file)$/;
const COMPUTER = /^(computer_|browser_)/;
/** Pictures of the screen (shown small, like Claude's activity summary); other pictures stay big. */
const SCREEN = /^(computer_|browser_)|screenshot/;

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
    make_pbr_texture: "stepTexture",
    make_ui_sprite: "stepSprite",
    request_access: "stepAccess",
    unreal_write_source: "stepWrite",
    unity_write_script: "stepWrite",
    unreal_read_source: "stepRead",
    unity_read_script: "stepRead",
    unreal_compile: "stepUeCompile",
    unreal_python: "stepUePython",
    unreal_package: "stepPackage",
    unity_build: "stepPackage",
    android_run_on_phone: "stepOnPhone",
    unreal_change_graph: "stepGraph",
    unity_change_graph: "stepGraph",
    unreal_inspect_level: "stepLevel",
    unreal_apply_material: "stepMaterial",
    computer_screenshot: "stepScreenshot",
    unity_screenshot: "stepScreenshot",
  };
  const what = arg(step, "path", "command", "entry", "name", "query", "url", "pattern", "prompt", "reason", "tags", "image", "target", "package", "actor", "level") || (n === "list_files" ? t("theFolder") : "");
  const key = keyFor[n] ?? (COMPUTER.test(n) ? "stepComputer" : undefined);
  if (key === "stepComputer") return t(key, { what: n.replace(/^(computer|browser)_/, "").replace(/_/g, " ") });
  return key ? t(key, { what }) : `${n}${what ? `: ${what}` : ""}`;
}

/** "Edited 2 files, ran 3 commands" for a group of steps. */
export function groupSummary(steps: Step[]): string {
  const count = (re: RegExp) => steps.filter((s) => re.test(s.call.name)).length;
  const parts: string[] = [];
  const w = count(WRITE);
  const r = count(READ);
  const c = count(RUN);
  const web = count(WEB);
  const pc = count(COMPUTER);
  const other = steps.length - w - r - c - web - pc;
  if (w) parts.push(t(w === 1 ? "sumWrite1" : "sumWrite", { n: w }));
  if (c) parts.push(t(c === 1 ? "sumRun1" : "sumRun", { n: c }));
  if (r) parts.push(t(r === 1 ? "sumRead1" : "sumRead", { n: r }));
  if (web) parts.push(t("sumWeb", { n: web }));
  if (pc) parts.push(t("sumComputer", { n: pc }));
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
export function ActivityGroup({ steps, live, renderStep, convId, liveOutput, after }: { steps: Step[]; live: boolean; renderStep: (s: Step) => React.ReactNode; convId?: string; liveOutput?: Record<string, string>; /** Shown under the group, never folded (a delegate call's sub-agent cards). */ after?: React.ReactNode[] }) {
  const current = live ? [...steps].reverse().find((s) => !s.result) ?? steps.at(-1) : undefined;
  const failed = steps.filter((s) => s.result && !s.result.ok).length;
  // A song's cover picture shows beside its player, not again as a picture.
  const images = steps.flatMap((s) => (SCREEN.test(s.call.name) || s.result?.audioIds?.length ? [] : s.result?.assetIds ?? []));
  // Screen pictures: small, in order, on the folded line (open one to see it full size).
  const shots = steps.flatMap((s) => (SCREEN.test(s.call.name) ? s.result?.assetIds ?? [] : []));
  const videos = steps.flatMap((s) => s.result?.videoIds ?? []);
  // A song's title and lyrics come from the make_music call itself (t80).
  const sounds = steps.flatMap((s) => (s.result?.audioIds ?? []).map((id) => {
    const input = (s.call.input ?? {}) as { title?: unknown; lyrics?: unknown };
    const lyrics = typeof input.lyrics === "string" && !/^\[instrumental\]$/i.test(input.lyrics.trim()) ? input.lyrics.trim() : "";
    return { id, title: typeof input.title === "string" ? input.title.trim() : "", lyrics, cover: s.result?.assetIds?.[0] };
  }));
  // Facts the model kept ("remember"), each with Undo (as Claude's "Saved memory").
  const kept = steps.flatMap((s) => {
    const input = (s.call.input ?? {}) as { note?: unknown; topic?: unknown };
    return s.call.name === "remember" && s.result?.ok && /^Remembered\b/.test(s.result.output) && typeof input.note === "string" ? [{ key: s.call.callId, note: input.note, topic: typeof input.topic === "string" ? input.topic : undefined }] : [];
  });
  // Something the request needs is not installed (offer_install): an Install button, never folded.
  const offers = steps.flatMap((s) => {
    const input = (s.call.input ?? {}) as { id?: unknown; why?: unknown };
    if (s.call.name === "offer_install") return s.result?.ok && /Install button/.test(s.result.output) && typeof input.id === "string" ? [{ key: s.call.callId, id: input.id, why: typeof input.why === "string" ? input.why : undefined }] : [];
    // computer_find / browser_find_visual without a vision model: the tool itself asks for the button (vision-find-tools.ts).
    const mark = /^(computer_find|browser_find_visual)$/.test(s.call.name) ? /\[offer_install:([\w-]+)\]/.exec(s.result?.output ?? "") : null;
    return mark ? [{ key: s.call.callId, id: mark[1]!, why: undefined }] : [];
  });
  // Older builds only said "Built dist/x.exe." in their output.
  // Inline action buttons (design ChatQuickActions): what this chat's buttons can run, which step made each picture,
  // and the run's receipt (for Undo on an engine step).
  const can = useQuickNames(convId);
  const events = useChatLive()?.events;
  const madeBy = new Map(steps.flatMap((s) => (s.result?.assetIds ?? []).map((id) => [id, s] as const)));
  const lastSeq = Math.max(0, ...steps.map((s) => s.result?.seq ?? 0));
  const next = lastSeq && events ? events.find((e) => e.seq > lastSeq && (e.type === "receipt" || e.type === "user")) : undefined;
  const run = next?.type === "receipt" ? next.run : undefined;
  const lastEngine = [...steps].reverse().find((s) => s.result?.ok && /^(unity|unreal|godot)_/.test(s.call.name));
  const stepButtons = live ? [] : steps.flatMap((s) => {
    const all = stepActions(s, run, can);
    // Engine buttons once per group (on its last engine step), not under every read.
    const list = s === lastEngine ? all : all.filter((a) => a.id !== "engine" && a.id !== "undo");
    return list.length ? [{ key: s.call.callId, list }] : [];
  });
  const made = steps.flatMap((s) => s.result?.files ?? (s.call.name === "build_executable" && s.result?.ok ? [/Built (\S+?)\.\s/.exec(`${s.result.output} `)?.[1]].filter((x): x is string => !!x) : []));
  return (
    <div className="activity">
      <details>
        <summary>
          {live && <span className="spinner" aria-hidden />}
          <span className="activity-sum">{groupSummary(steps)}</span>
          {failed > 0 && <span className="pill bad">{t("stepsFailed", { n: failed })}</span>}
          {shots.length > 0 && (
            <span className="activity-thumbs" aria-label={t("sumShots", { n: shots.length })}>
              {shots.slice(-4).map((id) => <img key={id} src={withToken(`/api/assets/${id}`)} alt="" />)}
              {shots.length > 4 && <span className="muted small">+{shots.length - 4}</span>}
            </span>
          )}
          <span className="chev" aria-hidden />
        </summary>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.call.callId} className={!s.result ? "pending" : s.result.ok ? "ok" : "fail"}>
              {renderStep(s)}
            </li>
          ))}
        </ol>
        {shots.length > 0 && (
          <div className="activity-shots">
            {shots.map((id) => (
              <a key={id} href={withToken(`/api/assets/${id}`)} target="_blank" rel="noreferrer">
                <img src={withToken(`/api/assets/${id}`)} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        )}
      </details>
      {/* What failed and why, without opening the group (only the first line of each error). */}
      {failed > 0 && (
        <ul className="activity-fails">
          {steps
            .filter((s) => s.result && !s.result.ok)
            .slice(0, 4)
            .map((s) => (
              <li key={s.call.callId} dir="auto">
                <span aria-hidden>✕ </span>
                {stepLabel(s)}: <span className="muted">{(s.result?.output ?? "").replace(/^Error:\s*/, "").split("\n").find((l) => l.trim())?.slice(0, 160) ?? ""}</span>
              </li>
            ))}
        </ul>
      )}
      {current && (
        <p className="activity-now" dir="auto">
          {stepLabel(current)}
        </p>
      )}
      {current && !current.result && liveOutput?.[current.call.callId] && <LiveOutput text={liveOutput[current.call.callId]!} />}
      {current && !current.result && (current.call.name === "generate_image" || current.call.name === "generate_video") && <ImageProgressLine />}
      {/* A picture, video, song or 3D job: ComfyUI's steps and preview frames, and Cancel (design ChatJobProgress). */}
      {live && steps.filter((s) => !s.result && MEDIA_JOB.test(s.call.name)).map((s) => <JobProgressView key={s.call.callId} callId={s.call.callId} />)}
      {after && after.length > 0 && <div className="hcards">{after}</div>}
      {stepButtons.map((b) => <ResultActions key={b.key} actions={b.list} label={t("actionsStep")} />)}
      {made.length > 0 && convId && <div className="made">{made.map((f) => <FileCard key={f} convId={convId} path={f} />)}</div>}
      {offers.length > 0 && <div className="memory-chips">{offers.map((o) => <InstallOffer key={o.key} id={o.id} {...(o.why ? { why: o.why } : {})} {...(convId ? { convId } : {})} />)}</div>}
      {kept.length > 0 && <div className="memory-chips">{kept.map((k) => <MemoryChip key={k.key} note={k.note} {...(k.topic ? { topic: k.topic } : {})} />)}</div>}
      {sounds.length > 0 && (
        <div className="activity-audio">
          {sounds.map(({ id, title, lyrics, cover }) => (
            <div key={id} className="audio-card">
              <MadeMedia
                file={{ assetId: id }}
                kind="audio"
                name={`${title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60) || `kesher-music-${id.slice(0, 8)}`}.mp3`}
                {...(title ? { title } : {})}
                {...(cover ? { poster: withToken(`/api/assets/${cover}`) } : {})}
                {...(convId ? { convId } : {})}
              />
              <ResultActions actions={playerActions(id, "audio", can)} label={t("actionsSound")} />
              {lyrics && (
                <details className="audio-lyrics">
                  <summary>{t("songLyrics")}</summary>
                  <pre dir="auto">{lyrics}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="activity-images">
          {videos.map((id) => (
            <div key={id} className="made-with-actions">
              <MadeMedia file={{ assetId: id }} kind="video" name={`kesher-video-${id.slice(0, 8)}.webm`} {...(convId ? { convId } : {})} />
              <ResultActions actions={playerActions(id, "video", can)} label={t("actionsVideo")} />
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="activity-images">
          {images.map((id) => (
            <div key={id} className="made-with-actions">
              <MadeMedia file={{ assetId: id }} kind="image" name={`kesher-image-${id.slice(0, 8)}.png`} {...(convId ? { convId } : {})} />
              <ResultActions actions={imageActions(id, madeBy.get(id), can)} label={t("actionsPicture")} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The last lines of a running build or command, like a small terminal under the step (as Claude, Cursor
 * and Codex show a command's output while it runs). Open it to see more.
 */
function LiveOutput({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  return (
    <details className="live-output" open>
      <summary className="small muted">{t("liveOutput")}</summary>
      <pre dir="ltr">{lines.slice(-12).join("\n")}</pre>
    </details>
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
 * A file the agent made, right in the conversation: download it, save it to Drive, open it in its editor (a
 * picture, video, sound or 3D model, which also plays here), open its folder, or (in the desktop app) run it.
 */
export function FileCard({ convId, path }: { convId: string; path: string }) {
  const name = path.split("/").pop() ?? path;
  const runnable = /\.(exe|msi|bat|cmd|app)$/i.test(name);
  const kind = mediaKindOf(null, name);
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
      <FileChips file={{ convId, path }} name={name} kind={kind} />
      {desktop()?.openPath && (
        <button type="button" onClick={() => void folder().then((p) => desktop()!.openPath!(p.replace(/[\\/][^\\/]+$/, "")))}>{t("openFolder")}</button>
      )}
      {runnable && desktop()?.runFile && (
        <button type="button" onClick={() => void folder().then((p) => desktop()!.runFile!(p))}>{t("runProgram")}</button>
      )}
      {kind && kind !== "model" && <div className="file-card-media"><MediaView src={fileUrl({ convId, path })} kind={kind} name={name} /></div>}
    </div>
  );
}
