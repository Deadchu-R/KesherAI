import { randomBytes, randomInt } from "node:crypto";
import type { AgentEvent } from "@kesher/shared";

/**
 * Talking to KesherAI from Telegram, through a bot of the user's own
 * (made in a minute with @BotFather, free). Like OpenClaw's channels, but
 * the models stay on this computer — and with safety first:
 *
 * - **No open port:** this computer asks Telegram for new messages (long
 *   polling); nothing reaches in from outside.
 * - **Pairing only on purpose:** a pairing code exists only after the user
 *   pressed "Pair a chat" on this computer, works for 10 minutes and once;
 *   five wrong tries close pairing. Every pairing is announced on the
 *   computer and the phone.
 * - **Only paired private chats:** groups, channels, bots, forwarded
 *   messages and unknown chats get no answer at all.
 * - **Limited chats:** Telegram chats ask before every change, never get
 *   the computer-control tools, and commands cannot be approved from
 *   Telegram unless the user turned that on (on this computer).
 * - **Emergency stop:** `/lock` in the chat turns the bot off; only this
 *   computer turns it on again.
 * - **Rate limit:** at most 20 messages in 10 minutes per chat.
 * - **Business mode** (Settings → Organisation) turns Telegram off unless
 *   the organisation allows it.
 */

/** The `telegram` settings in config.json. */
export interface TelegramConfig {
  enabled: boolean;
  /** The bot's token from @BotFather (kept on this computer only). */
  token?: string;
  /** Paired chat ids. */
  chats: number[];
  /** Chat id → the name Telegram gave and when it was paired (shown in Settings). */
  chatInfo?: Record<string, { name: string; pairedAt: string }>;
  /** Telegram chat id → KesherAI conversation id. */
  conversations: Record<string, string>;
  /** Whether commands (run_command, computer and browser control) may be approved from Telegram. Off by default. */
  approveCommands?: boolean;
}

/** What the bridge needs from the rest of KesherAI. */
export interface TelegramDeps {
  /** Starts a new chat conversation for Telegram (asks before every change, no computer control); returns its id. */
  newConversation(title: string): Promise<string>;
  /** Sends the user's text into a conversation. */
  send(conversationId: string, text: string): Promise<void>;
  /** Answers an approval. */
  decide(conversationId: string, requestId: string, decision: "allow" | "deny"): Promise<boolean>;
  /** Answers the agent's question. */
  answer(conversationId: string, questionId: string, text: string): Promise<boolean>;
  /** A picture the chat made. */
  image(assetId: string): Promise<{ data: Uint8Array; mimeType: string } | undefined>;
  /** Tells the user on this computer and the phone (pairings, lock, refused tries). */
  alert(title: string, body: string): void;
  /** Whether Telegram is allowed (business mode can forbid it). */
  allowed(): boolean;
}

type Fetch = typeof fetch;
interface Update {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
    photo?: unknown[];
    voice?: unknown;
    forward_origin?: unknown;
    forward_from?: unknown;
    via_bot?: unknown;
  };
  callback_query?: { id: string; data?: string; from?: { is_bot?: boolean }; message?: { chat: { id: number }; message_id: number } };
}

/** Tools that act on the computer itself: never approved from Telegram unless the user allowed it. */
export const COMMAND_TOOLS = /^(run_command|build_executable|computer_|browser_(click|type|open))/;

const LIMIT = 4000;
const PAIR_MS = 10 * 60_000;
const PAIR_TRIES = 5;
const RATE = { count: 20, ms: 10 * 60_000 };
const BUTTON_MS = 15 * 60_000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

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
  /** The pairing code, only while the user is pairing a chat (made on this computer). */
  private pairing?: { code: string; expires: number; tries: number };
  /** The latest answer of each conversation's current turn, sent when the turn ends. */
  private readonly pending = new Map<string, string>();
  /** Button id → the request it answers (each works once). */
  private readonly buttons = new Map<string, { convId: string; kind: "approval" | "question"; id: string; value: string; expires: number }>();
  /** Message times per chat, for the rate limit. */
  private readonly recent = new Map<number, number[]>();
  /** What happened lately (shown in Settings): never message text. */
  private readonly log: Array<{ at: string; what: string }> = [];

  /**
   * @param config - The `telegram` config section.
   * @param save - Persists it.
   * @param deps - Conversations, approvals, pictures and alerts.
   * @param http - fetch (replaceable in tests).
   */
  constructor(
    private readonly config: TelegramConfig,
    private readonly save: () => Promise<void>,
    private readonly deps: TelegramDeps,
    private readonly http: Fetch = fetch,
  ) {}

  private note(what: string): void {
    this.log.unshift({ at: new Date().toISOString(), what });
    this.log.length = Math.min(this.log.length, 30);
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
    // Telegram's own words, never the address (it holds the token).
    if (!j.ok) throw new Error(j.description ?? `Telegram answered ${r.status}`);
    return j.result as T;
  }

  /** @returns What Settings shows (never the token, never message text). */
  status(): {
    enabled: boolean;
    configured: boolean;
    running: boolean;
    allowed: boolean;
    bot?: string;
    chats: Array<{ id: number; name: string; pairedAt?: string }>;
    pairing?: { code: string; expiresAt: string };
    approveCommands: boolean;
    log: Array<{ at: string; what: string }>;
    error?: string;
  } {
    const p = this.pairing && this.pairing.expires > Date.now() ? this.pairing : undefined;
    return {
      enabled: this.config.enabled,
      configured: !!this.config.token,
      running: this.running,
      allowed: this.deps.allowed(),
      ...(this.bot ? { bot: this.bot } : {}),
      chats: this.config.chats.map((id) => ({ id, name: this.config.chatInfo?.[String(id)]?.name ?? String(id), ...(this.config.chatInfo?.[String(id)] ? { pairedAt: this.config.chatInfo[String(id)]!.pairedAt } : {}) })),
      ...(p ? { pairing: { code: p.code, expiresAt: new Date(p.expires).toISOString() } } : {}),
      approveCommands: !!this.config.approveCommands,
      log: this.log,
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
      this.config.chatInfo = {};
      this.config.conversations = {};
    }
    this.config.enabled = true;
    await this.save();
    this.note("Bot connected");
    this.restart();
    return this.bot;
  }

  /** Turns the bot on or off. */
  async setEnabled(on: boolean): Promise<void> {
    this.config.enabled = on;
    await this.save();
    this.note(on ? "Turned on" : "Turned off");
    this.restart();
  }

  /** Whether commands may be approved from Telegram (set on this computer only). */
  async setApproveCommands(on: boolean): Promise<void> {
    this.config.approveCommands = on;
    await this.save();
    this.note(on ? "Commands may be approved from Telegram" : "Commands need the computer or the app");
  }

  /**
   * Opens pairing for 10 minutes: one code, one chat.
   *
   * @returns The code to send with /start.
   */
  startPairing(): { code: string; expiresAt: string } {
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    this.pairing = { code, expires: Date.now() + PAIR_MS, tries: 0 };
    this.note("Pairing opened for 10 minutes");
    return { code, expiresAt: new Date(this.pairing.expires).toISOString() };
  }

  /** Closes pairing. */
  stopPairing(): void {
    this.pairing = undefined;
  }

  /**
   * @param chatId - A paired chat.
   * @returns Whether it was removed.
   */
  async unpair(chatId: number): Promise<boolean> {
    if (!this.config.chats.includes(chatId)) return false;
    this.config.chats = this.config.chats.filter((c) => c !== chatId);
    delete this.config.chatInfo?.[String(chatId)];
    delete this.config.conversations[String(chatId)];
    await this.save();
    this.note("A chat was unpaired");
    return true;
  }

  /** Forgets the token and every paired chat. */
  async forget(): Promise<void> {
    this.stop();
    delete this.config.token;
    this.config.chats = [];
    this.config.chatInfo = {};
    this.config.conversations = {};
    this.config.enabled = false;
    this.bot = undefined;
    this.pairing = undefined;
    await this.save();
    this.note("Bot removed");
  }

  /** Starts polling when on, configured and allowed. */
  start(): void {
    if (this.running || !this.config.enabled || !this.config.token || !this.deps.allowed()) return;
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

  /** Starts or stops to match the settings (and business mode). */
  restart(): void {
    this.stop();
    this.start();
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let wait = 1000;
    if (!this.bot) await this.call<{ username: string }>("getMe", {}, signal).then((m) => (this.bot = m.username), () => undefined);
    while (this.running && !signal.aborted) {
      if (!this.deps.allowed()) {
        this.note("Stopped: the organisation's business mode does not allow Telegram");
        break;
      }
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

  private limited(chat: number): boolean {
    const now = Date.now();
    const times = (this.recent.get(chat) ?? []).filter((t) => now - t < RATE.ms);
    times.push(now);
    this.recent.set(chat, times);
    return times.length > RATE.count;
  }

  /** @param u - One update from Telegram. */
  async handle(u: Update): Promise<void> {
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    // Only a person, in a private chat, writing it themselves.
    if (!m || m.chat.type !== "private" || m.from?.is_bot || m.forward_origin || m.forward_from || m.via_bot) return;
    const chat = m.chat.id;
    const text = (m.text ?? m.caption ?? "").trim();
    if (!this.config.chats.includes(chat)) return this.tryPair(chat, text, m.from);
    if (this.limited(chat)) {
      if ((this.recent.get(chat)?.length ?? 0) === RATE.count + 1) await this.say(chat, "Too many messages. Wait a few minutes.");
      return;
    }
    if (text === "/lock") {
      this.config.enabled = false;
      await this.save();
      await this.say(chat, "🔒 Locked. The bot is off; turn it on again on the computer (Settings → Phone → Telegram).");
      this.note("Locked from Telegram");
      this.deps.alert("Telegram locked", "The bot was turned off from the Telegram chat. Turn it on again in Settings → Phone → Telegram.");
      this.stop();
      return;
    }
    if (text === "/new") {
      delete this.config.conversations[String(chat)];
      await this.save();
      await this.say(chat, "Started a fresh chat. Write your message.");
      return;
    }
    if (text === "/help" || text === "/start" || text.startsWith("/start ")) {
      await this.say(chat, "Connected to KesherAI. Write anything.\n/new — a fresh chat\n/lock — turn the bot off at once (only the computer turns it on again)");
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

  /** An unknown chat: only `/start <the code>` while pairing is open pairs it; everything else gets no answer. */
  private async tryPair(chat: number, text: string, from: NonNullable<Update["message"]>["from"]): Promise<void> {
    const p = this.pairing;
    if (!p || p.expires < Date.now()) return;
    const code = /^\/start\s+([A-Z0-9]{8})$/i.exec(text)?.[1]?.toUpperCase();
    if (!code) return;
    if (code !== p.code) {
      p.tries++;
      if (p.tries >= PAIR_TRIES) {
        this.pairing = undefined;
        this.note("Pairing closed after wrong codes");
        this.deps.alert("Telegram: pairing closed", "Someone sent wrong pairing codes to your bot five times, so pairing was closed. If it was not you, nothing was paired; you can open pairing again in Settings.");
      }
      return;
    }
    this.pairing = undefined;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ") + (from?.username ? ` (@${from.username})` : "") || String(chat);
    this.config.chats.push(chat);
    this.config.chatInfo = { ...this.config.chatInfo, [String(chat)]: { name, pairedAt: new Date().toISOString() } };
    await this.save();
    this.note(`Paired: ${name}`);
    this.deps.alert("Telegram chat paired", `${name} can now talk to KesherAI from Telegram. If this was not you, remove it in Settings → Phone → Telegram.`);
    await this.say(chat, "✅ Connected to KesherAI on your computer.\n\nWrite anything. Changes on the computer always ask you first.\n/new — a fresh chat\n/lock — turn the bot off at once\n\nKeep your Telegram account safe (turn on Telegram's two-step verification): whoever has this chat can talk to your computer.");
  }

  private chatOf(convId: string): number | undefined {
    const entry = Object.entries(this.config.conversations).find(([, c]) => c === convId);
    const chat = entry ? Number(entry[0]) : undefined;
    return chat !== undefined && this.config.chats.includes(chat) ? chat : undefined;
  }

  /** @returns Whether a conversation belongs to a Telegram chat (it gets fewer tools). */
  isTelegramConversation(convId: string): boolean {
    return Object.values(this.config.conversations).includes(convId);
  }

  private button(convId: string, kind: "approval" | "question", id: string, value: string): string {
    const now = Date.now();
    for (const [k, v] of this.buttons) if (v.expires < now) this.buttons.delete(k);
    const key = randomBytes(12).toString("base64url");
    this.buttons.set(key, { convId, kind, id, value, expires: now + BUTTON_MS });
    return key;
  }

  private async onButton(q: NonNullable<Update["callback_query"]>): Promise<void> {
    const chat = q.message?.chat.id;
    const b = q.data ? this.buttons.get(q.data) : undefined;
    if (q.from?.is_bot || !b || b.expires < Date.now() || chat === undefined || !this.config.chats.includes(chat) || this.chatOf(b.convId) !== chat) {
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "This button is no longer valid." }).catch(() => undefined);
      return;
    }
    // One answer per request: the other buttons of the same message stop working too.
    for (const [k, v] of this.buttons) if (v.id === b.id) this.buttons.delete(k);
    const ok = b.kind === "approval" ? await this.deps.decide(b.convId, b.id, b.value === "allow" ? "allow" : "deny") : await this.deps.answer(b.convId, b.id, b.value);
    const label = b.kind === "approval" ? (b.value === "allow" ? "✅ Approved" : "⛔ Denied") : `➡ ${b.value}`;
    if (ok && b.kind === "approval") this.note(b.value === "allow" ? "Approved from Telegram" : "Denied from Telegram");
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
      if (COMMAND_TOOLS.test(e.name) && !this.config.approveCommands) {
        // Acting on the computer itself: only the person at the computer (or the app) approves it.
        send(this.say(chat, `⚠ Needs your approval on the computer or in the KesherAI app: ${e.name}\n\n${what}\n\nCommands cannot be approved from Telegram (a setting on the computer can allow it).`));
        return;
      }
      send(
        this.say(chat, `Needs your approval: ${e.name}\n\n${what}\n\nCheck it before approving.`, {
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
