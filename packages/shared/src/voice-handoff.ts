/**
 * Voice mode with a hand-off (docs/RESEARCH_LOG.md, "Realtime voice hand-off"): a small, fast local model talks with
 * the user in short spoken sentences, and real work goes to the chat's main model as an ordinary turn in the chat
 * ("I'll ask the main model to do that… It's done: …"). Tool approvals never happen by voice: they stay on screen
 * (the computer and the phone), and the voice only says that one waits there.
 *
 * Everything here is pure, so the page (apps/web/src/VoiceMode.tsx), the server (routes/voice.ts) and the tests
 * share it: the state machine returns effects as data and the page carries them out.
 */

import { nextSentences } from "./voice-stream.js";

/** Latency targets for one voice turn, in milliseconds (measured from the end of the user's speech). */
export const VOICE_TARGETS = {
  /** End of speech detected (silence after the last word). */
  endOfSpeech: 700,
  /** Speech to text on the computer (whisper.cpp, warm, a short sentence). */
  transcribe: 600,
  /** The small voice model's first spoken words (two short sentences at most). */
  reply: 700,
  /** The first audio of the local voice (Kokoro / the system's voice). */
  firstAudio: 300,
  /** Total from the end of speech to the first word heard: the budget the parts above add up to. */
  total: 2300,
  /** Speaking over an answer stops it within this time (barge-in). */
  bargeIn: 300,
} as const;

/** Longest spoken reply, in characters (about two short sentences). */
export const VOICE_REPLY_MAX = 280;

/** Without a small model, the main model's answer is said sentence by sentence up to about this many characters. */
export const VOICE_LIVE_MAX = 700;

/** What the voice loop is doing. */
export type VoicePhase = "ready" | "hearing" | "transcribing" | "replying" | "speaking";

/** The background turn handed to the chat's main model. */
export type VoiceJob = "none" | "running" | "approval";

/** The voice loop's state. */
export interface VoiceState {
  /** Hebrew lines (the app's language). */
  he: boolean;
  phase: VoicePhase;
  job: VoiceJob;
  /** The job is a plain answer (no small model): its summary is said as it is, without "It's done". */
  direct: boolean;
  /** No small voice model: every turn goes to the chat's main model, and its answer is read shortened. */
  fallback: boolean;
  /** Approval requests already announced (each one is said once). */
  announced: string[];
  /** Lines waiting to be said once the user stops talking or the current line ends. */
  queue: string[];
  /** The last main-model answer seen (answers from before voice mode opened are not read). */
  lastSeq: number;
  /** What the user said last (sent on to the main model if the voice model fails). */
  heard: string;
  /** A direct answer said as it is written: how far its text was read, and how many characters were said. */
  liveFrom: number;
  liveSaid: number;
  /** The user stopped the direct answer (barge-in) or it got too long: the rest is not said. */
  hushed: boolean;
}

/** Something that happened, from the microphone, the speech engines, the voice model or the chat. */
export type VoiceEvent =
  /** Speech started (the loudness detector, or push-to-talk pressed). */
  | { type: "speechStart" }
  /** Speech ended (silence, or push-to-talk released); `seconds` is how long it was. */
  | { type: "speechEnd"; seconds: number }
  /** Speech to text finished. */
  | { type: "transcript"; text: string }
  /** The small voice model's answer: what to say, and the task for the main model when it hands off. */
  | { type: "reply"; say: string; handoff?: string }
  /** The small voice model is missing or failed: from now on the main model answers. */
  | { type: "noVoiceModel" }
  /** The current line finished or was stopped. */
  | { type: "spoken" }
  /** The user tapped the orb (or pressed Esc once) while it spoke: stop and listen. */
  | { type: "bargeIn" }
  /** The approval requests waiting in the chat now. */
  | { type: "approvals"; ids: string[] }
  /** The main model's answer as it is written (all the text so far); said sentence by sentence in a direct job. */
  | { type: "answerText"; text: string }
  /** The main model finished a turn (not busy any more) with this answer. */
  | { type: "mainAnswer"; seq: number; text: string }
  /** The spoken summary of a finished job. */
  | { type: "summary"; text: string };

/** What the page must do. */
export type VoiceEffect =
  | { do: "say"; text: string }
  | { do: "stopSpeaking" }
  | { do: "transcribe" }
  /** Ask the small voice model (`working`: a job is still running, so it can say so). */
  | { do: "ask"; text: string; working: boolean }
  /**
   * Send a message to the chat (the main model works on it as a normal turn, visible on screen). `brief`: a direct
   * voice turn (no small model), so the main model is asked to answer short and speakable ({@link VOICE_BRIEF}).
   */
  | { do: "handoff"; text: string; brief?: true }
  /** Turn a finished answer into one or two spoken sentences. */
  | { do: "summarize"; text: string; direct: boolean };

/** The voice's fixed lines, in Hebrew and English. */
export const VOICE_LINES = {
  handoff: { he: "אני מעביר את זה למודל הראשי.", en: "I'll ask the main model to do that." },
  done: { he: "זה מוכן.", en: "It's done." },
  approval: { he: "מחכה לאישור שלך על המסך.", en: "Waiting for your approval on screen." },
  approvalByVoice: { he: "אישורים נותנים רק על המסך. הוא מחכה שם.", en: "Approvals are only given on screen. It's waiting there." },
  rest: { he: "את השאר אפשר לקרוא על המסך.", en: "The rest is on screen." },
} as const;

/**
 * The hint added (hidden, for that turn only) to a voice turn the main model answers itself because there is no
 * small voice model: the answer is read aloud as it is written, so its first sentence should carry the point.
 */
export const VOICE_BRIEF =
  "(Voice conversation: the user hears this answer read aloud as you write it. Start with the answer itself in one short sentence, then at most a few more short spoken sentences. No tables, headings or long lists; if code or long details are needed, put them after the spoken part, they stay on screen.)";

/**
 * A fresh voice loop.
 *
 * @param o.he - Hebrew lines.
 * @param o.fallback - No small voice model.
 * @param o.lastSeq - The latest answer already in the chat (not read aloud).
 */
export function voiceStart(o: { he: boolean; fallback: boolean; lastSeq: number }): VoiceState {
  return { he: o.he, phase: "ready", job: "none", direct: false, fallback: o.fallback, announced: [], queue: [], lastSeq: o.lastSeq, heard: "", liveFrom: 0, liveSaid: 0, hushed: false };
}

const line = (s: VoiceState, k: keyof typeof VOICE_LINES) => VOICE_LINES[k][s.he ? "he" : "en"];

/** Says a line now when the loop is free, otherwise after the user or the current line is done. */
function say(s: VoiceState, text: string, fx: VoiceEffect[]): VoiceState {
  if (!text.trim()) return s;
  if (s.phase === "ready") {
    fx.push({ do: "say", text });
    return { ...s, phase: "speaking" };
  }
  return { ...s, queue: [...s.queue, text] };
}

/** Back to listening, saying the next waiting line first. */
function free(s: VoiceState, fx: VoiceEffect[]): VoiceState {
  const [next, ...rest] = s.queue;
  if (next === undefined) return { ...s, phase: s.direct && s.job !== "none" ? "replying" : "ready" };
  fx.push({ do: "say", text: next });
  return { ...s, phase: "speaking", queue: rest };
}

/** Sends the words to the main model as a job. */
function handoff(s: VoiceState, text: string, direct: boolean, fx: VoiceEffect[]): VoiceState {
  fx.push({ do: "handoff", text, ...(direct ? { brief: true as const } : {}) });
  return { ...s, job: s.job === "approval" ? "approval" : "running", direct, liveFrom: 0, liveSaid: 0, hushed: false };
}

/**
 * Says the next sentences of a direct answer (as it is written, or its end once done), each as its own line so the
 * first starts early; while the loop waits for the answer it speaks at once. Past {@link VOICE_LIVE_MAX} it says that
 * the rest is on screen and stops.
 */
function sayLive(s: VoiceState, text: string, final: boolean, fx: VoiceEffect[]): VoiceState {
  if (s.hushed) return s;
  const r = nextSentences(text, s.liveFrom, final, s.he);
  let n: VoiceState = { ...s, liveFrom: r.next };
  for (const sentence of r.sentences) {
    if (n.liveSaid > 0 && n.liveSaid + sentence.length > VOICE_LIVE_MAX) {
      n = say({ ...n, hushed: true, phase: n.phase === "replying" ? "ready" : n.phase }, line(s, "rest"), fx);
      break;
    }
    n = { ...n, liveSaid: n.liveSaid + sentence.length };
    n = say(n.phase === "replying" ? { ...n, phase: "ready" } : n, sentence, fx);
  }
  return n;
}

/** Speech over the voice: stop now, drop the waiting lines and the rest of a direct answer. */
function bargeIn(s: VoiceState, fx: VoiceEffect[]): VoiceState {
  fx.push({ do: "stopSpeaking" });
  return { ...s, queue: [], hushed: s.hushed || (s.direct && s.job !== "none") };
}

/**
 * The voice loop's step: the next state and what to do. Rules:
 * - Speech over a spoken line stops it at once (barge-in) and listens.
 * - Every turn goes to the small voice model; it answers in at most two sentences, and hands real work to the
 *   main model. Without a voice model, every turn goes to the main model and its answer is read shortened.
 * - While a job waits for an approval, the voice says once that it waits on screen; a spoken "yes" never approves.
 * - A finished job is summarized and said ("It's done: …") when the loop is free.
 *
 * @param s - The state now.
 * @param e - What happened.
 * @returns The next state and the effects, in order.
 */
export function voiceStep(s: VoiceState, e: VoiceEvent): { state: VoiceState; effects: VoiceEffect[] } {
  const fx: VoiceEffect[] = [];
  let n = s;
  switch (e.type) {
    case "speechStart":
      n = { ...(s.phase === "speaking" ? bargeIn(s, fx) : s), phase: "hearing" };
      break;
    case "speechEnd":
      if (s.phase !== "hearing") break;
      // A click or a cough: nothing to transcribe.
      if (e.seconds < 0.4) n = free(s, fx);
      else {
        fx.push({ do: "transcribe" });
        n = { ...s, phase: "transcribing" };
      }
      break;
    case "transcript": {
      const text = e.text.trim();
      if (s.phase !== "transcribing") break;
      if (!text) {
        n = free(s, fx);
        break;
      }
      n = { ...s, heard: text };
      if (s.job === "approval" && isApprovalWords(text)) {
        n = say({ ...n, phase: "ready" }, line(s, "approvalByVoice"), fx);
        break;
      }
      if (s.fallback) {
        n = { ...handoff(n, text, true, fx), phase: "replying" };
        break;
      }
      fx.push({ do: "ask", text, working: s.job !== "none" });
      n = { ...n, phase: "replying" };
      break;
    }
    case "reply": {
      if (s.phase !== "replying") {
        // The user spoke again meanwhile: the reply waits for its turn, the hand-off goes now.
        if (e.handoff) n = handoff(s, e.handoff, false, fx);
        n = say(n, e.say || (e.handoff ? line(s, "handoff") : ""), fx);
        break;
      }
      n = { ...s, phase: "ready" };
      if (e.handoff) n = handoff(n, e.handoff, false, fx);
      n = say(n, e.say || (e.handoff ? line(s, "handoff") : ""), fx);
      if (n.phase === "ready") n = free(n, fx);
      break;
    }
    case "noVoiceModel": {
      n = { ...s, fallback: true };
      if (s.phase === "replying" && s.heard) n = handoff(n, s.heard, true, fx);
      break;
    }
    case "spoken":
      if (s.phase === "speaking") n = free({ ...s, phase: "ready" }, fx);
      break;
    case "bargeIn":
      if (s.phase === "speaking") {
        n = bargeIn(s, fx);
        n = { ...n, phase: n.direct && n.job !== "none" ? "replying" : "ready" };
      }
      break;
    case "approvals": {
      const fresh = e.ids.filter((id) => !s.announced.includes(id));
      if (fresh.length) {
        n = { ...s, job: "approval", announced: [...s.announced, ...fresh] };
        // The answer is not coming yet: the loop listens while it waits.
        if (n.phase === "replying" && n.direct) n = { ...n, phase: "ready" };
        n = say(n, line(s, "approval"), fx);
      } else if (!e.ids.length && s.job === "approval") {
        n = { ...s, job: "running" };
      }
      break;
    }
    case "answerText":
      if (s.direct && s.job !== "none") n = sayLive(s, e.text, false, fx);
      break;
    case "mainAnswer":
      if (e.seq <= s.lastSeq) break;
      n = { ...s, lastSeq: e.seq };
      if (s.job === "none") break;
      if (s.direct) {
        // No small model: the answer is said sentence by sentence (what was not said while it was written).
        n = { ...n, job: "none", direct: false, ...(s.phase === "replying" ? { phase: "ready" as const } : {}) };
        n = sayLive(n, e.text, true, fx);
        n = { ...n, liveFrom: 0, liveSaid: 0, hushed: false };
        break;
      }
      fx.push({ do: "summarize", text: e.text, direct: false });
      n = { ...n, job: "none", direct: false };
      break;
    case "summary":
      n = say(s, e.text, fx);
      break;
  }
  return { state: n, effects: fx };
}

/** Words that mean "yes, do it" (a spoken approval, which is never taken). */
const YES = new Set(["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "approve", "approved", "allow", "allowed", "confirm", "confirmed", "accept", "go", "proceed", "כן", "אשר", "תאשר", "מאשר", "מאשרת", "אישור", "מאושר", "בסדר", "סבבה", "קדימה", "יאללה", "תמשיך", "אוקיי", "אוקי", "תריץ", "תעשה"]);

/**
 * Whether a short utterance is a spoken approval ("yes", "approve it", "כן, תאשר"). Voice mode never approves:
 * when one is heard while an approval waits, the voice says that approvals are given on screen.
 *
 * @param text - What the user said.
 */
export function isApprovalWords(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return false;
  return words.some((w) => YES.has(w) || YES.has(w.replace(/^[ו]/, "")));
}

/**
 * Text as it should be heard, at most `max` characters, cut at the end of a sentence when it can be: no code blocks,
 * links or markdown. Used for the voice model's replies and for reading a main answer shortened.
 *
 * @param text - Any answer.
 * @param he - Hebrew (the word said in place of code).
 * @param max - Longest result.
 */
export function shortSpoken(text: string, he: boolean, max = VOICE_REPLY_MAX): string {
  const plain = text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, he ? " (קוד על המסך) " : " (code on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[#*_>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("."));
  return end > max * 0.4 ? cut.slice(0, end + 1).trim() : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).trim()}…`;
}

/**
 * The prompt for the small voice model's turn.
 *
 * @param o.text - What the user just said.
 * @param o.recent - The last few chat lines, oldest first (for context; short).
 * @param o.working - The main model is still working on an earlier request.
 * @param o.he - The app is in Hebrew.
 */
export function voiceTurnPrompt(o: { text: string; recent: Array<{ role: "user" | "assistant"; text: string }>; working: boolean; he: boolean }): string {
  const recent = o.recent.slice(-6).map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  return [
    "You are the voice of a local AI app, talking with the user out loud. Another, stronger model (the main model) does the real work in the chat.",
    `Answer in the user's language (${o.he ? "usually Hebrew" : "usually English"}), in at most two short spoken sentences, with no markdown, lists or code.`,
    "Answer yourself only small talk, a quick fact you are sure of, or a question about what was said. Hand off anything that needs tools, files, the computer, the web, code, a long or careful answer, or the chat's earlier work.",
    "You never run or approve anything. Tool approvals are given only on the screen, never by voice.",
    o.working ? "The main model is still working on an earlier request; if asked, say it is still working." : "",
    "Reply in exactly this format:",
    "SAY: <what to say out loud>",
    "HANDOFF: <the full task for the main model in the user's words, or NONE>",
    recent ? `\nThe chat so far:\n${recent}` : "",
    `\nThe user said: ${o.text.slice(0, 2000)}`,
  ].filter(Boolean).join("\n");
}

/**
 * Reads the small voice model's answer (see {@link voiceTurnPrompt}). Lenient: without the format, the whole text is
 * what to say.
 *
 * @param raw - The model's text.
 * @param he - Hebrew (for {@link shortSpoken}).
 * @returns What to say (short), and the task to hand off when there is one.
 */
export function parseVoiceReply(raw: string, he: boolean): { say: string; handoff?: string } {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const say = /^\s*SAY:\s*([\s\S]*?)(?=^\s*HANDOFF:|$(?![\s\S]))/im.exec(text)?.[1]?.trim();
  const task = /^\s*HANDOFF:\s*([\s\S]*)$/im.exec(text)?.[1]?.trim() ?? "";
  const handoff = task && !/^(none|no|-|n\/a|אין)\.?$/i.test(task) ? task.slice(0, 4000) : undefined;
  return { say: shortSpoken(say ?? (handoff ? "" : text.replace(/^\s*HANDOFF:[\s\S]*$/im, "")), he), ...(handoff ? { handoff } : {}) };
}

/**
 * The prompt that turns a finished main answer into what the voice says.
 *
 * @param answer - The main model's answer (shown in full on screen).
 * @param he - The app is in Hebrew.
 */
export function voiceSummaryPrompt(answer: string, he: boolean): string {
  return [
    "Say the result of this answer out loud in at most two short sentences, as a person would tell it.",
    `Use the answer's language (${he ? "usually Hebrew" : "usually English"}); no markdown, lists, code or links. If there is code or a long list, say it is on the screen.`,
    "Reply with only the sentences.",
    `\nThe answer:\n${answer.slice(0, 6000)}`,
  ].join("\n");
}
