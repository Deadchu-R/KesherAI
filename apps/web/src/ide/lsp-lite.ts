import { withToken } from "../api";

/**
 * A small language-server link with no editor attached (for the touch editor):
 * the document's text, its changes, suggestions at a place, and the server's
 * errors. The same server and WebSocket as the desktop editor's Rider mode.
 */
export interface LspItem { label: string; detail?: string; doc?: string; insert: string; snippet: boolean; kind?: number }
export interface LspDiag { line: number; character: number; endLine: number; endCharacter: number; severity: number; message: string; code?: string }

export class LspLite {
  private ws: WebSocket;
  private next = 1;
  private waiting = new Map<number, (v: unknown) => void>();
  private version = 1;
  ready: Promise<void>;
  onDiagnostics?: (d: LspDiag[]) => void;

  constructor(url: string, private readonly rootUri: string, private readonly uri: string, text: string) {
    const u = new URL(withToken(url), location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(u);
    this.ws.onmessage = (e) => this.receive(String(e.data));
    this.ready = new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("No link to the language server."));
    }).then(async () => {
      await this.request("initialize", { processId: null, rootUri, capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true, documentationFormat: ["plaintext", "markdown"] } }, publishDiagnostics: {} } } }, 180_000);
      this.notify("initialized", {});
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text } });
    });
  }

  private send(m: Record<string, unknown>) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
  }
  private notify(method: string, params: unknown) {
    this.send({ method, params });
  }
  private request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T | null> {
    const id = this.next++;
    this.send({ id, method, params });
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        res(null);
      }, timeoutMs);
      this.waiting.set(id, (v) => {
        clearTimeout(t);
        res(v as T);
      });
    });
  }
  private receive(text: string) {
    let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) {
      this.send({ id: m.id, result: m.method === "workspace/configuration" ? ((m.params?.items as unknown[]) ?? []).map(() => null) : null });
      return;
    }
    if (m.id !== undefined) {
      this.waiting.get(m.id)?.(m.result);
      this.waiting.delete(m.id);
      return;
    }
    if (m.method === "textDocument/publishDiagnostics" && String(m.params?.uri).toLowerCase() === this.uri.toLowerCase()) {
      const list = (m.params?.diagnostics ?? []) as Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; code?: string | number }>;
      this.onDiagnostics?.(list.map((d) => ({ line: d.range.start.line, character: d.range.start.character, endLine: d.range.end.line, endCharacter: d.range.end.character, severity: d.severity ?? 1, message: d.message, ...(d.code !== undefined ? { code: String(d.code) } : {}) })));
    }
  }

  /** The text changed (the whole text is sent). */
  change(text: string): void {
    this.version++;
    this.notify("textDocument/didChange", { textDocument: { uri: this.uri, version: this.version }, contentChanges: [{ text }] });
  }

  /** Suggestions at a line and character (0-based). */
  async complete(line: number, character: number): Promise<LspItem[]> {
    const r = await this.request<{ items?: unknown[] } | unknown[]>("textDocument/completion", { textDocument: { uri: this.uri }, position: { line, character } });
    const items = (Array.isArray(r) ? r : r?.items ?? []) as Array<{ label: string; detail?: string; documentation?: string | { value: string }; insertText?: string; insertTextFormat?: number; textEdit?: { newText: string }; kind?: number }>;
    return items.slice(0, 400).map((i) => ({ label: String(i.label), ...(i.detail ? { detail: i.detail } : {}), ...(i.documentation ? { doc: typeof i.documentation === "string" ? i.documentation : i.documentation.value } : {}), insert: i.textEdit?.newText ?? i.insertText ?? String(i.label), snippet: i.insertTextFormat === 2, ...(i.kind ? { kind: i.kind } : {}) }));
  }

  close(): void {
    this.notify("textDocument/didClose", { textDocument: { uri: this.uri } });
    this.ws.close();
  }
}
