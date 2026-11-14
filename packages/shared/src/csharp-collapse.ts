/**
 * "Collapse to Function" for a C# script graph, as Unreal's Blueprint editor does it: the chosen steps (one after
 * another, in the method's code) move into a new method of the class, and a call to it takes their place. A value the
 * steps read from the method (a parameter, or a variable made earlier in it) becomes a parameter of the new method,
 * as Unreal gives the collapsed function an input for each wire coming in.
 */
import { newId, parseCSharp, writeCSharp, writeStatements, type CsClass, type CsMethod, type CsStmt } from "./csharp-graph.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every step inside a list, the nested ones too. */
function all(list: CsStmt[]): CsStmt[] {
  return list.flatMap((s) => [s, ...(s.kind === "if" ? [...all(s.then), ...all(s.else ?? [])] : s.kind === "loop" ? all(s.body) : [])]);
}

/** The list holding a step (in the method's code only), and its index there. */
function holder(list: CsStmt[], id: string): { list: CsStmt[]; index: number } | undefined {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.id === id) return { list, index: i };
    const inner = s.kind === "if" ? holder(s.then, id) ?? (s.else ? holder(s.else, id) : undefined) : s.kind === "loop" ? holder(s.body, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Whether a name is used as a whole word in some code (not after a dot). */
const uses = (code: string, name: string) => new RegExp(`(^|[^.\\w])${name}\\b`).test(code);

/**
 * Collapses steps into a new method. Changes `classes` (the steps leave their method) only when it succeeds.
 *
 * @param text - The script the classes were read from.
 * @param classes - The classes as the page has them (with its edits; the ids are theirs).
 * @param ci - The class's index.
 * @param methodName - The method the steps are in.
 * @param ids - The chosen steps.
 * @param name - The new method's name.
 * @returns The new script, or an error in words.
 */
export function collapseToFunction(text: string, classes: CsClass[], ci: number, methodName: string, ids: string[], name: string): { text: string } | { error: string } {
  if (!IDENT.test(name)) return { error: "A function name is letters, digits and _ (not starting with a digit)." };
  const cls = classes[ci];
  const m = cls?.methods.find((x) => x.name === methodName);
  if (!cls || !m) return { error: "The method was not found." };
  if (cls.methods.some((x) => x.name === name) || cls.fields.some((f) => f.name === name)) return { error: `The class already has ${name}.` };
  const places = ids.map((id) => holder(m.body, id));
  if (!places.length || places.some((p) => !p)) return { error: "Choose steps that are wired into the method (steps alone on the graph are not in the code)." };
  const list = places[0]!.list;
  if (places.some((p) => p!.list !== list)) return { error: "Choose steps that follow one another in the same flow (not inside different branches)." };
  const idx = places.map((p) => p!.index).sort((a, b) => a - b);
  if (idx.some((v, i) => i > 0 && v !== idx[i - 1]! + 1)) return { error: "Choose steps that follow one another, with none left out between them." };
  const from = idx[0]!;
  const steps = list.slice(from, idx[idx.length - 1]! + 1);
  const inner = all(steps);
  if (inner.some((s) => s.kind === "return")) return { error: "Steps with a return cannot move into another function (it would return from that one instead)." };
  const code = writeStatements(steps, "");
  if (/\byield\b/.test(code)) return { error: "Steps with yield (a coroutine) cannot move into a plain function." };

  // What the steps read from the method: its parameters, and variables made in it outside the steps.
  const inside = new Set(inner.flatMap((s) => (s.kind === "local" ? [s.name] : [])));
  const outsideLocals = all(m.body).filter((s) => s.kind === "local" && !inner.includes(s)) as Array<Extract<CsStmt, { kind: "local" }>>;
  const params: Array<{ type: string; name: string }> = [];
  for (const p of m.params) if (uses(code, p.name) && !inside.has(p.name)) params.push(p);
  for (const l of outsideLocals) if (uses(code, l.name) && !inside.has(l.name) && !params.some((p) => p.name === l.name)) params.push({ type: l.type === "var" ? "" : l.type, name: l.name });
  const untyped = params.find((p) => !p.type);
  if (untyped) return { error: `${untyped.name} is made with "var": give it a type first, so the new function can take it.` };
  // A variable made in the steps and used after them would be gone.
  const after = writeStatements(list.slice(idx[idx.length - 1]! + 1), "");
  const lost = [...inside].find((n) => uses(after, n));
  if (lost) return { error: `${lost} is made in these steps and used after them: include those steps too, or make it a field.` };
  // Assigning to a passed-in value would only change the copy.
  const assigned = params.find((p) => new RegExp(`(^|[^.\\w])${p.name}\\s*([+\\-*/%]?=(?!=)|\\+\\+|--)`).test(code));
  if (assigned) return { error: `These steps change ${assigned.name}, which belongs to ${methodName}: a new function would change only its own copy.` };

  // The call in their place, then the new method at the end of the class.
  list.splice(from, steps.length, { id: newId(), kind: "call", target: "", name, args: params.map((p) => p.name), src: "", dirty: true });
  (m as CsMethod & { dirty?: boolean }).dirty = true;
  const now = writeCSharp(text, classes);
  const c2 = parseCSharp(now)[ci];
  if (c2?.close === undefined) return { error: "The class's end was not found." };
  const indent = c2.indent ?? "    ";
  const lineStart = now.lastIndexOf("\n", c2.close - 1) + 1;
  const method = `\n${indent}private void ${name}(${params.map((p) => `${p.type} ${p.name}`).join(", ")})\n${indent}{\n${writeStatements(steps, `${indent}    `)}\n${indent}}\n`;
  return { text: `${now.slice(0, lineStart)}${method}${now.slice(lineStart)}` };
}
