import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { replaceFile } from "./replace-file.js";
import { join } from "node:path";
import { CHALLENGE_PROMPT, CREATIVE_PROMPT, IDEAS_PROMPT, SUMMARY_PROMPT, TRIED_PROMPT, fallbackDirections, splitTranscript, cleanIdeas, editIdea, ideaNote, ideaQuery, ideaTask, jsonIn, mergeIdeas, mostlyHebrew, researchPrompt, sessionMatches, splitIdea, peekIdeas, type Idea, type IdeaFound, type IdeaProgress, type IdeaSession } from "@kesher/shared";

/** What the ideas need from the rest of KesherAI (fakes in the tests). */
export interface IdeasDeps {
  /** The chat model: a system and a user message in, its text out (`onText` gets each piece as it is written; `strong` asks for a stronger model when there is one). */
  ask: (system: string, user: string, signal?: AbortSignal, onText?: (delta: string) => void, strong?: boolean) => Promise<string>;
  /** A recording's speech as text. */
  /** Speech to text; `lang` is the recording app's language (he, en), used when the speech language is auto. */
  transcribe: (file: string, lang?: string) => Promise<string>;
  /** Her project names. */
  projects: () => string[];
  /** Her past chats that match some words (incognito ones left out). */
  search: (query: string) => Promise<Array<{ id: string; title: string; snippet: string; score: number }>>;
  /** Starts a research chat (web on) with a first message; its id. */
  startResearch: (title: string, text: string) => Promise<string>;
  /** Waits until that chat is done (or a while); "done" or "error". */
  settle: (conversationId: string) => Promise<"done" | "error">;
  /** Saves a Markdown note where Knowledge reads it; the note's file name. */
  saveNote: (title: string, markdown: string) => Promise<string>;
  /** Adds a task to the task inbox; its id. */
  addTask: (task: { title: string; goal: string; acceptance?: string }) => Promise<string>;
}

/** Ideas, tasks and questions in a finished list (the same counts `peekIdeas` gives while it is written). */
function countIdeas(ideas: Idea[]): IdeaFound {
  const n = (k: string) => ideas.filter((i) => (i.kind ?? "idea") === k).length;
  const last = ideas[ideas.length - 1]?.title;
  return { ideas: n("idea"), tasks: n("task"), questions: n("question"), ...(last ? { last } : {}) };
}

const SID = /^[\w-]{1,64}$/;

/**
 * "Open mind" sessions (design IdeaSession), one JSON file each in `dir`. A recording is turned into ideas in the
 * background: transcribed, the ideas pulled out and sorted by the chat model, then each checked against her past
 * chats ("tried before"). Research runs as ordinary chats with the web, one at a time when she asks for all.
 */
export class Ideas {
  private running = new Set<string>();
  /** Live progress of the analyses under way (memory only: a restart ends them anyway). */
  private live = new Map<string, IdeaProgress>();
  /** How many seconds reading one second of speech took last time (a guess for the first time: 0.25). */
  private speed = 0.25;

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

  /**
   * Her sessions, newest first, without transcripts; each with its first idea titles for the list.
   *
   * @param q - Only sessions whose transcript or ideas have every word of this (empty: all).
   */
  async list(q = ""): Promise<Array<Omit<IdeaSession, "transcript" | "ideas"> & { count: number; good: number; titles: string[] }>> {
    await mkdir(this.dir, { recursive: true });
    const out = [];
    for (const n of (await readdir(this.dir)).filter((n) => n.endsWith(".json"))) {
      const s = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (!s || !sessionMatches(s, q)) continue;
      const { transcript: _t, ideas, ...rest } = s;
      out.push({ ...rest, count: ideas.length, good: ideas.filter((i) => i.verdict === "good").length, titles: ideas.slice(0, 3).map((i) => i.title) });
    }
    return out.sort((a, b) => b.t - a.t);
  }

  /** One session, with its ideas. */
  async get(id: string): Promise<IdeaSession> {
    const raw = await readFile(this.file(id), "utf8").catch(() => {
      throw Object.assign(new Error("No such session."), { statusCode: 404 });
    });
    const s = JSON.parse(raw) as IdeaSession;
    const progress = this.live.get(id);
    if (progress && (s.status === "transcribing" || s.status === "sorting")) s.progress = { ...progress, now: Date.now() };
    return s;
  }

  /** Changes the live progress of a session (and starts a new stage's clock when the stage changes). */
  private mark(id: string, p: Partial<IdeaProgress> & { stage: IdeaProgress["stage"] }): void {
    const old = this.live.get(id);
    const now = Date.now();
    this.live.set(id, { startedAt: old?.startedAt ?? now, ...old, ...p, stageAt: old?.stage === p.stage ? old.stageAt : now });
  }

  private async save(s: IdeaSession): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(s.id)}.${randomUUID()}.tmp`;
    const { progress: _live, ...onDisk } = s;
    await writeFile(tmp, JSON.stringify(onDisk, null, 1));
    await replaceFile(tmp, this.file(s.id));
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
  async start(p: { file?: string; text?: string; seconds?: number; lang?: string }): Promise<IdeaSession> {
    const s: IdeaSession = { id: randomUUID(), t: Date.now(), seconds: Math.max(0, Math.round(Number(p.seconds) || 0)), status: p.file ? "transcribing" : "sorting", ideas: [], ...(p.text ? { transcript: p.text.slice(0, 400_000) } : {}) };
    await this.save(s);
    void this.process(s.id, p.file, undefined, p.lang).catch(() => undefined);
    return s;
  }

  /**
   * "Analyse again": one level deeper than the last time (2 creative, 3 small parts with a stronger model, 4+ the
   * model challenges the earlier result). The ideas found before are kept; only new ones are added. Runs in the
   * background like the first pass, with the same live progress.
   *
   * @param id - The session.
   * @returns The session, now being analysed.
   */
  async deeper(id: string): Promise<IdeaSession> {
    const s = await this.get(id);
    if (s.status === "transcribing" || s.status === "sorting") throw Object.assign(new Error("It is still being analysed."), { statusCode: 409 });
    if (!s.transcript?.trim()) throw Object.assign(new Error("There is no transcript to read again."), { statusCode: 400 });
    const level = (s.depth ?? 1) + 1;
    const next: IdeaSession = { ...s, status: "sorting" };
    delete next.error;
    delete next.deeperError;
    await this.save(next);
    void this.process(id, undefined, level).catch(() => undefined);
    return { ...next, progress: { stage: "splitting", startedAt: Date.now(), stageAt: Date.now(), now: Date.now(), level } };
  }

  /** Runs a session: transcribe, pull out and sort, check "tried before". Errors are kept on the session. */
  async process(id: string, file?: string, level = 1, lang?: string): Promise<IdeaSession> {
    let s = await this.get(id);
    const before = level > 1 ? s.ideas : [];
    this.live.set(id, { stage: file ? "transcribing" : "splitting", startedAt: Date.now(), stageAt: Date.now(), level });
    try {
      if (file) {
        const audio = s.seconds;
        this.mark(id, { stage: "transcribing", ...(audio ? { audioSeconds: audio, expectedSeconds: Math.max(5, Math.round(audio * this.speed)) } : {}) });
        const began = Date.now();
        const text = await this.deps.transcribe(file, lang).finally(() => rm(file, { force: true }));
        // Remember how fast this computer reads speech, for the next guess.
        if (audio >= 30) this.speed = Math.min(2, Math.max(0.02, (Date.now() - began) / 1000 / audio));
        s = { ...(await this.get(id)), transcript: text.slice(0, 400_000), status: "sorting" };
        await this.save(s);
      }
      this.mark(id, { stage: "splitting", found: { ideas: 0, tasks: 0, questions: 0 } });
      if (!s.transcript?.trim()) throw new Error("No speech was found in the recording.");
      const projects = this.deps.projects().slice(0, 80);
      const { ideas: found, summary } = await this.extract(id, s.transcript, projects, level, before);
      this.mark(id, { stage: "writing", found: countIdeas([...before, ...found]), checked: { done: 0, of: found.length } });
      await this.markTried(found, (done) => this.mark(id, { stage: "writing", checked: { done, of: found.length } }));
      this.live.delete(id);
      // Earlier ideas stay (she may have edited them); the new ones come after.
      s = { ...(await this.get(id)), ideas: [...before, ...found], status: "done", depth: Math.max(level, s.depth ?? 1) };
      if (summary && !before.length) s.summary = summary;
      else delete s.summary;
      delete s.error;
      delete s.deeperError;
      await this.save(s);
      return s;
    } catch (e) {
      this.live.delete(id);
      const msg = (e as Error).message.slice(0, 300);
      // A deeper pass that fails leaves what was found before: the session stays "done" with the reason beside it.
      s = before.length ? { ...(await this.get(id)), ideas: before, status: "done", deeperError: plainError(msg) } : { ...(await this.get(id)), status: "error", error: msg };
      await this.save(s);
      return s;
    }
  }

  /**
   * Pulls the ideas out of a transcript, working harder when it finds little: the transcript is read in parts (so
   * nothing is skipped), a second, more creative pass runs when the first found fewer than three, and when there is
   * still nothing a summary with possible directions is asked for, then made locally. Never returns an empty list.
   *
   * @param id - The session (its live progress is updated).
   * @param transcript - What was said.
   * @param projects - Her project names.
   * @returns The ideas, and a summary when they are only possible directions.
   */
  private async extract(id: string, transcript: string, projects: string[], level = 1, existing: Idea[] = []): Promise<{ ideas: Idea[]; summary?: string }> {
    // Depth 3 reads smaller parts so every sentence gets attention.
    const parts = splitTranscript(transcript.slice(0, 400_000), level === 3 ? 2500 : 12_000);
    const all: Idea[] = [];
    const seen = new Set(existing.map((i) => i.title.toLowerCase()));
    const add = (more: Idea[], inferred = false) => {
      for (const i of more) {
        const key = i.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(inferred ? { ...i, inferred: true } : i);
      }
    };
    const pass = async (prompt: string, forced: boolean, strong = false, withFound = false) => {
      for (const [n, part] of parts.entries()) {
        const base = countIdeas(all);
        this.mark(id, { stage: "splitting", part: { done: n, of: parts.length }, found: base });
        let written = "";
        // The challenge pass is told what is already found, so it adds instead of repeating.
        const extra = withFound ? `\n\nALREADY FOUND:\n${[...existing, ...all].map((i) => `- ${i.title}`).join("\n")}` : "";
        const found = await this.pull(prompt, part, projects, transcript, extra, strong, (d) => {
          written += d;
          const now = peekIdeas(written);
          this.mark(id, { stage: "splitting", found: { ideas: base.ideas + now.ideas, tasks: base.tasks + now.tasks, questions: base.questions + now.questions, ...(now.last ?? base.last ? { last: now.last ?? base.last } : {}) } });
        });
        add(found, forced);
      }
    };
    if (level === 1) {
      await pass(IDEAS_PROMPT, false);
      if (all.length < 3) await pass(CREATIVE_PROMPT, true);
    } else if (level === 2) await pass(CREATIVE_PROMPT, true);
    else if (level === 3) {
      await pass(IDEAS_PROMPT, false, true);
      await pass(CREATIVE_PROMPT, true, true);
    } else await pass(CHALLENGE_PROMPT, false, true, true);
    if (all.length || existing.length) return { ideas: all };
    // Still nothing: a summary with possible directions from the model, then from the text itself.
    this.mark(id, { stage: "splitting", found: { ideas: 0, tasks: 0, questions: 0 } });
    const raw = jsonIn(await this.deps.ask(SUMMARY_PROMPT, `TRANSCRIPT:\n<<<\n${transcript.slice(0, 12_000)}\n>>>`).catch(() => "")) as { summary?: unknown; directions?: unknown } | null;
    const directions = cleanIdeas(raw && typeof raw === "object" ? raw.directions : [], projects, () => randomUUID(), transcript).map((i) => ({ ...i, inferred: true }));
    const text = raw && typeof raw === "object" && typeof raw.summary === "string" ? raw.summary.trim().slice(0, 600) : "";
    if (directions.length) return { ideas: directions, summary: text || transcript.replace(/\s+/g, " ").trim().slice(0, 300) };
    const local = fallbackDirections(transcript, () => randomUUID());
    if (!local.ideas.length) throw new Error("No speech was found in the recording.");
    return { ideas: local.ideas, summary: text || local.summary };
  }

  /** One model call over one part of the transcript: its ideas, asked again in Hebrew when they spoke Hebrew and it drifted. */
  private async pull(prompt: string, part: string, projects: string[], transcript: string, extra: string, strong: boolean, onText: (d: string) => void): Promise<Idea[]> {
    // They spoke Hebrew: everything is written in Hebrew (small local models drift to English), checked and asked again once.
    const he = mostlyHebrew(part);
    const lang = he ? "\nLANGUAGE: they spoke Hebrew. Write title, prompt, why, audience and category IN HEBREW." : "";
    const user = `THEIR PROJECTS: ${projects.length ? projects.join(" | ") : "(none)"}${lang}\n\nTRANSCRIPT:\n<<<\n${part}\n>>>${extra}`;
    let ideas = cleanIdeas(jsonIn(await this.deps.ask(prompt, user, undefined, onText, strong)), projects, () => randomUUID(), transcript);
    if (he && ideas.length && ideas.filter((i) => !mostlyHebrew(`${i.title} ${i.prompt}`)).length > ideas.length / 2) {
      const again = cleanIdeas(jsonIn(await this.deps.ask(prompt, `${user}\n\nYour last answer was in English. Answer again with every text field in Hebrew.`, undefined, undefined, strong).catch(() => "")), projects, () => randomUUID(), transcript);
      if (again.length) ideas = again;
    }
    return ideas;
  }

  /** "Tried before": her past chats that match each idea, judged by the model in one go. */
  private async markTried(ideas: Idea[], onChecked: (done: number) => void = () => undefined): Promise<void> {
    const found: Array<{ i: number; hits: Array<{ id: string; title: string; snippet: string }> }> = [];
    for (const [i, idea] of ideas.entries()) {
      // Only strong matches go to the model (a few shared words match almost any chat).
      const all = await this.deps.search(ideaQuery(idea)).catch(() => []);
      const top = all[0]?.score ?? 0;
      const hits = all.filter((h) => h.score > 0 && h.score >= top * 0.6).slice(0, 3);
      if (hits.length) found.push({ i, hits });
      onChecked(i + 1);
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

  /** The session and one of its ideas (404 when either is missing). */
  private async idea(id: string, ideaId: string): Promise<{ s: IdeaSession; idea: Idea }> {
    const s = await this.get(id);
    const idea = s.ideas.find((i) => i.id === ideaId);
    if (!idea) throw Object.assign(new Error("No such idea."), { statusCode: 404 });
    return { s, idea };
  }

  /**
   * Her edit to one idea (title, prompt, kind, quote, next step, verdict).
   *
   * @param id - The session.
   * @param ideaId - The idea.
   * @param e - The changes (any shape; cleaned by editIdea).
   */
  async edit(id: string, ideaId: string, e: unknown): Promise<IdeaSession> {
    const { s, idea } = await this.idea(id, ideaId);
    s.ideas = s.ideas.map((i) => (i === idea ? editIdea(i, e) : i));
    await this.save(s);
    return s;
  }

  /** Deletes one idea from a session (its research chat, note and task stay). */
  async removeIdea(id: string, ideaId: string): Promise<IdeaSession> {
    const { s, idea } = await this.idea(id, ideaId);
    s.ideas = s.ideas.filter((i) => i !== idea);
    await this.save(s);
    return s;
  }

  /**
   * Joins two or more ideas into one, in the place of the first.
   *
   * @param id - The session.
   * @param ids - The ideas to join.
   */
  async merge(id: string, ids: string[]): Promise<IdeaSession> {
    const s = await this.get(id);
    const next = mergeIdeas(s.ideas, ids, randomUUID());
    if (!next) throw Object.assign(new Error("Choose at least two ideas to merge."), { statusCode: 400 });
    s.ideas = next;
    await this.save(s);
    return s;
  }

  /**
   * Splits one idea into separate ones: by the lines she wrote (two or more), else by the chat model reading the idea
   * again with the same instructions as the whole dump.
   *
   * @param id - The session.
   * @param ideaId - The idea.
   * @param lines - Her own parts, one per line (optional).
   */
  async split(id: string, ideaId: string, lines?: string[]): Promise<IdeaSession> {
    const { s, idea } = await this.idea(id, ideaId);
    const own = (lines ?? []).map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
    let parts: Idea[];
    if (own.length >= 2) {
      // Her own parts start fresh: no research, note, task or quote of the whole.
      const { research: _r, note: _n, task: _t, quote: _q, ...rest } = idea;
      parts = own.map((l) => ({ ...rest, id: randomUUID(), title: l.slice(0, 120), prompt: l.slice(0, 4000) }));
    } else {
      const text = [idea.quote, idea.title, idea.prompt].filter(Boolean).join("\n");
      const he = mostlyHebrew(`${idea.title} ${idea.prompt}`) ? "\nLANGUAGE: Hebrew. Write the text fields in Hebrew." : "";
      const user = `THEIR PROJECTS: ${idea.projects.join(" | ") || "(none)"}${he}\nThis is ONE item that holds several; split it into its separate ideas.\n\nTRANSCRIPT:\n<<<\n${text}\n>>>`;
      parts = cleanIdeas(jsonIn(await this.deps.ask(IDEAS_PROMPT, user)), idea.projects, () => randomUUID(), `${s.transcript ?? ""}\n${text}`);
    }
    const next = splitIdea(s.ideas, ideaId, parts);
    if (!next) throw Object.assign(new Error("It could not be split. Write each part on its own line."), { statusCode: 422 });
    s.ideas = next;
    await this.save(s);
    return s;
  }

  /**
   * Saves an idea as a note in Knowledge (once; again returns the same note).
   *
   * @param id - The session.
   * @param ideaId - The idea.
   * @param he - Write the note's labels in Hebrew.
   */
  async saveNote(id: string, ideaId: string, he: boolean): Promise<IdeaSession> {
    const { idea } = await this.idea(id, ideaId);
    if (idea.note) return this.get(id);
    const t = (await this.get(id)).t;
    const note = await this.deps.saveNote(idea.title, ideaNote(idea, t, he));
    const s = await this.get(id);
    const now = s.ideas.find((i) => i.id === ideaId);
    if (now) now.note = note;
    await this.save(s);
    return s;
  }

  /**
   * Adds an idea to the task inbox (once).
   *
   * @param id - The session.
   * @param ideaId - The idea.
   */
  async toTask(id: string, ideaId: string): Promise<IdeaSession> {
    const { idea } = await this.idea(id, ideaId);
    if (idea.task) return this.get(id);
    const task = await this.deps.addTask(ideaTask(idea));
    const s = await this.get(id);
    const now = s.ideas.find((i) => i.id === ideaId);
    if (now) now.task = task;
    await this.save(s);
    return s;
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

/**
 * A model or network error in words for the page, without the raw request (the user saw "POST https://… 503 …").
 *
 * @param msg - The error's message.
 */
export function plainError(msg: string): string {
  if (/\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand/i.test(msg)) return "The model is busy right now; try again in a few minutes.";
  if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg)) return "The model's limit was reached for now; try again later.";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(msg)) return "The model could not be reached (is it loaded?).";
  return msg.replace(/(POST|GET) https?:\/\/\S+/g, "").replace(/\[\{[\s\S]*$/, "").trim().slice(0, 200) || "The analysis failed.";
}
