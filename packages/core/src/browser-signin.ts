/**
 * Sign-in hand-off for the browser tools (like Claude in Chrome): when a browser step lands on a password page, a
 * one-time or two-step code, or a robot check (CAPTCHA, "verify you are human"), the model never types there. The
 * chat shows a "Sign in needed" card (PC and phone); the user signs in on the PC, presses Continue (or KesherAI sees
 * the page move on by itself), and the step goes on with the page read again.
 */
import type { SignInInfo } from "@kesher/shared";
import { hostOf } from "./browser-safety.js";

/** What kind of check is on the page. */
export type SignInWall = SignInInfo["wall"];

/** What the page's DOM shows (KesherAI's pane or Chrome over CDP): visible fields and robot-check frames. */
export interface SignInMarkers {
  /** A visible `input[type=password]`. */
  password: boolean;
  /** A visible `input[autocomplete=one-time-code]`. */
  otp: boolean;
  /** A reCAPTCHA, hCaptcha or Cloudflare Turnstile frame or box, or Cloudflare's challenge form. */
  captcha: boolean;
}

/**
 * Runs in the page (Runtime.evaluate) and returns {@link SignInMarkers}. Reads only element types and attributes,
 * never a field's value.
 */
export const SIGN_IN_PROBE = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const any = (sel) => Array.from(document.querySelectorAll(sel)).some(shown);
  return {
    password: any("input[type=password]"),
    otp: any("input[autocomplete~='one-time-code']"),
    // reCAPTCHA v3's corner badge and invisible widgets are on many normal pages: only a check the user must do counts.
    captcha: Array.from(document.querySelectorAll("iframe[src*='recaptcha/api2/anchor'], iframe[src*='recaptcha/api2/bframe'], iframe[src*='recaptcha/enterprise/anchor'], iframe[src*='hcaptcha.com'], iframe[src*='challenges.cloudflare.com']")).some((f) => shown(f) && !/size=invisible/.test(f.src) && !f.closest(".grecaptcha-badge")) || !!document.querySelector("#challenge-form, #challenge-stage, #cf-challenge-running"),
  };
})()`;

/** Robot checks by their words or frames (any language the snapshot shows; English and Hebrew covered). */
const CAPTCHA_TEXT = /verify (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|are you a robot|checking (?:if the site connection is secure|your browser)|press (?:and|&) hold|unusual traffic from your computer|אני לא רובוט|ודא(?:ו)? שאת(?:ה|ם)? אנוש/i;
/** hCaptcha and Turnstile frames by their names (reCAPTCHA's name is also its corner badge's, so only the DOM probe counts it). */
const CAPTCHA_FRAME = /(?:iframe|frame|document)\b[^\n]{0,20}"[^"\n]*(?:hcaptcha|turnstile|cloudflare security challenge)/i;
/** A field whose name says it takes a password. */
const PASSWORD_FIELD = /(?:textbox|input|field|password)\b[^\n]{0,20}"[^"\n]*(?:password|passcode|passphrase|סיסמ)/i;
/** A field whose name says it takes a one-time or two-step code. */
const CODE_FIELD = /(?:textbox|spinbutton|input|field)\b[^\n]{0,20}"[^"\n]*(?:one-time|verification code|security code|authentication code|2fa|6-digit|enter (?:the )?code|קוד אימות|קוד חד[- ]פעמי|קוד בן)/i;
/** Two-step pages by their heading, together with any field. */
const CODE_PAGE = /2-step verification|two-step verification|two-factor authentication|verify it'?s you|enter the code we sent|אימות דו[- ]שלבי|הזן את הקוד/i;
const ANY_FIELD = /^\s*-?\s*(?:textbox|spinbutton)\b|\binput\b/im;

/**
 * Finds a sign-in, code or robot check on a page, from what the model was given (a snapshot or a read) and, when
 * there is CDP, the DOM's markers. A plain "Sign in" link or button is not a check: only a password or code field, or
 * a robot check, counts.
 *
 * @param page - The page as text, and the DOM markers when they were read.
 * @returns The check, or `undefined` for a normal page.
 */
export function detectSignIn(page: { text: string; markers?: SignInMarkers | undefined }): SignInWall | undefined {
  const { text, markers } = page;
  if (markers?.captcha || CAPTCHA_TEXT.test(text) || CAPTCHA_FRAME.test(text)) return "captcha";
  if (markers?.otp || CODE_FIELD.test(text) || (CODE_PAGE.test(text) && ANY_FIELD.test(text))) return "code";
  if (markers?.password || PASSWORD_FIELD.test(text)) return "login";
  return undefined;
}

/**
 * Whether a field (its snapshot or read label, e.g. `textbox "Password"`) takes a password or a one-time code, so
 * browser_type refuses it before anything is typed.
 *
 * @param label - The field's label from the last read of the tab.
 * @returns `login` for a password field, `code` for a code field, else `undefined`.
 */
export function secretFieldKind(label: string | undefined): Extract<SignInWall, "login" | "code"> | undefined {
  if (!label) return undefined;
  if (PASSWORD_FIELD.test(label) || /^password\b/i.test(label)) return "login";
  if (CODE_FIELD.test(label)) return "code";
  return undefined;
}

/** Thrown by browser_type (and CdpPage.type) for a password or code field: the sign-in card takes over. */
export class SecretFieldError extends Error {
  /**
   * @param wall - `login` for a password field, `code` for a code field.
   */
  constructor(readonly wall: Extract<SignInWall, "login" | "code">) {
    super(`Refused: this is a ${wall === "login" ? "password" : "one-time code"} field. KesherAI never types passwords or codes; the user signs in themselves.`);
    this.name = "SecretFieldError";
  }
}

const WHAT: Record<SignInWall, string> = {
  login: "a sign-in page (a password field)",
  code: "a one-time or two-step code page",
  captcha: "a robot check (CAPTCHA or \"verify you are human\")",
};

/** Which browser, in words for the model. */
const browserName = (b: SignInInfo["browser"]) => (b === "pane" ? "KesherAI's browser pane" : "the user's Chrome");

/**
 * The tool result when the user cannot be asked now (an unattended run, a helper) or declined: stop and hand over.
 *
 * @param wall - The check.
 * @param site - The site's host.
 * @param browser - Where it is.
 * @param why - `none` (no one to ask), `cancel` (the user chose not to sign in), `timeout`, `still` (Continue, but the
 *   page still asks).
 */
export function handOverMessage(wall: SignInWall, site: string, browser: SignInInfo["browser"], why: "none" | "cancel" | "timeout" | "still"): string {
  const head = `SIGN-IN NEEDED: ${site} shows ${WHAT[wall]} in ${browserName(browser)}. Never type a password, code or CAPTCHA answer yourself, and do not try to get around the check.`;
  switch (why) {
    case "cancel":
      return `${head} The user chose not to sign in now: do not use this form. Go on with what works without signing in, or tell the user what you could not do.`;
    case "timeout":
      return `${head} The user did not sign in within 10 minutes. Stop the browser work, tell the user where you stopped, and ask them to tell you when they have signed in.`;
    case "still":
      return `${head} The user pressed Continue, but the page still asks. Stop and ask the user (one short message) to finish signing in there and tell you when it is done.`;
    default:
      return `${head} Stop here: tell the user to sign in on ${site} in ${browserName(browser)} and to tell you when they are done; then read the page again and go on.`;
  }
}

/** The card's one line, for notifications and the model's log. */
export function signInQuestion(wall: SignInWall, site: string): string {
  return wall === "captcha" ? `${site} asks to check that you are human. Do it on the PC, then press Continue.` : `Sign in to ${site} on the PC, then press Continue.`;
}

/** What {@link resolveSignIn} needs from the browser and the chat. */
export interface SignInDeps {
  /** The tab's DOM markers (undefined without CDP, or when reading them failed). */
  markers(): Promise<SignInMarkers | undefined>;
  /** Reads the page again, as the model sees it (snapshot or read). */
  reread(): Promise<string>;
  /** The tab's address now (for the auto-continue watch). */
  url(): Promise<string | undefined>;
  /** The chat's card (ToolContext.handOver); absent when no one can answer. */
  handOver: ((question: string, info: SignInInfo, watch?: (signal: AbortSignal) => Promise<boolean>) => Promise<string>) | undefined;
  browser: SignInInfo["browser"];
  /** How often the watch reads the address (default 3 s; tests pass less). */
  pollMs?: number;
}

/** The address of a page given to the model: the second line of a read or snapshot ("title\nurl\n"). */
export function pageUrlOf(output: string): string | undefined {
  return /(?:^|\n)(https?:\/\/\S+)\n/.exec(output)?.[1];
}

/** Origin and path: query and fragment change during a sign-in without the page moving on. */
const pageKey = (url: string | undefined) => {
  try {
    const u = new URL(url ?? "");
    return `${u.origin}${u.pathname}`;
  } catch {
    return url ?? "";
  }
};

/**
 * Watches the tab until it leaves `from` (another origin or path): the user finished signing in.
 *
 * @param url - Reads the tab's address.
 * @param from - The sign-in page's address.
 * @param signal - Ends the watch (the card was answered).
 * @param pollMs - How often.
 * @returns `true` when the page moved on, `false` when the watch was ended.
 */
export async function watchLeave(url: () => Promise<string | undefined>, from: string, signal: AbortSignal, pollMs = 3000): Promise<boolean> {
  const start = pageKey(from);
  while (!signal.aborted) {
    await new Promise<void>((r) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        r();
      };
      const t = setTimeout(done, pollMs);
      signal.addEventListener("abort", done, { once: true });
    });
    if (signal.aborted) return false;
    const now = await url().catch(() => undefined);
    if (now && pageKey(now) !== start) return true;
  }
  return false;
}

/**
 * Checks a browser step's page for a sign-in, code or robot check, and hands it to the user when there is one: the
 * card, then Continue → the page read again (a login followed by a code page shows the card again, up to 3 times).
 *
 * @param output - What the step returned (the page as text).
 * @param deps - The browser and the chat.
 * @param forced - The step itself refused a password or code field (browser_type).
 * @returns What the model sees: the page as it was (no check), the page after signing in, or the hand-over message.
 */
export async function resolveSignIn(output: string, deps: SignInDeps, forced?: SignInWall): Promise<string> {
  let page = output;
  let wall = forced;
  for (let round = 0; round < 3; round++) {
    if (!wall) wall = detectSignIn({ text: page, markers: await deps.markers().catch(() => undefined) });
    if (!wall) return round ? `The user finished signing in; the page now:\n${page}` : page;
    const url = pageUrlOf(page) ?? (await deps.url().catch(() => undefined)) ?? "";
    const site = hostOf(url) ?? "the site";
    if (!deps.handOver) return `${page}\n\n${handOverMessage(wall, site, deps.browser, "none")}`;
    const answer = await deps.handOver(signInQuestion(wall, site), { wall, site, browser: deps.browser }, url ? (s) => watchLeave(deps.url, url, s, deps.pollMs) : undefined);
    if (!answer.startsWith("continue")) return handOverMessage(wall, site, deps.browser, answer === "(timed out)" ? "timeout" : "cancel");
    page = await deps.reread();
    wall = undefined;
  }
  const site = hostOf(pageUrlOf(page) ?? "") ?? "the site";
  const still = detectSignIn({ text: page, markers: await deps.markers().catch(() => undefined) });
  return still ? `${page}\n\n${handOverMessage(still, site, deps.browser, "still")}` : `The user finished signing in; the page now:\n${page}`;
}
