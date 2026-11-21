/**
 * `‹ n/m ›` on an edited message (docs/FEATURE_REVIEW.md, 2026-11-21; as Claude and ChatGPT). "Edit and resend" opens
 * a branch: a new chat with everything before the message, then the edited text at the same place (its event has the
 * same seq as the original, conversations.ts `branch`). The versions of a message are the original chat and every
 * branch made from that message; the arrows switch between them in place (the same message stays in view).
 */

/** What this needs of a chat summary. */
export type BranchChat = { id: string; createdAt: string; branchOf?: { id: string; seq: number } };

/**
 * The versions of the user's message at `seq` in a chat.
 *
 * @param chat - The chat on screen.
 * @param seq - The message's event seq.
 * @param chats - Every chat summary (the sidebar's list).
 * @returns The chats that hold a version of the message, oldest first (the original first), and which one is shown;
 *   one entry when the message was never edited.
 */
export function messageVersions(chat: BranchChat, seq: number, chats: readonly BranchChat[]): { ids: string[]; at: number } {
  // In an edit branch, the edited message sits exactly at the seq it was branched at.
  const origin = chat.branchOf?.seq === seq ? chat.branchOf.id : chat.id;
  const known = origin === chat.id || chats.some((c) => c.id === origin);
  const edits = chats
    .filter((c) => c.branchOf?.id === origin && c.branchOf.seq === seq)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((c) => c.id);
  const ids = [...(known ? [origin] : []), ...edits.filter((id) => id !== origin)];
  if (!ids.includes(chat.id)) ids.unshift(chat.id);
  return { ids, at: ids.indexOf(chat.id) };
}

let scrollTo: { chat: string; seq: number } | undefined;

/**
 * Opens another version of a message in place: the chat is replaced (no extra Back step) and, once it has loaded,
 * the same message is scrolled into view (see {@link takeVersionScroll}).
 *
 * @param chatId - The chat holding the version.
 * @param seq - The message's seq.
 */
export function openVersion(chatId: string, seq: number): void {
  scrollTo = { chat: chatId, seq };
  location.replace(`#/c/${chatId}`);
}

/**
 * The message to bring into view after switching versions, once (the page calls it when the chat has loaded).
 *
 * @param chatId - The chat that loaded.
 * @returns The seq, or `undefined` when no switch led here.
 */
export function takeVersionScroll(chatId: string): number | undefined {
  if (scrollTo?.chat !== chatId) return undefined;
  const seq = scrollTo.seq;
  scrollTo = undefined;
  return seq;
}
