import * as monaco from "monaco-editor";
import { withToken } from "../api";

/**
 * The code editor's link to a real language server (csharp-ls, Roslyn) over
 * KesherAI's WebSocket: what Rider does — suggestions from every class of the
 * project and its libraries, the compiler's errors as you type, its quick
 * fixes, the signature of the call, go to definition, rename.
 *
 * One link per project; each open file is a document of it. While a file is
 * served here, the lighter built-in C# help steps aside (see {@link lspServes}).
 */

type Json = Record<string, unknown>;
interface Pos { line: number; character: number }
interface LRange { start: Pos; end: Pos }
interface TextEdit { range: LRange; newText: string }
interface Diagnostic { range: LRange; severity?: number; code?: string | number; message: string; source?: string }

const served = new Set<string>();
/** Whether a file (Monaco model) is served by a language server now. */
export function lspServes(model: monaco.editor.ITextModel): boolean {
  return served.has(model.uri.toString());
}

const toPos = (p: Pos) => ({ lineNumber: p.line + 1, column: p.character + 1 });
const toRange = (r: LRange) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const fromPos = (p: monaco.IPosition): Pos => ({ line: p.lineNumber - 1, character: p.column - 1 });

/** A file path on the computer as an LSP URI (`C:\a b\x.cs` → `file:///c%3A/a%20b/x.cs`). */
export function fileUri(path: string): string {
  const n = path.replace(/\\/g, "/");
  const withSlash = n.startsWith("/") ? n : `/${n}`;
  return `file://${withSlash.split("/").map((s, i) => (i === 1 && /^[A-Za-z]:$/.test(s) ? `${s[0]!.toLowerCase()}%3A` : encodeURIComponent(s))).join("/")}`;
}

class LspLink {
  private ws: WebSocket;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private docs = new Map<string, { model: monaco.editor.ITextModel; version: number; sub: monaco.IDisposable }>();
  ready: Promise<Json>;
  private onDiag?: (count: number) => void;
  dead = false;

  constructor(url: string, root: string, status: (s: string) => void) {
    const u = new URL(withToken(url), location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(u);
    this.ws.onmessage = (e) => this.receive(String(e.data));
    this.ws.onclose = () => {
      this.dead = true;
      for (const w of this.waiting.values()) w.reject(new Error("The language server closed."));
      for (const uri of this.docs.keys()) served.delete(uri);
      status("closed");
    };
    this.ready = new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("No link to the language server."));
    }).then(async () => {
      status("starting");
      const caps = (await this.request("initialize", {
        processId: null,
        rootUri: fileUri(root),
        workspaceFolders: [{ uri: fileUri(root), name: root.split(/[\\/]/).pop() }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail"] } } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true } } },
            publishDiagnostics: {},
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } }, resolveSupport: { properties: ["edit"] } },
            definition: {},
            rename: { prepareSupport: false },
            formatting: {},
          },
          workspace: { workspaceEdit: { documentChanges: true }, applyEdit: true, configuration: true },
        },
      }, 180_000)) as Json;
      this.notify("initialized", {});
      status("ready");
      return caps;
    });
  }

  private send(m: Json): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
  request<T = unknown>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.next++;
    this.send({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: no answer`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v as T); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  private receive(text: string): void {
    let m: { id?: number | string; method?: string; params?: Json; result?: unknown; error?: { message: string } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) {
      // Requests from the server: settings (none), applying an edit (to the open files), progress.
      if (m.method === "workspace/applyEdit") {
        this.applyEdit((m.params as { edit: Json }).edit);
        this.send({ id: m.id, result: { applied: true } });
      } else this.send({ id: m.id, result: m.method === "workspace/configuration" ? ((m.params?.items as unknown[]) ?? []).map(() => null) : null });
      return;
    }
    if (m.id !== undefined) {
      const w = this.waiting.get(Number(m.id));
      if (!w) return;
      this.waiting.delete(Number(m.id));
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
      return;
    }
    if (m.method === "textDocument/publishDiagnostics") {
      const p = m.params as { uri: string; diagnostics: Diagnostic[] };
      const doc = [...this.docs.entries()].find(([u]) => u.toLowerCase() === p.uri.toLowerCase())?.[1];
      if (!doc) return;
      monaco.editor.setModelMarkers(doc.model, "lsp", p.diagnostics.map((d) => ({
        ...toRange(d.range),
        startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1, endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
        severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: d.message,
        ...(d.code !== undefined ? { code: String(d.code) } : {}),
        source: d.source ?? "C#",
      })));
      this.onDiag?.(p.diagnostics.filter((d) => d.severity === 1).length);
    }
    if (m.method === "kesher/error" || m.method === "kesher/exit") this.ws.close();
  }

  /** Applies an edit to the files open here (edits to files not open are skipped and counted). */
  applyEdit(edit: Json): number {
    let skipped = 0;
    const changes: Array<[string, TextEdit[]]> = [];
    const dc = edit.documentChanges as Array<{ textDocument?: { uri: string }; edits?: TextEdit[] }> | undefined;
    if (dc) for (const c of dc) if (c.textDocument && c.edits) changes.push([c.textDocument.uri, c.edits]);
    for (const [uri, edits] of Object.entries((edit.changes as Record<string, TextEdit[]>) ?? {})) changes.push([uri, edits]);
    for (const [uri, edits] of changes) {
      const doc = [...this.docs.entries()].find(([u]) => u.toLowerCase() === uri.toLowerCase())?.[1];
      if (!doc) {
        skipped++;
        continue;
      }
      doc.model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText })), () => null);
    }
    return skipped;
  }

  /** Serves a file: the server gets its text and every change. */
  open(model: monaco.editor.ITextModel, uri: string, onErrors?: (n: number) => void): void {
    if (onErrors) this.onDiag = onErrors;
    const key = model.uri.toString();
    const old = this.docs.get(uri);
    if (old?.model === model) return;
    if (old) this.close(uri);
    const doc = { model, version: 1, sub: model.onDidChangeContent(() => {
      doc.version++;
      this.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text: model.getValue() }] });
    }) };
    this.docs.set(uri, doc);
    served.add(key);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text: model.getValue() } });
  }
  close(uri: string): void {
    const d = this.docs.get(uri);
    if (!d) return;
    d.sub.dispose();
    served.delete(d.model.uri.toString());
    this.docs.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }
  uriOf(model: monaco.editor.ITextModel): string | undefined {
    return [...this.docs.entries()].find(([, d]) => d.model === model)?.[0];
  }
}

let link: { key: string; link: LspLink } | undefined;
const links: LspLink[] = [];
/** The link for a project (one at a time). */
export function lspLink(url: string, root: string, status: (s: string) => void): LspLink {
  const key = `${url}|${root}`;
  if (link && link.key === key && !link.link.dead) return link.link;
  link = { key, link: new LspLink(url, root, status) };
  links.push(link.link);
  return link.link;
}
const linkOf = (model: monaco.editor.ITextModel) => links.find((l) => !l.dead && l.uriOf(model));

let providers = false;
/** Monaco asks the language server (for files it serves). */
export function registerLspProviders(): void {
  if (providers) return;
  providers = true;
  const kind = (k?: number) => (k ? [0, 18, 0, 1, 3, 4, 9, 6, 7, 8, 9, 12, 11, 13, 17, 14, 22, 19, 20, 21, 24, 15, 23, 24, 10, 25][k] ?? 18 : 18) as monaco.languages.CompletionItemKind;
  monaco.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: [".", "<", " ", "("],
    async provideCompletionItems(model, pos) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return { suggestions: [] };
      const r = await l.request<{ items?: Json[] } | Json[] | null>("textDocument/completion", { textDocument: { uri }, position: fromPos(pos) }).catch(() => null);
      // textEdit may be a plain edit (range) or an insert/replace pair (Roslyn sends these).
      const items = (Array.isArray(r) ? r : r?.items ?? []) as Array<{ label: string; kind?: number; detail?: string; documentation?: string | { value: string }; insertText?: string; insertTextFormat?: number; textEdit?: { newText: string; range?: LRange; insert?: LRange; replace?: LRange }; filterText?: string; sortText?: string }>;
      const word = model.getWordUntilPosition(pos);
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
      return {
        suggestions: items.slice(0, 400).map((i) => ({
          label: String(i.label),
          kind: kind(i.kind),
          ...(i.detail ? { detail: i.detail } : {}),
          ...(i.documentation ? { documentation: typeof i.documentation === "string" ? i.documentation : { value: i.documentation.value } } : {}),
          insertText: i.textEdit?.newText ?? i.insertText ?? String(i.label),
          ...(i.insertTextFormat === 2 ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
          ...(i.filterText ? { filterText: i.filterText } : {}),
          ...(i.sortText ? { sortText: i.sortText } : {}),
          range: i.textEdit?.range ? toRange(i.textEdit.range) : i.textEdit?.insert && i.textEdit.replace ? { insert: toRange(i.textEdit.insert), replace: toRange(i.textEdit.replace) } : range,
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider("csharp", {
    async provideHover(model, pos) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return null;
      const r = await l.request<{ contents: string | { value: string } | Array<string | { value: string }>; range?: LRange } | null>("textDocument/hover", { textDocument: { uri }, position: fromPos(pos) }).catch(() => null);
      if (!r) return null;
      const list = Array.isArray(r.contents) ? r.contents : [r.contents];
      return { contents: list.map((c) => ({ value: typeof c === "string" ? c : c.value })), ...(r.range ? { range: toRange(r.range) } : {}) };
    },
  });
  monaco.languages.registerSignatureHelpProvider("csharp", {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, pos) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return null;
      const r = await l.request<{ signatures: Array<{ label: string; documentation?: string | { value: string }; parameters?: Array<{ label: string | [number, number] }> }>; activeSignature?: number; activeParameter?: number } | null>("textDocument/signatureHelp", { textDocument: { uri }, position: fromPos(pos) }).catch(() => null);
      if (!r?.signatures?.length) return null;
      return { value: { signatures: r.signatures.map((s) => ({ label: s.label, ...(s.documentation ? { documentation: typeof s.documentation === "string" ? s.documentation : { value: s.documentation.value } } : {}), parameters: (s.parameters ?? []).map((p) => ({ label: p.label })) })), activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0 }, dispose: () => undefined };
    },
  });
  monaco.languages.registerCodeActionProvider("csharp", {
    async provideCodeActions(model, range, context) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return { actions: [], dispose: () => undefined };
      const diags = context.markers.filter((m) => m.source !== "KesherAI" && m.source !== "compiler").map((m) => ({ range: { start: fromPos({ lineNumber: m.startLineNumber, column: m.startColumn }), end: fromPos({ lineNumber: m.endLineNumber, column: m.endColumn }) }, message: m.message, severity: m.severity === monaco.MarkerSeverity.Error ? 1 : 2, ...(m.code ? { code: typeof m.code === "string" ? m.code : m.code.value } : {}) }));
      const r = await l.request<Array<{ title: string; kind?: string; edit?: Json; isPreferred?: boolean; data?: unknown }> | null>("textDocument/codeAction", { textDocument: { uri }, range: { start: fromPos(range.getStartPosition()), end: fromPos(range.getEndPosition()) }, context: { diagnostics: diags } }).catch(() => null);
      const actions = (r ?? []).filter((a) => a.title).slice(0, 30).map((a) => {
        const id = `kesher.lsp.action.${Math.random().toString(36).slice(2)}`;
        monaco.editor.registerCommand(id, async () => {
          const full = a.edit ? a : await l.request<{ edit?: Json }>("codeAction/resolve", a).catch(() => a);
          if (full.edit) l.applyEdit(full.edit);
        });
        return { title: a.title, kind: a.kind ?? "quickfix", ...(a.isPreferred ? { isPreferred: true } : {}), command: { id, title: a.title } };
      });
      return { actions, dispose: () => undefined };
    },
  });
  monaco.languages.registerDefinitionProvider("csharp", {
    async provideDefinition(model, pos) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return null;
      const r = await l.request<Array<{ uri: string; range: LRange }> | { uri: string; range: LRange } | null>("textDocument/definition", { textDocument: { uri }, position: fromPos(pos) }).catch(() => null);
      const list = !r ? [] : Array.isArray(r) ? r : [r];
      // Only places in this file can be shown here; others go to the page (it opens that script).
      return list.filter((d) => d.uri.toLowerCase() === uri.toLowerCase()).map((d) => ({ uri: model.uri, range: toRange(d.range) }));
    },
  });
  monaco.languages.registerRenameProvider("csharp", {
    async provideRenameEdits(model, pos, newName) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return { edits: [] };
      const r = await l.request<Json | null>("textDocument/rename", { textDocument: { uri }, position: fromPos(pos), newName });
      if (r) {
        const skipped = l.applyEdit(r);
        if (skipped) window.dispatchEvent(new CustomEvent("kesher-toast", { detail: `Renamed here; ${skipped} other file(s) use it too and were not changed.` }));
      }
      return { edits: [] };
    },
  });
  monaco.languages.registerDocumentFormattingEditProvider("csharp", {
    async provideDocumentFormattingEdits(model, options) {
      const l = linkOf(model);
      const uri = l?.uriOf(model);
      if (!l || !uri) return [];
      const r = await l.request<TextEdit[] | null>("textDocument/formatting", { textDocument: { uri }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }).catch(() => null);
      return (r ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
    },
  });
}

export { toPos };
