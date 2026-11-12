import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { Select } from "./ui/Select";

/** Hebrew or English, for this component's own words. */
const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Entity { id: string; name: string; kind: "person" | "project" | "company" | "concept"; summary?: string; aliases: string[]; parent?: string; hidden?: boolean; days: string[]; lastSeen: number }

/**
 * The "People & projects" tab of My day: the people, projects, companies and
 * topics the model keeps meeting in the day write-ups. Filters them, shows
 * hidden ones on demand, and can merge a few into one, hide one, change its
 * kind or the thing it belongs to.
 */
export function Entities() {
  const [list, setList] = useState<Entity[]>([]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const load = () => api<Entity[]>("/api/journal/entities").then(setList, () => undefined);
  useEffect(() => void load(), []);
  const edit = (id: string, body: Record<string, unknown>) => void api(`/api/journal/entities/${id}`, { method: "PATCH", body }).then(() => { setPicked([]); void load(); });
  const kinds: Array<[Entity["kind"], string]> = [["person", L("אנשים", "People")], ["project", L("פרויקטים", "Projects")], ["company", L("חברות", "Companies")], ["concept", L("נושאים", "Topics")]];
  const shown = list.filter((e) => (showHidden || !e.hidden) && (!q || `${e.name} ${e.aliases.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="stack">
      <div className="row wrap">
        <input className="grow" placeholder={L("סנן…", "Filter…")} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />{L("הצג מוסתרים", "Show hidden")}</label>
        {picked.length > 1 && <button type="button" className="primary" onClick={() => edit(picked[0]!, { merge: picked.slice(1) })}>{L(`אחד ${picked.length} לאחד`, `Merge ${picked.length} into one`)}</button>}
      </div>
      {!list.length && <p className="muted">{L("עוד אין. המודל מוסיף אנשים ופרויקטים כשהוא כותב את סיכום היום.", "None yet. The model adds people and projects when it writes up your day.")}</p>}
      {kinds.map(([k, label]) => {
        const items = shown.filter((e) => e.kind === k);
        if (!items.length) return null;
        return (
          <section key={k}>
            <h3>{label}</h3>
            <ul className="ent-list">
              {items.map((e) => (
                <li key={e.id} className={e.hidden ? "hidden" : ""}>
                  <label className="row">
                    <input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.id] : picked.filter((x) => x !== e.id))} aria-label={L("בחר לאיחוד", "Pick to merge")} />
                    <strong className="grow">{e.name}{e.parent && <span className="muted small"> · {list.find((x) => x.id === e.parent)?.name}</span>}</strong>
                    <span className="muted small">{L(`${e.days.length} ימים`, `${e.days.length} days`)}</span>
                  </label>
                  {e.summary && <p className="small">{e.summary}</p>}
                  {e.aliases.length > 0 && <p className="muted small">{L("גם: ", "Also: ")}{e.aliases.join(", ")}</p>}
                  <div className="row small">
                    <Select value={e.kind} onChange={(ev) => edit(e.id, { kind: ev.target.value })} aria-label={L("סוג", "Kind")}>{kinds.map(([kk, l]) => <option key={kk} value={kk}>{l}</option>)}</Select>
                    <Select value={e.parent ?? ""} onChange={(ev) => edit(e.id, { parent: ev.target.value || null })} aria-label={L("שייך ל", "Belongs to")}>
                      <option value="">{L("לא שייך ל…", "Belongs to…")}</option>
                      {list.filter((x) => x.id !== e.id && x.kind !== "person").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                    <button type="button" className="link-btn" onClick={() => edit(e.id, { hidden: !e.hidden })}>{e.hidden ? L("הצג", "Show") : L("הסתר", "Hide")}</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
