import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ModelInfo } from "./api";
import { t } from "./i18n";
import { refreshComputers } from "./computers";
import { toast } from "./library";

/**
 * The composer's model chooser: a searchable menu grouped by where the model
 * runs (this computer, a local server, the cloud) and by provider. Each
 * conversation keeps its own model, so one chat can use Claude, another
 * Gemini and another a local model, all at the same time.
 */

type Group = { key: string; label: string; where: ModelInfo["location"]; models: ModelInfo[] };

const WHERE_ORDER: Record<string, number> = { local: 0, server: 1, cloud: 2 };

let providerNames: Record<string, string> | undefined;
async function loadProviderNames(fresh = false): Promise<Record<string, string>> {
  if (!providerNames || fresh) {
    const list = await api<Array<{ id: string; name?: string }>>("/api/providers").catch(() => []);
    providerNames = Object.fromEntries(list.map((p) => [p.id, p.name ?? p.id]));
  }
  return providerNames;
}

/**
 * @param props.models - Chat models to offer.
 * @param props.value - The conversation's current model id.
 * @param props.onChange - Called with the chosen model id.
 */
export function ModelMenu({ models, value, onChange }: { models: ModelInfo[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findLine, setFindLine] = useState("");
  const [q, setQ] = useState("");
  const [names, setNames] = useState<Record<string, string>>(providerNames ?? {});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProviderNames().then(setNames);
  }, []);
  // Another computer of the user's (My devices) can appear while the app is open.
  useEffect(() => {
    if (open) void loadProviderNames(true).then(setNames);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);

  const current = models.find((m) => m.id === value);
  /** The user's other computers (My devices): each is a connection "device-…". */
  const deviceName = (providerId: string) => (names[providerId] ?? providerId).replace(/\s*\(your computer\)\s*$/i, "");
  const devices = useMemo(() => [...new Set(models.map((m) => m.providerId).filter((p) => p.startsWith("device-")))], [models]);
  const onDevice = current?.providerId.startsWith("device-") ? current.providerId : "";
  // Which computer runs the chat: this one ("") or one of My devices.
  const [where, setWhere] = useState<string>(onDevice);
  useEffect(() => {
    if (open) setWhere(onDevice);
  }, [open]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, Group>();
    for (const m of models) {
      if (devices.length && (where ? m.providerId !== where : m.providerId.startsWith("device-"))) continue;
      if (needle && !`${m.name} ${m.providerModelId} ${names[m.providerId] ?? m.providerId}`.toLowerCase().includes(needle)) continue;
      const key = m.providerId || "?";
      if (!map.has(key)) map.set(key, { key, label: names[key] ?? key, where: m.location, models: [] });
      map.get(key)!.models.push(m);
    }
    return [...map.values()].sort((a, b) => (WHERE_ORDER[a.where] ?? 3) - (WHERE_ORDER[b.where] ?? 3) || a.label.localeCompare(b.label));
  }, [models, q, names, where, devices]);

  const whereLabel = (w: ModelInfo["location"]) => (w === "cloud" ? t("whereCloud") : w === "server" ? t("whereServer") : t("whereLocal"));

  return (
    <div className="model-menu" ref={ref}>
      <button type="button" data-slide-menu className="model-chip" aria-haspopup="listbox" aria-expanded={open} aria-label={t("pickModel")} onClick={() => setOpen(!open)}>
        <span className={`where-dot ${current?.location ?? "local"}`} aria-hidden="true" />
        {onDevice && <span className="model-chip-device" title={t("runsOn", { name: deviceName(onDevice) })}>🖥 {deviceName(onDevice)} ·</span>}
        <span className="model-chip-name">{current?.name ?? (value || t("defaultModel"))}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="model-pop" role="listbox" aria-label={t("pickModel")}>
          {devices.length > 0 && (
            <div className="segmented model-where" role="group" aria-label={t("runWhere")}>
              <button type="button" className={where === "" ? "on" : ""} aria-pressed={where === ""} onClick={() => setWhere("")}>💻 {t("thisComputer")}</button>
              {devices.map((d) => (
                <button key={d} type="button" className={where === d ? "on" : ""} aria-pressed={where === d} onClick={() => setWhere(d)}>🖥 {deviceName(d)}</button>
              ))}
            </div>
          )}
          {where && <p className="muted small model-where-note">{t("runsOnNote", { name: deviceName(where) })}</p>}
          <input autoFocus placeholder={t("searchModels")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchModels")} />
          <div className="model-pop-list">
            {groups.length === 0 && <p className="muted small">{t("noModelsMatch")}</p>}
            {groups.map((g) => (
              <div key={g.key} className="model-group" role="group" aria-label={g.label}>
                <div className="model-group-head">
                  <span>{g.label}</span>
                  <span className={`where-tag ${g.where}`}>{whereLabel(g.where)}</span>
                </div>
                {g.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={m.id === value}
                    className={m.id === value ? "on" : ""}
                    onClick={() => {
                      setOpen(false);
                      if (m.id !== value) onChange(m.id);
                    }}
                  >
                    <span dir="ltr">{m.name}</span>
                    {m.id === value && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button type="button" className="model-pop-foot small" disabled={finding} onClick={() => {
            setFinding(true);
            void refreshComputers(setFindLine).then((msg) => { toast(msg); return loadProviderNames(true).then(setNames); }, (e: Error) => toast(e.message)).finally(() => { setFinding(false); setFindLine(""); });
          }}>{finding ? `⟳ ${findLine || "…"}` : `⟳ ${t("findComputers")}`}</button>
          {!devices.length && <a className="model-pop-foot small" href="#/connections">{t("runOnOtherComputer")}</a>}
          <a className="model-pop-foot" href="#/connections">{t("connectMoreModels")}</a>
        </div>
      )}
    </div>
  );
}
