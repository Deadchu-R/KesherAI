import type { ChatStreamEvent, ModelInfo } from "@kesher/shared";
import type { Provider, ProviderChatRequest } from "@kesher/providers";
import { MicrosoftSignIn, ONEDRIVE_ENDPOINTS, type MicrosoftSignInConfig, type OneDriveEndpoints } from "./onedrive.js";

/**
 * Microsoft 365 Copilot as a chat model, for organisations that want their
 * people to use only Copilot: answers come from Copilot inside the
 * organisation's Microsoft 365 boundary, grounded on its own data (mail,
 * files, meetings, chats) with each person's own permissions, and on the web
 * unless that is turned off.
 *
 * It uses Microsoft's Copilot Chat API (`/beta/copilot/conversations`,
 * preview), which needs a work or school account with a Microsoft 365
 * Copilot licence. Sign-in is the same public-client PKCE flow as OneDrive,
 * with the permissions the Chat API requires (read-only).
 *
 * The API keeps conversations on Microsoft's side and has no system prompt
 * or tools, so each turn starts a Copilot conversation and passes the
 * persona and the earlier messages as extra context.
 */

/** The permissions the Copilot Chat API requires (all of them, delegated, read-only). */
export const COPILOT_SCOPES = [
  "Sites.Read.All",
  "Mail.Read",
  "People.Read.All",
  "OnlineMeetingTranscript.Read.All",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "ExternalItem.Read.All",
  "offline_access",
  "openid",
  "email",
  "profile",
].join(" ");

/** Copilot settings in config.json. */
export interface CopilotConfig extends MicrosoftSignInConfig {
  /** Let Copilot also search the web (on by default, like Copilot itself). */
  web?: boolean;
}

/** The single model Copilot offers. */
export const COPILOT_MODEL = "m365-copilot";

/** Signs in with a work or school account and talks to Copilot. */
export class Copilot extends MicrosoftSignIn {
  /**
   * @param config - The `copilot` config section.
   * @param save - Persists it.
   * @param endpoints - Microsoft URLs (tests pass a fake server); sign-in uses the "organizations" tenant.
   * @param defaultClientId - The project's app registration.
   */
  constructor(config: CopilotConfig, save: () => Promise<void>, endpoints: OneDriveEndpoints = ONEDRIVE_ENDPOINTS, defaultClientId?: string | (() => string | undefined)) {
    super(config, save, { ...endpoints, login: endpoints.login.replace("/common/", "/organizations/") }, defaultClientId, COPILOT_SCOPES, "Microsoft 365 Copilot");
  }

  /**
   * Asks Copilot once.
   *
   * @param text - The question.
   * @param context - Extra text Copilot should use (persona, earlier messages).
   * @param signal - Cancels the request.
   * @returns Copilot's answer and its sources.
   */
  async ask(text: string, context: string[], signal?: AbortSignal): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
    const graph = this.endpoints.graph.replace(/\/v1\.0$/, "/beta");
    const conv = await this.call<{ id: string }>(`${graph}/copilot/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", ...(signal ? { signal } : {}) });
    if (!conv) throw new Error("Copilot did not start a conversation.");
    const web = (this.config as CopilotConfig).web !== false;
    const res = await this.call<{ messages?: Array<{ text?: string; attributions?: Array<{ attributionType?: string; providerDisplayName?: string; seeMoreWebUrl?: string }> }> }>(
      `${graph}/copilot/conversations/${encodeURIComponent(conv.id)}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { text },
          locationHint: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
          ...(context.length ? { additionalContext: context.map((t) => ({ text: t })) } : {}),
          ...(web ? {} : { contextualResources: { webContext: { isWebEnabled: false } } }),
        }),
        ...(signal ? { signal } : {}),
      },
    );
    const reply = res?.messages?.at(-1);
    const sources = (reply?.attributions ?? [])
      .filter((a) => a.attributionType === "citation" && a.seeMoreWebUrl && /^https:\/\//.test(a.seeMoreWebUrl))
      .map((a) => ({ title: a.providerDisplayName || new URL(a.seeMoreWebUrl!).hostname, url: a.seeMoreWebUrl! }));
    return { text: cleanCopilotText(reply?.text ?? ""), sources };
  }
}

/**
 * Removes Copilot's inline markup (`<Event>…</Event>`, `<Person>…</Person>`) and turns its `[^1^]` marks into plain numbers.
 *
 * @param text - Copilot's answer.
 * @returns Markdown.
 */
export function cleanCopilotText(text: string): string {
  return text.replace(/<\/?(Event|Person|File|Message|Meeting|Chat|Site)>/g, "").replace(/\[\^(\d+)\^\]/g, "[$1]");
}

/**
 * The chat provider "copilot": one model, Microsoft 365 Copilot.
 *
 * @param copilot - The signed-in client.
 * @returns The provider.
 */
export function copilotProvider(copilot: Copilot): Provider {
  return {
    id: "copilot",
    name: "Microsoft 365 Copilot",
    location: "cloud",
    capabilities: { chat: true },
    async checkHealth() {
      return copilot.connected;
    },
    async listModels(): Promise<ModelInfo[]> {
      if (!copilot.connected) return [];
      return [{ id: `copilot/${COPILOT_MODEL}`, providerId: "copilot", providerModelId: COPILOT_MODEL, name: "Microsoft 365 Copilot", category: "chat", location: "cloud" }];
    },
    async *chat(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
      const messages = req.messages.filter((m) => typeof m.content === "string" && m.content.trim());
      const last = [...messages].reverse().find((m) => m.role === "user");
      if (!last) {
        yield { type: "error", message: "Nothing to ask Copilot." };
        return;
      }
      const context: string[] = [];
      const system = messages.filter((m) => m.role === "system").map((m) => m.content as string).join("\n\n");
      if (system) context.push(`Instructions for this conversation:\n${system.slice(0, 6000)}`);
      const earlier = messages.filter((m) => m !== last && m.role !== "system").slice(-12);
      if (earlier.length) context.push(`The conversation so far:\n${earlier.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.content as string).slice(0, 2000)}`).join("\n\n")}`);
      try {
        const r = await copilot.ask((last.content as string).slice(0, 10_000), context, signal);
        const sources = r.sources.length ? `\n\nSources:\n${r.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}` : "";
        yield { type: "delta", text: r.text + sources };
        yield { type: "done" };
      } catch (err) {
        yield { type: "error", message: (err as Error).message };
      }
    },
  };
}
