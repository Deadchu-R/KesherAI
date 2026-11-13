/* exported readPage, clickRef, typeRef */
/* eslint-disable @typescript-eslint/no-unused-vars -- used by background.js and the app's browser pane */
// KesherAI page helpers: run inside a page to read it and act on it. Used by the browser extension
// (background.js) and by the browser pane in the KesherAI app, so both read and act the same way.
// Never types into password or card fields.

// Runs inside the page: its text, and numbered elements the agent can use.
function readPage() {
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const els = [...document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [contenteditable="true"]')].filter(visible).slice(0, 300);
  let n = 0;
  const lines = [];
  for (const el of els) {
    n++;
    el.setAttribute("data-kesher-ref", String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const kind = tag === "a" ? "link" : tag === "input" ? `field${type ? ` (${type})` : ""}` : tag === "textarea" ? "text box" : tag === "select" ? "list" : el.getAttribute("role") || tag;
    lines.push(`${n}: ${kind} "${type === "password" ? "password" : label}"${tag === "a" ? ` → ${el.href.slice(0, 120)}` : ""}`);
  }
  return { url: location.href, title: document.title, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000), elements: lines };
}

function clickRef(ref) {
  const el = document.querySelector(`[data-kesher-ref="${ref}"]`);
  if (!el) return { error: "That element is gone; read the page again." };
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}

function typeRef(ref, text, submit) {
  const el = document.querySelector(`[data-kesher-ref="${ref}"]`);
  if (!el) return { error: "That element is gone; read the page again." };
  const type = (el.getAttribute("type") || "").toLowerCase();
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (type === "password" || /cc-|password/.test(ac)) return { error: "KesherAI never types passwords or card numbers. Ask the user to type it." };
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  } else {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (submit) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
  }
  return true;
}
