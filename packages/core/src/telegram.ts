import { randomBytes, randomInt } from "node:crypto";
import type { AgentEvent } from "@kesher/shared";

/**
 * Talking to KesherAI from Telegram, through a bot of the user's own
 * (made in a minute with @BotFather, free). Like OpenClaw's channels, but
 * the models stay on this computer.
 *
 * - **No open port:** this computer asks Telegram for new messages (long
 *   polling); nothing reaches in from outside.
 * - **Only paired chats:** a chat counts only after it sent `/start <code>`
 *   with the code shown in Settings on this computer; everything else is
 *   ignored without an answer.
 * - **Approvals as buttons:** when the agent needs approval, the chat gets
 *   Approve / Deny; a button works once, for that one request.
 * - Each chat has its own conversation (also in the app); `/new` starts a
 *   fresh one. Pictures the chat makes are sent back as photos.
 */

/** The `telegram` settings in config.json. */
export interface TelegramConfig {
  enabled: boolean;
  /** The bot's token from @BotFather (kept on this computer only). */
  token?: string;
  /** Paired chat ids. */
  chats: number[];
  /** Telegram chat id → KesherAI conversation id. */
  conversations: Record<string, string>;
}

/** What the bridge needs from the rest of KesherAI. */
export interface TelegramDeps {
  /** Starts a new chat conversation; returns its id. */
  newConversation(title: string): Promise<string>;
  /** Sends the user's text into a conversation. */
  send(conversationId: string, text: string): Promise<void>;
  /** Answers an approval. */
  decide(conversationId: string, requestId: string, decision: "allow" | "deny"): Promise<boolean>;
  /** Answers the agent's question. */
  answer(conversationId: string, questionId: string, text: string): Promise<boolean>;
  /** A picture the chat made. */
  image(assetId: string): Promise<{ data: Uint8Array; mimeType: string } | undefined>;
}

type Fetch = typeof fetch;
interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { first_name?: string }; text?: string; caption?: string; photo?: unknown[]; voice?: unknown };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}

const LIMIT = 4000;

/** Splits long text at paragraph or line breaks, under Telegram's 4096-character limit. */
export function splitText(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** The bot: polls Telegram, routes messages to conversations, and sends answers back. */
export class TelegramBridge {
  private running = false;
  private abort?: AbortController;
  private offset = 0;
  private bot?: string;
  private error?: string;
  /** The code a new chat sends with /start (shown in Settings; changes after each pairing). */
  private pairCode = TelegramBridge.newCode();
  /** Button id → the request it answers (each works once). */
  /** The latest answer of each conversation's current turn, sent when the turn ends. */
  private readonly pending = new Map<string, string>();
  private readonly buttons = new Map<string, { convId: string; kind: "approval" | "question"; id: string; value: string; expires: number }>();

  /**
   * @param config - The `telegram` config section.
   * @param save - Persists it.
   * @param deps - Conversations, approvals and pictures.
   * @param http - fetch (replaceable in tests).
   */
  constructor(
    private readonly config: TelegramConfig,
    private readonly save: () => Promise<void>,
    private readonly deps: TelegramDeps,
    private readonly http: Fetch = fetch,
  ) {}

  private static newCode(): string {
    return String(randomInt(100000, 1000000));
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    if (!this.config.token) throw new Error("No bot token yet.");
    const isForm = body instanceof FormData;
    const r = await this.http(`https://api.telegram.org/bot${this.config.token}/${method}`, {
      method: "POST",
      ...(isForm ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!j.ok) throw new Error(j.description ?? `Telegram answered ${r.status}`);
    return j.result as T;
  }

  /** @returns What Settings shows (never the token). */
  status(): { enabled: boolean; configured: boolean; running: boolean; bot?: string; chats: number; pairCode: string; error?: string } {
    return {
      enabled: this.config.enabled,
      configured: !!this.config.token,
      running: this.running,
      ...(this.bot ? { bot: this.bot } : {}),
      chats: this.config.chats.length,
      pairCode: this.pairCode,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Saves a bot token after checking it with Telegram, and starts the bot.
   *
   * @param token - From @BotFather.
   * @returns The bot's @name.
   * @throws Error when Telegram does not accept it.
   */
  async setToken(token: string): Promise<string> {
    const t = token.trim();
    if (!/^\d{5,}:[\w-]{30,}$/.test(t)) throw new Error("That does not look like a bot token (it looks like 123456789:AA…, from @BotFather).");
    const old = this.config.token;
    this.config.token = t;
    try {
      const me = await this.call<{ username: string }>("getMe", {});
      this.bot = me.username;
    } catch (e) {
      this.config.token = old;
      throw new Error(`Telegram did not accept that token: ${(e as Error).message}`);
    }
    if (old !== t) {
      // A new bot: chats paired with the old one are not this bot's.
      this.config.chats = [];
      this.config.conversations = {};
    }
    this.config.enabled = true;
    await this.save();
    this.restart();
    return this.bot;
  }

  /** Turns the bot on or off. */
  async setEnabled(on: boolean): Promise<void> {
    this.config.enabled = on;
    await this.save();
    this.restart();
  }

  /** Forgets the token and every paired chat. */
  async forget(): Promise<void> {
    this.stop();
    delete this.config.token;
    this.config.chats = [];
    this.config.conversations = {};
    this.config.enabled = false;
    this.bot = undefined;
    await this.save();
  }

  /** Unpairs every chat (they need the code again). */
  async unpairAll(): Promise<void> {
    this.config.chats = [];
    this.config.conversations = {};
    this.pairCode = TelegramBridge.newCode();
    await this.save();
  }

  /** Starts polling when on and configured. */
  start(): void {
    if (this.running || !this.config.enabled || !this.config.token) return;
    this.running = true;
    this.abort = new AbortController();
    void this.loop(this.abort.signal);
  }

  /** Stops polling. */
  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = undefined;
  }

  private restart(): void {
    this.stop();
    this.start();
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let wait = 1000;
    if (!this.bot) await this.call<{ username: string }>("getMe", {}, signal).then((m) => (this.bot = m.username), () => undefined);
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.call<Update[]>("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, signal);
        this.error = undefined;
        wait = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch(() => undefined);
        }
      } catch (e) {
        if (signal.aborted) break;
        this.error = (e as Error).message;
        await new Promise((r) => setTimeout(r, wait).unref?.());
        wait = Math.min(wait * 2, 60_000);
      }
    }
    // A restart already started a new loop: only the current one marks the bot stopped.
    if (this.abort?.signal === signal) this.running = false;
  }

  /** @param u - One update from Telegram. */
  async handle(u: Update): Promise<void> {
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    if (!m || m.chat.type !== "private") return;
    const chat = m.chat.id;
    const text = (m.text ?? m.caption ?? "").trim();
    if (!this.config.chats.includes(chat)) {
      // Only `/start <the code from Settings>` pairs a chat; anything else gets no answer.
      const code = /^\/start\s+(\d{6})$/.exec(text)?.[1];
      if (!code || code !== this.pairCode) return;
      this.config.chats.push(chat);
      this.pairCode = TelegramBridge.newCode();
      await this.save();
      await this.say(chat, "Connected to KesherAI on your computer. Write anything to start; /new starts a fresh chat.");
      return;
    }
    if (text === "/new") {
      delete this.config.conversations[String(chat)];
      await this.save();
      await this.say(chat, "Started a fresh chat. Write your message.");
      return;
    }
    if (text === "/start" || text.startsWith("/start ")) {
      await this.say(chat, "Already connected. Write anything; /new starts a fresh chat.");
      return;
    }
    if (!text) {
      await this.say(chat, m.photo ? "Pictures from Telegram are not supported yet; write it in words." : "Only text messages for now.");
      return;
    }
    let convId = this.config.conversations[String(chat)];
    try {
      if (!convId) {
        convId = await this.deps.newConversation(`Telegram: ${text.slice(0, 40)}`);
        this.config.conversations[String(chat)] = convId;
        await this.save();
      }
      await this.call("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => undefined);
      await this.deps.send(convId, text);
    } catch (e) {
      if (/not found/i.test((e as Error).message)) {
        delete this.config.conversations[String(chat)];
        await this.save();
      }
      await this.say(chat, `Could not send that: ${(e as Error).message}`);
    }
  }

  private chatOf(convId: string): number | undefined {
    const entry = Object.entries(this.config.conversations).find(([, c]) => c === convId);
    const chat = entry ? Number(entry[0]) : undefined;
    return chat !== undefined && this.config.chats.includes(chat) ? chat : undefined;
  }

  private button(convId: string, kind: "approval" | "question", id: string, value: string): string {
    const now = Date.now();
    for (const [k, v] of this.buttons) if (v.expires < now) this.buttons.delete(k);
    const key = randomBytes(9).toString("base64url");
    this.buttons.set(key, { convId, kind, id, value, expires: now + 6 * 60 * 60_000 });
    return key;
  }

  private async onButton(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chat = q.message?.chat.id;
    const b = q.data ? this.buttons.get(q.data) : undefined;
    if (!b || chat === undefined || !this.config.chats.includes(chat) || this.chatOf(b.convId) !== chat) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "This button is no longer valid." }).catch(() => undefined);
      return;
    }
    // One answer per request: the other buttons of the same message stop working too.
    for (const [k, v] of this.buttons) if (v.id === b.id) this.buttons.delete(k);
    const ok = b.kind === "approval" ? await this.deps.decide(b.convId, b.id, b.value === "allow" ? "allow" : "deny") : await this.deps.answer(b.convId, b.id, b.value);
    const label = b.kind === "approval" ? (b.value === "allow" ? "✅ Approved" : "⛔ Denied") : `➡ ${b.value}`;
    await this.call("answerCallbackQuery", { callback_query_id: q.id, text: ok ? label : "Already answered." }).catch(() => undefined);
    if (q.message) await this.call("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: ok ? label : "Answered", callback_data: "x" }]] } }).catch(() => undefined);
  }

  private async say(chat: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const parts = splitText(text);
    for (let i = 0; i < parts.length; i++) {
      await this.call("sendMessage", { chat_id: chat, text: parts[i], ...(i === parts.length - 1 ? extra : {}) });
    }
  }

  /**
   * Follows conversations that belong to a Telegram chat, and sends what the
   * chat should see: the answer when the turn ends, approvals and questions
   * as buttons, and pictures made.
   *
   * @param convId - The conversation.
   * @param e - Its event.
   */
  onConversationEvent(convId: string, e: AgentEvent): void {
    if (!this.running) return;
    const chat = this.chatOf(convId);
    if (chat === undefined) return;
    const send = (p: Promise<unknown>) => void p.catch(() => undefined);
    if (e.type === "approval_request") {
      const what = [e.reason, e.preview ? e.preview.slice(0, 600) : ""].filter(Boolean).join("\n\n");
      send(
        this.say(chat, `Needs your approval: ${e.name}\n\n${what}`, {
          reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: this.button(convId, "approval", e.requestId, "allow") }, { text: "⛔ Deny", callback_data: this.button(convId, "approval", e.requestId, "deny") }]] },
        }),
      );
      return;
    }
    if (e.type === "question") {
      const options = (e.options ?? []).slice(0, 8);
      send(
        this.say(chat, e.question, options.length ? { reply_markup: { inline_keyboard: options.map((o) => [{ text: o.slice(0, 60), callback_data: this.button(convId, "question", e.questionId, o) }]) } } : {}),
      );
      return;
    }
    if (e.type === "tool_result" && e.ok && e.assetIds?.length) {
      for (const id of e.assetIds.slice(0, 4)) {
        send(
          this.deps.image(id).then(async (img) => {
            if (!img) return;
            const form = new FormData();
            form.set("chat_id", String(chat));
            form.set("photo", new Blob([Buffer.from(img.data)], { type: img.mimeType }), `kesher.${img.mimeType.split("/")[1] ?? "png"}`);
            await this.call("sendPhoto", form);
          }),
        );
      }
      return;
    }
    if (e.type === "assistant") {
      if (e.text.trim()) this.pending.set(convId, e.text);
      return;
    }
    if (e.type === "status" && e.status === "running") send(this.call("sendChatAction", { chat_id: chat, action: "typing" }));
    if (e.type === "status" && e.status === "idle") {
      const text = this.pending.get(convId)?.trim();
      this.pending.delete(convId);
      if (text) send(this.say(chat, text));
    }
    if (e.type === "status" && e.status === "error") send(this.say(chat, `Stopped with an error: ${e.message ?? "open KesherAI to see what happened."}`));
  }
}
