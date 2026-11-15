import { useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { Menu, MenuItem } from "../ui/Menu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Closes the open Unreal or Unity editor from KesherAI (the phone too), with the choice made here, so
 * the editor asks nothing: save everything first, or throw unsaved changes away. Needs the KesherAI
 * plugin 0.1.18 / Unity package 0.2.7; an older one says so.
 *
 * @param p.kind - Which editor.
 * @param p.onClosed - Called once it has closed (to refresh the page).
 */
export function CloseEditor({ kind, onClosed }: { kind: "unreal" | "unity"; onClosed: () => void }) {
  const [busy, setBusy] = useState<"" | "save" | "discard">("");
  const app = kind === "unity" ? "Unity" : "Unreal";
  const close = (save: boolean) => {
    setBusy(save ? "save" : "discard");
    void api<{ closed: boolean; saved: boolean }>(`/api/${kind}/close`, { method: "POST", body: { save } })
      .then(
        (r) => {
          toast(r.saved ? L(`${app} נשמר ונסגר.`, `${app} saved and closed.`) : L(`${app} נסגר בלי לשמור.`, `${app} closed without saving.`));
          onClosed();
        },
        (e: Error) => toast(e.message),
      )
      .finally(() => setBusy(""));
  };
  return (
    <Menu
      trigger={busy ? (busy === "save" ? L("שומר וסוגר…", "Saving and closing…") : L("סוגר…", "Closing…")) : L(`סגור את ${app}`, `Close ${app}`)}
      triggerClassName="chip"
      popClassName="bar-pop"
      disabled={!!busy}
      aria-label={L(`סגירת ${app}`, `Close ${app}`)}
    >
      <MenuItem icon="💾" onSelect={() => close(true)} title={L("שומר את כל הקבצים שלא נשמרו, ואז סוגר", "Saves every unsaved file, then closes")}>
        {L("שמור וסגור", "Save and close")}
      </MenuItem>
      <MenuItem icon="✕" danger onSelect={() => close(false)} title={L("שינויים שלא נשמרו יאבדו", "Unsaved changes are lost")}>
        {L("סגור בלי לשמור", "Close without saving")}
      </MenuItem>
    </Menu>
  );
}
