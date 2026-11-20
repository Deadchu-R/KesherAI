/**
 * One Unity Undo step per chat turn (docs/RESEARCH_LOG.md, "Usability gap list against the code", Area 3).
 *
 * When a turn of the agent makes its first change in the open Unity Editor, a named Undo group is opened there
 * ("KesherAI: <the request, short>"); when the turn ends, every Undo step Unity recorded since then is collapsed into
 * that group. So one Ctrl+Z in Unity takes back the whole turn: KesherAI's own tools, `unity_command` and
 * `unity_script_eval` code that records Undo (most Editor commands do) alike.
 *
 * The state lives here, per chat, keyed by the Unity service, so the chat's tools (made again when a project is
 * opened) and the conversation's turn events meet without new wiring through the server.
 */
import type { UnityCli } from "./unity-cli.js";
import { csString } from "./unity-tools.js";

/** What a chat's Unity tools use of the turn: open the group before a change, count compile fixes. */
export interface UnityTurnHandle {
  /** Opens the turn's Undo group in Unity before its first change (once per turn; nothing outside a turn). */
  beforeEdit(): Promise<void>;
  /** Failed compiles per script path in this turn (unity_write_script stops after 2 automatic fixes). */
  compileFailures(): Map<string, number>;
}

interface ChatTurn {
  /** A turn is running (between the "running" and the "idle"/"error" statuses). */
  active: boolean;
  /** The group's name in Unity's Edit menu. */
  title: string;
  /** Unity's Undo group index of the turn's first change, once it was opened. */
  group?: number;
  /** The project the group was opened in (the chat may switch projects mid-turn). */
  project?: string;
  /** The open call in flight, so two changes at once open one group. */
  opening?: Promise<void>;
  /** Failed compiles per script in this turn. */
  failures: Map<string, number>;
}

/** The longest title in Unity's Undo menu. */
const TITLE_MAX = 48;

/**
 * A short Undo name from the user's request: its first line, cut at a word, with "KesherAI: " before it.
 *
 * @param request - The user's message for this turn.
 */
export function turnTitle(request: string): string {
  const line = request.replace(/\s+/g, " ").trim();
  if (!line) return "KesherAI: chat turn";
  if (line.length <= TITLE_MAX) return `KesherAI: ${line}`;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `KesherAI: ${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

/** C#: starts a new Undo group with the turn's name and returns its index. */
export const OPEN_GROUP = (title: string) => `UnityEditor.Undo.IncrementCurrentGroup();
UnityEditor.Undo.SetCurrentGroupName(${csString(title)});
return UnityEditor.Undo.GetCurrentGroup();`;

/** C#: folds every Undo step since the group into it (skipped when Unity restarted and its counter began again). */
export const COLLAPSE_GROUP = (group: number) => `if (UnityEditor.Undo.GetCurrentGroup() < ${group}) return "skipped";
UnityEditor.Undo.CollapseUndoOperations(${group});
return "collapsed";`;

/** The turns of every chat that uses one Unity service. */
export class UnityTurns {
  private readonly chats = new Map<string, ChatTurn>();

  /** @param unity - The Unity CLI service (its active project is where the groups are made). */
  constructor(private readonly unity: UnityCli) {}

  private chat(id: string): ChatTurn {
    let c = this.chats.get(id);
    if (!c) this.chats.set(id, (c = { active: false, title: "", failures: new Map() }));
    return c;
  }

  /** Runs C# in the open Editor; undefined when it did not answer (closed, reloading). */
  private async eval(project: string, code: string): Promise<string | undefined> {
    const r = await this.unity.cliRaw(["command", "script", "eval", "--project-path", project, "--result-only", "--timeout", "30", "--", code], 45_000).catch(() => undefined);
    if (!r || r.code !== 0) return undefined;
    return r.stdout.trim().replace(/^"|"$/g, "");
  }

  /**
   * A turn of a chat began: its first Unity change opens a group with this name.
   *
   * @param id - The chat.
   * @param request - The user's message for the turn (for the group's name).
   */
  begin(id: string, request: string): void {
    const c = this.chat(id);
    if (c.active) return; // "running" again after an approval: the same turn
    Object.assign(c, { active: true, title: turnTitle(request), group: undefined, project: undefined, opening: undefined });
    c.failures.clear();
  }

  /**
   * The turn of a chat ended: Unity's steps since its group are folded into one.
   *
   * @param id - The chat.
   * @returns Whether a group was collapsed.
   */
  async end(id: string): Promise<boolean> {
    const c = this.chats.get(id);
    if (!c?.active) return false;
    c.active = false;
    await c.opening?.catch(() => undefined);
    const { group, project } = c;
    c.group = c.project = undefined;
    if (group === undefined || !project) return false;
    return (await this.eval(project, COLLAPSE_GROUP(group))) === "collapsed";
  }

  /**
   * The handle a chat's Unity tools get.
   *
   * @param id - The chat.
   */
  handle(id: string): UnityTurnHandle {
    return {
      beforeEdit: async () => {
        const c = this.chat(id);
        const project = this.unity.activeProject;
        if (!c.active || !project || (c.group !== undefined && c.project === project)) return;
        if (c.opening) return c.opening;
        c.opening = (async () => {
          const got = Number(await this.eval(project, OPEN_GROUP(c.title)));
          // Not opened (the Editor did not answer): the next change tries again.
          if (Number.isInteger(got) && got >= 0 && c.active) Object.assign(c, { group: got, project });
        })().finally(() => (c.opening = undefined));
        return c.opening;
      },
      compileFailures: () => this.chat(id).failures,
    };
  }
}

const all = new WeakMap<UnityCli, UnityTurns>();

/**
 * The turns of the chats that use this Unity service (one set per service).
 *
 * @param unity - The Unity CLI service.
 */
export function unityTurns(unity: UnityCli): UnityTurns {
  let t = all.get(unity);
  if (!t) all.set(unity, (t = new UnityTurns(unity)));
  return t;
}

/** The Unity tools that change the open Editor's scene or assets (they open the turn's group first). */
export const UNITY_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "unity_create_gameobject",
  "unity_add_component",
  "unity_command",
  "unity_script_eval",
  "unity_modify_scene",
  "unity_import_sprite",
  "unity_create_pbr_material",
]);

/** Automatic fixes of one script per turn before KesherAI stops and asks the user. */
export const MAX_COMPILE_FIXES = 2;
/** Errors listed after a compile. */
const MAX_ERRORS = 10;

/**
 * The compile errors of `unity recompile --format json`, one line each as "file:line: message" (at most 10, then a
 * count of the rest), so a fix costs few tokens. Reads the JSON diagnostics, else Unity's own console format
 * ("Assets/A.cs(12,5): error CS1002: ; expected").
 *
 * @param stdout - The CLI's output.
 * @param stderr - Its error output.
 * @returns The lines; empty when none could be read.
 */
export function compileErrors(stdout: string, stderr = ""): string[] {
  const found: string[] = [];
  const add = (file: unknown, line: unknown, code: unknown, message: unknown) => {
    const msg = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!msg) return;
    const where = typeof file === "string" && file ? `${file.replace(/\\/g, "/")}${line ? `:${Number(line)}` : ""}: ` : "";
    const id = typeof code === "string" && code && !msg.includes(code) ? `${code}: ` : "";
    const text = `${where}${id}${msg}`;
    if (!found.includes(text)) found.push(text);
  };
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 4) return;
    const o = v as Record<string, unknown>;
    for (const key of ["errors", "diagnostics"]) {
      const list = o[key];
      if (!Array.isArray(list)) continue;
      for (const d of list as Array<Record<string, unknown>>) {
        if (!d || typeof d !== "object") continue;
        // A diagnostic, not the CLI's own "the compile failed" envelope error (that one has no place in a file).
        if (key === "errors" && !("file" in d || "path" in d || "filePath" in d || "line" in d) && /^[A-Z_]+$/.test(String(d.code ?? "")) && /compil/i.test(String(d.message ?? ""))) continue;
        if (String(d.severity ?? d.type ?? "error").toLowerCase().startsWith("warn")) continue;
        add(d.file ?? d.path ?? d.filePath ?? d.sourceFile, d.line ?? d.lineNumber, d.code ?? d.id, d.message ?? d.text);
      }
    }
    visit(o.data, depth + 1);
  };
  for (const line of [stdout.trim(), ...stdout.split(/\r?\n/)]) {
    try {
      visit(JSON.parse(line) as unknown, 0);
    } catch {
      // not JSON
    }
    if (found.length) break;
  }
  if (!found.length) {
    for (const m of `${stdout}\n${stderr}`.matchAll(/([\w./\\ -]+\.\w+)\((\d+),\d+\): error (\w+): ([^\r\n]+)/g)) add(m[1]!.trim(), m[2], m[3], m[4]);
  }
  return found.length > MAX_ERRORS ? [...found.slice(0, MAX_ERRORS), `… and ${found.length - MAX_ERRORS} more`] : found;
}
