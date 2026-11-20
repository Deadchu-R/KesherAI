import { useState } from "react";
import { sceneCounts, type SceneDiff, type SceneObjectChange } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";
import "./scene-diff.css";

/*
 * What a Unity, Unreal or Godot tool will change in a scene, on its approval card (shared/scene-diff.ts): the objects
 * added, removed and changed, each value as old → new, and how it can be undone. Shown inside ApprovalCard, so the
 * Allow / Deny buttons stay the card's own; the same on the phone (390 px: values wrap, nothing is cut).
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Objects shown before "Show all". */
const FIRST = 8;

const ENGINE = { unity: ["סצנת Unity", "Unity scene"], unreal: ["שלב Unreal", "Unreal level"], godot: ["סצנת Godot", "Godot scene"] } as const;

function kindText(k: SceneObjectChange["kind"]): string {
  return k === "added" ? L("נוסף", "Added") : k === "removed" ? L("נמחק", "Removed") : L("משתנה", "Changed");
}

function undoText(d: SceneDiff): string {
  switch (d.undo) {
    case "undo": return L("צעד ביטול אחד בעורך (Ctrl+Z). נקודת שמירה נשמרת כשהסצנה נשמרת.", "One undo step in the editor (Ctrl+Z). A checkpoint is kept when the scene is saved.");
    case "checkpoint": return L("הקובץ נשמר בנקודת שמירה של הצ'אט לפני השינוי (↺ להחזרה).", "The file is kept in this chat's checkpoint before the change (↺ to go back).");
    case "queued": return L("העורך סגור: השינוי ממתין ויוחל בסנכרון הבא, עם נקודת שמירה של הקובץ לפניו.", "The editor is closed: the change waits for the next sync, with a checkpoint of the file before it.");
  }
}

/**
 * The scene diff on an approval card.
 *
 * @param props.diff - The diff from the approval preview.
 */
export function SceneDiffCard({ diff }: { diff: SceneDiff }) {
  const [all, setAll] = useState(false);
  const c = sceneCounts(diff);
  const shown = all ? diff.objects : diff.objects.slice(0, FIRST);
  const [he, en] = ENGINE[diff.engine];
  return (
    <div className="sd-card" role="group" aria-label={L("מה ישתנה בסצנה", "What changes in the scene")}>
      <p className="sd-head">
        <b>{L(he, en)}</b>
        {diff.scene && <> · <code dir="ltr">{diff.scene}</code></>}
      </p>
      <ul className="sd-counts" aria-label={L("סיכום", "Summary")}>
        {c.added > 0 && <li className="sd-added">+{c.added} {L("נוספים", "added")}</li>}
        {c.removed > 0 && <li className="sd-removed">−{c.removed} {L("נמחקים", "removed")}</li>}
        {c.changed > 0 && <li className="sd-changed">~{c.changed} {L("משתנים", "changed")}</li>}
      </ul>
      <ul className="sd-objects">
        {shown.map((o, i) => (
          <li key={`${o.name}-${i}`} className={`sd-obj sd-${o.kind}`}>
            <div className="sd-obj-head">
              <span className="sd-kind">{kindText(o.kind)}</span>
              <code className="sd-name" dir="ltr">{o.name}</code>
              {o.type && <span className="muted small" dir="ltr">{o.type}</span>}
            </div>
            {(o.components?.added?.length || o.components?.removed?.length) && (
              <p className="sd-comps">
                {o.components?.added?.map((x) => <span key={`+${x}`} className="sd-chip sd-added" dir="ltr">+ {x}</span>)}
                {o.components?.removed?.map((x) => <span key={`-${x}`} className="sd-chip sd-removed" dir="ltr">− {x}</span>)}
              </p>
            )}
            {o.props && o.props.length > 0 && (
              <table className="sd-props">
                <tbody>
                  {o.props.map((p) => (
                    <tr key={p.name}>
                      <th scope="row" dir="ltr">{p.name}</th>
                      <td dir="ltr">
                        {p.from !== undefined && <><del className="sd-old">{p.from}</del> <span aria-hidden="true">→</span> </>}
                        <ins className="sd-new">{p.to}</ins>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
      {diff.objects.length > FIRST && (
        <button type="button" className="link sd-more" onClick={() => setAll(!all)}>
          {all ? L("פחות", "Show less") : L(`הצג את כל ה-${diff.objects.length}`, `Show all ${diff.objects.length}`)}
        </button>
      )}
      {!diff.readBefore && <p className="muted small">{L("העורך לא ענה, אז מוצגים רק הערכים החדשים.", "The editor did not answer, so only the new values are shown.")}</p>}
      <p className="sd-undo muted small">↺ {undoText(diff)}</p>
    </div>
  );
}
