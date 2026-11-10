import { useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { Select } from "../ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * A new Blueprint from KesherAI: made in Unreal at once, or — with Unreal
 * closed — kept with an empty graph you can already work on (in words, or
 * in the code view), and made when the project opens, before those changes.
 */
export function NewBlueprint({ connected, onMade }: { connected: boolean; onMade: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("BP_New");
  const [parent, setParent] = useState("Actor");
  const [folder, setFolder] = useState("/Game/Blueprints");
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)}>{L("+ Blueprint חדש", "+ New Blueprint")}</button>;
  const make = () => {
    setBusy(true);
    void api<{ path: string; queued: boolean }>("/api/unreal/create", { method: "POST", body: { name, parent, folder } })
      .then(
        (r) => {
          toast(r.queued ? L(`${name} ממתין: ייווצר ב-Unreal כשהפרויקט ייפתח. אפשר כבר לעבוד עליו.`, `${name} is waiting: it is made in Unreal when the project opens. You can work on it already.`) : L(`${name} נוצר ב-Unreal.`, `${name} was made in Unreal.`));
          setOpen(false);
          onMade(r.path);
        },
        (e: Error) => toast(e.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form className="stack small ue-new" onSubmit={(e) => { e.preventDefault(); make(); }}>
      <label>{L("שם", "Name")}<input dir="ltr" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label>
        {L("סוג", "Type")}
        <Select value={parent} onChange={(e) => { setParent(e.target.value); if (e.target.value === "UserWidget" && /^BP_/.test(name)) setName(name.replace(/^BP_/, "WBP_")); }}>
          {[["Actor", "Actor"], ["Pawn", "Pawn"], ["Character", "Character"], ["GameModeBase", "Game Mode"], ["PlayerController", "Player Controller"], ["ActorComponent", "Actor Component"], ["UserWidget", L("Widget (ממשק)", "Widget (UI)")]].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </Select>
      </label>
      <label>{L("תיקייה", "Folder")}<input dir="ltr" value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
      {!connected && <p className="muted">{L("Unreal סגור: ה-Blueprint ייווצר כשהפרויקט ייפתח עם הפלאגין, ושינויים שתעשו בו עד אז יחולו אחריו.", "Unreal is closed: it is made when the project opens with the plugin, and changes you make to it meanwhile apply after it.")}</p>}
      <div className="row">
        <button type="button" onClick={() => setOpen(false)}>{L("ביטול", "Cancel")}</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? "…" : L("צור", "Create")}</button>
      </div>
    </form>
  );
}

