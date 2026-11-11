import { useEffect, useState } from "react";
import type { CategoryDefinition, ModelInfo } from "@kesher/shared";
import { api, type ModelListing } from "./api";
import { getLocale, t } from "./i18n";
import { Select } from "./ui/Select";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }

/** "Active models": the chat, image and the other category defaults, chosen from every installed model. */

export function ActiveModels() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<CategoryDefinition[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api<Settings>("/api/settings").then(setSettings);
    void api<CategoryDefinition[]>("/api/categories").then(setCategories);
    void api<ModelListing>("/api/models").then((l) => setModels(l.models));
  }, []);
  if (!settings) return null;

  const set = async (category: string, modelId: string) => {
    const activeModels = { ...settings.activeModels, [category]: modelId };
    if (!modelId) delete activeModels[category];
    const next = await api<Settings>("/api/settings", { method: "PUT", body: { activeModels } });
    setSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="card stack">
      <div className="row"><h2 className="grow">{t("activeModels")}</h2>{saved && <span className="pill good">{t("saved")}</span>}</div>
      <p className="muted">{t("activeModelsHint")}</p>
      <div className="grid-2">
        {categories.map((c) => {
          const options = models.filter((m) => m.category === c.id);
          const current = settings.activeModels[c.id] ?? "";
          return (
            <label key={c.id}>
              {c.label[getLocale()] ?? c.label.en}
              <Select value={current} onChange={(e) => void set(c.id, e.target.value)}>
                <option value="">{t("none")}</option>
                {current && !options.some((m) => m.id === current) && <option value={current}>{current.split(/[\\/]/).pop()}</option>}
                {options.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
              </Select>
            </label>
          );
        })}
        <label title={getLocale() === "he" ? "בזמן כתיבת קוד, המודל מציע את ההמשך באפור; Tab מכניס. מודל קוד קטן ומהיר הכי טוב." : "While you write code, the model suggests what comes next in grey; Tab inserts it. A small fast coder model works best."}>
          {getLocale() === "he" ? "הצעות קוד תוך כדי כתיבה (Inline)" : "Code suggestions while typing (inline)"}
          <Select value={settings.activeModels.codeInline ?? ""} onChange={(e) => void set("codeInline", e.target.value)}>
            <option value="">{getLocale() === "he" ? "כבוי" : "Off"}</option>
            {settings.activeModels.codeInline && !models.some((m) => m.id === settings.activeModels.codeInline) && <option value={settings.activeModels.codeInline}>{settings.activeModels.codeInline}</option>}
            {models.filter((m) => m.category === "chat").sort((a, b) => Number(/coder|code/i.test(b.name)) - Number(/coder|code/i.test(a.name))).map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
          </Select>
        </label>
      </div>
    </section>
  );
}
