import { Menu, MenuItem, MenuLabel, MenuNote } from "../ui/Menu";
import { getLocale } from "../i18n";
import { createConversation, toast, useLibrary } from "../library";
import { openWithDraft } from "../phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * "Open in chat": the project goes into a chat, a new one or one you pick,
 * so you keep working on it in words (the chat's Unity or Unreal tools).
 *
 * @param props.line - What goes into the message box (empty: no project yet).
 */
export function OpenInChat({ line }: { line: string }) {
  const { conversations } = useLibrary();
  if (!line) return null;
  const newChat = () =>
    void createConversation({ kind: "chat" }).then((id) => id && openWithDraft(id, line), (e: Error) => toast(e.message));
  return (
    <Menu triggerClassName="primary" trigger={<>💬 {L("פתח בצ'אט", "Open in chat")}</>}>
      <MenuItem icon="＋" onSelect={newChat}>{L("צ'אט חדש", "New chat")}</MenuItem>
      <MenuLabel>{L("או לצ'אט קיים", "Or into a chat")}</MenuLabel>
      {conversations.slice(0, 12).map((c) => (
        <MenuItem key={c.id} dir="auto" onSelect={() => openWithDraft(c.id, line)}>{c.title}</MenuItem>
      ))}
      {!conversations.length && <MenuNote>{L("אין עדיין צ'אטים.", "No chats yet.")}</MenuNote>}
    </Menu>
  );
}
