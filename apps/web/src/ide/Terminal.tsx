import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { withToken } from "../api";

/**
 * A real terminal in the conversation's folder (PowerShell on Windows, the
 * login shell elsewhere), running on the computer that runs KesherAI.
 *
 * @param props.convId - Conversation id.
 * @param props.run - A command the server knows by name to start in it (e.g. "gemini" for Gemini CLI).
 */
export function TerminalPane({ convId, run }: { convId: string; run?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const css = getComputedStyle(document.documentElement);
    const term = new XTerm({
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: css.getPropertyValue("--bg").trim() || "#0f1420", foreground: "#e8ecf4", cursor: "#8b9cff", selectionBackground: "rgba(139,156,255,0.3)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    fit.fit();
    const url = new URL(withToken(`/api/conversations/${convId}/terminal${run ? `?run=${encodeURIComponent(run)}` : ""}`), location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    const send = (o: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
    ws.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
    const input = term.onData((data) => send({ type: "input", data }));
    const ro = new ResizeObserver(() => {
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    });
    ro.observe(box.current);
    term.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [convId, run]);
  return <div className="terminal-pane" ref={box} dir="ltr" />;
}
