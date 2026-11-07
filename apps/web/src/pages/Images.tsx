import { useState } from "react";
import { pickModel } from "../ModelPicker";
import { api, withToken, type Asset } from "../api";
import { useModels } from "../useModels";
import { t } from "../i18n";

/** Text-to-image with any image provider (ComfyUI today; cloud APIs through plugins). */
export function ImagesPage() {
  const { models } = useModels("image");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const selected = modelId || models[0]?.id || "";

  async function generate() {
    let use = selected;
    if (!use) {
      // No image model yet: let the user choose or get one instead of an error.
      const picked = await pickModel("image");
      if (!picked) return;
      setModelId(picked);
      use = picked;
    }
    setBusy(true);
    setError("");
    try {
      const { assets } = await api<{ assets: Asset[] }>("/api/images", {
        method: "POST",
        body: { modelId: use, prompt, width, height, steps },
      });
      setResults((prev) => [...assets, ...prev]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>{t("images")}</h1>
      {models.length === 0 && <p className="muted">{t("noModels")}</p>}
      <form
        className="card"
        style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <label style={{ gridColumn: "1 / -1" }}>
          {t("pickModel")}
          <select value={selected} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
          </select>
        </label>
        <label style={{ gridColumn: "1 / -1" }}>
          {t("prompt")}
          <textarea rows={3} dir="auto" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <span className="row">
            <button
              type="button"
              className="as-link"
              disabled={!prompt.trim() || enhancing}
              title={t("enhanceHint")}
              onClick={() => {
                setEnhancing(true);
                void api<{ prompt: string }>("/api/prompts/enhance", { method: "POST", body: { prompt, kind: "image" } })
                  .then((r) => setPrompt(r.prompt), (e: Error) => setError(e.message))
                  .finally(() => setEnhancing(false));
              }}
            >
              ✨ {enhancing ? "…" : t("enhancePrompt")}
            </button>
          </span>
        </label>
        <label>{t("width")}<input type="number" step={64} value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>
        <label>{t("height")}<input type="number" step={64} value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label>
        <label>{t("steps")}<input type="number" value={steps} onChange={(e) => setSteps(Number(e.target.value))} /></label>
        <div style={{ alignSelf: "end" }}>
          <button type="submit" className="primary" disabled={busy || !selected || !prompt.trim()}>
            {busy ? "…" : t("generate")}
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {results.map((a) => (
          <figure key={a.id} style={{ margin: 0 }}>
            <img src={withToken(`/api/assets/${a.id}`)} alt={String(a.meta?.prompt ?? "")} style={{ width: "100%", borderRadius: 10 }} />
            <figcaption className="muted">seed {String(a.meta?.seed ?? "")}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
