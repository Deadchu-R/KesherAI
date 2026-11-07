import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";

/** What goes into a system prompt. */
export interface PromptOptions {
  /** Product name, from branding. */
  productName: string;
  /** Project folder, for code conversations. */
  workspace?: string;
  /** A chat's private folder for files it makes for the user. */
  outputsFolder?: string;
  /** The project's own instructions, if any. */
  projectInstructions?: string;
  /** Lines describing extra tools (e.g. which model generate_image uses). */
  toolNotes?: string[];
}

/**
 * Reads `AGENTS.md` (or `CLAUDE.md`, for compatibility) from the project
 * root: the conventional place for instructions to coding agents.
 *
 * @param workspace - Project folder.
 * @returns The file's text, cut to 20 000 characters, or `undefined`.
 */
export async function readProjectGuide(workspace: string): Promise<string | undefined> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(workspace, name), "utf8").catch(() => undefined);
    if (text) return text.slice(0, 20_000);
  }
  return undefined;
}

/**
 * Builds the system prompt for a conversation.
 *
 * @param opts - See {@link PromptOptions}.
 * @returns The prompt text.
 */
export async function buildSystemPrompt(opts: PromptOptions): Promise<string> {
  const os = { win32: "Windows", darwin: "macOS", linux: "Linux" }[platform() as string] ?? platform();
  const parts: string[] = [
    `You are the assistant inside ${opts.productName}, an app that runs AI models on the user's own computer (${os}).`,
    "Answer in the language the user writes in. Be direct and concise.",
    "When a request is ambiguous or a choice is really the user's to make, call ask_user instead of guessing. Do not ask about things you can find out yourself.",
  ];
  if (opts.workspace) {
    parts.push(
      [
        `You are working as a coding agent in the project folder: ${opts.workspace}`,
        "Work like a careful senior engineer:",
        "- Look before you change: list and read the relevant files first.",
        "- Prefer edit_file for small changes; copy old_text exactly from read_file, without line numbers.",
        "- After changing code, run the project's build or tests with run_command when they exist, and fix what fails.",
        "- Keep changes focused on the request. Do not reformat unrelated code.",
        "- If the user wants a program they can run or install (for example a .exe), build it: for Python use build_executable; otherwise use the project's own build or packaging command.",
        "- Some actions need the user's approval. If one is denied, do not repeat it unchanged: adjust, or ask.",
        "- Finish with a short summary of what you changed and anything left to do.",
      ].join("\n"),
    );
    const guide = await readProjectGuide(opts.workspace);
    if (guide) parts.push(`Project instructions from AGENTS.md:\n${guide}`);
  }
  if (opts.outputsFolder) {
    parts.push(
      [
        `You have a private folder for files you make for the user: ${opts.outputsFolder}`,
        "When the user asks you to make something (a program, script, website, document, data file), make real files there with write_file; do not only paste code into the chat.",
        "- Test what you made with run_command when it can run (for example: python calculator.py --help, or a quick check script).",
        "- When the user wants a program they can run or install, such as a .exe, write it in Python (tkinter for windows and buttons, no extra libraries unless needed) and call build_executable. Then say it is ready to download in the Files panel.",
        "- Everything in this folder appears in the conversation's Files panel, where the user can download each file or all of them as a ZIP.",
        "- Commands need the user's approval; writing files in this folder does not.",
      ].join("\n"),
    );
  }
  if (opts.toolNotes?.length) parts.push(opts.toolNotes.join("\n"));
  if (opts.projectInstructions) parts.push(`Instructions for this project:\n${opts.projectInstructions}`);
  return parts.join("\n\n");
}
