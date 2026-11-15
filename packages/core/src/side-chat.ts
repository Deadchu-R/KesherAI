import type { AgentEvent } from "@kesher/shared";
import type { ModelTurn } from "@kesher/agent";

/** One turn of a side thread. */
export interface SideTurn {
  role: "user" | "assistant";
  text: string;
}

/** How much of the main chat goes with a side question (the newest part). */
const CONTEXT_CHARS = 12_000;

/**
 * Side chats (audit F3, like Open WebUI's `/side` and Claude's `/btw`): a question beside a chat that never enters
 * its history. The main chat is read, never written: no event is added, no tool runs, nothing is remembered.
 * The threads live in memory only, one per chat, and are gone when KesherAI restarts.
 */
export class SideChats {
  private threads = new Map<string, SideTurn[]>();

  /**
   * @param convId - The chat.
   * @returns Its side thread so far.
   */
  thread(convId: string): SideTurn[] {
    return [...(this.threads.get(convId) ?? [])];
  }

  /**
   * Answers a side question with the main chat as read-only context.
   *
   * @param convId - The chat.
   * @param main - The chat's events (read only).
   * @param text - The side question.
   * @param turn - The chat's model.
   * @param signal - Stops the answer.
   * @returns The answer.
   */
  async ask(convId: string, main: readonly AgentEvent[], text: string, turn: ModelTurn, signal: AbortSignal): Promise<string> {
    const lines: string[] = [];
    for (const e of main) {
      if (e.type === "user") lines.push(`User: ${e.text}`);
      else if (e.type === "assistant" && e.text.trim()) lines.push(`Assistant: ${e.text}`);
    }
    let context = lines.join("\n\n");
    if (context.length > CONTEXT_CHARS) context = `…${context.slice(-CONTEXT_CHARS)}`;
    const earlier = this.thread(convId);
    const system =
      "You answer a side question about the conversation below. It is a quick aside: answer it briefly and do not continue the conversation's task, do not use tools, and do not repeat the conversation. Reply in the user's language.\n\n--- The conversation (for context only) ---\n" +
      (context || "(empty)");
    const out = await turn({ messages: [{ role: "system", content: system }, ...earlier.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: text }], tools: [] }, signal, () => undefined);
    const answer = out.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    const next: SideTurn[] = [...earlier, { role: "user", text }, { role: "assistant", text: answer }];
    this.threads.set(convId, next.slice(-20));
    return answer;
  }

  /**
   * Forgets a chat's side thread.
   *
   * @param convId - The chat.
   */
  clear(convId: string): void {
    this.threads.delete(convId);
  }
}
