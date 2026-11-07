import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES, type ModelInfo } from "@kesher/shared";
import { api } from "./api";
import { getLocale, t } from "./i18n";

/**
 * "Choose a model" popup. Any screen that needs a model of some category
 * and has none calls {@link pickModel} instead of showing an error.
 */

interface Request {
  category: string;
  resolve: (modelId: string | null) => void;
}

let show: ((r: Request) => void) | undefined;

/**
 * Asks the user to choose a model of a category. The choice also becomes
 * the active model for that category.
 *
 * @param category - Category id, e.g. `chat` or `image`.
 * @returns The chosen model id, or `null` if the user closed the popup.
 */
export function pickModel(category: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ category, resolve });
  });
}

/** Mount once near the root of the app. */
export function ModelPickerHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [choice, setChoice] = useState("");
  useEffect(() => {
    show = (r) => {
      setReq(r);
      setModels(null);
      setChoice("");
      void api<{ models: ModelInfo[] }>("/api/models")
        .then((l) => {
          setModels(l.models);
          setChoice(l.models.find((m) => m.category === r.category)?.id ?? "");
        })
        .catch(() => setModels([]));
    };
    return () => {
      show = undefined;
    };
  }, []);
  if (!req) return null;

  const close = (id: string | null) => {
    req.resolve(id);
    setReq(null);
  };
  const choose = async (id: string) => {
    const settings = await api<{ activeModels: Record<string, string> }>("/api/settings");
    await api("/api/settings", { method: "PUT", body: { activeModels: { ...settings.activeModels, [req.category]: id } } });
    close(id);
  };
  const cat = BUILT_IN_CATEGORIES.find((c) => c.id === req.category);
  const label = cat ? (cat.label[getLocale()] ?? cat.label.en) : req.category;
  // Code sessions use chat models.
  const list = (models ?? []).filter((m) => m.category === req.category);
  const go = (hash: string) => {
    close(null);
    location.hash = hash;
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={() => close(null)}>
      <div className="dialog card" role="dialog" aria-modal="true" aria-label={t("pickModelTitle", { category: label })} onClick={(e) => e.stopPropagation()}>
        <h2>{t("pickModelTitle", { category: label })}</h2>
        {models === null && <p className="muted">{t("loading")}</p>}
        {models !== null && list.length > 0 && (
          <>
            <label className="stack">
              {t("model")}
              <select autoFocus value={choice} onChange={(e) => setChoice(e.target.value)} dir="ltr">
                {[...new Set(list.map((m) => m.providerId))].map((p) => (
                  <optgroup key={p} label={p}>
                    {list.filter((m) => m.providerId === p).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <p className="muted">{t("pickModelHint")}</p>
          </>
        )}
        {models !== null && list.length === 0 && <p>{t("pickModelNone", { category: label })}</p>}
        <div className="row">
          <button type="button" onClick={() => go("#/models")}>{t("pickModelDownload")}</button>
          <button type="button" onClick={() => go("#/connections")}>{t("pickModelConnect")}</button>
          <span className="grow" />
          <button type="button" onClick={() => close(null)}>{t("cancel")}</button>
          {list.length > 0 && <button type="button" className="primary" disabled={!choice} onClick={() => void choose(choice)}>{t("useModel")}</button>}
        </div>
      </div>
    </div>
  );
}
