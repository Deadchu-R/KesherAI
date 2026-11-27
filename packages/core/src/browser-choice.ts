/**
 * Which browser the model's browser tools use when it does not say: the user's setting (Settings → Browser and
 * computer), what is connected, and what the user asked for in the message. Pure, so it is easy to test.
 */

/** The setting: KesherAI's own pane, the user's Chrome (the extension), or decide per task. */
export type PreferredBrowser = "pane" | "chrome" | "auto";

/** What the choice came out as: a browser, or a reason to ask the user instead of switching. */
export type BrowserChoice = { browser: "pane" | "chrome" } | { ask: string };

/** Words that mean "my own sign-in": my account, a signed-in service, in Hebrew and English. */
const OWN_SIGN_IN = [
  /\bmy (?:own )?(?:account|gmail|google drive|drive|inbox|email|emails|mail|calendar|profile|orders|bank|facebook|instagram|linkedin|github)\b/i,
  /\b(?:gmail|google drive|outlook|icloud|my chrome|signed[- ]in|logged[- ]in)\b/i,
  /(?:^|[\s"'(])(?:ב)?(?:חשבון|מייל|ג'ימייל|גימייל|דרייב|הדרייב|לוח השנה|ההזמנות|הפרופיל)\s*(?:שלי|שלנו)/,
  /בחשבון\s+שלי|מחובר|התחברתי|גימייל|ג'ימייל|ג׳ימייל/,
];

/**
 * @param text - The user's latest message.
 * @returns Whether the task needs the user's own sign-ins (their account, Gmail, Drive…).
 */
export function needsOwnSignIn(text: string | undefined): boolean {
  return !!text && OWN_SIGN_IN.some((re) => re.test(text));
}

/**
 * @param text - The user's latest message.
 * @returns The browser the user named ("in my Chrome", "בכרום", "in KesherAI's browser"), or undefined.
 */
export function namedBrowser(text: string | undefined): "pane" | "chrome" | undefined {
  if (!text) return undefined;
  if (/\b(?:kesher\s?ai'?s? (?:own )?browser|the (?:kesher\s?ai |built-in |in-app )?(?:browser )?pane|built-in browser)\b|בדפדפן של קשר|בדפדפן המובנה/i.test(text)) return "pane";
  if (/\b(?:in|on|with|using|via) (?:my |the )?(?:own )?chrome\b|\bmy chrome\b|בכרום|בדפדפן שלי|ב-?chrome/i.test(text)) return "chrome";
  return undefined;
}

/**
 * Picks the browser for a call that did not name one.
 *
 * @param o.preferred - The setting (default automatic).
 * @param o.pane - Whether KesherAI's own browser pane is open.
 * @param o.chrome - Whether the extension is connected.
 * @param o.lastUser - The user's latest message.
 * @returns The browser to use (the other one silently when the preferred is not there), or `ask` when the user
 * named a browser that is not available: the model asks them (ask_user) instead of switching.
 */
export function chooseBrowser(o: { preferred?: PreferredBrowser; pane: boolean; chrome: boolean; lastUser?: string }): BrowserChoice {
  const named = namedBrowser(o.lastUser);
  const have = { pane: o.pane, chrome: o.chrome };
  if (named && !have[named]) {
    const other = named === "pane" ? "chrome" : "pane";
    return { ask: `The user asked for ${named === "pane" ? "KesherAI's own browser" : "their own Chrome"}, but it is not available now${named === "chrome" ? " (the KesherAI extension is not connected)" : " (open KesherAI on the computer)"}. Do not switch: ask the user with ask_user whether to use ${other === "pane" ? "KesherAI's own browser" : "their own Chrome"} instead, or to connect it first.` };
  }
  if (!have.pane && !have.chrome) return { browser: "pane" };
  const want = named ?? (o.preferred === "pane" || o.preferred === "chrome" ? o.preferred : needsOwnSignIn(o.lastUser) ? "chrome" : "pane");
  return { browser: have[want] ? want : want === "pane" ? "chrome" : "pane" };
}
