import { useEffect, useRef, useState } from "react";
import type { McpAppRef } from "@kesher/shared";
import { api } from "./api";
import { getLocale } from "./i18n";
import { appDocument } from "./mcp-app-doc";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** One JSON-RPC message from the view. */
interface RpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A tool's own view inside the chat (MCP Apps, protocol 2026-01-26): a sandboxed frame (scripts only: no access to
 * KesherAI's page, cookies or storage), talking to KesherAI over postMessage. The view is given the tool's input and
 * result; it may call its own server's tools (one that changes things asks first), open https links in the browser,
 * and put text in the message box.
 */
export function McpAppView({ app, onMessage }: { app: McpAppRef; onMessage?: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<{ html: string; border: boolean } | null>(null);
  const [error, setError] = useState("");
  const [height, setHeight] = useState(320);

  useEffect(() => {
    let off = false;
    void api<{ html: string; csp: { connect: string[]; resource: string[] }; prefersBorder: boolean }>(`/api/mcp/servers/${encodeURIComponent(app.server)}/ui?uri=${encodeURIComponent(app.uri)}`).then(
      (r) => !off && setDoc({ html: appDocument(r.html, r.csp), border: r.prefersBorder }),
      (e: Error) => !off && setError(e.message),
    );
    return () => {
      off = true;
    };
  }, [app.server, app.uri]);

  useEffect(() => {
    if (!doc) return;
    const win = () => frame.current?.contentWindow;
    const send = (m: object) => win()?.postMessage({ jsonrpc: "2.0", ...m }, "*");
    const reply = (id: RpcMsg["id"], result: unknown) => send({ id, result });
    const fail = (id: RpcMsg["id"], message: string) => send({ id, error: { code: -32000, message } });
    let ready = false;
    const dark = matchMedia("(prefers-color-scheme: dark)").matches || document.documentElement.dataset.theme === "dark";
    const onMsg = async (e: MessageEvent) => {
      // Only this frame's messages (a sandboxed frame has an opaque origin, so its window is the check).
      if (e.source !== win()) return;
      const m = e.data as RpcMsg;
      if (!m || typeof m !== "object" || typeof m.method !== "string") return;
      const p = m.params ?? {};
      switch (m.method) {
        case "ui/initialize":
          reply(m.id, {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "KesherAI", version: "1" },
            hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
            hostContext: { theme: dark ? "dark" : "light", displayMode: "inline", availableDisplayModes: ["inline"], locale: getLocale() === "he" ? "he-IL" : "en-US", platform: matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop", containerDimensions: { maxHeight: 800 } },
          });
          return;
        case "ui/notifications/initialized":
          if (ready) return;
          ready = true;
          send({ method: "ui/notifications/tool-input", params: { arguments: app.input ?? {} } });
          send({ method: "ui/notifications/tool-result", params: app.result ?? {} });
          return;
        case "ui/notifications/size-changed":
          if (typeof p.height === "number") setHeight(Math.max(60, Math.min(800, Math.ceil(p.height))));
          return;
        case "ping":
          reply(m.id, {});
          return;
        case "tools/call": {
          const name = String(p.name ?? "");
          const body = { name, arguments: (p.arguments ?? {}) as Record<string, unknown> };
          try {
            reply(m.id, await api(`/api/mcp/servers/${encodeURIComponent(app.server)}/app-call`, { method: "POST", body }));
          } catch (err) {
            const msg = (err as Error).message;
            if (!/needs-confirm/.test(msg)) return fail(m.id, msg);
            // A tool that changes things: the person says yes here first.
            if (!confirm(L(`האפליקציה בצ'אט רוצה להפעיל את "${name}". לאשר?`, `The app in the chat wants to run "${name}". Allow?`))) return fail(m.id, "The user declined.");
            try {
              reply(m.id, await api(`/api/mcp/servers/${encodeURIComponent(app.server)}/app-call`, { method: "POST", body: { ...body, confirmed: true } }));
            } catch (err2) {
              fail(m.id, (err2 as Error).message);
            }
          }
          return;
        }
        case "ui/open-link": {
          const url = String(p.url ?? "");
          if (!/^https:\/\//.test(url)) return fail(m.id, "Only https links.");
          // In the desktop app this opens in the person's browser (the window's open handler).
          window.open(url, "_blank", "noopener,noreferrer");
          reply(m.id, {});
          return;
        }
        case "ui/message": {
          const content = (p.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
          const text = content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n").slice(0, 4000);
          if (text) onMessage?.(text);
          reply(m.id, {});
          return;
        }
        case "ui/update-model-context":
        case "notifications/message":
          if (m.id !== undefined) reply(m.id, {});
          return;
        case "ui/request-display-mode":
          reply(m.id, { mode: "inline" });
          return;
        default:
          if (m.id !== undefined) fail(m.id, `Not supported: ${m.method}`);
      }
    };
    addEventListener("message", onMsg);
    return () => {
      removeEventListener("message", onMsg);
      // Teardown: the view gets a moment to save before the frame goes.
      send({ id: Date.now(), method: "ui/resource-teardown", params: {} });
    };
  }, [doc, app, onMessage]);

  if (error) return <p className="muted small">{L("אי אפשר להציג את התצוגה של הכלי", "The tool's view could not be shown")}: {error}</p>;
  if (!doc) return <p className="muted small">…</p>;
  return (
    <iframe
      ref={frame}
      className={`mcp-app${doc.border ? " bordered" : ""}`}
      title={L("תצוגה של כלי", "Tool view")}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc.html}
      style={{ height }}
    />
  );
}
