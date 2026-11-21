/**
 * Console mode: a full-screen, big-tile home for a handheld or a TV (the ROG Xbox Ally X at 1920×1080 on 7", a Steam
 * Deck's 1280×800, a PC on the TV), driven by the controller as the Xbox full-screen experience and Steam Big Picture
 * are. This file holds the parts without a page: the tiles, moving on the tile grid, the mode's on/off switch (kept
 * per device), the View+Menu hold that switches it, and the game helper's questions. The page is
 * pages/ConsoleMode.tsx.
 */

/** One tile of the console home. */
export interface ConsoleTile {
  id: "chat" | "voice" | "game" | "images" | "models" | "remote" | "settings";
  /** A LineIcon name (ui/glyphs.ts). */
  icon: string;
  he: string;
  en: string;
  /** The page it opens; the voice and game tiles act instead (see ConsoleMode.tsx). */
  href?: string;
}

/** The tiles in reading order (the grid mirrors itself in Hebrew). */
export const CONSOLE_TILES: readonly ConsoleTile[] = [
  { id: "chat", icon: "chat", he: "צ'אט חדש", en: "New chat", href: "#/" },
  { id: "voice", icon: "speaker", he: "דיבור", en: "Voice" },
  { id: "game", icon: "gamepad", he: "עוזר משחק", en: "Game helper", href: "#/console/game" },
  { id: "images", icon: "image", he: "תמונות", en: "Images", href: "#/images" },
  { id: "models", icon: "box", he: "מודלים", en: "Models", href: "#/models" },
  { id: "remote", icon: "monitor", he: "מחשב ושלט רחוק", en: "Remote / PC", href: "#/remote" },
  { id: "settings", icon: "gear", he: "הגדרות", en: "Settings", href: "#/settings" },
];

/** A direction on the D-pad or stick. */
export type PadDir = "up" | "down" | "left" | "right";

/**
 * How many tile columns fit a screen width (CSS pixels): four on a handheld or a TV, three on a small window, two on
 * a phone (remote).
 *
 * @param width - The window's width.
 * @returns The number of columns.
 */
export function gridCols(width: number): number {
  return width >= 1000 ? 4 : width >= 640 ? 3 : 2;
}

/**
 * Where the focus goes on the tile grid. Index -1 is the "continue" card above the grid (when there is one): up from
 * the first row reaches it, down from it goes to the first tile. Left and right stay in their row (no wrapping to the
 * next row, as on Xbox); in a right-to-left layout they swap, since the grid's first tile is on the right. Down from a
 * column the last row does not reach goes to the last tile; at an edge the focus stays.
 *
 * @param at - The focused index (-1: the continue card).
 * @param count - How many tiles.
 * @param cols - Columns in the grid.
 * @param dir - Where to go.
 * @param opts.rtl - The layout reads right to left.
 * @param opts.header - A continue card is above the grid.
 * @returns The new index.
 */
export function gridMove(at: number, count: number, cols: number, dir: PadDir, opts: { rtl?: boolean; header?: boolean } = {}): number {
  if (count <= 0) return opts.header ? -1 : 0;
  if (at < 0) return opts.header && dir !== "down" ? -1 : 0;
  const i = Math.min(at, count - 1);
  const c = Math.max(1, cols);
  const row = Math.floor(i / c);
  const col = i % c;
  const lastRow = Math.floor((count - 1) / c);
  const horizontal = opts.rtl ? (dir === "left" ? "right" : dir === "right" ? "left" : dir) : dir;
  switch (horizontal) {
    case "left":
      return col > 0 ? i - 1 : i;
    case "right":
      return col < c - 1 && i + 1 < count ? i + 1 : i;
    case "up":
      return row > 0 ? i - c : opts.header ? -1 : i;
    case "down":
      return row < lastRow ? Math.min(i + c, count - 1) : i;
  }
  return i;
}

const KEY = "kesher.console";
const OFFERED = "kesher.console.offered";

/** Whether console mode is on on this device (remembered in the browser, so the phone and the PC each have their own). */
export function consoleOn(store: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  try {
    return store?.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * Turns console mode on or off on this device.
 *
 * @param on - The new state.
 * @param store - Where it is kept (localStorage by default).
 */
export function setConsoleOn(on: boolean, store: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    store?.setItem(KEY, on ? "on" : "off");
  } catch {
    /* for this visit only */
  }
}

/**
 * Whether to offer console mode once: a handheld was found, the mode is not on, and this handheld was not offered it
 * before (saying "Not now" is remembered too).
 *
 * @param handheld - The handheld's name from /api/system/device, or "".
 * @param store - Where the answers are kept.
 * @returns True to show the offer.
 */
export function shouldOfferConsole(handheld: string, store: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  if (!handheld) return false;
  try {
    return store?.getItem(KEY) !== "on" && store?.getItem(OFFERED) !== handheld;
  } catch {
    return false;
  }
}

/**
 * Remembers that this handheld was offered console mode.
 *
 * @param handheld - The handheld's name.
 * @param store - Where it is kept.
 */
export function markConsoleOffered(handheld: string, store: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    store?.setItem(OFFERED, handheld);
  } catch {
    /* offered again next time */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** How long View and Menu must be held together to switch console mode (Steam's chords are under a second). */
export const COMBO_HOLD_MS = 800;

/** The View+Menu hold, between controller frames. */
export interface ComboState {
  /** When both buttons went down together (undefined: not both held). */
  since?: number;
  /** The switch already fired in this hold (it fires once until both are let go). */
  fired: boolean;
  /** Both were held together in this press, so letting go of View or Menu does not also do its own action. */
  used: boolean;
}

/** The starting state. */
export const COMBO_IDLE: ComboState = { fired: false, used: false };

/**
 * One controller frame of the View+Menu hold.
 *
 * @param s - The state from the last frame.
 * @param view - View (⧉) is down.
 * @param menu - Menu (≡) is down.
 * @param now - The frame's time in ms.
 * @returns The next state, and `toggle` true on the one frame the hold completes.
 */
export function comboStep(s: ComboState, view: boolean, menu: boolean, now: number): ComboState & { toggle: boolean } {
  if (view && menu) {
    const since = s.since ?? now;
    const toggle = !s.fired && now - since >= COMBO_HOLD_MS;
    return { since, fired: s.fired || toggle, used: true, toggle };
  }
  // One still held: the press stays "used" until both are up, so neither button acts alone afterwards.
  if (view || menu) return { fired: s.fired, used: s.used, toggle: false };
  return { fired: false, used: false, toggle: false };
}

/** What the game helper can be asked with one button. */
export type GameAsk = "tip" | "guide" | "shot";

/**
 * The question a game helper button sends to the game's chat. Tips are short and spoiler-free; the guide comes from the
 * web, with spoilers wrapped in `||…||` so the answer shows them behind a button (RichText draws them hidden).
 *
 * @param kind - Which button.
 * @param game - The game's name ("" when none was found).
 * @param he - Write the question in Hebrew.
 * @returns The text, and whether it searches the web.
 */
export function gamePrompt(kind: GameAsk, game: string, he: boolean): { text: string; web: boolean } {
  const name = game.trim().slice(0, 80);
  const spoilers = he
    ? "כל ספוילר (עלילה, פתרון חידה, בוס) לעטוף ב-||כך|| כדי שיישאר מוסתר."
    : "Wrap every spoiler (story, puzzle solution, boss) in ||like this|| so it stays hidden.";
  if (kind === "tip") {
    return {
      text: he
        ? `${name ? `אני משחק ב-${name}. ` : ""}תן 3 טיפים קצרים למקום שבו אני נמצא, בלי ספוילרים. עד 60 מילים.`
        : `${name ? `I'm playing ${name}. ` : ""}Give me 3 short tips for where I am now, no spoilers. At most 60 words.`,
      web: false,
    };
  }
  if (kind === "shot") {
    return {
      text: he
        ? `${name ? `אני משחק ב-${name}. ` : ""}לפי התמונה, מה עליי לעשות עכשיו? צעדים קצרים. ${spoilers}`
        : `${name ? `I'm playing ${name}. ` : ""}From the picture, what should I do now? Short steps. ${spoilers}`,
      web: false,
    };
  }
  return {
    text: he
      ? `חפש מדריך ל-${name || "המשחק שלי"} למקום שבו אני נמצא וסכם את הצעדים בקצרה, עם מקורות. ${spoilers}`
      : `Search for a ${name || "game"} guide for where I am and sum up the steps briefly, with sources. ${spoilers}`,
    web: true,
  };
}
