import { getLocale } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The pictures area's tabs, by what you want to do (redesign 2026-11): create, remove the background or upscale,
 * train a model, or build a flow in Nodes. Each is its own page; the tabs tie them together.
 *
 * @param p.at - The page it is on.
 */
export function ImageTabs({ at }: { at: "#/images" | "#/batch" | "#/training" }) {
  const tabs: Array<[string, string]> = [
    ["#/images", L("יצירה", "Create")],
    ["#/batch", L("הסרת רקע והגדלה", "Background and upscale")],
    ["#/training", L("אימון", "Training")],
    ["#/nodes", "Nodes"],
  ];
  return (
    <nav className="tabs" aria-label={L("תמונות", "Pictures")}>
      {tabs.map(([href, label]) => (
        <a key={href} href={href} className={href === at ? "on" : ""} aria-current={href === at ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}
