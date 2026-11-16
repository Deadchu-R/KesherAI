import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { runProgram } from "./unreal-tools.js";

/**
 * Minecraft and Roblox modding from the chat (Roee, 2026-11-16: Java with Fabric and NeoForge, Bedrock add-ons, and
 * Roblox with Rojo). How the communities start a project, researched first:
 *
 * - Fabric: the official example mod (FabricMC/fabric-example-mod, its newest Minecraft) with Gradle and Loom; `gradlew build` makes the jar.
 * - NeoForge: the official MDK (NeoForgeMDKs/MDK-1.21.1-ModDevGradle); the same Gradle build.
 * - Bedrock: a behavior pack and a resource pack (manifest.json with UUIDs, linked by dependency), zipped as .mcaddon.
 * - Roblox: Rojo (default.project.json, Luau in src/), `rojo build` makes a place file Roblox Studio opens.
 *
 * The Java and Rojo tools are KesherAI's own copies in its engines folder (a JDK 21 and rojo.exe), found by themselves.
 */

/** The kinds of Minecraft and Roblox projects. */
export type ModKind = "fabric" | "neoforge" | "bedrock" | "roblox";

const TEMPLATES: Record<"fabric" | "neoforge", string> = {
  fabric: "https://github.com/FabricMC/fabric-example-mod",
  neoforge: "https://github.com/NeoForgeMDKs/MDK-1.21.1-ModDevGradle",
};

/** A mod id: lowercase letters, digits and underscores (what Fabric and NeoForge accept). */
export function modId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "m$1").slice(0, 40) || "my_mod";
}

/**
 * The files of a Bedrock add-on: a behavior pack and a resource pack that need each other.
 *
 * @param name - The add-on's name.
 * @returns Paths (relative) and contents.
 */
export function bedrockFiles(name: string): Record<string, string> {
  const [bpHeader, bpModule, rpHeader, rpModule] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const version = [1, 0, 0];
  const minEngine = [1, 21, 0];
  const id = modId(name);
  const manifest = (header: string, mod: string, type: "data" | "resources", dep: string) =>
    JSON.stringify({ format_version: 2, header: { name: `${name} ${type === "data" ? "BP" : "RP"}`, description: `${name} (made with KesherAI)`, uuid: header, version, min_engine_version: minEngine }, modules: [{ type, uuid: mod, version }], dependencies: [{ uuid: dep, version }] }, null, 2);
  return {
    [`behavior_pack/manifest.json`]: manifest(bpHeader, bpModule, "data", rpHeader),
    [`resource_pack/manifest.json`]: manifest(rpHeader, rpModule, "resources", bpHeader),
    // A first item, so the add-on shows something in the game.
    [`behavior_pack/items/${id}_gem.json`]: JSON.stringify({ format_version: "1.21.0", "minecraft:item": { description: { identifier: `${id}:gem`, menu_category: { category: "items" } }, components: { "minecraft:max_stack_size": 64, "minecraft:icon": `${id}_gem` } } }, null, 2),
    [`resource_pack/textures/item_texture.json`]: JSON.stringify({ resource_pack_name: id, texture_name: "atlas.items", texture_data: { [`${id}_gem`]: { textures: "textures/items/gem" } } }, null, 2),
    [`resource_pack/texts/en_US.lang`]: `item.${id}:gem=Gem\n`,
    [`README.md`]: `# ${name}\n\nA Minecraft Bedrock add-on. Add a 16×16 PNG at resource_pack/textures/items/gem.png. Build makes ${id}.mcaddon (open it to install).\n`,
  };
}

/**
 * The files of a Rojo project for Roblox.
 *
 * @param name - The game's name.
 */
export function robloxFiles(name: string): Record<string, string> {
  return {
    "default.project.json": JSON.stringify({ name, tree: { $className: "DataModel", ReplicatedStorage: { Shared: { $path: "src/shared" } }, ServerScriptService: { Server: { $path: "src/server" } }, StarterPlayer: { StarterPlayerScripts: { Client: { $path: "src/client" } } } } }, null, 2),
    "src/server/init.server.luau": 'print("Hello from the server")\n',
    "src/client/init.client.luau": 'print("Hello from the client")\n',
    "src/shared/Hello.luau": 'return function()\n\treturn "Hello from shared code"\nend\n',
    "README.md": `# ${name}\n\nA Roblox game with Rojo. Build makes ${modId(name)}.rbxlx: open it in Roblox Studio. To work live, run \`rojo serve\` and connect the Rojo plugin in Studio.\n`,
  };
}

/** Which kind of mod project a folder is. */
export function modKindOf(dir: string): ModKind | undefined {
  if (existsSync(join(dir, "default.project.json"))) return "roblox";
  if (existsSync(join(dir, "behavior_pack", "manifest.json"))) return "bedrock";
  if (existsSync(join(dir, "src", "main", "resources", "fabric.mod.json")) || existsSync(join(dir, "src", "main", "resources", "fabric.mod.json.template"))) return "fabric";
  if (existsSync(join(dir, "src", "main", "templates", "META-INF", "neoforge.mods.toml")) || existsSync(join(dir, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) return "neoforge";
  return undefined;
}

/** Sets the mod's id, name and group in gradle.properties (both templates keep them there). */
export function renameGradle(props: string, id: string, name: string): string {
  const set = (text: string, key: string, value: string) => (new RegExp(`^${key}\\s*=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}\\s*=.*$`, "m"), `${key}=${value}`) : text);
  let p = props;
  p = set(p, "mod_id", id);
  p = set(p, "mod_name", name.replace(/[\r\n]/g, " "));
  p = set(p, "archives_base_name", id);
  p = set(p, "maven_group", `com.example.${id}`);
  p = set(p, "mod_group_id", `com.example.${id}`);
  p = set(p, "group", `com.example.${id}`);
  return p;
}

/**
 * The chat's modding tools.
 *
 * @param enginesDir - KesherAI's engines folder (jdk/, rojo/).
 */
export function modTools(enginesDir: string): AgentTool[] {
  const javaHome = async (): Promise<string | undefined> => {
    const dir = join(enginesDir, "jdk");
    for (const d of await readdir(dir).catch(() => [] as string[])) if (/^jdk-?21/i.test(d) && existsSync(join(dir, d, "bin"))) return join(dir, d);
    return process.env.JAVA_HOME;
  };
  const rojo = () => [join(enginesDir, "rojo", "rojo.exe"), join(enginesDir, "rojo", "rojo")].find((f) => existsSync(f));
  return [
    {
      risk: "write",
      spec: {
        name: "mod_new",
        description: "Start a Minecraft or Roblox project in a new folder: kind fabric or neoforge (Java mod from the official template, needs git), bedrock (a Bedrock add-on: behavior and resource packs), roblox (a Rojo project with Luau). Then mod_build.",
        inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["fabric", "neoforge", "bedrock", "roblox"] }, name: { type: "string" }, folder: { type: "string", description: "The parent folder; the project goes in a new folder named after it." } }, required: ["kind", "name", "folder"] },
      },
      preview: async (input) => `Make a ${String(input.kind)} project "${String(input.name)}" in ${String(input.folder)}.`,
      run: async (input) => {
        const kind = String(input.kind) as ModKind;
        const name = String(input.name ?? "").trim().slice(0, 60) || "My Mod";
        const dir = join(String(input.folder ?? ""), modId(name));
        if (existsSync(dir)) throw new Error(`${dir} already exists.`);
        if (kind === "bedrock" || kind === "roblox") {
          const files = kind === "bedrock" ? bedrockFiles(name) : robloxFiles(name);
          for (const [rel, text] of Object.entries(files)) {
            await mkdir(join(dir, rel, ".."), { recursive: true });
            await writeFile(join(dir, rel), text);
          }
          return { output: `Made ${dir} (${Object.keys(files).length} files). mod_build turns it into ${kind === "bedrock" ? "an .mcaddon" : "an .rbxlx place"}.` };
        }
        if (kind !== "fabric" && kind !== "neoforge") throw new Error("kind is fabric, neoforge, bedrock or roblox.");
        const r = await runProgram("git", ["clone", "--depth", "1", TEMPLATES[kind], dir], { timeoutMs: 180_000 });
        if (r.code !== 0) throw new Error(`git clone failed: ${r.out.slice(-1500)}`);
        const props = join(dir, "gradle.properties");
        if (existsSync(props)) await writeFile(props, renameGradle(await readFile(props, "utf8"), modId(name), name));
        // Fabric keeps the id and name in fabric.mod.json.
        const fmj = join(dir, "src", "main", "resources", "fabric.mod.json");
        if (existsSync(fmj)) {
          try {
            const j = JSON.parse(await readFile(fmj, "utf8")) as Record<string, unknown>;
            j.id = modId(name);
            j.name = name;
            await writeFile(fmj, `${JSON.stringify(j, null, "\t")}\n`);
          } catch {
            // left as the template has it
          }
        }
        return { output: `Made ${dir} from the official ${kind === "fabric" ? "Fabric example mod" : "NeoForge MDK"} (mod id ${modId(name)} in gradle.properties; rename the Java package and the mod's class in src/main/java when needed). mod_build builds the jar (the first build downloads Minecraft and Gradle, a few minutes).` };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "mod_build",
        description: "Build a Minecraft or Roblox project: Fabric/NeoForge → `gradlew build` with KesherAI's JDK 21 (the jar in build/libs); Bedrock → an .mcaddon; Roblox → `rojo build` to an .rbxlx place. Returns the errors to fix.",
        inputSchema: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"] },
      },
      commandOf: (input) => `build ${String(input.folder)}`,
      run: async (input) => {
        const dir = String(input.folder ?? "");
        const kind = modKindOf(dir);
        if (!kind) throw new Error("That folder is not a Fabric, NeoForge, Bedrock or Roblox (Rojo) project.");
        if (kind === "bedrock") {
          const out = join(dir, `${basename(dir)}.mcaddon`);
          const r = process.platform === "win32"
            ? await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Force -Path behavior_pack,resource_pack -DestinationPath out.zip; Move-Item -Force out.zip $env:KESHER_OUT"], { cwd: dir, env: { ...process.env, KESHER_OUT: out }, timeoutMs: 60_000 })
            : await runProgram("zip", ["-qr", out, "behavior_pack", "resource_pack"], { cwd: dir, timeoutMs: 60_000 });
          return { output: r.code === 0 ? `Built ${out}: open it to add it to Minecraft.` : `Packing failed:\n${r.out.slice(-3000)}` };
        }
        if (kind === "roblox") {
          const exe = rojo();
          if (!exe) throw new Error("Rojo is not installed in KesherAI's engines folder (engines/rojo).");
          const out = join(dir, `${basename(dir)}.rbxlx`);
          const r = await runProgram(exe, ["build", "-o", out], { cwd: dir, timeoutMs: 120_000 });
          return { output: r.code === 0 ? `Built ${out}: open it in Roblox Studio.` : `rojo build failed:\n${r.out.slice(-4000)}` };
        }
        const jh = await javaHome();
        if (!jh) throw new Error("Java 21 is missing (KesherAI keeps one in engines/jdk).");
        const gradlew = join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
        if (!existsSync(gradlew)) throw new Error("The project has no Gradle wrapper (gradlew).");
        const r = await runProgram(gradlew, ["build", "--console=plain"], { cwd: dir, env: { ...process.env, JAVA_HOME: jh }, timeoutMs: 20 * 60_000 });
        const libs = existsSync(join(dir, "build", "libs")) ? (await readdir(join(dir, "build", "libs"))).filter((f) => f.endsWith(".jar")) : [];
        return { output: r.code === 0 ? `Built: ${libs.map((f) => join(dir, "build", "libs", f)).join(", ") || "(no jar found)"}. Put the jar in the mods folder of a ${kind === "fabric" ? "Fabric" : "NeoForge"} Minecraft install.` : `The build failed:\n${r.out.slice(-6000)}` };
      },
    },
  ];
}

/** One line for the chat's prompt (the tools load with find_tools). */
export const MOD_NOTE = "Minecraft (Fabric, NeoForge, Bedrock) and Roblox (Rojo, Luau): mod_new starts a project from the official template, mod_build builds it and returns the errors; never say it built unless mod_build says so.";
