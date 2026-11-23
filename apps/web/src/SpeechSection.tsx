import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, t } from "./i18n";
import { langName, SPEECH_LANGS } from "./DetectedLang";
import { HebrewVoicePicker, VoicePicker } from "./Speak";
import { Select } from "./ui/Select";

interface Info {
  choice: string;
  language: string;
  /** "My languages" as the server uses them, and whether they were chosen yet. */
  languages: string[];
  languagesSet: boolean;
  local: { engine: boolean; model?: string; recommended: { label: string; sizeGb: number }; busy?: string; error?: string; localPossible: boolean; gpuUpgrade?: number };
  clouds: Array<{ id: string; label: string }>;
  ttsClouds?: string[];
}

/** Settings → Speech: which engine turns speech into text, the language, and the local engine's state. */
export function SpeechSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const load = () => api<Info>(`/api/speech/stt?app=${getLocale()}`).then(setInfo, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
  // The first time: keep the default (the app's language plus English) as the saved choice.
  if (!info.languagesSet && info.languages.length) void api("/api/speech/stt", { method: "PUT", body: { languages: info.languages } }).then(load);
  const toggle = (code: string) => {
    const has = info.languages.includes(code);
    const next = has ? info.languages.filter((c) => c !== code) : [...info.languages, code];
    if (next.length) void api("/api/speech/stt", { method: "PUT", body: { languages: next } }).then(load);
  };
  const set = async (body: Record<string, string>) => {
    await api("/api/speech/stt", { method: "PUT", body });
    await load();
  };
  const ready = info.local.engine && !!info.local.model;
  return (
    <section className="card stack">
      <h2>{t("spTitle")}</h2>
      <p className="muted small">{t("spIntro")}</p>
      <label className="stack">
        <span>{t("spEngine")}</span>
        <Select value={info.choice} onChange={(e) => void set({ stt: e.target.value })}>
          <option value="auto">{t("spAuto")}</option>
          {info.local.localPossible && <option value="local">{t("spLocal", { model: info.local.recommended.label })}</option>}
          {info.clouds.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </label>
      <label className="stack">
        <span>{t("spLanguage")}</span>
        <Select value={info.language} onChange={(e) => void set({ language: e.target.value })}>
          <option value="auto">{t("spLangAuto")}</option>
          <option value="he">עברית</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
          <option value="ru">Русский</option>
        </Select>
      </label>
      {info.language === "auto" && (
        <div className="stack" role="group" aria-label={t("spMyLangs")}>
          <span>{t("spMyLangs")}</span>
          <div className="sp-langs">
            {SPEECH_LANGS.map((l) => <button key={l.code} type="button" className="chip-text" aria-pressed={info.languages.includes(l.code)} onClick={() => toggle(l.code)}>{langName(l.code)}</button>)}
          </div>
          <p className="muted small">{t("spMyLangsHint")}</p>
        </div>
      )}
      {info.local.localPossible && (
        <p className="small">
          {ready ? `✓ ${t("spReady", { model: info.local.recommended.label })}` : info.local.busy ? t("micPreparing") : t("spNotReady", { gb: info.local.recommended.sizeGb.toFixed(1) })}{" "}
          {!ready && !info.local.busy && <button type="button" className="link-btn" onClick={() => void api("/api/speech/stt/setup", { method: "POST" }).then(load)}>{t("micDownload")}</button>}
        </p>
      )}
      {ready && !info.local.busy && info.local.gpuUpgrade && (
        <p className="small">
          {t("spGpuUpgrade", { gb: info.local.gpuUpgrade.toFixed(2) })}{" "}
          <button type="button" className="link-btn" onClick={() => void api("/api/speech/stt/upgrade-gpu", { method: "POST" }).then(load)}>{t("spGpuNow")}</button>
        </p>
      )}
      {info.local.error && <p className="error small">{info.local.error}</p>}
      <h3 className="sp-sub">{t("ttsTitle")}</h3>
      <VoicePicker clouds={info.ttsClouds ?? []} />
      <HebrewVoicePicker />
    </section>
  );
}
