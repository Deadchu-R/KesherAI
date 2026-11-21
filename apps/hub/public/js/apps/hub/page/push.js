/**
 * Notifications on this device (Settings › Notifications, HubNotify in the design doc): the hub's Web Push, so the
 * phone shows "KesherAI: 2 waiting for you" when something on a PC waits for an approval or a Run press, wherever
 * the phone is, with the hub page closed. Free, through the browser's own push service; no extra app.
 *
 * - The subscription is this browser's (its service worker, `/sw.js`) and is tied on the hub to this paired device
 *   (its token). The hub learns only a count, never what waits.
 * - Inside the KesherAI app (a WebView, which has no Web Push) and in browsers without it, the section says how:
 *   open the hub in the phone's browser and add it to the home screen (an installed app; iOS needs that too).
 */
import { h, L, getLocale } from "./dom.js";
/** The notification tag the service worker uses (the same as the Worker's `PUSH.tag`). */
const TAG = "kesher-waiting";
const push = { state: "checking", error: undefined };
/** Whether this browser can do Web Push at all. */
function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
/** The service worker's registration (registered once, at start). */
function registration() {
    return "serviceWorker" in navigator ? navigator.serviceWorker.ready : undefined;
}
/** The key as bytes for `pushManager.subscribe`. */
function keyBytes(b64url) {
    const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
/**
 * Registers the service worker (it shows the pushes and makes the hub installable), reads whether this browser is
 * subscribed, tells the hub again (it may have dropped it, and the language may have changed), and closes a shown
 * "waiting" notification now that the page is open.
 *
 * @param v - The page's parts.
 */
export async function startPush(v) {
    if (!("serviceWorker" in navigator))
        return void ((push.state = "unsupported"), v.render());
    try {
        // The module service worker shows asks with buttons (ask-note.ts); a browser that cannot run one gets the count-only one.
        await navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => navigator.serviceWorker.register("/sw-basic.js"));
        const reg = await registration();
        for (const n of await reg.getNotifications({ tag: TAG }))
            n.close();
        if (!supported())
            push.state = "unsupported";
        else if (Notification.permission === "denied")
            push.state = "blocked";
        else {
            const sub = await reg.pushManager.getSubscription();
            push.state = sub ? "on" : "off";
            if (sub && v.device.paired)
                await v.device.postAsDevice("/api/push/subscribe", { ...sub.toJSON(), lang: getLocale() });
        }
    }
    catch {
        push.state = supported() ? "off" : "unsupported";
    }
    v.render();
}
/** Closes a shown "waiting" notification (the page came to the front). */
export function clearShown() {
    void registration()?.then(async (reg) => {
        for (const n of await reg.getNotifications({ tag: TAG }))
            n.close();
    });
}
/** Asks for permission, subscribes and gives the subscription to the hub. */
async function turnOn(v) {
    push.error = undefined;
    push.state = "busy";
    v.render();
    try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
            push.state = perm === "denied" ? "blocked" : "off";
            return;
        }
        const reg = await registration();
        const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(v.vapidKey()) }));
        const r = await v.device.postAsDevice("/api/push/subscribe", { ...sub.toJSON(), lang: getLocale() });
        if (r?.status !== 200) {
            await sub.unsubscribe().catch(() => undefined);
            push.state = "off";
            push.error = { he: "המרכז לא קיבל את המכשיר הזה להתראות. נסו שוב.", en: "The hub did not take this device for notifications. Try again." };
            return;
        }
        push.state = "on";
    }
    catch {
        push.state = "off";
        push.error = { he: "הדפדפן לא אפשר התראות כאן.", en: "The browser did not allow notifications here." };
    }
    finally {
        v.render();
    }
}
/** Unsubscribes this browser and tells the hub. */
async function turnOff(v) {
    push.error = undefined;
    push.state = "busy";
    v.render();
    try {
        const sub = await (await registration()).pushManager.getSubscription();
        await sub?.unsubscribe();
        await v.device.postAsDevice("/api/push/unsubscribe", {});
    }
    catch {
        // The browser forgot it anyway; the hub drops it on the push service's next "gone".
    }
    push.state = "off";
    v.render();
}
/** The way to notifications when this browser cannot (the app's WebView, or no Web Push here). */
function howTo(v) {
    return h("div", { class: "card pad stack start in-app-note", role: "note" }, h("span", { class: "sm" }, v.inApp() ? L("בתוך האפליקציה אין התראות מהמרכז. פתחו את המרכז בדפדפן של הטלפון והוסיפו אותו למסך הבית, ומשם הפעילו התראות.", "The app can't get the hub's notifications. Open the hub in the phone's browser, add it to the home screen, and turn notifications on there.") : L("הדפדפן הזה לא מקבל התראות מאתרים. הוסיפו את המרכז למסך הבית (תפריט הדפדפן › הוספה למסך הבית), פתחו אותו משם ונסו שוב.", "This browser doesn't take notifications from sites. Add the hub to the home screen (the browser's menu › Add to Home screen), open it from there and try again.")), 
    // The app opens this marked address in the phone's browser (NotifyPlugin.java), as the sign-in note's link does.
    v.inApp() ? h("a", { class: "btn pri", href: v.externalHref(), rel: "noopener" }, L("פתח בדפדפן של הטלפון ↗", "Open in the phone's browser ↗")) : null);
}
/**
 * Settings › Notifications: "Notify this device", its state, and what it tells (a count only).
 *
 * @param v - The page's parts.
 * @returns The section.
 */
export function notifySection(v) {
    const s = push.state;
    const title = h("h3", null, L("התראות", "Notifications"));
    const what = h("span", { class: "mut xs" }, L("כשמשהו במחשב מחכה לאישור או להרצה, והדף סגור: ההתראה מראה את הבקשה עם שני כפתורים (הפעל / לא עכשיו, או אשר / דחה). המחשב נועל אותה למכשיר הזה, והמרכז רואה רק את המספר. לחיצה על ההתראה פותחת את הבקשה. אחרי עדכון: פתחו את הדף פעם אחת.", "When something on a PC waits for an approval or a Run, with this page closed: the notification shows the ask with two buttons (Run / Not now, or Approve / Deny). The PC seals it to this device; the hub sees only the count. A tap opens the ask. After an update, open this page once."));
    let body;
    if (!v.device.paired)
        body = h("span", { class: "mut sm" }, L("קודם חברו את המכשיר הזה (לשונית חיבור).", "Pair this device first (the Pair tab)."));
    else if (!v.vapidKey())
        body = h("span", { class: "mut sm" }, L("ההתראות לא הוגדרו במרכז הזה (VAPID_PUBLIC_KEY).", "Notifications are not set up on this hub (VAPID_PUBLIC_KEY)."));
    else if (v.inApp() || s === "unsupported")
        body = howTo(v);
    else
        body = h("div", { class: "row" }, h("span", { class: "grow" }, h("b", null, L("הודע למכשיר הזה", "Notify this device")), h("div", { class: "mut sm" }, s === "blocked" ? L("ההתראות חסומות בדפדפן. אפשרו אותן בהגדרות האתר ונסו שוב.", "Notifications are blocked in the browser. Allow them in the site's settings and try again.") : s === "on" ? L("פועל. גם כשהדף סגור.", "On, even with the page closed.") : L("כבוי", "Off"))), h("button", { type: "button", role: "switch", class: `tog${s === "on" ? "" : " off"}`, "aria-checked": s === "on", "aria-label": L("הודע למכשיר הזה", "Notify this device"), disabled: s === "busy" || s === "checking" || s === "blocked", onclick: () => void (s === "on" ? turnOff(v) : turnOn(v)) }));
    return h("section", { class: "sec", id: "notify" }, title, body, push.error ? h("span", { class: "warn sm", role: "alert" }, L(push.error.he, push.error.en)) : null, what);
}
/** Drops this browser's subscription (the device was forgotten here; the hub drops its copy with the device). */
export async function dropLocalPush() {
    try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
    }
    catch {
        // Nothing to drop.
    }
    push.state = supported() ? "off" : "unsupported";
}
