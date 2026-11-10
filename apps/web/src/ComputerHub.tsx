import { useEffect, useRef, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, t } from "./i18n";
import { desktop, toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** Another computer this window can open: one of "My devices", or one connected with a link. */
interface Other { key: string; name: string; online: boolean; open: () => Promise<{ name?: string; error?: string }> }

interface Hardware {
  platform: string;
  cpu: string;
  ramTotal: number;
  ramFree: number;
  gpus: Array<{ name: string; vramTotal: number; vramFree: number; computeCap?: number }>;
  unifiedMemory: boolean;
}
interface Info {
  hw?: Hardware;
  name?: string;
  address?: string;
  version?: string;
  model?: string | null;
  gpuPlan?: string | null;
  activeChat?: string;
  remote?: boolean;
}

const GB = 1024 ** 3;
const fmt = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`;
const os = (p: string) => (p === "win32" ? "Windows" : p === "darwin" ? "macOS" : p === "linux" ? "Linux" : p);

/** A meter: used / total. */
function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="hub-meter">
      <div className="hub-meter-top">
        <span>{label}</span>
        <span className="muted" dir="ltr">{fmt(used)} / {fmt(total)}</span>
      </div>
      <span className={`hub-bar ${pct > 85 ? "hot" : ""}`}><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

interface PcStatus {
  system?: { ramUsed: number; ramTotal: number; cpu: number; cpuTemp?: number };
  cards: Array<{ index: number; name: string; temp: number; util: number; memUsed: number; memTotal: number; power?: number }>;
  cooling: boolean;
  running: number;
  model: string | null;
  comfy: boolean;
  selfWork: string | null;
}

/** A percent bar (load). */
function Pct({ label, pct, extra }: { label: string; pct: number; extra?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="hub-meter">
      <div className="hub-meter-top">
        <span>{label}</span>
        <span className="muted" dir="ltr">{v}%{extra ? ` · ${extra}` : ""}</span>
      </div>
      <span className={`hub-bar ${v > 90 ? "hot" : ""}`}><span style={{ width: `${v}%` }} /></span>
    </div>
  );
}

const hot = (c?: number) => (c === undefined ? "" : `${c}°C`);

/**
 * The computer's load, live while the panel is open (from the phone too): processor and memory, each graphics
 * card's load, memory, temperature and power, and what KesherAI runs. Terminate frees everything (self-work,
 * chats, models, ComfyUI, Antigravity) and restarts KesherAI — for when remote work gets the computer stuck.
 */
function PcLoad() {
  const [st, setSt] = useState<PcStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () => void api<PcStatus>("/api/pc-status").then((r) => alive && setSt(r), () => undefined);
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!st) return null;
  const terminate = async () => {
    if (!confirm(L("לעצור הכל ולהפעיל מחדש את קשר?\n\nזה עוצר את העבודה העצמית, את כל השיחות, את המודלים, את ComfyUI ואת Antigravity, ומפעיל את קשר מחדש (עד כחצי דקה). עבודה שלא נשמרה בשיחה תיעצר.", "Stop everything and restart KesherAI?\n\nThis stops self-work, every chat, the models, ComfyUI and Antigravity, and restarts KesherAI (up to about half a minute). Work in progress in a chat is stopped."))) return;
    setBusy(true);
    try {
      const r = await api<{ restarting: boolean }>("/api/system/terminate", { method: "POST", body: { confirm: "terminate" } });
      toast(r.restarting ? L("עוצר הכל ומפעיל מחדש…", "Stopping everything and restarting…") : L("הכל נעצר. הפעל את קשר מחדש בחלון שלו.", "Everything stopped. Restart KesherAI in its window."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const busyNow = [st.model && L(`מודל: ${st.model}`, `Model: ${st.model}`), st.running > 0 && L(`${st.running} עובדים עכשיו`, `${st.running} working now`), st.comfy && "ComfyUI", st.selfWork && L("עבודה עצמית", "Self-work")].filter(Boolean).join(" · ");
  return (
    <div className="hub-load">
      <span className="muted small">{L("עומס עכשיו", "Load now")}{st.cooling ? L(" · ❄ מקרר", " · ❄ cooling down") : ""}</span>
      {st.system && <Pct label={L("מעבד", "Processor")} pct={st.system.cpu} extra={hot(st.system.cpuTemp)} />}
      {st.system && <Pct label={L("זיכרון (RAM)", "Memory (RAM)")} pct={(st.system.ramUsed / st.system.ramTotal) * 100} extra={`${fmt(st.system.ramUsed)} / ${fmt(st.system.ramTotal)}`} />}
      {st.cards.map((c) => (
        <div key={c.index} className="hub-card">
          <Pct label={`${c.name.replace(/^NVIDIA (GeForce )?/i, "")} · ${L("עומס", "load")}`} pct={c.util} extra={[hot(c.temp), c.power ? `${Math.round(c.power)}W` : ""].filter(Boolean).join(" · ")} />
          <Pct label="VRAM" pct={(c.memUsed / c.memTotal) * 100} extra={`${fmt(c.memUsed)} / ${fmt(c.memTotal)}`} />
        </div>
      ))}
      {busyNow && <p className="muted small" dir="auto">{busyNow}</p>}
      <button type="button" className="danger hub-terminate" disabled={busy} onClick={() => void terminate()}>⏻ {L("Terminate: לעצור הכל ולהפעיל מחדש", "Terminate: stop everything and restart")}</button>
    </div>
  );
}

/**
 * The computer icon at the end of the top bar. Hovering (or tapping) it
 * shows the connected computer: name, address, system, memory and each
 * graphics card in use, the loaded model and how it uses the cards.
 *
 * @param props.online - Whether the server answers.
 * @param props.status - Accessible status text.
 * @param props.icon - The computer icon.
 */
export function ComputerHub({ online, status, icon }: { online: boolean | null; status: string; icon: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Info>({});
  const [others, setOthers] = useState<Other[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      const [hw, links, version, engine, settings] = await Promise.all([
        api<Hardware>("/api/hardware").catch(() => undefined),
        api<{ name?: string; links?: Array<{ url: string }> }>("/api/remote/links").catch(() => undefined),
        api<{ version: string; commit?: string }>("/api/version").catch(() => undefined),
        api<{ modelPath?: string; running: boolean; gpus?: string }>("/api/engines/llamacpp").catch(() => undefined),
        api<{ activeModels?: Record<string, string>; remote?: { enabled?: boolean } }>("/api/settings").catch(() => undefined),
      ]);
      if (!alive) return;
      setInfo({
        ...(hw ? { hw } : {}),
        ...(links?.name ? { name: links.name } : {}),
        address: links?.links?.[0]?.url?.replace(/^https?:\/\//, "") ?? location.host,
        ...(version ? { version: `v${version.version}${version.commit ? ` · ${version.commit}` : ""}` } : {}),
        model: engine?.running && engine.modelPath ? engine.modelPath.split(/[\\/]/).pop() ?? null : null,
        gpuPlan: engine?.gpus ?? null,
        ...(settings?.activeModels?.chat ? { activeChat: settings.activeModels.chat } : {}),
        remote: !!settings?.remote?.enabled,
      });
    };
    // The user's other computers (desktop app only: each opens in a window of its own, like a tab of that computer).
    const bridge = desktop();
    const loadOthers = async () => {
      if (!bridge || isRemote()) return;
      const [mine, linked] = await Promise.all([
        api<{ devices: Array<{ id: string; name: string; online: boolean; me: boolean }> }>("/api/devices").catch(() => ({ devices: [] })),
        bridge.computers?.().catch(() => []) ?? Promise.resolve([]),
      ]);
      if (!alive) return;
      setOthers([
        ...mine.devices.filter((d) => !d.me && bridge.openDevice).map((d) => ({ key: `d:${d.id}`, name: d.name, online: d.online, open: () => bridge.openDevice!(d.id) })),
        ...linked.filter(() => !!bridge.openComputer).map((c) => ({ key: `c:${c.origin}`, name: c.name, online: true, open: () => bridge.openComputer!(c.origin) })),
      ]);
    };
    void load();
    void loadOthers();
    const id = setInterval(load, 3000);
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      alive = false;
      clearInterval(id);
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);

  const hw = info.hw;
  return (
    <div
      className="hub"
      ref={ref}
      // Hover opens it with a mouse only: on a phone a tap is the only way (a tap's emulated mouse events closed it again).
      onPointerEnter={(e) => { if (e.pointerType !== "mouse") return; clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 180); }}
      onPointerLeave={(e) => { if (e.pointerType !== "mouse") return; clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 260); }}
    >
      <button type="button" className={`bar-status ${online ? "ok" : online === false ? "off" : ""}`} aria-label={status} aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        <span className="dot" aria-hidden="true" />
      </button>
      {open && (
        <div className="hub-pop" role="dialog" aria-label={t("pcHubTitle")}>
          <div className="hub-head">
            <span className={`hub-led ${online ? "ok" : "off"}`} aria-hidden />
            <div>
              <strong dir="ltr">{info.name ?? location.hostname}</strong>
              <span className="muted small" dir="ltr">{info.address}{info.version ? ` · ${info.version}` : ""}</span>
            </div>
          </div>
          {hw ? (
            <>
              <p className="hub-line small"><span className="muted">{t("hubSystem")}</span> <span dir="ltr">{os(hw.platform)} · {hw.cpu.replace(/\(R\)|\(TM\)|CPU|Processor/gi, "").replace(/\s+/g, " ").trim()}</span></p>
              <Meter label={hw.unifiedMemory ? t("hubMemoryShared") : t("hubMemory")} used={hw.ramTotal - hw.ramFree} total={hw.ramTotal} />
              {hw.gpus.map((g, i) => (
                <Meter key={i} label={`${g.name.replace(/^NVIDIA (GeForce )?/i, "")}${g.computeCap ? ` · CUDA ${g.computeCap}` : ""}`} used={g.vramTotal - g.vramFree} total={g.vramTotal} />
              ))}
              {hw.gpus.length === 0 && !hw.unifiedMemory && <p className="muted small">{t("hubNoGpu")}</p>}
              <PcLoad />
            </>
          ) : (
            <p className="muted small">{t("barChecking")}</p>
          )}
          <div className="hub-facts small">
            <p><span className="muted">{t("hubChat")}</span> <span dir="ltr">{info.activeChat?.split("/").slice(1).join("/") || "—"}</span></p>
            <p><span className="muted">{t("hubLoaded")}</span> <span dir="ltr">{info.model ?? t("hubNone")}</span></p>
            {info.gpuPlan && <p className="muted" dir="ltr">{info.gpuPlan}</p>}
            <p><span className="muted">{t("hubRemote")}</span> {info.remote ? t("hubOn") : t("hubOff")}</p>
          </div>
          {others.length > 0 && (
            <div className="hub-others">
              <span className="muted small">{L("מחשבים אחרים", "Other computers")}</span>
              {others.map((o) => (
                <button key={o.key} type="button" disabled={!o.online} title={o.online ? L("נפתח בחלון משלו, כמו לשונית של המחשב ההוא", "Opens in its own window, like a tab of that computer") : L("לא זמין כרגע", "Not reachable now")} onClick={() => void o.open().then((r) => (r.error ? toast(r.error) : setOpen(false)), (e: Error) => toast(e.message))}>
                  <span className={`hub-led ${o.online ? "ok" : "off"}`} aria-hidden />
                  <span className="grow" dir="auto">{o.name}</span>
                  <span className="muted small">{o.online ? L("פתח בחלון ↗", "Open in a window ↗") : L("לא זמין", "Offline")}</span>
                </button>
              ))}
            </div>
          )}
          {desktop() && !isRemote() && !others.length && (
            <p className="muted small"><a href="#/settings">{L("לחבר מחשב נוסף: הגדרות ← החיבורים", "Connect another computer: Settings → Connections")}</a></p>
          )}
          <div className="hub-actions">
            <a href="#/settings">{t("settings")}</a>
            <a href="#/models">{t("models")}</a>
          </div>
        </div>
      )}
    </div>
  );
}
