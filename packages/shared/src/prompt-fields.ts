/**
 * Fields in a saved prompt, filled in a small form before it is used (Open WebUI's prompt variables, the same
 * syntax so prompts move between the two): `{{name}}`, or typed `{{name | type:prop=value:required}}`, e.g.
 * `{{tone | select:options=["formal","casual"]:default="formal"}}`, `{{count | number:min=1:max=10}}`,
 * `{{details | checkbox:label="Add details"}}`. `{{input}}` is not a field: it marks where the cursor goes.
 */

/** The kinds of field the form can show. */
export type PromptFieldType = "text" | "textarea" | "select" | "number" | "checkbox" | "date";

/** One field of a saved prompt. */
export interface PromptField {
  /** Its name, as written (also its label unless `label` is given). */
  name: string;
  type: PromptFieldType;
  options?: string[];
  default?: string;
  required?: boolean;
  placeholder?: string;
  label?: string;
  min?: number;
  max?: number;
}

const FIELD = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;
const TYPES: readonly PromptFieldType[] = ["text", "textarea", "select", "number", "checkbox", "date"];

/** Splits `select:options=["a","b"]:default="a":required` at the colons outside quotes and brackets. */
function parts(spec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote = false;
  for (const ch of spec) {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "[") depth++;
    else if (!quote && ch === "]") depth--;
    if (ch === ":" && !quote && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (v: string) => v.replace(/^"(.*)"$/s, "$1");

/**
 * The fields a saved prompt asks for, once each, in order.
 *
 * @param text - The prompt's text.
 * @returns Its fields (none for a prompt without any).
 */
export function promptFields(text: string): PromptField[] {
  const seen = new Map<string, PromptField>();
  for (const m of text.matchAll(FIELD)) {
    const name = m[1]!.trim().slice(0, 60);
    if (!name || name.toLowerCase() === "input" || seen.has(name)) continue;
    const [kind = "text", ...props] = m[2] ? parts(m[2]) : [];
    const type = (TYPES as readonly string[]).includes(kind) ? (kind as PromptFieldType) : "text";
    const f: PromptField = { name, type };
    for (const p of props) {
      const eq = p.indexOf("=");
      const key = (eq < 0 ? p : p.slice(0, eq)).trim();
      const raw = eq < 0 ? "" : p.slice(eq + 1).trim();
      if (key === "required") f.required = true;
      else if (key === "options") {
        try {
          const list = JSON.parse(raw) as unknown;
          if (Array.isArray(list)) f.options = list.map((x) => String(x).slice(0, 100)).slice(0, 30);
        } catch {
          // A broken list: the field stays a text box.
        }
      } else if (key === "default") f.default = unquote(raw).slice(0, 500);
      else if (key === "placeholder") f.placeholder = unquote(raw).slice(0, 120);
      else if (key === "label") f.label = unquote(raw).slice(0, 120);
      else if ((key === "min" || key === "max") && Number.isFinite(Number(raw))) f[key] = Number(raw);
    }
    if (f.type === "select" && !f.options?.length) f.type = "text";
    seen.set(name, f);
  }
  return [...seen.values()].slice(0, 20);
}

/**
 * The prompt with its fields filled (a checkbox becomes its label when ticked, else nothing).
 *
 * @param text - The prompt's text.
 * @param values - Each field's value by name (missing ones use their default, or stay empty).
 * @returns The text to put in the message box; `{{input}}` is left for the cursor.
 */
export function fillPromptFields(text: string, values: Record<string, string | boolean>): string {
  const fields = new Map(promptFields(text).map((f) => [f.name, f]));
  return text.replace(FIELD, (all, rawName: string) => {
    const f = fields.get(rawName.trim());
    if (!f) return all;
    const v = values[f.name] ?? f.default ?? "";
    if (f.type === "checkbox") return v === true || v === "true" ? (f.label ?? f.name) : "";
    return String(v);
  });
}
