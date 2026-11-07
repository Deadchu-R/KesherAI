import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { McpSection } from "../McpSection";
import { DevicesSection } from "../DevicesSection";

interface ProviderRow {
  id: string; type: string; name?: string; baseUrl?: string; location?: string;
  hasApiKey: boolean; healthy: boolean; autodetected: boolean;
}
interface Preset { config: { id: string; type: string; name?: string; baseUrl?: string; location?: string }; description: string; needsApiKey?: boolean }
interface ProviderType { type: string; displayName: string }
interface Plugin { id: string; name: string; version: string; status: string; error?: string }

/** Servers, cloud APIs and plugins — every place models can come from. */
export function ConnectionsPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [types, setTypes] = useState<ProviderType[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [form, setForm] = useState({ id: "", type: "openai-compatible", name: "", baseUrl: "", apiKey: "" });
  const [error, setError] = useState("");

  const reload = () => {
    api<ProviderRow[]>("/api/providers").then(setProviders).catch((e: Error) => setError(e.message));
    api<Plugin[]>("/api/plugins").then(setPlugins).catch(() => undefined);
  };

  useEffect(() => {
    reload();
    api<Preset[]>("/api/providers/presets").then(setPresets).catch(() => undefined);
    api<ProviderType[]>("/api/providers/types").then(setTypes).catch(() => undefined);
  }, []);

  async function add(config: Record<string, string>) {
    setError("");
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ""));
    try {
      await api("/api/providers", { method: "POST", body: clean });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    reload();
  }

  const fromPreset = (p: Preset) =>
    setForm({ id: p.config.id, type: p.config.type, name: p.config.name ?? "", baseUrl: p.config.baseUrl ?? "", apiKey: "" });

  return (
    <div className="page">
      <h1>{t("connections")}</h1>
      {error && <p className="error">{error}</p>}

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {providers.map((p) => (
          <div key={p.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row">
              <strong className="grow">{p.name ?? p.id}</strong>
              <span className={`pill ${p.healthy ? "good" : "bad"}`}>{p.healthy ? t("connected") : t("offline")}</span>
            </div>
            <span className="mono muted" dir="ltr" style={{ textAlign: "start" }}>{p.baseUrl ?? p.type}</span>
            <div className="row">
              <span className="pill">{p.location ?? "server"}</span>
              {p.autodetected && <span className="pill">{t("autodetected")}</span>}
              <button type="button" style={{ marginInlineStart: "auto" }} onClick={() => void remove(p.id)}>{t("remove")}</button>
            </div>
          </div>
        ))}
      </div>

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2>{t("presets")}</h2>
        <div className="row">
          {presets.map((p) => (
            <button key={p.config.id} type="button" title={p.description} onClick={() => fromPreset(p)}>{p.config.name}</button>
          ))}
        </div>
        <form
          style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
          onSubmit={(e) => {
            e.preventDefault();
            void add(form);
          }}
        >
          <label>{t("id")}<input required value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></label>
          <label>
            {t("type")}
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {types.map((ty) => <option key={ty.type} value={ty.type}>{ty.displayName}</option>)}
            </select>
          </label>
          <label>{t("name")}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>{t("baseUrl")}<input dir="ltr" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
          <label>{t("apiKey")}<input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
          <div style={{ alignSelf: "end" }}><button type="submit" className="primary">{t("add")}</button></div>
        </form>
      </section>

      <DevicesSection />

      <McpSection />

      <section className="card">
        <h2>{t("plugins")}</h2>
        <div className="list">
          {plugins.map((p) => (
            <div key={p.id} className="row">
              <span className="grow">{p.name} <span className="muted mono">v{p.version}</span></span>
              <span className={`pill ${p.status === "active" ? "good" : p.status === "error" ? "bad" : ""}`} title={p.error}>{p.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
