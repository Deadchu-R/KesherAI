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
  useEffect(() => {
    show = (r) => {
      setReq(r);
      setModels(null);
      void api<{ models: ModelInfo[] }>("/api/models").then((l) => setModels(l.models)).catch(() => setModels([]));
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
            <p className="muted">{t("pickModelHint")}</p>
            <div className="list pick-list">
              {list.map((m) => (
                <button key={m.id} type="button" className="pick-row" onClick={() => void choose(m.id)}>
                  <strong dir="ltr">{m.name}</strong>
                  <span className="muted mono" dir="ltr">{m.providerId}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {models !== null && list.length === 0 && <p>{t("pickModelNone", { category: label })}</p>}
        <div className="row">
          <button type="button" className={list.length ? "" : "primary"} onClick={() => go("#/models")}>{t("pickModelDownload")}</button>
          <button type="button" onClick={() => go("#/connections")}>{t("pickModelConnect")}</button>
          <span className="grow" />
          <button type="button" onClick={() => close(null)}>{t("cancel")}</button>
        </div>
      </div>
    </div>
  );
}
