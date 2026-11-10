import { NAMESPACE_OF, UNITY_API, type ApiMember } from "./unity-api";

/**
 * Unity C# help that needs no editor (shared by the desktop editor and the
 * touch editor): what can follow a dot, the script's own members, bracket and
 * `using` checks.
 */

/** The project's own script classes (set by the page), offered as types. */
export let projectTypes: string[] = [];
export function setProjectTypes(names: string[]): void {
  projectTypes = names;
}

export const KEYWORDS = "public private protected internal static readonly const void int float bool string var new return if else for foreach while do switch case break continue class struct enum interface using namespace this base null true false out ref in params override virtual abstract yield async await try catch finally throw is as typeof".split(" ");

/** The type of a name declared in the file: a field, a local or a parameter (`Rigidbody rb`, `List<int> xs`). */
export function declaredType(text: string, name: string): string | undefined {
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

export const baseType = (t: string) => t.replace(/<.*>$/, "").replace(/\[\]$/, "").replace(/^.*\./, "");

/** The members after `expr.`: the expression is read from the left (names, calls, generics). */
export function membersAfter(text: string, chain: string): { members: ApiMember[]; statics: boolean } | undefined {
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
export function chainBefore(line: string): string | undefined {
  const m = /([A-Za-z_][\w]*(?:<\w+>)?(?:\([^()]*\))?(?:\.[A-Za-z_]\w*(?:<\w+>)?(?:\([^()]*\))?)*)\.\w*$/.exec(line);
  return m?.[1];
}

/** The script's own fields and methods (for suggestions without a dot). */
export function ownMembers(text: string): Array<{ name: string; kind: "field" | "method"; detail: string }> {
  const out = new Map<string, { name: string; kind: "field" | "method"; detail: string }>();
  for (const m of text.matchAll(/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|readonly)\s+)+([A-Za-z_][\w.<>,[\]\s]*?)\s+([A-Za-z_]\w*)\s*(=|;)/gm)) out.set(m[2]!, { name: m[2]!, kind: "field", detail: m[1]!.trim() });
  for (const m of text.matchAll(/^\s*(?:(?:public|private|protected|internal|static|override|virtual)\s+)*([A-Za-z_][\w<>[\]]*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?\s*$/gm)) {
    if (!/^(if|for|foreach|while|switch|return|new|else)$/.test(m[1]!)) out.set(m[2]!, { name: m[2]!, kind: "method", detail: `${m[1]} ${m[2]}(${m[3]})` });
  }
  return [...out.values()];
}

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

export const close = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 2) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
  return d[a.length]![b.length]! <= 2;
};


/** Suggestions at a place in the text (after a dot: that type's members; else types, own members, keywords). */
export function suggestAt(text: string, offset: number): Array<{ label: string; detail?: string; doc?: string; kind: "method" | "prop" | "const" | "class" | "field" | "keyword" | "snippet"; insert: string }> {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  const chain = /\.\w*$/.test(line) ? chainBefore(line) : undefined;
  if (chain) {
    const found = membersAfter(text, chain);
    return (found?.members ?? []).map((x) => ({ label: x.name, kind: x.kind, ...(x.sig ? { detail: x.sig } : x.type ? { detail: x.type } : {}), ...(x.doc ? { doc: x.doc } : {}), insert: x.kind === "method" ? (/\(\)$/.test(x.sig ?? "") ? `${x.name}()` : `${x.name}(`) : x.name }));
  }
  return [
    ...ownMembers(text).map((x) => ({ label: x.name, kind: x.kind, detail: x.detail, insert: x.kind === "method" ? `${x.name}(` : x.name })),
    ...Object.entries(UNITY_API).map(([name, api]) => ({ label: name, kind: "class" as const, detail: api.ns ?? "UnityEngine", doc: api.doc, insert: name })),
    ...projectTypes.map((n) => ({ label: n, kind: "class" as const, detail: "Script in this project", insert: n })),
    ...UNITY_API.MonoBehaviour!.members.map((x) => ({ label: x.name, kind: x.kind, ...(x.sig ? { detail: x.sig } : {}), insert: x.kind === "method" ? `${x.name}(` : x.name })),
    ...KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const, insert: k })),
  ];
}
