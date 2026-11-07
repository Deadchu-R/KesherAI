import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, t } from "./i18n";
import { toast } from "./library";

interface Tool { name: string; description?: string; annotations?: { readOnlyHint?: boolean; title?: string } }
interface Server {
  id: string; name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; headers?: Record<string, string>; enabled: boolean; preset?: string; disabledTools?: string[];
  signedIn: boolean;
  status: { state: "off" | "connecting" | "ready" | "needs-sign-in" | "error"; error?: string; tools: Tool[]; server?: string };
}
interface Field { key: string; label: string; secret?: boolean; target: string; help?: string; prefix?: string }
interface Preset { id: string; name: string; he: string; en: string; transport: "stdio" | "http"; url?: string; command?: string; args?: string[]; fields?: Field[]; signIn?: boolean; needs?: string; link?: string }

const STATE_CLASS: Record<Server["status"]["state"], string> = { ready: "good", error: "bad", "needs-sign-in": "warn", connecting: "", off: "" };

/**
 * Connections → MCP: tools from other apps (Notion, GitHub, Jira, Unity…)
 * that every chat and agent can use. One click for well-known services,
 * a form for any other server, or paste a Claude Desktop / Cursor config.
 */
export function McpSection() {
  const [servers, setServers] = useState<Server[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [adding, setAdding] = useState<Preset | "custom" | "import" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api<{ servers: Server[]; presets: Preset[] }>("/api/mcp").then((r) => { setServers(r.servers); setPresets(r.presets); }, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const signIn = async (id: string) => {
    try {
      const { url } = await api<{ url: string }>(`/api/mcp/servers/${id}/sign-in`, { method: "POST" });
      window.open(url, "_blank", "noopener");
      toast(t("mcpSignInOpened"));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const save = async (s: Partial<Server> & { id: string }) => {
    const { status: _s, signedIn: _i, ...cfg } = s as Server;
    await api("/api/mcp/servers", { method: "PUT", body: cfg }).catch((e: Error) => toast(e.message));
    await load();
  };
  const unused = presets.filter((p) => !servers.some((s) => s.preset === p.id || s.id === p.id));

  return (
    <section className="card stack">
      <h2>{t("mcpTitle")}</h2>
      <p className="muted small">{t("mcpIntro")}</p>

      {servers.length > 0 && (
        <div className="mcp-list">
          {servers.map((s) => (
            <div key={s.id} className="mcp-row">
              <div className="row">
                <strong className="grow">{s.name}</strong>
                <span className={`pill ${STATE_CLASS[s.status.state]}`} title={s.status.error}>{t(`mcpState_${s.status.state.replace(/-/g, "_")}` as "mcpState_ready", { n: String(s.status.tools.length) })}</span>
              </div>
              <span className="mono muted small" dir="ltr">{s.transport === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ")}</span>
              {s.status.error && <p className="error small">{s.status.error}</p>}
              <div className="row wrap">
                {s.status.state === "needs-sign-in" && <button type="button" className="primary" onClick={() => void signIn(s.id)}>{t("mcpSignIn")}</button>}
                <label className="row small"><input type="checkbox" checked={s.enabled} onChange={(e) => void save({ ...s, enabled: e.target.checked })} />{t("mcpOn")}</label>
                {s.status.tools.length > 0 && <button type="button" className="link-btn" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? t("mcpHideTools") : t("mcpShowTools")}</button>}
                <span className="grow" />
                <button type="button" onClick={() => void api(`/api/mcp/servers/${s.id}/reconnect`, { method: "POST" }).then(load)}>{t("mcpReconnect")}</button>
                {s.signedIn && <button type="button" onClick={() => void api(`/api/mcp/servers/${s.id}/sign-out`, { method: "POST" }).then(load)}>{t("mcpSignOut")}</button>}
                <button type="button" onClick={() => void api(`/api/mcp/servers/${s.id}`, { method: "DELETE" }).then(load)}>{t("remove")}</button>
              </div>
              {open === s.id && (
                <ul className="mcp-tools">
                  {s.status.tools.map((tool) => {
                    const off = s.disabledTools?.includes(tool.name);
                    return (
                      <li key={tool.name}>
                        <label className="row">
                          <input type="checkbox" checked={!off} onChange={() => void save({ ...s, disabledTools: off ? (s.disabledTools ?? []).filter((x) => x !== tool.name) : [...(s.disabledTools ?? []), tool.name] })} />
                          <span className="mono">{tool.name}</span>
                          {tool.annotations?.readOnlyHint && <span className="pill">{t("mcpReadOnly")}</span>}
                        </label>
                        {tool.description && <p className="muted small">{tool.description.slice(0, 200)}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {unused.length > 0 && (
        <div className="mcp-presets">
          {unused.map((p) => (
            <button key={p.id} type="button" className="mcp-preset" onClick={() => setAdding(p)} title={getLocale() === "he" ? p.he : p.en}>
              <strong>{p.name}</strong>
              <span className="muted small">{getLocale() === "he" ? p.he : p.en}</span>
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <button type="button" onClick={() => setAdding("custom")}>{t("mcpAddCustom")}</button>
        <button type="button" onClick={() => setAdding("import")}>{t("mcpImport")}</button>
      </div>
      <GoogleApps />

      {adding && <AddDialog what={adding} onClose={() => setAdding(null)} onDone={async (id, signInNow) => { setAdding(null); await load(); if (signInNow) void signIn(id); }} />}
    </section>
  );
}

function AddDialog({ what, onClose, onDone }: { what: Preset | "custom" | "import"; onClose: () => void; onDone: (id: string, signIn: boolean) => Promise<void> }) {
  const preset = typeof what === "object" ? what : undefined;
  const [vals, setVals] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ id: "", name: "", transport: "http" as "http" | "stdio", url: "", command: "", args: "", token: "" });
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (what === "import") {
        const { added } = await api<{ added: string[] }>("/api/mcp/import", { method: "POST", body: { json } });
        toast(t("mcpImported", { n: String(added.length) }));
        await onDone(added[0] ?? "", false);
        return;
      }
      let cfg: Record<string, unknown>;
      if (preset) {
        const env: Record<string, string> = {};
        const headers: Record<string, string> = {};
        const args = [...(preset.args ?? [])];
        for (const f of preset.fields ?? []) {
          const v = vals[f.key]?.trim() ?? "";
          if (!v) throw new Error(t("mcpFill", { field: f.label }));
          if (f.target === "arg") args.push(v);
          else if (f.target.startsWith("env:")) env[f.target.slice(4)] = v;
          else headers[f.target.slice(7)] = (f.prefix ?? "") + v;
        }
        cfg = { id: preset.id, name: preset.name, preset: preset.id, transport: preset.transport, enabled: true, ...(preset.transport === "http" ? { url: preset.url, headers } : { command: preset.command, args, env }) };
      } else {
        const id = (custom.id || custom.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
        cfg = custom.transport === "http"
          ? { id, name: custom.name || id, transport: "http", url: custom.url, headers: custom.token ? { Authorization: `Bearer ${custom.token}` } : {}, enabled: true }
          : { id, name: custom.name || id, transport: "stdio", command: custom.command, args: custom.args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [], env: {}, enabled: true };
      }
      await api("/api/mcp/servers", { method: "PUT", body: cfg });
      await onDone(String(cfg.id), !!preset?.signIn);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form className="dialog card stack" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <strong>{preset ? t("mcpAddNamed", { name: preset.name }) : what === "import" ? t("mcpImport") : t("mcpAddCustom")}</strong>
        {preset && <p className="muted small">{getLocale() === "he" ? preset.he : preset.en}</p>}
        {preset?.signIn && <p className="small">{t("mcpWillSignIn")}</p>}
        {preset?.needs && <p className="muted small">{t(preset.needs === "uv" ? "mcpNeedsUv" : "mcpNeedsNode")}</p>}
        {preset?.fields?.map((f) => (
          <label key={f.key} className="stack">
            <span>{f.label}{f.help && <> · <a href={f.help} target="_blank" rel="noreferrer">{t("mcpWhere")}</a></>}</span>
            <input dir="ltr" type={f.secret ? "password" : "text"} autoComplete="off" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
          </label>
        ))}
        {preset?.link && <a className="small" href={preset.link} target="_blank" rel="noreferrer">{t("mcpDocs")}</a>}
        {what === "custom" && (
          <>
            <div className="row">
              <label className="row small"><input type="radio" checked={custom.transport === "http"} onChange={() => setCustom({ ...custom, transport: "http" })} />{t("mcpOnline")}</label>
              <label className="row small"><input type="radio" checked={custom.transport === "stdio"} onChange={() => setCustom({ ...custom, transport: "stdio" })} />{t("mcpProgram")}</label>
            </div>
            <label className="stack"><span>{t("name")}</span><input required value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
            {custom.transport === "http" ? (
              <>
                <label className="stack"><span>{t("mcpUrl")}</span><input dir="ltr" required placeholder="https://…/mcp" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} /></label>
                <label className="stack"><span>{t("mcpToken")}</span><input dir="ltr" type="password" autoComplete="off" value={custom.token} onChange={(e) => setCustom({ ...custom, token: e.target.value })} /></label>
              </>
            ) : (
              <>
                <label className="stack"><span>{t("mcpCommand")}</span><input dir="ltr" required placeholder="npx" value={custom.command} onChange={(e) => setCustom({ ...custom, command: e.target.value })} /></label>
                <label className="stack"><span>{t("mcpArgs")}</span><input dir="ltr" placeholder="-y @scope/server" value={custom.args} onChange={(e) => setCustom({ ...custom, args: e.target.value })} /></label>
              </>
            )}
          </>
        )}
        {what === "import" && (
          <label className="stack">
            <span className="muted small">{t("mcpImportHelp")}</span>
            <textarea dir="ltr" rows={8} className="mono" value={json} onChange={(e) => setJson(e.target.value)} placeholder={'{ "mcpServers": { … } }'} />
          </label>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="primary" disabled={busy}>{preset?.signIn ? t("mcpAddAndSignIn") : t("add")}</button>
        </div>
      </form>
    </div>
  );
}

interface GoogleStatus { configured: boolean; connected: boolean; email: string | null; services: string[] }

/** Gmail and Google Calendar: connected with Google's own sign-in and consent page, like Drive. */
function GoogleApps() {
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const load = () => api<GoogleStatus>("/api/google").then(setG, () => setG(null));
  useEffect(() => void load(), []);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void api<GoogleStatus>("/api/google").then((s) => { setG(s); if (s.services.includes(waiting)) setWaiting(null); }), 2000);
    return () => clearInterval(id);
  }, [waiting]);
  if (!g) return null;
  const connect = async (service: string) => {
    try {
      const { url } = await api<{ url: string }>("/api/google/connect", { method: "POST", body: { services: [service] } });
      window.open(url, "_blank", "noopener");
      setWaiting(service);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const apps = [
    { id: "gmail", name: "Gmail", text: t("mcpGmail") },
    { id: "calendar", name: "Google Calendar", text: t("mcpCalendar") },
    { id: "drive", name: "Google Drive", text: t("mcpDrive") },
  ];
  return (
    <div className="mcp-presets">
      {apps.map((a) => {
        const on = g.services.includes(a.id);
        return (
          <div key={a.id} className="mcp-preset card-like">
            <strong>{a.name}{on && <span className="pill good" style={{ marginInlineStart: 8 }}>{t("connected")}</span>}</strong>
            <span className="muted small">{a.text}</span>
            {on ? (
              <span className="muted small">{g.email}</span>
            ) : g.configured ? (
              <button type="button" className="primary" onClick={() => void connect(a.id)}>{waiting === a.id ? t("driveWaiting") : t("mcpGoogleConnect")}</button>
            ) : (
              <span className="muted small">{t("mcpGoogleNoClient")} <a href="#/settings">{t("settings")}</a></span>
            )}
          </div>
        );
      })}
    </div>
  );
}
