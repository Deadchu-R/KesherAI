/**
 * The hub page's small DOM helpers: element building without innerHTML (so nothing a device reports can become
 * markup), and the two-language text helper. No framework: the page is a few screens and must load with no build step
 * on the Worker (the compiled JS is committed in `public/js`).
 */
/** The page language, Hebrew by default (Roee's), English when chosen or when the browser is not Hebrew. */
let locale = "he";
/**
 * Sets the language and the page direction.
 *
 * @param l - "he" or "en".
 */
export function setLocale(l) {
    locale = l;
    document.documentElement.lang = l;
    document.documentElement.dir = l === "he" ? "rtl" : "ltr";
    try {
        localStorage.setItem("kh-lang", l);
    }
    catch {
        // Private window: the language is not remembered.
    }
}
/**
 * The language in use.
 *
 * @returns "he" or "en".
 */
export function getLocale() {
    return locale;
}
/** Picks the saved language, else Hebrew for a Hebrew browser, else English. */
export function initLocale() {
    let saved = null;
    try {
        saved = localStorage.getItem("kh-lang");
    }
    catch {
        // No storage.
    }
    setLocale(saved === "en" || saved === "he" ? saved : navigator.language.startsWith("en") ? "en" : "he");
}
/**
 * One text in both languages.
 *
 * @param he - Hebrew.
 * @param en - English.
 * @returns The one for the page language.
 */
export function L(he, en) {
    return locale === "he" ? he : en;
}
/**
 * Builds an element. Text children are text nodes (never parsed as HTML).
 *
 * @param tag - The tag name.
 * @param attrs - Attributes; `onclick` style keys add listeners; false/undefined skip the attribute.
 * @param children - Children.
 * @returns The element.
 */
export function h(tag, attrs = null, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false)
            continue;
        if (typeof v === "function")
            el.addEventListener(k.slice(2), v);
        else if (k === "value" && "value" in el)
            el.value = String(v);
        else
            el.setAttribute(k, v === true ? "" : String(v));
    }
    append(el, children);
    return el;
}
/** Appends children (flattened), skipping empty ones. */
function append(el, children) {
    for (const c of children) {
        if (c === null || c === undefined || c === false)
            continue;
        if (Array.isArray(c))
            append(el, c);
        else
            el.append(c instanceof Node ? c : String(c));
    }
}
/**
 * A short local time ("היום 09:12", "שישי 23:40", or a date).
 *
 * @param t - Epoch ms or an ISO time.
 * @returns The text.
 */
export function when(t) {
    if (t === undefined)
        return "";
    const d = new Date(t);
    if (Number.isNaN(d.getTime()))
        return "";
    const tag = locale === "he" ? "he-IL" : "en-GB";
    const time = d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
    if (days === 0)
        return `${L("היום", "Today")} ${time}`;
    if (days === 1)
        return `${L("אתמול", "Yesterday")} ${time}`;
    if (days > 1 && days < 7)
        return `${d.toLocaleDateString(tag, { weekday: "long" })} ${time}`;
    return d.toLocaleDateString(tag, { day: "numeric", month: "short" }) + ` ${time}`;
}
