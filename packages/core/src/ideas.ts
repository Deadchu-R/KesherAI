import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IDEAS_PROMPT, TRIED_PROMPT, cleanIdeas, ideaQuery, jsonIn, researchPrompt, type Idea, type IdeaSession } from "@kesher/shared";

/** What the ideas need from the rest of KesherAI (fakes in the tests). */
export interface IdeasDeps {
  /** The chat model: a system and a user message in, its text out. */
  ask: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
  /** A recording's speech as text. */
  transcribe: (file: string) => Promise<string>;
  /** Her project names. */
  projects: () => string[];
  /** Her past chats that match some words (incognito ones left out). */
  search: (query: string) => Promise<Array<{ id: string; title: string; snippet: string; score: number }>>;
  /** Starts a research chat (web on) with a first message; its id. */
  startResearch: (title: string, text: string) => Promise<string>;
  /** Waits until that chat is done (or a while); "done" or "error". */
  settle: (conversationId: string) => Promise<"done" | "error">;
}

const SID = /^[\w-]{1,64}$/;

/**
 * "Open mind" sessions (design IdeaSession), one JSON file each in `dir`. A recording is turned into ideas in the
 * background: transcribed, the ideas pulled out and sorted by the chat model, then each checked against her past
 * chats ("tried before"). Research runs as ordinary chats with the web, one at a time when she asks for all.
 */
export class Ideas {
  private running = new Set<string>();

  /**
   * @param dir - Where sessions are kept.
   * @param deps - Model, speech, projects, chat search and research chats.
   */
  constructor(
    private readonly dir: string,
    private readonly deps: IdeasDeps,
  ) {}

  private file(id: string): string {
    if (!SID.test(id)) throw Object.assign(new Error("No such session."), { statusCode: 404 });
    return join(this.dir, `${id}.json`);
  }

  /** Her sessions, newest first, without transcripts. */
  async list(): Promise<Array<Omit<IdeaSession, "transcript" | "ideas"> & { count: number; good: number }>> {
    await mkdir(this.dir, { recursive: true });
    const out = [];
    for (const n of (await readdir(this.dir)).filter((n) => n.endsWith(".json"))) {
      const s = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (!s) continue;
      const { transcript: _t, ideas, ...rest } = s;
      out.push({ ...rest, count: ideas.length, good: ideas.filter((i) => i.verdict === "good").length });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  /** One session, with its ideas. */
  async get(id: string): Promise<IdeaSession> {
    const raw = await readFile(this.file(id), "utf8").catch(() => {
      throw Object.assign(new Error("No such session."), { statusCode: 404 });
    });
    return JSON.parse(raw) as IdeaSession;
  }

  private async save(s: IdeaSession): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(s.id)}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 1));
    await rename(tmp, this.file(s.id));
  }

  /** Deletes a session (its research chats stay). */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  /**
   * A new session from a recording (the file is deleted once read) or from text she typed; sorted in the background.
   *
   * @param p - The recording's path, or text; and how long it was.
   */
  async start(p: { file?: string; text?: string; seconds?: number }): Promise<IdeaSession> {
    const s: IdeaSession = { id: randomUUID(), t: Date.now(), seconds: Math.max(0, Math.round(Number(p.seconds) || 0)), status: p.file ? "transcribing" : "sorting", ideas: [], ...(p.text ? { transcript: p.text.slice(0, 400_000) } : {}) };
    await this.save(s);
    void this.process(s.id, p.file).catch(() => undefined);
    return s;
  }

  /** Runs a session: transcribe, pull out and sort, check "tried before". Errors are kept on the session. */
  async process(id: string, file?: string): Promise<IdeaSession> {
    let s = await this.get(id);
    try {
      if (file) {
        const text = await this.deps.transcribe(file).finally(() => rm(file, { force: true }));
        s = { ...(await this.get(id)), transcript: text.slice(0, 400_000), status: "sorting" };
        await this.save(s);
      }
      if (!s.transcript?.trim()) throw new Error("No speech was found in the recording.");
      const projects = this.deps.projects().slice(0, 80);
      const raw = await this.deps.ask(IDEAS_PROMPT, `THEIR PROJECTS: ${projects.length ? projects.join(" | ") : "(none)"}\n\nTRANSCRIPT:\n<<<\n${s.transcript.slice(0, 120_000)}\n>>>`);
      const ideas = cleanIdeas(jsonIn(raw), projects, () => randomUUID());
      if (!ideas.length) throw new Error("No ideas were found in what was said.");
      await this.markTried(ideas);
      s = { ...(await this.get(id)), ideas, status: "done" };
      delete s.error;
      await this.save(s);
      return s;
    } catch (e) {
      s = { ...(await this.get(id)), status: "error", error: (e as Error).message.slice(0, 300) };
      await this.save(s);
      return s;
    }
  }

  /** "Tried before": her past chats that match each idea, judged by the model in one go. */
  private async markTried(ideas: Idea[]): Promise<void> {
    const found: Array<{ i: number; hits: Array<{ id: string; title: string; snippet: string }> }> = [];
    for (const [i, idea] of ideas.entries()) {
      const hits = (await this.deps.search(ideaQuery(idea)).catch(() => [])).filter((h) => h.score > 0).slice(0, 3);
      if (hits.length) found.push({ i, hits });
    }
    if (!found.length) return;
    const user = found.map(({ i, hits }) => `IDEA ${i}: ${ideas[i]!.title} — ${ideas[i]!.prompt.slice(0, 300)}\n${hits.map((h) => `  [chat "${h.title}"] ${h.snippet.slice(0, 400)}`).join("\n")}`).join("\n\n");
    const verdicts = jsonIn(await this.deps.ask(TRIED_PROMPT, user).catch(() => "[]"));
    if (!Array.isArray(verdicts)) return;
    for (const v of verdicts as Array<{ i?: unknown; tried?: unknown; note?: unknown }>) {
      const f = found.find((x) => x.i === Number(v.i));
      if (!f || v.tried !== true) continue;
      const idea = ideas[f.i]!;
      idea.tried = "yes";
      if (typeof v.note === "string" && v.note.trim()) idea.triedNote = v.note.trim().slice(0, 300);
      idea.triedIn = f.hits.map((h) => ({ conversationId: h.id, title: h.title.slice(0, 120) }));
    }
  }

  private async setResearch(id: string, ideaId: string, r: Idea["research"]): Promise<IdeaSession> {
    const s = await this.get(id);
    const idea = s.ideas.find((i) => i.id === ideaId);
    if (!idea) throw Object.assign(new Error("No such idea."), { statusCode: 404 });
    if (r) idea.research = r;
    else delete idea.research;
    await this.save(s);
    return s;
  }

  /**
   * Starts research on one idea: a chat with the web, named after the idea. Returns the chat's id (an existing one
   * when it was already researched).
   */
  async research(id: string, ideaId: string, he: boolean): Promise<string> {
    const s = await this.get(id);
    const idea = s.ideas.find((i) => i.id === ideaId);
    if (!idea) throw Object.assign(new Error("No such idea."), { statusCode: 404 });
    if (idea.research && idea.research.status !== "error" && idea.research.status !== "queued") return idea.research.conversationId;
    const conversationId = await this.deps.startResearch(`🔬 ${idea.title}`, researchPrompt(idea, he));
    await this.setResearch(id, ideaId, { conversationId, status: "running" });
    void this.deps.settle(conversationId).then((st) => this.setResearch(id, ideaId, { conversationId, status: st }).catch(() => undefined));
    return conversationId;
  }

  /** Research on every idea not researched yet, one after another (good ones first). */
  async researchAll(id: string, he: boolean): Promise<IdeaSession> {
    if (this.running.has(id)) return this.get(id);
    const s = await this.get(id);
    s.researchAll = true;
    await this.save(s);
    this.running.add(id);
    const order = { good: 0, maybe: 1, weak: 2 } as const;
    const todo = s.ideas.filter((i) => !i.research || i.research.status === "error").sort((a, b) => order[a.verdict] - order[b.verdict]).map((i) => i.id);
    void (async () => {
      try {
        for (const ideaId of todo) {
          if (!(await this.get(id).catch(() => undefined))?.researchAll) break;
          const cid = await this.research(id, ideaId, he).catch(() => undefined);
          if (cid) await this.setResearch(id, ideaId, { conversationId: cid, status: await this.deps.settle(cid) });
        }
      } finally {
        this.running.delete(id);
        const done = await this.get(id).catch(() => undefined);
        if (done) {
          delete done.researchAll;
          await this.save(done);
        }
      }
    })();
    return this.get(id);
  }

  /** Stops "research all" after the idea being researched now. */
  async stopAll(id: string): Promise<IdeaSession> {
    const s = await this.get(id);
    delete s.researchAll;
    await this.save(s);
    return s;
  }
}
