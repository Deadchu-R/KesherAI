import * as monaco from "monaco-editor";
import { lspServes } from "./lsp-client";
import { NAMESPACE_OF, UNITY_API, UNITY_EVENTS_SNIPPETS, type ApiMember } from "./unity-api";

/**
 * Rider-like help for Unity C# in Monaco: suggestions that know the Unity API
 * and the script's own variables (also after a dot: `transform.position.`),
 * the signature of the method being called, a short description on hover, a
 * live check of brackets and missing `using` lines, and quick fixes (add the
 * `using`, add a missing `;`, a close name for an unknown one).
 */

/** The project's own script classes (set by the page), offered as types. */
let projectTypes: string[] = [];
export function setProjectTypes(names: string[]): void {
  projectTypes = names;
}

const KEYWORDS = "public private protected internal static readonly const void int float bool string var new return if else for foreach while do switch case break continue class struct enum interface using namespace this base null true false out ref in params override virtual abstract yield async await try catch finally throw is as typeof".split(" ");

/** The type of a name declared in the file: a field, a local or a parameter (`Rigidbody rb`, `List<int> xs`). */
function declaredType(text: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s(,;{])(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|readonly|const|ref|out|in)\\s+)*([A-Za-z_][\\w.]*(?:<[^<>;=()]*>)?(?:\\[\\])?)\\s+${name}\\s*(?:[=;,)]|$)`, "m");
  const m = re.exec(text);
  if (!m) return undefined;
  const t = m[1]!;
  if (t === "var") {
    // var x = new T(...) / GetComponent<T>()
    const v = new RegExp(`var\\s+${name}\\s*=\\s*(?:new\\s+([A-Za-z_]\\w*)|[\\w.]*GetComponent\\w*<([A-Za-z_]\\w*)>)`).exec(text);
    return v ? (v[1] ?? v[2]) : undefined;
  }
  return KEYWORDS.includes(t) && !["int", "float", "bool", "string"].includes(t) ? undefined : t;
}

const baseType = (t: string) => t.replace(/<.*>$/, "").replace(/\[\]$/, "").replace(/^.*\./, "");

/** The members after `expr.`: the expression is read from the left (names, calls, generics). */
function membersAfter(text: string, chain: string): { members: ApiMember[]; statics: boolean } | undefined {
  const parts = chain.split(".").filter(Boolean);
  if (!parts.length) return undefined;
  let type: string | undefined;
  let statics = false;
  const first = parts[0]!;
  const call = /^(\w+)(?:<(\w+)>)?\(.*\)$/.exec(first);
  if (first === "this" || first === "base") type = "MonoBehaviour";
  else if (call && /^(GetComponent|GetComponentInChildren|GetComponentInParent|AddComponent|FindFirstObjectByType)$/.test(call[1]!) && call[2]) type = call[2];
  else if (UNITY_API[first]) {
    type = first;
    statics = true;
  } else {
    type = declaredType(text, first) ?? UNITY_API.MonoBehaviour!.members.find((x) => x.name === first)?.type;
  }
  for (const part of parts.slice(1)) {
    if (!type) return undefined;
    const name = part.replace(/(<\w+>)?\(.*\)$/, "");
    const generic = /<(\w+)>\(.*\)$/.exec(part)?.[1];
    const mem: ApiMember | undefined = UNITY_API[baseType(type)]?.members.find((x) => x.name === name);
    type = mem?.type === "T" && generic ? generic : mem?.type;
    statics = false;
  }
  if (!type) return undefined;
  const api = UNITY_API[baseType(type)];
  if (!api) return undefined;
  return { members: api.members.filter((x) => (statics ? x.static : !x.static)), statics };
}

/** The expression right before the cursor's dot: `transform.position` from `   transform.position.` */
function chainBefore(line: string): string | undefined {
  const m = /([A-Za-z_][\w]*(?:<\w+>)?(?:\([^()]*\))?(?:\.[A-Za-z_]\w*(?:<\w+>)?(?:\([^()]*\))?)*)\.\w*$/.exec(line);
  return m?.[1];
}

/** The script's own fields and methods (for suggestions without a dot). */
function ownMembers(text: string): Array<{ name: string; kind: "field" | "method"; detail: string }> {
  const out = new Map<string, { name: string; kind: "field" | "method"; detail: string }>();
  for (const m of text.matchAll(/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|readonly)\s+)+([A-Za-z_][\w.<>,[\]\s]*?)\s+([A-Za-z_]\w*)\s*(=|;)/gm)) out.set(m[2]!, { name: m[2]!, kind: "field", detail: m[1]!.trim() });
  for (const m of text.matchAll(/^\s*(?:(?:public|private|protected|internal|static|override|virtual)\s+)*([A-Za-z_][\w<>[\]]*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?\s*$/gm)) {
    if (!/^(if|for|foreach|while|switch|return|new|else)$/.test(m[1]!)) out.set(m[2]!, { name: m[2]!, kind: "method", detail: `${m[1]} ${m[2]}(${m[3]})` });
  }
  return [...out.values()];
}

const kindOf = (x: ApiMember) => (x.kind === "method" ? monaco.languages.CompletionItemKind.Method : x.kind === "const" ? monaco.languages.CompletionItemKind.EnumMember : monaco.languages.CompletionItemKind.Property);

/** Brackets that do not close (outside strings and comments): the live check. */
export function bracketProblems(text: string): Array<{ index: number; message: string }> {
  const stack: Array<{ c: string; i: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const out: Array<{ index: number; message: string }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const verbatim = text[i - 1] === "@";
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += !verbatim && text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push({ c, i });
    else if (c in pairs) {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) {
        out.push({ index: i, message: `"${c}" closes nothing here` });
        if (top) stack.push(top);
      }
    }
  }
  for (const s of stack.slice(-3)) out.push({ index: s.i, message: `"${s.c}" is never closed` });
  return out;
}

/** Types used in the file whose `using` line is missing. */
export function missingUsings(text: string): Array<{ index: number; type: string; ns: string }> {
  const out: Array<{ index: number; type: string; ns: string }> = [];
  const seen = new Set<string>();
  for (const [type, ns] of Object.entries(NAMESPACE_OF)) {
    if (seen.has(ns) || new RegExp(`^\\s*using\\s+${ns.replace(/\./g, "\\.")}\\s*;`, "m").test(text)) continue;
    const m = new RegExp(`(?<![\\w.])${type}\\s*[<(\\s\\[]`).exec(text.replace(/\/\/[^\n]*|"(?:[^"\\\\\n]|\\\\.)*"/g, (s) => " ".repeat(s.length)));
    if (m && !/^\s*using/.test(text.slice(text.lastIndexOf("\n", m.index) + 1, m.index))) {
      out.push({ index: m.index, type, ns });
      seen.add(ns);
    }
  }
  return out;
}

const close = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 2) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
  return d[a.length]![b.length]! <= 2;
};

let registered = false;
/** Registers the C# helpers once (they read whichever C# file is open). */
export function registerCSharpAssist(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: ["."],
    provideCompletionItems(model, pos) {
      if (lspServes(model)) return { suggestions: [] };
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const word = model.getWordUntilPosition(pos);
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
      const text = model.getValue();
      const chain = /\.\w*$/.test(line) ? chainBefore(line) : undefined;
      if (chain) {
        const found = membersAfter(text, chain);
        if (!found) return { suggestions: [] };
        return {
          suggestions: found.members.map((x) => ({
            label: x.name,
            kind: kindOf(x),
            detail: x.sig ? `${x.sig}${x.type && x.type !== "void" ? ` → ${x.type}` : ""}` : x.type,
            documentation: x.doc,
            insertText: x.kind === "method" ? (/<T>/.test(x.sig ?? "") ? `${x.name}<\${1:T}>()` : /\(\)$/.test(x.sig ?? "") ? `${x.name}()` : `${x.name}($0)`) : x.name,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      }
      const s: monaco.languages.CompletionItem[] = [];
      for (const [name, api] of Object.entries(UNITY_API)) s.push({ label: name, kind: monaco.languages.CompletionItemKind.Class, detail: api.ns ? `${api.ns}.${name}` : `UnityEngine.${name}`, documentation: api.doc, insertText: name, range });
      for (const n of projectTypes) s.push({ label: n, kind: monaco.languages.CompletionItemKind.Class, detail: "Script in this project", insertText: n, range });
      for (const x of ownMembers(text)) s.push({ label: x.name, kind: x.kind === "method" ? monaco.languages.CompletionItemKind.Method : monaco.languages.CompletionItemKind.Field, detail: x.detail, insertText: x.kind === "method" ? `${x.name}($0)` : x.name, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "0", range });
      for (const x of UNITY_API.MonoBehaviour!.members) s.push({ label: x.name, kind: kindOf(x), detail: x.sig ?? x.type, documentation: x.doc, insertText: x.kind === "method" ? (/<T>/.test(x.sig ?? "") ? `${x.name}<\${1:T}>()` : `${x.name}($0)`) : x.name, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "1", range });
      for (const sn of UNITY_EVENTS_SNIPPETS) s.push({ label: sn.label, kind: monaco.languages.CompletionItemKind.Snippet, detail: "Unity", documentation: sn.doc, insertText: sn.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: "2", range });
      for (const k of KEYWORDS) s.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, sortText: "3", range });
      return { suggestions: s };
    },
  });
  monaco.languages.registerHoverProvider("csharp", {
    provideHover(model, pos) {
      if (lspServes(model)) return null;
      const w = model.getWordAtPosition(pos);
      if (!w) return null;
      const before = model.getLineContent(pos.lineNumber).slice(0, w.startColumn - 1);
      const chain = /\.$/.test(before) ? chainBefore(`${before}${w.word}`) : undefined;
      const mem = chain ? membersAfter(model.getValue(), chain)?.members.find((x) => x.name === w.word) : undefined;
      const api = UNITY_API[w.word];
      const text = mem ? `**${mem.sig ?? mem.name}**${mem.type ? ` → \`${mem.type}\`` : ""}${mem.doc ? `\n\n${mem.doc}` : ""}` : api ? `**${w.word}** (${api.ns ?? "UnityEngine"})\n\n${api.doc}` : undefined;
      return text ? { contents: [{ value: text }], range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn) } : null;
    },
  });
  monaco.languages.registerSignatureHelpProvider("csharp", {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model, pos) {
      if (lspServes(model)) return null;
      const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      let depth = 0;
      let i = line.length - 1;
      let commas = 0;
      for (; i >= 0; i--) {
        const c = line[i];
        if (c === ")") depth++;
        else if (c === "(") {
          if (!depth) break;
          depth--;
        } else if (c === "," && !depth) commas++;
      }
      if (i < 0) return null;
      const head = line.slice(0, i);
      const name = /(\w+)(?:<\w+>)?$/.exec(head)?.[1];
      if (!name) return null;
      const chain = /\.\w+(?:<\w+>)?$/.test(head) ? chainBefore(head.replace(/(<\w+>)?$/, "")) : undefined;
      const mems = chain ? membersAfter(model.getValue(), chain)?.members ?? [] : UNITY_API.MonoBehaviour!.members;
      const mem = mems.find((x) => x.name === name && x.kind === "method");
      if (!mem?.sig) return null;
      const params = (/\((.*)\)/.exec(mem.sig)?.[1] ?? "").split(/,\s*/).filter(Boolean);
      return { value: { signatures: [{ label: mem.sig, documentation: mem.doc, parameters: params.map((p) => ({ label: p })) }], activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) }, dispose: () => undefined };
    },
  });
  monaco.languages.registerCodeActionProvider("csharp", {
    provideCodeActions(model, _range, context) {
      const actions: monaco.languages.CodeAction[] = [];
      if (lspServes(model)) return { actions, dispose: () => undefined };
      const text = model.getValue();
      const usingAt = (() => {
        const lines = text.split("\n");
        let last = 0;
        lines.forEach((l, i) => /^\s*using\s+[\w.]+\s*;/.test(l) && (last = i + 1));
        return last + 1;
      })();
      for (const mk of context.markers) {
        const code = typeof mk.code === "string" ? mk.code : mk.code?.value;
        const word = model.getWordAtPosition({ lineNumber: mk.startLineNumber, column: mk.startColumn })?.word ?? /'(\w+)'/.exec(mk.message)?.[1] ?? "";
        const ns = /using (\S+);/.exec(mk.message)?.[1] ?? NAMESPACE_OF[word];
        if ((code === "missing-using" || code === "CS0246") && ns) {
          actions.push({ title: `Add using ${ns};`, kind: "quickfix", diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(usingAt, 1, usingAt, 1), text: `using ${ns};\n` } }] } });
        }
        if (code === "CS1002") {
          const ln = mk.startLineNumber;
          const end = model.getLineMaxColumn(ln);
          actions.push({ title: "Add ;", kind: "quickfix", diagnostics: [mk], isPreferred: true, edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(ln, end, ln, end), text: ";" } }] } });
        }
        if ((code === "CS0103" || code === "CS1061" || code === "CS0117") && word) {
          const known = [...Object.keys(UNITY_API), ...projectTypes, ...ownMembers(text).map((x) => x.name), ...Object.values(UNITY_API).flatMap((a) => a.members.map((x) => x.name))];
          for (const k of [...new Set(known)].filter((k) => k !== word && close(k, word)).slice(0, 3)) {
            const w = model.getWordAtPosition({ lineNumber: mk.startLineNumber, column: mk.startColumn });
            if (!w) continue;
            actions.push({ title: `Change to ${k}`, kind: "quickfix", diagnostics: [mk], edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(mk.startLineNumber, w.startColumn, mk.startLineNumber, w.endColumn), text: k } }] } });
          }
        }
      }
      return { actions, dispose: () => undefined };
    },
  });
}

/** The live check's markers for a C# file (brackets, missing `using`). */
export function liveMarkers(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  if (lspServes(model)) return [];
  const text = model.getValue();
  const at = (i: number) => model.getPositionAt(i);
  return [
    ...bracketProblems(text).map((p) => {
      const s = at(p.index);
      return { severity: monaco.MarkerSeverity.Error, message: p.message, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: s.lineNumber, endColumn: s.column + 1, code: "brackets", source: "KesherAI" };
    }),
    ...missingUsings(text).map((p) => {
      const s = at(p.index);
      return { severity: monaco.MarkerSeverity.Warning, message: `${p.type} needs "using ${p.ns};" at the top (Ctrl+. adds it)`, startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: s.lineNumber, endColumn: s.column + p.type.length, code: "missing-using", source: "KesherAI" };
    }),
  ];
}
