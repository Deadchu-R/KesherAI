import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ModelInfo } from "./api";
import { refreshComputers } from "./computers";
import { toast } from "./library";
import { thinkingLevels, type ThinkingLevel } from "@kesher/shared";
import { getLocale, he$, t } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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
 * A model's id as a name to show when the model is not in the list right now (its engine is not loaded): without
 * the connection's prefix, the folders and the file ending ("llamacpp/Qwen3.8-27B-Q4" → "Qwen3.8-27B-Q4").
 *
 * @param id - The model id.
 * @returns The short name.
 */
export function shortModelName(id: string): string {
  return id.split(/[\\/]/).pop()!.replace(/\.(gguf|safetensors)$/i, "") || id;
}

/**
 * The composer's model chooser (see the top of this file).
 *
 * @param props.models - Chat models to offer.
 * @param props.value - The conversation's current model id.
 * @param props.onChange - Called with the chosen model id.
 * @param props.thinking - The chat's thinking level and its setter (null = the model's default); the picker shows
 *   only for local reasoning models (thinking.ts).
 * @param props.auto - "Auto" (model-router.ts): whether it is on and its setter; the menu offers it first, and the
 *   chip shows "Auto · the last pick". Choosing a model turns it off (the page sends both).
 */
export function ModelMenu({ models, value, onChange, thinking, auto }: { models: ModelInfo[]; value: string; onChange: (id: string) => void; thinking?: { value?: ThinkingLevel; onChange: (level: ThinkingLevel | null) => void }; auto?: { on: boolean; onChange: (on: boolean) => void } }) {
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
  // Thinking levels this model's server can apply (none: the picker is hidden).
  const levels = thinking && current ? thinkingLevels(current.providerId, current.providerModelId || current.id, current.location) : [];
  const levelName = (l: ThinkingLevel) => (l === "off" ? L("כבויה", "Off") : l === "low" ? L("נמוכה", "Low") : L("גבוהה", "High"));
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
        {auto?.on && <span className="model-chip-auto">✨ {L("אוטומטי", "Auto")} ·</span>}
        <span className="model-chip-name" title={value || undefined}>{current?.name ?? (value ? shortModelName(value) : t("defaultModel"))}</span>
        {levels.length > 0 && thinking?.value && levels.includes(thinking.value) && <span className="model-chip-think" title={L("רמת חשיבה", "Thinking level")}>· {levelName(thinking.value)}</span>}
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="model-pop kmenu" role="listbox" aria-label={t("pickModel")}>
          {devices.length > 0 && (
            <div className="segmented model-where" role="group" aria-label={t("runWhere")}>
              <button type="button" className={where === "" ? "on" : ""} aria-pressed={where === ""} onClick={() => setWhere("")}>💻 {t("thisComputer")}</button>
              {devices.map((d) => (
                <button key={d} type="button" className={where === d ? "on" : ""} aria-pressed={where === d} onClick={() => setWhere(d)}>🖥 {deviceName(d)}</button>
              ))}
            </div>
          )}
          {where && <p className="muted small model-where-note">{t("runsOnNote", { name: deviceName(where) })}</p>}
          {levels.length > 0 && thinking && (
            // How much this reasoning model thinks before answering, for this chat (thinking.ts).
            <div className="model-think">
              <span className="small muted">{L("חשיבה", "Thinking")}</span>
              <div className="segmented" role="group" aria-label={L("רמת חשיבה לצ'אט הזה", "Thinking level for this chat")}>
                <button type="button" className={!thinking.value ? "on" : ""} aria-pressed={!thinking.value} title={L("ברירת המחדל של המודל", "The model's default")} onClick={() => thinking.onChange(null)}>{L("רגילה", "Default")}</button>
                {levels.map((l) => (
                  <button key={l} type="button" className={thinking.value === l ? "on" : ""} aria-pressed={thinking.value === l} onClick={() => thinking.onChange(l)}>{levelName(l)}</button>
                ))}
              </div>
            </div>
          )}
          <input autoFocus placeholder={t("searchModels")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("searchModels")} />
          <div className="model-pop-list">
            {auto && !q.trim() && (
              <button type="button" role="option" aria-selected={auto.on} className={`model-auto-opt${auto.on ? " on" : ""}`} onClick={() => { setOpen(false); if (!auto.on) auto.onChange(true); }}>
                <span className="grow">✨ {L("אוטומטי", "Auto")}<span className="muted small model-auto-hint">{L("בוחר את המודל המתאים לכל הודעה", "Picks the right model for each message")}</span></span>
                {auto.on && <span aria-hidden="true">✓</span>}
              </button>
            )}
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
                    aria-selected={m.id === value && !auto?.on}
                    className={m.id === value && !auto?.on ? "on" : ""}
                    onClick={() => {
                      setOpen(false);
                      if (m.id !== value || auto?.on) onChange(m.id);
                    }}
                  >
                    <span dir="ltr">{m.name}</span>
                    {m.id === value && !auto?.on && <span aria-hidden="true">✓</span>}
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
