#!/usr/bin/env node
/**
 * `kesher`: KesherAI from the command line.
 *
 *   kesher serve [--port 7420]           run KesherAI without a window (a server)
 *   kesher chat [message]                chat (no message: an interactive chat)
 *       --model <id> --persona <name> --code <folder> --web --new
 *   kesher models [category]             models KesherAI can use
 *   kesher search <words>                search the knowledge bases
 *   kesher run <pipeline> [name=value …] run a pipeline and follow it
 *   kesher status                        is KesherAI running, and what is loaded
 *
 * It talks to the KesherAI that runs on this computer (or --url / KESHER_URL
 * with --token / KESHER_TOKEN for another one). Chats appear in the app too.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    model: { type: "string" },
    persona: { type: "string" },
    code: { type: "string" },
    web: { type: "boolean" },
    new: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean", short: "y" },
  },
});
const [command, ...rest] = positionals;
const base = String(values.url ?? process.env.KESHER_URL ?? "http://127.0.0.1:7420").replace(/\/$/, "");
const token = (values.token as string | undefined) ?? process.env.KESHER_TOKEN;
const color = stdout.isTTY ? (c: number, s: string) => `\x1b[${c}m${s}\x1b[0m` : (_c: number, s: string) => s;
const dim = (s: string) => color(2, s);

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new Error(`KesherAI is not running at ${base}. Open the app, or run: kesher serve`);
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}

/** Follows a conversation's events until the agent is done, printing the answer as it comes. */
async function follow(id: string, after: number, rl?: ReturnType<typeof createInterface>): Promise<number> {
  const res = await fetch(`${base}/api/conversations/${id}/events?after=${after}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok || !res.body) throw new Error(`Could not follow the conversation (${res.status}).`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let last = after;
  let started = false;
  let streamed = false;
  // The answer may be done before this connects; the replayed events then show it.
  let answered = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      const e = JSON.parse(data) as { type: string; seq?: number; text?: string; status?: string; name?: string; preview?: string; requestId?: string; ok?: boolean; output?: string; message?: string; pendingApprovals?: string[] };
      if (e.seq) last = Math.max(last, e.seq);
      if (e.type === "assistant_delta") {
        stdout.write(e.text ?? "");
        streamed = true;
      } else if (e.type === "assistant") {
        answered = true;
        if (!streamed) stdout.write(e.text ?? "");
        stdout.write("\n");
        streamed = false;
      } else if (e.type === "tool_call") stdout.write(dim(`\n⚙ ${e.name}\n`));
      else if (e.type === "tool_result" && e.ok === false) stdout.write(color(31, `  ✗ ${(e.output ?? "").split("\n")[0]}\n`));
      else if (e.type === "approval_request") {
        stdout.write(color(33, `\n? ${e.name} wants to run:\n`) + `${(e.preview ?? "").slice(0, 2000)}\n`);
        let yes = values.yes === true;
        if (!yes) {
          const own = rl ?? createInterface({ input: stdin, output: stdout });
          yes = /^y(es)?|^כ/i.test((await own.question("Allow? [y/N] ")).trim());
          if (!rl) own.close();
        }
        await api(`/api/conversations/${id}/approvals/${e.requestId}`, { body: { decision: yes ? "allow" : "deny" } });
      } else if (e.type === "status" && e.status === "error") {
        answered = true;
        stdout.write(color(31, `\n${e.message ?? "Error"}\n`));
      }
      else if (e.type === "info") {
        if (e.status === "running" || e.status === "waiting") started = true;
        else if (started || answered) {
          await reader.cancel().catch(() => undefined);
          return last;
        }
      }
    }
  }
  return last;
}

async function chat(): Promise<void> {
  const body = {
    kind: values.code ? "code" : "chat",
    ...(values.model ? { modelId: values.model } : {}),
    ...(values.code ? { workspace: String(values.code) } : {}),
  } as Record<string, unknown>;
  if (values.persona) {
    const { personas } = await api<{ personas: Array<{ id: string; name: string }> }>("/api/personas");
    const p = personas.find((x) => x.name.toLowerCase() === String(values.persona).toLowerCase() || x.id === values.persona);
    if (!p) throw new Error(`No persona named ${String(values.persona)}.`);
    body.personaId = p.id;
  }
  const conv = await api<{ id: string; modelId: string }>("/api/conversations", { body });
  console.error(dim(`${conv.modelId} · ${base}/#/c/${conv.id}`));
  const send = async (text: string, after: number, rl?: ReturnType<typeof createInterface>) => {
    await api(`/api/conversations/${conv.id}/messages`, { body: { text, ...(values.web ? { web: true } : {}) } });
    return follow(conv.id, after, rl);
  };
  const message = rest.join(" ").trim() || (!stdin.isTTY ? await readAll() : "");
  if (message) {
    await send(message, 0);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  let after = 0;
  console.error(dim("Type a message (empty line or Ctrl+C to quit)."));
  for (;;) {
    const line = (await rl.question(color(36, "› "))).trim();
    if (!line) break;
    after = await send(line, after, rl);
  }
  rl.close();
}

async function readAll(): Promise<string> {
  let s = "";
  for await (const c of stdin) s += c;
  return s.trim();
}

async function main(): Promise<void> {
  switch (command) {
    case "serve": {
      // The same server the app runs, without a window.
      process.argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)];
      try {
        await import("./main.js");
      } catch {
        // The copy of this file in the desktop app has no server next to it.
        throw new Error("Run the app without a window instead: KesherAI --headless");
      }
      return;
    }
    case "chat":
      return chat();
    case "models": {
      const { models } = await api<{ models: Array<{ id: string; category: string; location: string }> }>("/api/models");
      const settings = await api<{ activeModels: Record<string, string> }>("/api/settings");
      const active = new Set(Object.values(settings.activeModels));
      for (const m of models.filter((x) => !rest[0] || x.category === rest[0])) console.log(`${active.has(m.id) ? "●" : " "} ${m.id}  ${dim(`${m.category}, ${m.location}`)}`);
      return;
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) throw new Error("kesher search <words>");
      const { hits } = await api<{ hits: Array<{ source: string; page: number; base: string; text: string }> }>("/api/knowledge/search", { body: { query: q } });
      if (!hits.length) console.log("Nothing found.");
      for (const h of hits) console.log(`${color(36, `${h.source}${/^https?:/.test(h.source) ? "" : `, p. ${h.page}`}`)} ${dim(`(${h.base})`)}\n${h.text.replace(/\s+/g, " ").slice(0, 400)}\n`);
      return;
    }
    case "run": {
      const name = rest[0];
      if (!name) throw new Error("kesher run <pipeline> [name=value …]");
      const { pipelines } = await api<{ pipelines: Array<{ id: string; name: string }> }>("/api/pipelines");
      const p = pipelines.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
      if (!p) throw new Error(`No pipeline named ${name}. Pipelines: ${pipelines.map((x) => x.name).join(", ") || "none"}`);
      const inputs = Object.fromEntries(rest.slice(1).map((kv) => [kv.split("=")[0]!, kv.split("=").slice(1).join("=")]));
      const run = await api<{ id: string }>(`/api/pipelines/${p.id}/run`, { body: { inputs } });
      let shown = 0;
      for (;;) {
        const r = await api<{ status: string; log: Array<{ type: string; text: string }>; files: string[]; error?: string }>(`/api/pipelines/runs/${run.id}`);
        for (const l of r.log.slice(shown)) console.log(`${dim(l.type.padEnd(10))} ${l.text}`);
        shown = r.log.length;
        if (r.status !== "running") {
          if (r.files.length) console.log(`Files: ${r.files.map((f) => `${base}/api/pipelines/runs/${run.id}/files/${encodeURIComponent(f)}`).join("\n       ")}`);
          if (r.status === "error") process.exitCode = 1;
          return;
        }
        await new Promise((ok) => setTimeout(ok, 800));
      }
    }
    case "status": {
      const h = await api<{ version: string; build?: { version: string } }>("/api/health");
      const e = await api<{ running: boolean; modelPath?: string }>("/api/engines/llamacpp").catch(() => undefined);
      const s = await api<{ activeModels: Record<string, string> }>("/api/settings");
      console.log(`KesherAI ${h.build?.version ?? h.version} at ${base}`);
      for (const [k, v] of Object.entries(s.activeModels)) console.log(`  ${k.padEnd(10)} ${v}`);
      if (e) console.log(`  engine     ${e.running ? `running ${e.modelPath?.split(/[\\/]/).pop() ?? ""}` : "stopped"}`);
      return;
    }
    default:
      console.log(`kesher — KesherAI from the command line

  kesher serve [--port 7420]             run KesherAI without a window
  kesher chat [message]                  chat (no message: interactive)
      --model <id>  --persona <name>  --code <folder>  --web  -y (approve all)
  kesher models [category]               the models you can use
  kesher search <words>                  search your knowledge bases
  kesher run <pipeline> [name=value …]   run a pipeline
  kesher status                          what is running

  --url / KESHER_URL and --token / KESHER_TOKEN reach KesherAI on another computer.`);
      if (command && command !== "help" && !values.help) process.exitCode = 1;
  }
}

main().catch((e: Error) => {
  console.error(color(31, e.message));
  process.exit(1);
});
