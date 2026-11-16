/**
 * An on-screen keyboard for a game controller (audit C5): for fields other than the chat box (search, settings,
 * names) on a handheld without touch or on a PC with an Xbox pad. Like Windows 11's gamepad keyboard: the D-pad moves
 * between keys, A types the key, X deletes, Y is a space, Menu is Enter, B closes; LB switches Hebrew and English,
 * RB capitals and symbols. Typed text goes into the field the way typing does (React sees an input event).
 */

const LAYOUTS: Record<"he" | "en" | "EN" | "sym", string[]> = {
  he: ["1234567890", "קראטוןםפ", "שדגכעיחלךף", "זסבהנמצתץ.", "-,?!@/:"],
  en: ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm.", "-,?!@/:"],
  EN: ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM.", "-,?!@/:"],
  sym: ["!@#$%^&*()", "-_=+[]{}", ";:'\"\\|", "<>,./?~`", "€₪°…"],
};

/** Where the cursor goes on the keys: wraps around in a row, keeps the column between rows of different lengths. */
export function moveKey(rows: string[], at: { r: number; c: number }, dir: "up" | "down" | "left" | "right"): { r: number; c: number } {
  const n = rows.length;
  if (dir === "left" || dir === "right") {
    const len = [...rows[at.r]!].length;
    return { r: at.r, c: (at.c + (dir === "right" ? 1 : -1) + len) % len };
  }
  const r = (at.r + (dir === "down" ? 1 : -1) + n) % n;
  return { r, c: Math.min(at.c, [...rows[r]!].length - 1) };
}

/** Types into a field so React's onChange runs (its value setter, then an input event). */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, next: (value: string, start: number, end: number) => { value: string; caret: number }): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const out = next(el.value, start, end);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, out.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    el.setSelectionRange(out.caret, out.caret);
  } catch {
    // number and email fields have no selection
  }
}

let box: HTMLDivElement | undefined;
let target: HTMLInputElement | HTMLTextAreaElement | undefined;
let layout: keyof typeof LAYOUTS = "en";
let at = { r: 1, c: 0 };

const rows = () => LAYOUTS[layout];

function draw(): void {
  if (!box) return;
  box.dir = layout === "he" ? "rtl" : "ltr";
  box.innerHTML =
    rows()
      .map((row, r) => `<div class="osk-row">${[...row].map((ch, c) => `<span class="osk-key${r === at.r && c === at.c ? " on" : ""}">${ch.replace(/[&<>"]/g, (x) => `&#${x.charCodeAt(0)};`)}</span>`).join("")}</div>`)
      .join("") +
    `<div class="osk-help" dir="auto">${document.documentElement.lang === "he" ? "A הקלדה · X מחיקה · Y רווח · ☰ אישור · B סגירה · LB שפה · RB אותיות/סימנים" : "A type · X delete · Y space · ☰ enter · B close · LB language · RB caps/symbols"}</div>`;
}

/** Whether the keyboard is open (the controller then talks to it only). */
export function padKeyboardOpen(): boolean {
  return !!box;
}

/**
 * Opens the keyboard for a field.
 *
 * @param el - The field.
 */
export function openPadKeyboard(el: HTMLInputElement | HTMLTextAreaElement): void {
  closePadKeyboard();
  target = el;
  layout = document.documentElement.lang === "he" ? "he" : "en";
  at = { r: 1, c: 0 };
  box = document.createElement("div");
  box.className = "osk";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", document.documentElement.lang === "he" ? "מקלדת לשלט" : "Controller keyboard");
  document.body.appendChild(box);
  draw();
}

/** Closes it; focus stays on the field. */
export function closePadKeyboard(): void {
  box?.remove();
  box = undefined;
  target?.focus();
  target = undefined;
}

/**
 * A controller button while the keyboard is open.
 *
 * @param button - "up" / "down" / "left" / "right", or A, B, X, Y, LB, RB, MENU.
 * @returns Always true (the keyboard takes every button while open).
 */
export function padKeyboardButton(button: string): boolean {
  if (!box || !target) return false;
  const el = target;
  if (button === "up" || button === "down" || button === "left" || button === "right") {
    // In Hebrew the rows read right to left, so left and right swap.
    const dir = layout === "he" && (button === "left" || button === "right") ? (button === "left" ? "right" : "left") : button;
    at = moveKey(rows(), at, dir);
  } else if (button === "A" || button === "Y") {
    const ch = button === "Y" ? " " : [...rows()[at.r]!][at.c]!;
    typeInto(el, (v, s, e) => ({ value: v.slice(0, s) + ch + v.slice(e), caret: s + ch.length }));
  } else if (button === "X") {
    typeInto(el, (v, s, e) => (s !== e ? { value: v.slice(0, s) + v.slice(e), caret: s } : s > 0 ? { value: v.slice(0, s - 1) + v.slice(s), caret: s - 1 } : { value: v, caret: 0 }));
  } else if (button === "LB") {
    layout = layout === "he" ? "en" : "he";
    at = { r: Math.min(at.r, rows().length - 1), c: 0 };
  } else if (button === "RB") {
    layout = layout === "en" ? "EN" : layout === "EN" ? "sym" : layout === "sym" ? "en" : "sym";
    at = { r: Math.min(at.r, rows().length - 1), c: Math.min(at.c, [...rows()[Math.min(at.r, rows().length - 1)]!].length - 1) };
  } else if (button === "MENU") {
    closePadKeyboard();
    // A form is sent; a field outside a form gets Enter, as typing it would.
    if (el.form) el.form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  } else if (button === "B") {
    closePadKeyboard();
    return true;
  }
  draw();
  return true;
}
