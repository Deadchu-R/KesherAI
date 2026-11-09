import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/**
 * Checks Unreal C++ for the mistakes models make most, without building
 * (a build takes minutes and needs the engine): the .generated.h include
 * must match the header's own name and come last, local includes must name
 * files that exist, a delegate used with BlueprintAssignable or Broadcast must
 * be MULTICAST, Actor classes start with A and UObject classes with U, every
 * UCLASS/USTRUCT has GENERATED_BODY, and UE5-removed calls (IsPendingKill)
 * are flagged. Fast, so it runs on every check_code.
 *
 * @param files - Path → text of the .h/.cpp files to check.
 * @param known - Basenames of every header in the project (for "include not found").
 * @returns One line per problem: "file:line: error|warning: what, and the fix".
 */
export function unrealCppProblems(files: Record<string, string>, known: Set<string>): string[] {
  const out: string[] = [];
  const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
  const multicast = new Set<string>();
  const single = new Set<string>();
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(/DECLARE_DYNAMIC_MULTICAST_DELEGATE\w*\(\s*(\w+)/g)) multicast.add(m[1]!);
    for (const m of text.matchAll(/DECLARE_DYNAMIC_DELEGATE\w*\(\s*(\w+)/g)) single.add(m[1]!);
  }
  for (const [path, text] of Object.entries(files)) {
    const name = basename(path);
    const stem = name.replace(/\.(h|hpp|cpp)$/i, "");
    const isHeader = /\.(h|hpp)$/i.test(name);
    const uses = /\b(UCLASS|USTRUCT|UENUM|GENERATED_BODY)\s*\(/.test(text);
    if (isHeader && uses) {
      const gen = [...text.matchAll(/#include\s+"([^"]+)\.generated\.h"/g)];
      if (!gen.length) out.push(`${path}:1: error: a header with UCLASS/USTRUCT needs #include "${stem}.generated.h" as its last include.`);
      for (const g of gen) {
        if (g[1] !== stem) out.push(`${path}:${lineOf(text, g.index!)}: error: #include "${g[1]}.generated.h" must be "${stem}.generated.h" (the header's own file name).`);
      }
      const includes = [...text.matchAll(/^\s*#include\s+["<][^">]+[">]/gm)];
      const last = includes.at(-1);
      if (gen.length && last && !/\.generated\.h/.test(last[0])) out.push(`${path}:${lineOf(text, last.index!)}: error: the .generated.h include must be the last #include.`);
    }
    // Every UCLASS/USTRUCT is followed by its class with GENERATED_BODY().
    for (const m of text.matchAll(/\b(UCLASS|USTRUCT)\s*\([^)]*\)\s*(class|struct)\s+(?:\w+_API\s+)?(\w+)\s*(?::\s*public\s+(\w+))?[^{]*\{([\s\S]{0,400})/g)) {
      const [, , , cls, base, body] = m;
      if (!/GENERATED_(BODY|UCLASS_BODY|USTRUCT_BODY)\s*\(/.test(body ?? "")) out.push(`${path}:${lineOf(text, m.index!)}: error: ${cls} needs GENERATED_BODY() as the first line inside the class.`);
      if (base && cls) {
        const actor = /^(A[A-Z]\w*|AActor|APawn|ACharacter)$/.test(base);
        if (actor && !cls.startsWith("A")) out.push(`${path}:${lineOf(text, m.index!)}: error: ${cls} derives from ${base}, so its name must start with A (e.g. A${cls.replace(/^[UF]/, "")}).`);
        if (/^U[A-Z]/.test(base) && !cls.startsWith("U")) out.push(`${path}:${lineOf(text, m.index!)}: error: ${cls} derives from ${base}, so its name must start with U (e.g. U${cls.replace(/^[AF]/, "")}).`);
      }
    }
    // Local includes must exist (engine includes have a folder: "Components/BoxComponent.h").
    for (const m of text.matchAll(/^\s*#include\s+"([^"/\\]+\.h)"/gm)) {
      const inc = m[1]!;
      if (/\.generated\.h$/.test(inc) || /^(CoreMinimal|Engine|EngineMinimal|TimerManager|DrawDebugHelpers|UObject)\.h$/.test(inc)) continue;
      if (!known.has(inc.toLowerCase())) {
        const guess = [...known].find((k) => k.replace(/^[uafst](?=[a-z])/, "") === inc.toLowerCase().replace(/^[uafst](?=[a-z])/, "")) ?? [...known].find((k) => inc.toLowerCase().endsWith(k) || k.endsWith(inc.toLowerCase().replace(/^u/, "")));
        out.push(`${path}:${lineOf(text, m.index!)}: error: #include "${inc}" — no such file in the project${guess ? ` (did you mean "${[...known].includes(guess) ? guess : guess}"? header names have no U/A prefix: UHealthComponent lives in HealthComponent.h)` : " (Unreal header names have no U/A prefix: UHealthComponent lives in HealthComponent.h)"}.`);
      }
    }
    // A delegate that is broadcast or BlueprintAssignable must be MULTICAST.
    for (const m of text.matchAll(/UPROPERTY\s*\([^)]*BlueprintAssignable[^)]*\)\s*(\w+)\s+(\w+)\s*;/g)) {
      if (single.has(m[1]!) && !multicast.has(m[1]!)) out.push(`${path}:${lineOf(text, m.index!)}: error: ${m[1]} is used with BlueprintAssignable, so declare it with DECLARE_DYNAMIC_MULTICAST_DELEGATE… (not DECLARE_DYNAMIC_DELEGATE).`);
    }
    for (const m of text.matchAll(/^\s*DECLARE_DYNAMIC_DELEGATE\w*\(\s*(\w+)/gm)) {
      const n = m[1]!;
      if (Object.values(files).some((t) => new RegExp(`\\b\\w+\\.Broadcast\\s*\\(`).test(t) && new RegExp(`\\b${n}\\b\\s+\\w+\\s*;`).test(t)) && !multicast.has(n)) {
        out.push(`${path}:${lineOf(text, m.index!)}: error: ${n} is broadcast (.Broadcast), which only MULTICAST delegates have: use DECLARE_DYNAMIC_MULTICAST_DELEGATE… (or call .ExecuteIfBound).`);
      }
    }
    for (const m of text.matchAll(/\bIsPendingKill\s*\(/g)) out.push(`${path}:${lineOf(text, m.index!)}: warning: IsPendingKill() was removed in Unreal 5: use IsValid(Actor) instead.`);
    for (const m of text.matchAll(/\bGetComponentByClass\s*\(\s*(\w+)::StaticClass\s*\(\s*\)\s*\)/g)) out.push(`${path}:${lineOf(text, m.index!)}: warning: prefer FindComponentByClass<${m[1]}>() (typed, no Cast).`);
  }
  return [...new Set(out)];
}

/** Folders that hold generated or third-party code, never the user's Unreal sources. */
const SKIP = new Set(["intermediate", "binaries", "saved", "deriveddatacache", "plugins", ".git", ".vs", "node_modules", "build"]);

/**
 * Runs unrealCppProblems on a folder: its .h/.cpp files (up to 400, generated
 * folders skipped), but only when they use Unreal's macros.
 *
 * @param root - The project or chat folder.
 * @returns The problems, or undefined when there is no Unreal C++ here.
 */
export async function checkUnrealFolder(root: string): Promise<string[] | undefined> {
  const files: Record<string, string> = {};
  const known = new Set<string>();
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const dir = stack.pop()!;
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      seen++;
      if (d.isDirectory()) {
        if (!SKIP.has(d.name.toLowerCase()) && !d.name.startsWith(".")) stack.push(join(dir, d.name));
        continue;
      }
      if (!/\.(h|hpp|cpp)$/i.test(d.name)) continue;
      const full = join(dir, d.name);
      if (/\.(h|hpp)$/i.test(d.name)) known.add(d.name.toLowerCase());
      if (Object.keys(files).length >= 400) continue;
      const s = await stat(full).catch(() => undefined);
      if (!s || s.size > 400_000) continue;
      files[relative(root, full).replace(/\\/g, "/")] = await readFile(full, "utf8").catch(() => "");
    }
  }
  if (!Object.values(files).some((t) => /\b(UCLASS|USTRUCT|GENERATED_BODY|_API\b)/.test(t))) return undefined;
  return unrealCppProblems(files, known);
}
