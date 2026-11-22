/**
 * The hub page's half of the backup path (packages/shared/src/direct-path.ts): it remembers each PC's tailnet-only
 * address from presence (in this browser), and when the hub does not answer, answers 5xx or has used up its daily
 * storage, it shows which path is in use and a button straight to the PC through Tailscale. In the phone app the
 * button goes back to the app, which connects with its own key (the same auth as at home); in a browser it opens the
 * PC's tailnet HTTPS address, where KesherAI asks for its own pairing as usual.
 */
import { choosePath, cleanTailscaleDirect, directUrls, hubUsable, PATH_LABELS, TAILSCALE_HINT, type HubProbe, type TailscaleDirect } from "../../../packages/shared/src/direct-path.js";
import type { HubPresence } from "../../../packages/shared/src/hub-protocol.js";
import { h, L } from "./dom.js";

const KEY = "kh-direct";
const HINT_KEY = "kh-ts-hint";
/** Whether the one-time Tailscale hint shows on this page load. */
let hintNow: boolean | undefined;

/** The remembered PC addresses, newest PC first. */
function remembered(): Array<{ id: string; name: string; direct: TailscaleDirect }> {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]") as Array<{ id: string; name: string; direct: unknown }>;
    return list.flatMap((x) => {
      const direct = cleanTailscaleDirect(x?.direct);
      return direct && typeof x.id === "string" ? [{ id: x.id, name: String(x.name ?? "").slice(0, 80), direct }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Remembers the PCs' tailnet addresses from presence, so they are known when the hub is down later.
 *
 * @param presence - The devices the hub lists.
 */
export function rememberDirect(presence: readonly HubPresence[]): void {
  const fresh = presence.flatMap((d) => {
    const direct = d.kind === "pc" ? cleanTailscaleDirect(d.direct) : undefined;
    return direct ? [{ id: d.id, name: d.name, direct }] : [];
  });
  if (!fresh.length) return;
  const list = [...fresh, ...remembered().filter((x) => !fresh.some((f) => f.id === x.id))].slice(0, 8);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage off: not remembered */
  }
}

/**
 * The path line: nothing while the hub works; when it does not, "Direct through Tailscale" with a button to the PC,
 * or (once) the hint to install Tailscale.
 *
 * @param probe - How the last hub request went (`status` missing when it did not answer).
 * @param appOrigin - The phone app's origin when the page runs inside it.
 * @returns The line, or null.
 */
export function pathLine(probe: HubProbe | undefined, appOrigin: string | undefined): HTMLElement | null {
  if (!probe || hubUsable(probe)) return null;
  const pc = remembered()[0];
  const pick = choosePath(probe, pc?.direct);
  if (pick.path === "tailscale" && pc) {
    const href = appOrigin ? `${appOrigin}/index.html?direct=1` : directUrls(pc.direct).find((u) => u.startsWith("https://"));
    return h(
      "div",
      { class: "off-banner", role: "status" },
      h("span", null, L(`ההאב לא זמין · ${PATH_LABELS.tailscale.he}`, `The hub is unavailable · ${PATH_LABELS.tailscale.en}`)),
      h("span", { class: "grow" }),
      href ? h("a", { class: "acc xs", href }, L(`פתח את ${pc.name}`, `Open ${pc.name}`)) : null,
    );
  }
  // Once per phone: decided on the first render that needs it, then kept for this page load (render runs often).
  if (hintNow === undefined) {
    try {
      hintNow = !localStorage.getItem(HINT_KEY);
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      hintNow = true;
    }
  }
  return !hintNow ? null : h("div", { class: "off-banner", role: "status" }, h("span", null, L(TAILSCALE_HINT.he, TAILSCALE_HINT.en)));
}
