/**
 * "Draw a change" (Game projects and the phone's screen view): the chat message that carries a marked-up picture of
 * the running game or editor to the engine. Kept apart from the page so it can be tested.
 *
 * The message is written for the model: the engine's name in Latin letters (the chat's tool routing loads that
 * engine's tools by it, chat-tool-groups.ts), the project line the chat's project button makes, the picture's
 * attachment line, the numbered notes, and what to do: change it in the editor with that engine's tools, one change
 * per approval (the approval card shows the scene diff), never a change the picture does not ask for.
 */

/** The engines a change request can go to. */
export type ChangeEngine = "unity" | "unreal" | "godot";

/** What the message is made from. */
export interface ChangeRequest {
  engine: ChangeEngine;
  /** The project's name. */
  name: string;
  /** The line /api/conversations/:id/project gave for the project ("[Unity project: …]"). */
  projectLine: string;
  /** The picture's attachment line ("[Attached: …png]"). */
  imageLine: string;
  /** The numbered pins' notes from the Annotator ("1: move this here"). */
  notes: string[];
  /** What the user wrote about the change (may be empty). */
  text: string;
  /** Where the picture came from: the engine's own view, or the computer's screen. */
  source?: "engine" | "screen" | "photo";
}

/** Each engine's name and its tools' prefix. */
const ENGINES: Record<ChangeEngine, { label: string; tools: string }> = {
  unity: { label: "Unity", tools: "unity_" },
  unreal: { label: "Unreal", tools: "unreal_" },
  godot: { label: "Godot", tools: "godot_" },
};

/** The longest user text and note kept (the picture carries the rest). */
const MAX_TEXT = 2000;
const MAX_NOTE = 300;

/**
 * The change request's message.
 *
 * @param r - The project, the picture's line, the notes and the user's words.
 * @returns The text to send to the chat.
 */
export function changeRequestText(r: ChangeRequest): string {
  const e = ENGINES[r.engine];
  const notes = r.notes.map((n) => n.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE)).filter(Boolean).slice(0, 30);
  const text = r.text.trim().slice(0, MAX_TEXT);
  const from = r.source === "screen" ? "the computer's screen" : r.source === "photo" ? "a photo" : `the ${e.label} view`;
  return [
    `Change request for the ${e.label} project "${r.name}", drawn on a screenshot of ${from}.`,
    r.projectLine,
    r.imageLine,
    ...(text ? ["", "What I want:", text] : []),
    ...(notes.length ? ["", "The marks on the screenshot:", ...notes] : []),
    "",
    `Look at the screenshot first (the arrows, circles, boxes and numbered pins show where). Then make the change in the ${e.label} editor with the ${e.tools}* tools: find the objects the marks point at, and change only what is asked. One change per step, so I can approve each one and see the scene change in the approval card. If a mark is unclear, ask me before changing anything. At the end, take a new screenshot of the same view so I can compare.`,
  ].join("\n");
}
