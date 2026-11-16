/**
 * How the phone app addresses her in Hebrew (Settings → About you), bundled into www/vendor/address.js by
 * scripts/vendor.mjs from the shared code the computer uses. A classic script: it sets `kesherHebrew(text)` on the page
 * before the other scripts run.
 */
import { hebrewFor, type HebrewAddress } from "../../packages/shared/src/hebrew-address.ts";

const g = globalThis as unknown as { kesherHebrew: (text: string) => string; localStorage: { getItem(k: string): string | null } };
let address: HebrewAddress | undefined;
try {
  const a = g.localStorage.getItem("kesher-address");
  if (a === "f" || a === "m" || a === "p") address = a;
} catch {
  // no storage: the text as written
}
g.kesherHebrew = (text: string) => hebrewFor(text, address);
