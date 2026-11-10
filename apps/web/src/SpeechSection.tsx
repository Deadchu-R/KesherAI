import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { VoicePicker } from "./Speak";
import { Select } from "./ui/Select";

interface Info {
  choice: string;
  language: string;
  local: { engine: boolean; model?: string; recommended: { label: string; sizeGb: number }; busy?: string; error?: string; localPossible: boolean };
  clouds: Array<{ id: string; label: string }>;
  ttsClouds?: string[];
}

/** Settings → Speech: which engine turns speech into text, the language, and the local engine's state. */
export function SpeechSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const load = () => api<Info>("/api/speech/stt").then(setInfo, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
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
      {info.local.localPossible && (
        <p className="small">
          {ready ? `✓ ${t("spReady", { model: info.local.recommended.label })}` : info.local.busy ? t("micPreparing") : t("spNotReady", { gb: info.local.recommended.sizeGb.toFixed(1) })}{" "}
          {!ready && !info.local.busy && <button type="button" className="link-btn" onClick={() => void api("/api/speech/stt/setup", { method: "POST" }).then(load)}>{t("micDownload")}</button>}
        </p>
      )}
      {info.local.error && <p className="error small">{info.local.error}</p>}
      <h3 className="sp-sub">{t("ttsTitle")}</h3>
      <VoicePicker clouds={info.ttsClouds ?? []} />
    </section>
  );
}
