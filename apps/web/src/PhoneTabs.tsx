import { Fragment, useEffect, useState } from "react";
import { api } from "./api";
import { useParts } from "./parts";
import { PHONE_TABS, type PhoneTab } from "@kesher/shared";
import { t } from "./i18n";
import { useAppearance } from "./appearance";
import { GLYPHS } from "./ui/Glyph";

/** Line icons for the bar (one stroke weight, like the phone's own). */
const I = {
  chats: <path d="M4 5h16v11H9l-5 4z" />,
  new: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  tools: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></>,
  settings: <>{GLYPHS.gear!.map((d) => <path key={d} d={d} />)}</>,
  study: <><path d="M2.5 9 12 4.5 21.5 9 12 13.5z" /><path d="M6.5 11v4.5c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8V11" /><path d="M21.5 9v5" /></>,
};

let studentRole: Promise<boolean> | undefined;
/** Whether the person chose "Student" on the welcome screen (asked once per page load). */
function useStudent(): boolean {
  const [is, setIs] = useState(false);
  useEffect(() => {
    studentRole ??= api<{ role?: string }>("/api/onboarding").then((o) => (o.role ?? "").split(",").includes("student"), () => false);
    void studentRole.then(setIs);
  }, []);
  return is;
}
const icon = (k: keyof typeof I) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[k]}</svg>
);

/**
 * The phone's bottom bar (thumb reach, like phone apps): chats, a new chat,
 * all tools, settings. Hidden inside a chat, where the message box is.
 */
export function PhoneTabs({ hash, onChats }: { hash: string; onChats: () => void }) {
  // The user's order (Settings → Appearance → Phone bar).
  const order = useAppearance().tabsOrder;
  // Students get Study in the bar (when its part is on).
  const student = useStudent();
  const study = useParts().on("study") && student;
  if (hash.startsWith("#/c/") || hash.startsWith("#/p/") || hash === "#/nodes") return null;
  const tab = (href: string, k: keyof typeof I, label: string) => (
    <a href={href} className="tab" aria-current={hash === href || (href !== "#/" && hash.startsWith(`${href}/`)) || (href === "#/settings" && hash.startsWith("#/settings")) ? "page" : undefined}>
      {icon(k)}
      <small>{label}</small>
    </a>
  );
  const parts: Record<PhoneTab, React.ReactNode> = {
    chats: (
      <button key="chats" type="button" className="tab" onClick={onChats}>
        {icon("chats")}
        <small>{t("tabChats")}</small>
      </button>
    ),
    new: <Fragment key="new">{tab("#/", "new", t("tabNew"))}</Fragment>,
    tools: <Fragment key="tools">{tab("#/apps", "tools", t("tabTools"))}</Fragment>,
    settings: <Fragment key="settings">{tab("#/settings", "settings", t("settings"))}</Fragment>,
  };
  return (
    <nav className="phone-tabs" aria-label="Main" data-slide-bar>
      {(order ?? PHONE_TABS).flatMap((k) => (k === "new" && study ? [parts[k], <Fragment key="study">{tab("#/study", "study", t("studyNav"))}</Fragment>] : [parts[k]]))}
    </nav>
  );
}
