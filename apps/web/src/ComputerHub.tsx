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
      onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 180); }}
      onMouseLeave={() => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 260); }}
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
