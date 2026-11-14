import { getLocale } from "../i18n";

/**
 * Asks for one line of text in a small dialog of the app's own. Replaces `window.prompt`, which the desktop app
 * (Electron) does not show at all (found by Roee's brother: shortcuts could not be renamed or given an address).
 * Enter or OK answers; Escape, Cancel or a click outside gives null.
 *
 * @param title - The question.
 * @param initial - The text already in the box.
 * @param o.placeholder - A hint inside the box.
 * @param o.ltr - For addresses and code.
 * @returns The text, or null when cancelled.
 */
export function askText(title: string, initial = "", o: { placeholder?: string; ltr?: boolean } = {}): Promise<string | null> {
  const he = getLocale() === "he";
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dialog-backdrop on-top";
    const box = document.createElement("form");
    box.className = "dialog card stack ask-text";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const label = document.createElement("label");
    label.className = "stack";
    const caption = document.createElement("span");
    caption.textContent = title;
    caption.dir = "auto";
    const input = document.createElement("input");
    input.value = initial;
    input.dir = o.ltr ? "ltr" : "auto";
    if (o.placeholder) input.placeholder = o.placeholder;
    label.append(caption, input);
    const row = document.createElement("div");
    row.className = "row";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "primary";
    ok.textContent = he ? "אישור" : "OK";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = he ? "ביטול" : "Cancel";
    row.append(ok, cancel);
    box.append(label, row);
    back.append(box);
    const was = document.activeElement as HTMLElement | null;
    const done = (v: string | null) => {
      removeEventListener("keydown", onKey, true);
      back.remove();
      was?.focus?.();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    };
    addEventListener("keydown", onKey, true);
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value);
    });
    cancel.addEventListener("click", () => done(null));
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) done(null);
    });
    document.body.append(back);
    input.focus();
    input.select();
  });
}
