import { useState } from "react";
import { sceneCounts, type SceneDiff, type SceneObjectChange, type ScenePlan } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";
import "./scene-diff.css";

/*
 * What a Unity, Unreal or Godot tool will change in a scene, on its approval card (shared/scene-diff.ts): the objects
 * added, removed and changed, each value as old → new, and how it can be undone. Shown inside ApprovalCard, so the
 * Allow / Deny buttons stay the card's own; the same on the phone (390 px: values wrap, nothing is cut).
 *
 * GE-28: when `onSelectObject` is provided, each object row with an `id` is clickable and highlights the object in the
 * open engine (Unity instanceID / Unreal path / Godot node path carried on `SceneObjectChange.id`). Rows without an id
 * stay plain text.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

const FIRST = 6;

const ENGINE: Record<SceneDiff["engine"], [string, string]> = {
 unity: ["Unity", "Unity"],
 unreal: ["Unreal", "Unreal"],
 godot: ["Godot", "Godot"],
};

function kindText(k: SceneObjectChange["kind"]): string {
 return k === "added" ? L("נוסף", "Added") : k === "removed" ? L("הוסר", "Removed") : L("שונה", "Changed");
}

function undoText(d: SceneDiff): string {
 if (d.undo === "checkpoint") return L("שמור כנקודת חזרה לפני ההרצה", "Saved as a checkpoint before running");
 return L("צעד אחד של Undo בעורך הפתוח", "One Undo step in the open editor");
}

function PlanSvg({ plan }: { plan: ScenePlan }) {
 const [minX, minY] = plan.min;
 const [maxX, maxY] = plan.max;
 const w = maxX - minX || 1;
 const h = maxY - minY || 1;
 const sx = 200 / w;
 const sy = 200 / h;
 const dots: Array<{ x: number; y: number; cls: string; key: string }> = [];
 plan.rest.forEach(([x, y], i) => dots.push({ x, y, cls: "sd-dot-rest", key: `r-${i}` }));
 plan.before.forEach(([x, y], i) => dots.push({ x, y, cls: "sd-dot-moved", key: `b-${i}` }));
 plan.after.forEach(([x, y], i) => {
 const cls = i < plan.moved ? "sd-dot-moved" : "sd-dot-added";
 dots.push({ x, y, cls, key: `a-${i}` });
 });
 return (
 <svg viewBox="0 0 200 200" role="img" aria-label={L("מפת שינויים", "Change map")}>
 <rect className="sd-plan-bg" x="0" y="0" width="200" height="200" rx="8" />
 {dots.map((d) => {
 const cx = (d.x - minX) * sx + sx / 2;
 const cy = (maxY - d.y) * sy + sy / 2;
 return <circle key={d.key} className={d.cls} cx={cx} cy={cy} r="6" />;
 })}
 </svg>
 );
}

/**
 * A scene diff on an approval card: counts, per-object changes with old → new values, optional before/after plan, and
 * undo hint. When `onSelectObject` is given, rows carrying an engine `id` become focusable buttons that call it.
 *
 * @param props.diff - The diff from the approval preview.
 * @param props.onSelectObject - Optional callback fired with the object's engine id when a selectable row is activated.
 */
export function SceneDiffCard({ diff, onSelectObject }: { diff: SceneDiff; onSelectObject?: (id: string) => void }) {
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
 <ul className="sd-counts">
 {c.added > 0 && <li className="sd-added">{he$(String(c.added))} {L("נוספו", "added")}</li>}
       {c.removed > 0 && <li className="sd-removed">{he$(String(c.removed))} {L("הוסרו", "removed")}</li>}
       {c.changed > 0 && <li className="sd-changed">{he$(String(c.changed))} {L("שונו", "changed")}</li>}
 </ul>
 {diff.plan && (
 <figure className="sd-plan-side">
 <PlanSvg plan={diff.plan} />
 <figcaption className="muted small">{L("לפני ואחרי", "Before and after")}</figcaption>
 </figure>
 )}
 <ul className="sd-objects">
 {shown.map((o, i) => {
 const selectable = !!o.id && !!onSelectObject;
 return (
 <li
 key={`${o.name}-${i}`}
 className={`sd-obj sd-${o.kind}${selectable ? " sd-selectable" : ""}`}
 role={selectable ? "button" : undefined}
 tabIndex={selectable ? 0 : undefined}
 aria-label={selectable ? L(`בחר את ${o.name} בעורך`, `Select ${o.name} in the editor`) : undefined}
 onClick={selectable ? () => onSelectObject!(o.id!) : undefined}
 onKeyDown={selectable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectObject!(o.id!); } } : undefined}
 >
 <div className="sd-obj-head">
 <span className="sd-kind">{kindText(o.kind)}</span>
 <code className="sd-name" dir="ltr">{o.name}</code>
 {o.type && <span className="muted small" dir="ltr">{o.type}</span>}
 {selectable && <span className="sd-select-hint muted small" aria-hidden="true">{L("🔍", "🔍")}</span>}
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
 );
 })}
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