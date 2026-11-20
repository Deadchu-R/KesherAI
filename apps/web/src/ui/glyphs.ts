/**
 * KesherAI's own line icons, as data (no React here, so tests can read them): 24 × 24 paths drawn for this app with
 * one stroke width and round ends, and which emoji or page each stands for. `Glyph.tsx` draws them.
 */

/** A cog with 8 teeth, worked out once (a hand-written path would be long and uneven). */
const GEAR = (() => {
  const pts: string[] = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / (teeth * 4);
    const r = i % 4 < 2 ? 9 : 7;
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
const rect = (x: number, y: number, w: number, h: number, r = 2) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

/** The drawings, by name. Each is one or more path strings. */
export const GLYPHS: Record<string, string[]> = {
  plus: ["M12 5v14M5 12h14"],
  code: ["M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5"],
  grid: [rect(4, 4, 6.5, 6.5, 1.5), rect(13.5, 4, 6.5, 6.5, 1.5), rect(4, 13.5, 6.5, 6.5, 1.5), rect(13.5, 13.5, 6.5, 6.5, 1.5)],
  image: [rect(3.5, 5, 17, 14), circle(9, 10, 1.6), "m20.5 15.5-4.5-4.5-8.5 8"],
  stack: [rect(3.5, 10, 17, 10), "M6 6.5h12M8.5 3.5h7"],
  nodes: [rect(3.5, 3.5, 7, 7, 1.6), rect(13.5, 13.5, 7, 7, 1.6), "M10.5 7h3.5a3 3 0 0 1 3 3v3.5"],
  gamepad: ["M7 8.5h10a4.5 4.5 0 0 1 4.5 4.5v1.2a2.8 2.8 0 0 1-5 1.7L15 14H9l-1.5 1.9a2.8 2.8 0 0 1-5-1.7V13A4.5 4.5 0 0 1 7 8.5z", "M8 10.8v3.4M6.3 12.5h3.4", circle(15.6, 11.6, 0.6), circle(17.6, 13.4, 0.6)],
  joystick: [circle(12, 6.5, 2.8), "M12 9.3V16", rect(5, 16, 14, 4.5, 1.8)],
  dumbbell: ["M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"],
  page: ["M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z", "M14 3.5V8h4.5M9 12.5h6M9 16h4"],
  book: ["M3.5 5.5H9a3 3 0 0 1 3 3v11a2.3 2.3 0 0 0-2.3-2.3H3.5z", "M20.5 5.5H15a3 3 0 0 0-3 3v11a2.3 2.3 0 0 1 2.3-2.3h6.2z"],
  library: [rect(4, 4, 4, 16, 1), rect(10, 4, 4, 16, 1), "m15.8 5.2 3-.8 3.4 14.8-3 .7z"],
  calendar: [rect(3.5, 5, 17, 15.5), "M3.5 10h17M8 3v4M16 3v4"],
  compare: [rect(3.5, 4.5, 17, 15), "M12 4.5v15"],
  flow: [circle(6, 6, 2.5), circle(18, 18, 2.5), "M8.5 6H15a3 3 0 0 1 3 3v6.5"],
  monitor: [rect(3, 4, 18, 12), "M8.5 20h7M12 16v4"],
  bell: ["M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z", "M10 21a2.2 2.2 0 0 0 4 0"],
  bot: [rect(4.5, 8, 15, 11.5, 3), "M12 4.8V8", circle(12, 3.6, 1.2), circle(9.2, 13.5, 0.5), circle(14.8, 13.5, 0.5)],
  person: [circle(12, 8, 3.8), "M4.5 20.5a7.5 7.5 0 0 1 15 0"],
  layers: ["m12 3.5 8.5 4.5-8.5 4.5L3.5 8z", "m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5"],
  chat: ["M4 5.5h16v11H9.5L4 20.5z"],
  people: [circle(9, 8, 3.3), "M2.8 20a6.2 6.2 0 0 1 12.4 0M15.8 4.8a3.3 3.3 0 0 1 0 6.4M17.6 14.2a6 6 0 0 1 3.6 5.8"],
  chart: ["M4 20h16M7 20v-7M12 20V5M17 20v-10"],
  box: ["m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z", "M4 7.2 12 11.4l8-4.2M12 11.4V21"],
  plug: ["M9 3.5V8M15 3.5V8M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5v4"],
  puzzle: ["M9.5 4.5a2.5 2.5 0 0 1 5 0V6h4.5v4.5h-1.5a2.5 2.5 0 0 0 0 5H19V20H5v-4.5h1.5a2.5 2.5 0 0 0 0-5H5V6h4.5z"],
  sliders: ["M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1", circle(15, 6.5, 2), circle(9, 12, 2), circle(17, 17.5, 2)],
  pulse: ["M3 12h4l2.5-6 5 12 2.5-6H21"],
  phone: [rect(7, 2.5, 10, 19, 2.2), "M11 18h2"],
  upload: [circle(12, 12, 8.5), "M12 16V8.5M8.8 11.5 12 8.3l3.2 3.2"],
  download: ["M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"],
  gear: [GEAR, circle(12, 12, 3)],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  palette: ["M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.8 2-1.8 0-1.5-1.5-1.7-1.5-3.2 0-1 .8-1.5 1.8-1.5H17a3.5 3.5 0 0 0 3.5-3.5c0-3.9-3.8-7-8.5-7z", circle(7.8, 11, 0.6), circle(10.5, 7.5, 0.6), circle(15, 8, 0.6)],
  pencil: ["M15.5 4.5 19.5 8.5 8.5 19.5H4.5v-4z", "M13 7l4 4"],
  trash: ["M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 11v5.5M13.5 11v5.5"],
  shield: ["M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z"],
  paperclip: ["m19 11.5-7 7a4.5 4.5 0 0 1-6.4-6.4l7.5-7.5a3 3 0 0 1 4.2 4.2l-7.4 7.4a1.5 1.5 0 0 1-2.1-2.1l6.7-6.7"],
  globe: [circle(12, 12, 8.5), "M3.5 12h17M12 3.5c2.5 2.4 3.5 5.2 3.5 8.5s-1 6.1-3.5 8.5c-2.5-2.4-3.5-5.2-3.5-8.5s1-6.1 3.5-8.5z"],
  refresh: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9", "M19.5 4v5h-5"],
  sparkle: ["M12 3.5c.6 4.4 2.1 5.9 6.5 6.5-4.4.6-5.9 2.1-6.5 6.5-.6-4.4-2.1-5.9-6.5-6.5 4.4-.6 5.9-2.1 6.5-6.5z", "M18.5 15.5c.3 1.8.9 2.4 2.5 2.7-1.6.3-2.2.9-2.5 2.6-.3-1.7-.9-2.3-2.5-2.6 1.6-.3 2.2-.9 2.5-2.7z"],
  star: ["m12 4 2.4 5 5.4.7-4 3.7 1 5.4L12 16.2l-4.8 2.6 1-5.4-4-3.7 5.4-.7z"],
  camera: ["M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", circle(12, 13, 3.3)],
  wrench: ["M15 4.5a4.5 4.5 0 0 0-4.3 5.8l-5.9 5.9a2.1 2.1 0 0 0 3 3l5.9-5.9A4.5 4.5 0 0 0 19.5 9l-2.8 2.8-3-.5-.5-3z"],
  scroll: ["M7 4.5h10.5v13a2.5 2.5 0 0 1-2.5 2.5H6.5", "M7 4.5A2.5 2.5 0 0 0 4.5 7v1.5H7M6.5 20A2.5 2.5 0 0 0 9 17.5V7M10.5 9h4M10.5 12.5h4"],
  cap: ["M2.5 9 12 4.5 21.5 9 12 13.5z", "M6.5 11v4.5c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8V11", "M21.5 9v5"],
  clipboard: [rect(5.5, 5, 13, 16), rect(9, 3, 6, 4, 1.2), "M9 12h6M9 15.5h4"],
  building: ["M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v15.5M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5M3.5 20.5h17M8.5 7.5h3M8.5 11h3M8.5 14.5h3"],
  moon: ["M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"],
  cloud: ["M7.5 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.5 3.8 3.8 0 0 1-.8 7.5z"],
  play: ["M8 5.5v13l10.5-6.5z"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  close: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
  swap: ["M4 8.5h14l-3.5-3.5M20 15.5H6l3.5 3.5"],
  microscope: ["M9 3.5h4l-.5 8h-3z", "M7 20.5h11M10.5 11.5v3a4 4 0 0 0 4 4h0a5.5 5.5 0 0 0 1.5-10.8"],
  crayon: ["m16 3.5 4.5 4.5-10 10H6v-4.5z", "M4 20.5h7"],
  half: [circle(12, 12, 8.5), "M12 3.5v17"],
  branch: [circle(6, 5.5, 2.2), circle(6, 18.5, 2.2), circle(18, 8, 2.2), "M6 7.7v8.6M18 10.2c0 4.3-5 4.8-10.4 6.6"],
  speaker: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"],
  stop: [rect(6.5, 6.5, 11, 11, 2)],
  keyboard: [rect(2.5, 6, 19, 12, 2), "M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M18 13.5h.01M8.5 14.5h7"],
};

/** Emoji and signs used across the app, and the drawing that stands for each. */
const FROM_TEXT: Record<string, string> = {
  "+": "plus", "＋": "plus", "</>": "code", "▦": "grid", "⚙": "gear", "⚙️": "gear", "🔗": "link", "🎮": "gamepad", "🕹": "joystick", "🧠": "layers",
  "📁": "folder", "💬": "chat", "🎨": "palette", "✏": "pencil", "✏️": "pencil", "✎": "pencil", "🤖": "bot", "🛡": "shield", "🛡️": "shield", "🗑": "trash", "🗑️": "trash",
  "🖥": "monitor", "🖥️": "monitor", "📎": "paperclip", "🌐": "globe", "⬇": "download", "⟳": "refresh", "↻": "refresh", "🧩": "nodes", "🖍": "crayon", "🔬": "microscope",
  "🔧": "wrench", "🔔": "bell", "🔌": "plug", "📷": "camera", "📱": "phone", "📲": "phone", "📦": "box", "📜": "scroll", "📚": "book", "📋": "clipboard", "📄": "page", "📝": "page", "📑": "chart", "🔍": "microscope",
  "🏢": "building", "🌙": "moon", "⭐": "star", "✨": "sparkle", "✦": "sparkle", "✕": "close", "✅": "check", "☁": "cloud", "☁️": "cloud", "◐": "half", "▶": "play", "⇄": "swap", "⌨": "keyboard", "⑂": "branch", "🔊": "speaker", "■": "stop", "⌨️": "keyboard",
  "🖼": "image", "🖼️": "image", "🗂": "stack", "🗂️": "stack", "🏋": "dumbbell", "🏋️": "dumbbell", "📅": "calendar", "⚖": "compare", "⚖️": "compare", "⛓": "flow", "⛓️": "flow",
  "🎭": "person", "👥": "people", "📊": "chart", "🧷": "puzzle", "🎛": "sliders", "🎛️": "sliders", "🩺": "pulse", "🎓": "cap", "⬆": "upload",
};

/** Pages whose drawing differs from their emoji's (the menu has two 📦, "Libraries" and "Models"). */
const FROM_PAGE: Record<string, string> = { "#/libraries": "library", "#/models": "box", "#/self-work": "bot", "#/memory": "layers", "#/task-inbox": "download", "#/games": "gamepad" };

/**
 * The drawing's name for an icon, if there is one.
 *
 * @param icon - An emoji or sign ("🖼", "+").
 * @param href - The page it stands for, when known (it wins).
 */
export function glyphName(icon: unknown, href?: string): string | undefined {
  if (href && FROM_PAGE[href]) return FROM_PAGE[href];
  return typeof icon === "string" ? FROM_TEXT[icon.trim()] : undefined;
}
