/**
 * Settings › "Connect to Claude" (HubConnector): the address to paste into Claude's custom connectors, the steps, and
 * "Connected apps" with Revoke. The connector itself is the hub's remote MCP endpoint (src/connector.ts); what it can
 * see is metadata only, because task text, results and approvals stay end-to-end encrypted.
 */
import { h, L, when } from "./dom.js";
/**
 * The settings section.
 *
 * @param connections - The approved connections (from the owner's state).
 * @param busy - Whether an owner action is running (buttons wait).
 * @param revoke - Ends one connection (the caller posts it and reloads the state).
 * @returns The section.
 */
export function connectorSection(connections, busy, revoke) {
    const url = `${location.origin}/mcp`;
    const copied = h("span", { class: "mut xs", role: "status" });
    const copy = () => {
        void navigator.clipboard?.writeText(url).then(() => {
            copied.textContent = L("הועתק", "Copied");
        });
    };
    return h("section", { class: "sec" }, h("h3", null, L("חיבור ל-Claude", "Connect to Claude")), h("span", { class: "mut sm" }, L("Claude יוכל לראות את המכשירים, הסוכנים, כמה מחכה לאישור, ולשלוח משימה למחשב. רק החשבון שלך יכול לאשר את החיבור.", "Claude can see your devices, agents and how much waits for approval, and send a task to a PC. Only your account can approve the connection.")), h("div", { class: "row wrap" }, h("code", { class: "mono grow min0 ell", title: url }, url), h("button", { type: "button", class: "btn", onclick: copy }, L("העתק", "Copy")), copied), h("ol", { class: "sm lines" }, h("li", null, L("ב-Claude: הגדרות › מחברים › הוספת מחבר מותאם אישית.", "In Claude: Settings › Connectors › Add custom connector.")), h("li", null, L("שם: Kesher Cloud. הדביקו את הכתובת למעלה, בלי מזהה לקוח או סוד.", "Name: Kesher Cloud. Paste the address above, with no client id or secret.")), h("li", null, L("לחצו \"התחבר\". ייפתח דף של המרכז: בדקו שהחזרה היא ל-claude.ai ואשרו.", "Press \"Connect\". The hub's page opens: check that it returns to claude.ai and approve.")), h("li", null, L("בצ'אט, הפעילו את Kesher Cloud בתפריט הכלים.", "In a chat, turn Kesher Cloud on in the tools menu."))), h("span", { class: "mut xs" }, L("תוכן המשימות, התוצאות והאישורים נעולים בין המכשירים שלך; המרכז ו-Claude מקבלים רק מספרים ומזהים, וקישור לדף הזה.", "Task text, results and approvals stay sealed between your devices; the hub and Claude get only counts and ids, and a link to this page.")), h("h3", null, L("אפליקציות מחוברות", "Connected apps")), connections.length
        ? connections.map((c) => h("div", { class: "row wrap" }, h("span", { class: "grow min0" }, h("b", null, c.name), h("div", { class: "mut xs" }, L(`חובר ${when(c.createdAt)} · שימוש אחרון ${when(c.lastUsed)} · עד ${when(c.endsAt)}`, `Connected ${when(c.createdAt)} · last used ${when(c.lastUsed)} · until ${when(c.endsAt)}`))), h("button", { type: "button", class: "btn bad", disabled: busy, onclick: () => confirm(L(`לנתק את "${c.name}"? Claude יצטרך להתחבר מחדש.`, `Disconnect "${c.name}"? Claude will have to connect again.`)) && revoke(c) }, L("נתק", "Revoke"))))
        : h("span", { class: "mut sm" }, L("אין חיבורים.", "No connections.")));
}
