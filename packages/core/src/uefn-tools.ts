import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, relative } from "node:path";
import type { AgentTool } from "@kesher/agent";

/**
 * UEFN (Unreal Editor for Fortnite) and Verse from the chat (Roee, 2026-11-16: Verse, and getting ready for UE6, where
 * Epic is bringing Verse to Unreal). A UEFN project lives in Documents\Fortnite Projects\<Project>, its Verse files in
 * Plugins\<Project>\Content. UEFN compiles Verse itself (Verse → Build Verse Code), so the tools read and write the
 * files and the user builds in UEFN. A Blueprint read through the KesherAI Bridge (unreal_read_graph) can be written as
 * a Verse device the same way.
 */

export const VERSE_NOTE =
  "UEFN/Verse: uefn_projects lists the user's UEFN projects; verse_file reads, lists and writes .verse files in a project's Content folder. A device is `my_device := class(creative_device):` with `OnBegin<override>()<suspends>:void=`, `using { /Fortnite.com/Devices }`, `using { /Verse.org/Simulation }`, `using { /UnrealEngine.com/Temporary/Diagnostics }`; four-space indents; failable calls in `if (...)` or `[]`; `@editable` fields for devices placed in the level. To turn a Blueprint into Verse, read it with unreal_read_graph first. The user builds in UEFN (Verse → Build Verse Code); never say it compiled.";

/** The user's UEFN projects (Documents\Fortnite Projects). */
export async function uefnProjects(home = homedir()): Promise<Array<{ name: string; path: string; content: string }>> {
  const root = join(home, "Documents", "Fortnite Projects");
  const out: Array<{ name: string; path: string; content: string }> = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const content = join(root, name, "Plugins", name, "Content");
    if (existsSync(content)) out.push({ name, path: join(root, name), content });
  }
  return out;
}

/**
 * The chat's UEFN tools.
 *
 * @param home - The home folder (tests).
 */
export function uefnTools(home = homedir()): AgentTool[] {
  const contentOf = async (project: string) => {
    const p = (await uefnProjects(home)).find((x) => x.name.toLowerCase() === project.toLowerCase());
    if (!p) throw new Error(`No UEFN project named ${project} in Documents\\Fortnite Projects.`);
    return p.content;
  };
  const inside = (content: string, file: string) => {
    const full = normalize(join(content, file));
    const rel = relative(content, full);
    if (rel.startsWith("..") || !/\.verse$/i.test(full)) throw new Error("Only .verse files inside the project's Content folder.");
    return full;
  };
  return [
    {
      risk: "read",
      spec: { name: "uefn_projects", description: "The user's UEFN (Fortnite) projects and their Verse files.", inputSchema: { type: "object", properties: {} } },
      run: async () => {
        const list = await uefnProjects(home);
        if (!list.length) return { output: "No UEFN projects in Documents\\Fortnite Projects (UEFN makes them there)." };
        const lines: string[] = [];
        for (const p of list) {
          const files: string[] = [];
          const walk = async (dir: string, depth: number) => {
            if (depth > 6 || files.length > 200) return;
            for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
              if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
              else if (e.name.endsWith(".verse")) files.push(relative(p.content, join(dir, e.name)));
            }
          };
          await walk(p.content, 0);
          lines.push(`${p.name}: ${files.length ? files.join(", ") : "(no Verse files yet)"}`);
        }
        return { output: lines.join("\n") };
      },
    },
    {
      risk: "write",
      spec: {
        name: "verse_file",
        description: "Read or write a .verse file in a UEFN project's Content folder (action read or write; write takes the whole file). The user then builds in UEFN (Verse → Build Verse Code).",
        inputSchema: { type: "object", properties: { project: { type: "string" }, file: { type: "string", description: "e.g. my_device.verse" }, action: { type: "string", enum: ["read", "write"] }, text: { type: "string" } }, required: ["project", "file", "action"] },
      },
      preview: async (input) => `${String(input.action)} ${String(input.project)}/${String(input.file)}${input.action === "write" ? `\n${String(input.text ?? "").slice(0, 3000)}` : ""}`,
      run: async (input) => {
        const full = inside(await contentOf(String(input.project ?? "")), String(input.file ?? ""));
        if (input.action === "read") return { output: (await readFile(full, "utf8").catch(() => "(no such file)")).slice(0, 20_000) };
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, String(input.text ?? ""));
        return { output: `Wrote ${String(input.file)}. In UEFN: Verse → Build Verse Code, then place the device from CreativeDevices.` };
      },
    },
  ];
}
