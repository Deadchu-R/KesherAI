import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { makeDiff, type ExternalAgent, type ExternalIO } from "@kesher/agent";
import { AcpAgent, type AcpHandlers, type AcpOption, type AcpPermission, type AcpUpdate } from "./acp.js";
import { agyPath } from "./routes/terminal.js";

/**
 * Outside coding agents a code conversation can run on instead of a model: KesherAI starts the agent's own CLI
 * in ACP mode in the conversation's folder and shows its turn (text, steps with diffs, plan) in the chat. Its
 * permission questions become KesherAI's approval cards, so they can be answered from the notifications page
 * and the phone. The agent signs in by itself (Antigravity: `agy`, once, in the terminal), so no token passes
 * through KesherAI.
 */
export const OUTSIDE_AGENTS: Record<string, { name: string; command: string; args: string[] }> = {
  "agent/antigravity": { name: "Antigravity CLI", command: "agy", args: ["acp"] },
};

/** @returns Whether the model id is an outside agent. */
export function isOutsideAgent(modelId: string): boolean {
  return modelId in OUTSIDE_AGENTS;
}

/** The option to send for the user's answer, from the agent's own options. */
export function optionFor(p: AcpPermission, decision: "allow" | "always" | "deny"): string | undefined {
  const want = decision === "always" ? ["allow_always", "allow_once"] : decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of want) {
    const o = p.options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return undefined;
}

/** What the approval card shows for an agent's question. */
function previewOf(p: AcpPermission, step?: { diffs?: string; text?: string }): string {
  // The change itself, so an edit is not approved blind: the diff it asks for, else what the step gets.
  const asked = p.diffs?.length ? p.diffs.map((d) => makeDiff(d.path, d.oldText ?? null, d.newText)).join("\n") : undefined;
  const raw = !asked && !step?.diffs && p.rawInput && p.rawInput !== "{}" ? p.rawInput : undefined;
  return [p.title, asked ?? step?.diffs, raw, step?.text].filter(Boolean).join("\n\n").slice(0, 8000) || p.toolKind || "(the agent did not say)";
}

/** An outside agent in a code chat. */
export type OutsideAgent = ExternalAgent & {
  close: () => void;
  /** The session's choices (model, thinking level…); starts the agent if needed. */
  options: () => Promise<AcpOption[]>;
  setOption: (configId: string, value: string) => Promise<AcpOption[]>;
};

/**
 * Builds the outside agent for a conversation.
 *
 * @param modelId - e.g. "agent/antigravity".
 * @param workspace - The conversation's folder.
 * @param start - Starts the connection (tests pass an in-process agent).
 * @param modeOf - The chat's approvals mode, matched to the agent's own modes before each turn.
 * @param saved - Where the chat keeps the agent's session id, so a restart resumes it instead of starting over.
 * @param extraDirs - More folders it may read (the shared task board), each as its own `--add-dir`.
 * @returns The agent, or undefined when the id is not an outside agent.
 */
export function outsideAgent(modelId: string, workspace: string | undefined, start?: (h: AcpHandlers) => Promise<AcpAgent>, modeOf?: () => string, saved?: { get: () => string | undefined; set: (id: string) => void }, extraDirs: string[] = []): OutsideAgent | undefined {
  const def = OUTSIDE_AGENTS[modelId];
  if (!def) return undefined;
  let conn: Promise<AcpAgent> | undefined;
  let io: ExternalIO | undefined;
  const steps = new Map<string, { name: string; diffs?: string; text?: string }>();
  const rel = (p: string) => (workspace ? relative(workspace, p) || p : p);
  const handlers: AcpHandlers = {
    update: (u: AcpUpdate) => {
      if (!io) return;
      if (u.kind === "text") io.text(u.text);
      else if (u.kind === "plan") io.plan(u.entries.map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${e.content}`).join("\n"));
      else if (u.kind === "tool") {
        const st = steps.get(u.id) ?? { name: u.title || u.toolKind || "step" };
        if (u.title) st.name = u.title;
        if (u.diffs?.length) st.diffs = u.diffs.map((d) => makeDiff(rel(d.path), d.oldText ?? null, d.newText)).join("\n");
        if (u.text) st.text = u.text;
        steps.set(u.id, st);
        const done = u.status === "completed" ? true : u.status === "failed" ? false : undefined;
        io.tool({ id: u.id, name: st.name, ...(u.toolKind ? { input: { kind: u.toolKind } } : {}), ...(done !== undefined ? { ok: done, output: st.text ?? "", ...(st.diffs ? { diff: st.diffs } : {}) } : {}) });
      }
    },
    permission: async (p) => {
      if (!io) return undefined;
      const step = steps.get(p.toolCallId);
      const decision = await io.approve({ callId: p.toolCallId, name: p.title || step?.name || def.name, preview: previewOf(p, step), reason: `${def.name} asks before this step.` });
      return optionFor(p, decision);
    },
  };
  const connect = async (): Promise<AcpAgent> => {
    if (start) return start(handlers);
    if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory()) throw new Error("This conversation has no project folder for the agent.");
    const local = def.command === "agy" ? agyPath() : undefined;
    const command = local && (await stat(local).catch(() => undefined)) ? local : def.command;
    try {
      return await AcpAgent.spawn(command, [...def.args, "--add-dir", workspace, ...extraDirs.flatMap((d) => ["--add-dir", d])], workspace, handlers);
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${def.name} is not installed. On the code page, press "Install Antigravity CLI", then "Antigravity CLI" once to sign in with Google.` : (e as Error).message;
      throw new Error(msg);
    }
  };
  const ready = async (): Promise<AcpAgent> => {
    conn ??= connect().then(async (a) => {
      const cwd = workspace ?? process.cwd();
      const before = saved?.get();
      // After a restart: the same session again (the agent remembers it); if that fails, a new one.
      if (before) {
        try {
          await a.resumeSession(before, cwd);
          return a;
        } catch {
          /* gone or not supported: start over */
        }
      }
      // (Not `saved?.set(await …)`: optional chaining would skip starting the session when nothing is saved.)
      const sid = await a.newSession(cwd);
      saved?.set(sid);
      return a;
    });
    try {
      return await conn;
    } catch (e) {
      conn = undefined;
      throw e;
    }
  };
  return {
    options: async () => (await ready()).options,
    setOption: async (configId, value) => (await ready()).setOption(configId, value),
    turn: async (text, turnIo, signal) => {
      io = turnIo;
      steps.clear();
      const agent = await ready();
      // KesherAI's mode → the agent's (ask before changes, accept edits, plan only, auto: Antigravity's own Auto,
      // which still reviews risky commands); a mode the agent lacks keeps its own.
      const want = { ask: "default", "auto-edit": "accept-edits", plan: "plan", auto: "auto" }[modeOf?.() ?? ""];
      if (want) await agent.setMode(want).catch(() => false);
      const onAbort = () => void agent.cancel().catch(() => undefined);
      signal.addEventListener("abort", onAbort);
      try {
        await agent.prompt(text);
      } catch (e) {
        const m = (e as Error).message;
        // Not signed in yet: say how, in its own terminal (KesherAI never handles the sign-in).
        if (/auth|sign.?in|login|credential/i.test(m)) throw new Error(`${def.name} is not signed in. On the code page, press "Antigravity CLI" once and sign in with Google, then send again. (${m})`);
        // The connection broke (the CLI quit): start it again next time.
        agent.close();
        conn = undefined;
        throw e;
      } finally {
        signal.removeEventListener("abort", onAbort);
        io = undefined;
      }
    },
    close: () => {
      void conn?.then((a) => a.close(), () => undefined);
      conn = undefined;
    },
  };
}
