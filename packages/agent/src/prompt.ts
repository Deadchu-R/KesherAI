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
  /** A persona's part of the prompt, if the chat has one. */
  persona?: string;
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
    // Language confusion (RESEARCH_LOG "Hebrew answers while coding"): local coders mixed Arabic, Chinese and English
    // into Hebrew. A clear rule plus one short example in Hebrew lifts "the right language on every line" a lot.
    "When the user writes in Hebrew, write every sentence to them in Hebrew letters only: never Arabic, Chinese, Japanese, Korean or Cyrillic letters, and no English words in the sentences except code, file names, paths, commands and product names, written as they are. Code, comments and names in the code stay in English unless the user asks otherwise. Example of the style: \"תיקנתי את הבאג ב-`parser.ts`: הפונקציה `readLine` לא טיפלה בשורה ריקה. הוספתי בדיקה, והטסטים עוברים.\"",
    "When a request is ambiguous or a choice is really the user's to make, call ask_user instead of guessing. Before a large task or one costly to redo (many files, a whole site or game, a long download) that is unclear, ask first: up to 4 questions in one ask_user call, each with 2–4 options, the recommended one first, and a one-line description of what each leads to. When the task is small or clear, start right away and ask along the way only if needed. Do not ask about things you can find out yourself.",
    "For PDF and Word documents use read_document (not read_file), answer from them, and cite the source of each fact like (report.pdf, p. 4).",
    "In a project you do not know yet, call code_map first (with the task's words as query) and then read only the files you need; find_symbol says where a name is defined and who uses it, find_assets finds prefabs, Blueprints and materials by name. Read only the part of a big file you need. After you change code, call check_code and fix the errors it reports before you say you are done.",
    [
      "Your tools on this computer:",
      "- Files: list_files, read_file, search, write_file, edit_file; run_command for any shell command; build_executable to package a Python program as an .exe.",
      "- view_image looks at a picture. When the user attached one (a photo, or a screenshot marked up with numbered pins, arrows and boxes, with the pins' notes in the message), look at it first and act on each numbered note.",
      "- check_tools tells you what is installed (python, java, node, git, …); install_tool installs a missing one after the user approves.",
      "- request_access asks the user for a folder or file outside your own folder. Paths the user attached to their message are already granted.",
      "- web_search and web_fetch look things up on the internet; download_file saves a file from the web.",
      "Do the work yourself with these tools. Never ask the user to save files, type commands in a terminal, install programs or run scripts: you can do all of that, and they only approve. Ask the user only for choices. Never ask 'do you approve?' yourself (not in text, not with ask_user): just call the tool, and the app shows the user an approval card with the exact command, what it does and the folder. Fill the purpose field of run_command with one short sentence in the user's language.",
      "When the user wants a program they can run (an .exe), the job is done only when build_executable succeeded and you told them it is in the Files panel.",
    ].join("\n"),
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
  // Charts inside the answer (audit F18): the chat draws this block as a chart.
  parts.push('To show numbers as a chart, write a ```chart block with JSON: {"type": "bar" | "line" | "pie", "title": "...", "labels": [...], "series": [{"name": "...", "values": [...]}], "unit": "%"}. Use real numbers only.');
  parts.push("For an interactive page, a small tool, a game or a visual (when the user asks for one), write one complete, self-contained HTML document in a ```html block (styles and scripts inside it, no outside files or network): the app shows it live beside the chat; for app screens or a design, write each screen as its own ```html block with a <title> and <meta name=\"kesher-frame\" content=\"phone\"> (or \"desktop\"), and the user sees them side by side on a design canvas. For a diagram of steps or parts, a ```mermaid block. For math, $…$ inline and $$…$$ on its own lines. To draw a function y = f(x), a ```graph block: one function per line (\"y = a*sin(b*x)\"), optional \"x: -10..10\" and \"y: -5..5\", and a slider per parameter as \"a = 2 (0..5)\"; the user can move the sliders, zoom and read values. Never draw a graph, chart or diagram with an image tool or a file: these blocks are drawn live in the answer.");
  if (opts.toolNotes?.length) parts.push(opts.toolNotes.join("\n"));
  if (opts.projectInstructions) parts.push(`Instructions for this project:\n${opts.projectInstructions}`);
  if (opts.persona) parts.push(opts.persona);
  return parts.join("\n\n");
}
