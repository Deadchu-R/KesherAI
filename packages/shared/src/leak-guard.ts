/**
 * The leak guard (Roee, 2026-11-23): finds sensitive things in text before it goes to a model service that may train on
 * it (training-risk.ts), and hides them behind typed placeholders such as `[key hidden]`. Pure functions, used by the
 * server's model turn (every chat, agent, helper and task inbox run) and by the chat's "sensitive info found" dialog.
 *
 * What it finds, in the order of the secret scanners (GitGuardian, gitleaks) and Presidio:
 * - private key blocks, then keys and tokens by their known prefixes (`ghp_`, `sk-`, `AKIA`, `AIza`, `xox*`, `hf_`, ...);
 * - values of secret-named settings (`API_KEY=…`, `password: "…"`, `.env` lines), and passwords inside URLs;
 * - long random-looking tokens (upper and lower case and digits, high entropy);
 * - email addresses, phone numbers, ID numbers (Israeli ID with its check digit beside an "ID" word; US SSN), card
 *   numbers (Luhn);
 * - this computer's home folder and user name inside paths, and any `C:\Users\<name>`, `/home/<name>`, `/Users/<name>`;
 * - the words, files and folders on the user's own "never send" list.
 *
 * Ordinary code does not match: `const key = "id"`, `token = getToken()`, `maxTokens = 4096` and git hashes stay as they are.
 */

/** What kind of sensitive thing a hit is. */
export type LeakKind = "private-key" | "key" | "password" | "email" | "phone" | "id-number" | "card" | "path" | "user" | "never-send";

/** One sensitive span in a text (offsets in UTF-16 code units, end exclusive). The text itself is never kept. */
export interface LeakHit {
  kind: LeakKind;
  start: number;
  end: number;
}

/** What the guard knows about this user and computer. */
export interface LeakContext {
  /** This computer's user name (found inside paths only: a bare word can be anyone's name). */
  username?: string;
  /** This computer's home folder. */
  home?: string;
  /** The user's own "never send" list: words, file names or folders (case-insensitive). */
  neverSend?: readonly string[];
  /** `win32` makes path matching case-insensitive. Default: this process's platform (in a browser: not Windows). */
  platform?: string;
}

/** What to do when a request to a service that may train holds a hit (Settings › Privacy). */
export type PrivacyMode = "ask" | "auto-hide" | "block-training-providers";

/** The modes, the default first. */
export const PRIVACY_MODES: readonly PrivacyMode[] = ["ask", "auto-hide", "block-training-providers"];

/** The placeholder each kind is replaced with. */
export const LEAK_PLACEHOLDER: Readonly<Record<LeakKind, string>> = {
  "private-key": "[private key hidden]",
  key: "[key hidden]",
  password: "[password hidden]",
  email: "[email hidden]",
  phone: "[phone hidden]",
  "id-number": "[ID hidden]",
  card: "[card hidden]",
  path: "[home hidden]",
  user: "[user hidden]",
  "never-send": "[hidden]",
};

/** Each kind's name for people, in Hebrew and English (the dialog and logs). */
export const LEAK_LABEL: Readonly<Record<LeakKind, { he: string; en: string }>> = {
  "private-key": { he: "מפתח פרטי", en: "private key" },
  key: { he: "מפתח או טוקן", en: "key or token" },
  password: { he: "סיסמה", en: "password" },
  email: { he: "כתובת מייל", en: "email address" },
  phone: { he: "מספר טלפון", en: "phone number" },
  "id-number": { he: "מספר זהות", en: "ID number" },
  card: { he: "מספר כרטיס אשראי", en: "card number" },
  path: { he: "תיקיית המשתמש", en: "your user folder" },
  user: { he: "שם המשתמש במחשב", en: "your computer user name" },
  "never-send": { he: "פריט מרשימת 'לעולם לא לשלוח'", en: "an item on your never-send list" },
};

/** Any guard placeholder (to count them, and to stop an agent writing them into a file). */
const PLACEHOLDER_RE = /\[(?:(?:private key|key|password|email|phone|ID|card|home|user) )?hidden\]/g;

/** Keys and tokens by their known shapes. */
const KEY_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-|or-v1-|svcacct-)?[A-Za-z0-9_-]{24,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g,
  /\bxai-[A-Za-z0-9]{40,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{40,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // A Telegram bot token: `<bot id>:<35 characters>`.
  /(?<![\w:])\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/g,
];

/** A setting's name that holds a secret (its last word): `API_KEY`, `password`, `clientSecret`, `GITHUB_TOKEN`. */
const SECRET_NAME = /(pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credentials?)$/i;
const PASSWORD_NAME = /(pass(?:word|wd|phrase)?|pwd)$/i;
/** `name = value` / `name: "value"` / `"name": "value"` (the value is hit, never the name). */
const ASSIGN_RE = /(["']?)([A-Za-z_][\w-]*)\1[ \t]*(:|=)[ \t]*(["'`]?)([^\s"'`,;]+)\4/g;
/** Values that are not a secret: placeholders, references and plain words for empty. */
const NOT_SECRET = /^(<[^>]*>|\$\{?[\w.:-]+\}?|%\w+%|\{\{.*\}\}|x{3,}|\*+|\.{3,}|your[\w-]*|changeme|example[\w-]*|placeholder|null|undefined|none|true|false|redacted|dummy|string|number|boolean|process\.env\.\w+|\[[^\]]*hidden\])$/i;
/** A password inside a URL: `scheme://user:password@host` (only the password is hit). */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi;
/** A long token that may be random (checked for mixed characters and entropy). */
const LONG_TOKEN = /(?<![\w+/=-])[A-Za-z0-9+_-]{32,128}={0,2}(?![\w+/=-])/g;

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
/** Addresses that are fine (examples, no-reply, git remotes). */
const OK_EMAIL = /^(git@|noreply@|no-reply@)|@(example\.(com|org|net)|users\.noreply\.github\.com|noreply\.invalid|kesher\.invalid|localhost|test)$/i;
const FILE_TLD = /\.(png|jpe?g|gif|svg|webp|js|ts|tsx|css|json|md)$/i;

const PHONE_RES: readonly RegExp[] = [
  /(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g,
  /(?<![\w.])0(?:5\d|7\d|[23489])-?\d{3}-?\d{4}(?![\w.])/g,
  /(?<![\w(])\(\d{3}\) ?\d{3}-\d{4}(?![\w])/g,
];
/** An Israeli ID (9 digits) only beside an "ID" word, in Hebrew or English (case matters: `id: 123…` in code does not count). */
const IL_ID_RE = /(?:ת\.? ?ז\.?|ת"ז|תעודת זהות|מספר זהות|\bID(?: number| No\.?| no\.?)?|[Ii]dentity number|national ID|teudat zehut)[ \t]*[:#-]?[ \t]*(\d{9})(?!\d)/g;
const SSN_RE = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
const CARD_RE = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])/g;

/** User names that are not a person (placeholders and system accounts). */
const OK_USER = /^(public|shared|guest|default|default user|all users|user|username|you|me|name|runner|runneradmin|root|claude|node|app|ubuntu|vscode|codespace|\$\{?\w+\}?|%\w+%|<[^>]+>|\.\.\.|x+|\[user hidden\])$/i;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shannon entropy of a string, in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Whether a digit string passes the Luhn check (card numbers).
 *
 * @param digits - Digits only.
 */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Whether nine digits are a valid Israeli ID (its check digit). */
function israeliId(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = (digits.charCodeAt(i) - 48) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0 && !/^0+$/.test(digits);
}

/** Whether a setting's value looks like a real secret (not a placeholder or code). */
function secretValue(name: string, value: string, quoted: boolean, sep: string): boolean {
  if (NOT_SECRET.test(value) || /^(.)\1*$/.test(value)) return false;
  const password = PASSWORD_NAME.test(name);
  if (!quoted) {
    // `.env` and shell lines (`API_KEY=…`): any value. In code, an unquoted value is usually an expression
    // (`token = getToken()`, `password: string`): only a mix of letters and digits counts.
    if (sep === "=" && /^[A-Z][A-Z0-9_]*$/.test(name)) return value.length >= 6;
    return value.length >= 8 && !/[()[\]{}]/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && !/^[\w$]+\.[\w$.]+$/.test(value);
  }
  if (password) return value.length >= 6;
  return value.length >= 12 && (/\d/.test(value) || entropy(value) >= 3.5);
}

/** The platform to match paths for (case-insensitive on Windows). */
function platformOf(ctx: LeakContext): string | undefined {
  return ctx.platform ?? (globalThis as { process?: { platform?: string } }).process?.platform;
}

/**
 * Finds the sensitive spans in a text. Hits never overlap (the first kind found wins: private keys, keys, settings,
 * then the rest). Only offsets are returned, so a finding can be logged without the secret.
 *
 * @param text - Any text: a message, a file an agent read, a tool's output.
 * @param ctx - This computer's user name and home folder, and the user's "never send" list.
 * @returns The hits, sorted by where they start.
 */
/**
 * Whether a key-shaped string is plainly a made-up one from tests or docs (`sk-test-abc123…`, `ghp_xxxxxxxx…`,
 * `AKIAEXAMPLE…`): a fake/test/example word, a long run of one character, or a counting pattern. Real keys are random,
 * so this never matches one. Used only where a hit would stop an unattended run, never to send a key (25.11: fake keys
 * in KesherAI's own tests moved tasks off the free models).
 *
 * @param s - The key.
 */
export function looksFakeKey(s: string): boolean {
  if (/(fake|dummy|example|sample|placeholder|redacted|not[-_]?a[-_]?real|your[-_]?(api[-_]?)?key|changeme|test[-_]?key|xxxx)/i.test(s)) return true;
  if (/(.)\1{5,}/.test(s)) return true;
  if (/(0123456|123456789|abcdefgh|ABCDEFGH)/.test(s)) return true;
  const body = s.replace(/^[A-Za-z]{2,5}[-_]/, "");
  return body.length >= 16 && entropy(body) < 3;
}

export function findLeaks(text: string, ctx: LeakContext = {}): LeakHit[] {
  if (!text) return [];
  const hits: LeakHit[] = [];
  const add = (kind: LeakKind, start: number, end: number) => {
    if (end > start) hits.push({ kind, start, end });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      fn(m);
      if (m[0] === "") re.lastIndex++;
    }
  };

  each(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, (m) => add("private-key", m.index, m.index + m[0].length));
  for (const re of KEY_PATTERNS) each(re, (m) => add("key", m.index, m.index + m[0].length));
  each(URL_PASSWORD, (m) => {
    const at = m.index + m[0].length - 1 - m[1]!.length;
    if (!NOT_SECRET.test(m[1]!)) add("password", at, at + m[1]!.length);
  });
  each(ASSIGN_RE, (m) => {
    const [, , name, sep, quote, value] = m as unknown as [string, string, string, string, string, string];
    if (!SECRET_NAME.test(name) || !secretValue(name, value, !!quote, sep)) return;
    const end = m.index + m[0].length - quote.length;
    add(PASSWORD_NAME.test(name) ? "password" : "key", end - value.length, end);
  });
  each(LONG_TOKEN, (m) => {
    const tok = m[0];
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    // Integrity hashes and inline pictures are not secrets.
    if (/(sha\d+-|base64,)$/i.test(before) || /^sha\d+-/i.test(tok)) return;
    if (/[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok) && entropy(tok) >= 4.3) add("key", m.index, m.index + tok.length);
  });

  each(EMAIL_RE, (m) => {
    const e = m[0];
    const domain = e.slice(e.indexOf("@") + 1);
    if (!OK_EMAIL.test(e) && !/^\d/.test(domain) && !FILE_TLD.test(e)) add("email", m.index, m.index + e.length);
  });
  for (const re of PHONE_RES) {
    each(re, (m) => {
      const n = m[0].replace(/\D/g, "").length;
      if (n >= 9 && n <= 15) add("phone", m.index, m.index + m[0].length);
    });
  }
  each(IL_ID_RE, (m) => {
    if (israeliId(m[1]!)) add("id-number", m.index + m[0].length - 9, m.index + m[0].length);
  });
  each(SSN_RE, (m) => add("id-number", m.index, m.index + m[0].length));
  each(CARD_RE, (m) => {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    // One kind of separator only (spaces or dashes), a card's first digit (3-6), the Luhn check, not one digit repeated.
    if (/ /.test(raw) && /-/.test(raw)) return;
    if (digits.length < 13 || digits.length > 19 || !/^[3-6]/.test(digits) || /^(\d)\1+$/.test(digits)) return;
    if (luhn(digits)) add("card", m.index, m.index + raw.length);
  });

  // Paths: this computer's home folder, any user folder, and the user name as a folder.
  const win = platformOf(ctx) === "win32";
  const home = ctx.home && ctx.home.length > 3 ? ctx.home.split(/[\\/]+/).filter(Boolean) : undefined;
  if (home?.length) {
    const lead = /^[\\/]/.test(ctx.home!) ? "[\\\\/]+" : "";
    each(new RegExp(`${lead}${home.map(escapeRe).join("[\\\\/]+")}(?![\\w.-])`, win ? "gi" : "g"), (m) => add("path", m.index, m.index + m[0].length));
  }
  each(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/"'`\s<>|:*?]+)/gi, (m) => {
    if (!OK_USER.test(m[1]!)) add("path", m.index, m.index + m[0].length);
  });
  each(/\/(?:home|Users)\/([^/"'`\s<>|:*?]+)/g, (m) => {
    if (!OK_USER.test(m[1]!)) add("path", m.index, m.index + m[0].length);
  });
  if (ctx.username && ctx.username.length >= 2 && !OK_USER.test(ctx.username)) {
    each(new RegExp(`(?<=[\\\\/])${escapeRe(ctx.username)}(?=[\\\\/"'\`\\s]|$)`, win ? "gi" : "g"), (m) => add("user", m.index, m.index + m[0].length));
  }

  // The user's own list: whole words (any language), files and folders with either slash.
  for (const raw of ctx.neverSend ?? []) {
    const item = raw.trim();
    if (item.length < 2) continue;
    const body = item.split(/[\\/]+/).map(escapeRe).join("[\\\\/]+");
    const startB = /^[\p{L}\p{N}_]/u.test(item) ? "(?<![\\p{L}\\p{N}_])" : "";
    const endB = /[\p{L}\p{N}_]$/u.test(item) ? "(?![\\p{L}\\p{N}_])" : "";
    each(new RegExp(`${startB}${body}${endB}`, "giu"), (m) => add("never-send", m.index, m.index + m[0].length));
  }

  // The first found wins where hits overlap (the order above: the more certain kinds first).
  const kept: LeakHit[] = [];
  for (const h of hits) {
    if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Replaces each hit with its placeholder (`[key hidden]`, `[home hidden]`, ...).
 *
 * @param text - The text.
 * @param ctx - As for {@link findLeaks}.
 * @returns The hidden text and the hits that were replaced (offsets in the original text).
 */
export function redactLeaks(text: string, ctx: LeakContext = {}): { text: string; hits: LeakHit[] } {
  const hits = findLeaks(text, ctx);
  if (!hits.length) return { text, hits };
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += text.slice(at, h.start) + LEAK_PLACEHOLDER[h.kind];
    at = h.end;
  }
  return { text: out + text.slice(at), hits };
}

/**
 * How many hits of each kind, most first (for the dialog's chips and log lines).
 *
 * @param hits - Hits from {@link findLeaks}.
 */
export function leakSummary(hits: readonly Pick<LeakHit, "kind">[]): Array<{ kind: LeakKind; count: number }> {
  const m = new Map<LeakKind, number>();
  for (const h of hits) m.set(h.kind, (m.get(h.kind) ?? 0) + 1);
  return [...m].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

/**
 * How many guard placeholders a text holds. An agent that writes more of them into a file than the file had would
 * replace real values with `[key hidden]`: the write tools refuse that.
 *
 * @param text - Any text.
 */
export function countPlaceholders(text: string): number {
  return (text.match(PLACEHOLDER_RE) ?? []).length;
}

/**
 * Reads a privacy mode from settings (anything else: the default, `ask`).
 *
 * @param v - The stored value.
 */
export function privacyModeOf(v: unknown): PrivacyMode {
  return PRIVACY_MODES.includes(v as PrivacyMode) ? (v as PrivacyMode) : "ask";
}
