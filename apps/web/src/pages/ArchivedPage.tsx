import type { ConversationSummary } from "@kesher/shared";
import { api } from "../api";
import { dayLabel, dayOf, splitArchived } from "../chat-archive";
import { getLocale, he$ } from "../i18n";
import { refreshLibrary, toast, useLibrary } from "../library";
import { askConfirm } from "../ui/askText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Archives a chat or brings it back (chat-archive.ts): it leaves or rejoins the sidebar's lists; nothing in it changes.
 *
 * @param id - The chat.
 * @param archived - True to archive, false to restore.
 */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  await api(`/api/conversations/${id}`, { method: "PATCH", body: { archived } });
  await refreshLibrary();
  toast(archived ? L("הצ'אט הועבר לארכיון. אפשר להחזיר אותו מ'צ'אטים בארכיון'.", "Archived. Bring it back from Archived chats.") : L("הצ'אט הוחזר לרשימה.", "Restored to the list."));
}

/**
 * Deletes a chat for good, after asking (and, for a session in its own worktree with work in it, asking what to do
 * with the worktree).
 *
 * @param c - The chat.
 * @returns Whether it was deleted.
 */
export async function deleteChatForever(c: Pick<ConversationSummary, "id" | "title" | "worktree">): Promise<boolean> {
  const he = getLocale() === "he";
  // The app's own dialogs, not confirm(): after a system dialog the desktop app took no typing (Roee, 2026-11-18).
  if (!(await askConfirm(he ? `למחוק את הצ'אט "${c.title}" לצמיתות? אי אפשר לבטל את זה.` : `Delete the chat "${c.title}" for good? This cannot be undone.`, { yes: he ? "מחק" : "Delete", danger: true }))) return false;
  // A session in its own worktree: a clean one goes with it; one with work in it is the user's call.
  let worktree = "";
  if (c.worktree) {
    const w = await api<{ branch: string; changed: number; commits: number } | null>(`/api/conversations/${c.id}/worktree`).catch(() => null);
    if (w && (w.changed || w.commits)) {
      const lose = he ? `${w.changed} קבצים ששונו ו-${w.commits} קומיטים בענף ${w.branch}` : `${w.changed} changed files and ${w.commits} commits on ${w.branch}`;
      worktree = (await askConfirm(he ? `ב-worktree של הסשן יש עבודה: ${lose}.\n\nאישור = למחוק גם אותה. ביטול = להשאיר את ה-worktree והענף בדיסק.` : `The session's worktree holds work: ${lose}.\n\nOK = delete it too. Cancel = keep the worktree and branch on disk.`)) ? "?worktree=remove" : "?worktree=keep";
    }
  }
  try {
    await api(`/api/conversations/${c.id}${worktree}`, { method: "DELETE" });
    await refreshLibrary();
    return true;
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
}

/** The Archived chats page (#/archived): each archived chat with Open, Restore and Delete for good. */
export function ArchivedPage() {
  const { conversations } = useLibrary();
  const { archived } = splitArchived(conversations);
  const he = getLocale() === "he";
  const now = new Date();
  return (
    <div className="page archived-page">
      <h1>{L("צ'אטים בארכיון", "Archived chats")}</h1>
      <p className="muted small">{L("צ'אט בארכיון יוצא מהרשימות ונשמר כמו שהוא. אפשר להחזיר אותו בכל זמן.", "An archived chat leaves the lists and is kept as it is. You can bring it back any time.")}</p>
      {archived.length === 0 && <p className="muted">{L("אין צ'אטים בארכיון.", "No archived chats.")}</p>}
      <ul className="archived-list">
        {archived.map((c) => (
          <li key={c.id} className="card archived-row">
            <a href={`#/c/${c.id}`} className="archived-title" dir="auto">
              <span aria-hidden="true">{c.kind === "code" ? "</> " : "• "}</span>{c.title || L("צ'אט בלי שם", "Untitled chat")}
            </a>
            <span className="muted small">{dayLabel(dayOf(c.updatedAt) ?? "", now, he)}</span>
            <span className="archived-actions">
              <button type="button" onClick={() => void setArchived(c.id, false).catch((e: Error) => toast(e.message))}>{L("להחזיר", "Restore")}</button>
              <button type="button" className="danger" onClick={() => void deleteChatForever(c)}>{L("מחיקה לצמיתות", "Delete for good")}</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
