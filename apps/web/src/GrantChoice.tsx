import { getLocale, he$ } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** How long a yes on an approval card holds (the server's approval-grants.ts `GrantChoice`). */
export type GrantChoice = "once" | "chat" | "hour" | "revoke";

/**
 * The words for each choice; a helper's "Until I revoke" holds only in its chat, so it is not offered to helpers.
 *
 * @param helper - The card is a helper's step.
 */
export function grantChoices(helper = false): Array<[GrantChoice, string]> {
  return [
    ["once", L("הפעם", "This time")],
    ["chat", L("לצ'אט הזה", "For this chat")],
    ["hour", L("לשעה", "For 1 hour")],
    ...(helper ? [] : [["revoke", L("עד שאבטל", "Until I revoke")] as [GrantChoice, string]]),
  ];
}

/**
 * Where a grant will hold, in a few words for the card ("in src", "on github.com", "in Unity"), from the tool and
 * its arguments; undefined when it holds for the whole tool. Mirrors the server's `targetOf` for the text only.
 *
 * @param tool - The tool.
 * @param input - Its arguments.
 * @param scope - The browser's `site:<host>`.
 */
export function grantWhere(tool: string, input: Record<string, unknown>, scope?: string): string | undefined {
  if (scope?.startsWith("site:")) return L(`ב-${scope.slice(5)}`, `on ${scope.slice(5)}`);
  if (tool === "computer_use_app" && typeof input.app === "string" && input.app) return L(`ב-${input.app}`, `in ${input.app}`);
  const path = typeof input.path === "string" ? input.path.replace(/\\/g, "/") : "";
  if (path && /^(write_file|edit_file)$/.test(tool)) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/").pop() || "/" : ".";
    return L(`בתיקייה ${folder}`, `in the ${folder} folder`);
  }
  return undefined;
}

/**
 * The card's "For how long" picker: This time / For this chat / For 1 hour / Until I revoke. Shown only where the
 * server may keep a grant (not on always-ask cards); the server checks again.
 *
 * @param props.value - The current choice.
 * @param props.onChange - Called with the new choice.
 * @param props.helper - The card is a helper's step (no "Until I revoke").
 * @param props.where - Where the grant holds, shown in the label's tooltip.
 */
export function GrantPicker({ value, onChange, helper, where }: { value: GrantChoice; onChange: (v: GrantChoice) => void; helper?: boolean; where?: string }) {
  return (
    <Select
      className="model-chip grant-pick"
      value={value}
      aria-label={where ? L(`לכמה זמן לאשר (${where})`, `Allow for how long (${where})`) : L("לכמה זמן לאשר", "Allow for how long")}
      onChange={(e) => onChange(e.target.value as GrantChoice)}
    >
      {grantChoices(helper).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </Select>
  );
}

/**
 * The Allow button's words for a choice ("Allow", "Allow for this chat"…).
 *
 * @param choice - The choice.
 */
export function allowLabel(choice: GrantChoice): string {
  switch (choice) {
    case "chat": return L("אשר לצ'אט הזה", "Allow for this chat");
    case "hour": return L("אשר לשעה", "Allow for 1 hour");
    case "revoke": return L("אשר עד שאבטל", "Allow until I revoke");
    default: return L("אשר", "Allow");
  }
}
