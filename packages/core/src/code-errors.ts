/**
 * Compiler errors as the code editor marks them: one per file, line and
 * message, read from Unity's (C#: `Assets/A.cs(12,5): error CS1002: ; expected`)
 * or Unreal's / MSVC's (`D:\Proj\Source\A.cpp(12): error C2065: 'x': undeclared`)
 * output, plain or inside JSON.
 */
export interface CodeError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: "error" | "warning";
}

const CS = /([^\s"'(]+\.cs)\((\d+),(\d+)\):\s*(error|warning)\s+(CS\d+):\s*([^\n"\\]+)/g;
const MSVC = /([A-Za-z]:[\\/][^"(\n]+?\.(?:h|hpp|cpp|inl)|[^\s"'(]+\.(?:h|hpp|cpp|inl))\((\d+)(?:,(\d+))?\)\s*:\s*(?:fatal\s+)?(error|warning)\s+([A-Z]+\d+)\s*:\s*([^\n"\\]+)/g;

/**
 * @param text - A compiler's output (any mix of lines and JSON).
 * @param root - The project folder: paths under it are shown relative to it, with forward slashes.
 * @returns Each different problem once, errors first.
 */
export function parseCodeErrors(text: string, root = ""): CodeError[] {
  const seen = new Set<string>();
  const out: CodeError[] = [];
  const rootN = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rel = (f: string) => {
    const n = f.replace(/\\\\/g, "/").replace(/\\/g, "/");
    return rootN && n.toLowerCase().startsWith(`${rootN}/`) ? n.slice(rootN.length + 1) : n;
  };
  for (const re of [CS, MSVC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const e: CodeError = { file: rel(m[1]!), line: Number(m[2]), column: Number(m[3] ?? 1) || 1, severity: m[4] === "warning" ? "warning" : "error", code: m[5]!, message: m[6]!.trim() };
      const key = `${e.file}|${e.line}|${e.code}|${e.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).slice(0, 200);
}

/** The code inside the model's answer: the first fenced block, else the whole text. */
export function codeFromAnswer(text: string): string {
  const m = /```[\w+#-]*[^\S\n]*\n([\s\S]*?)```/.exec(text.replace(/<think>[\s\S]*?<\/think>/g, ""));
  return (m ? m[1]! : text).replace(/\s+$/, "") + "\n";
}

/**
 * What the model is asked when the user writes a request in the code editor's
 * AI bubble: change the whole file, keep everything else as it is.
 */
export function codeEditPrompt(o: { language: "csharp" | "cpp"; engine: "unity" | "unreal"; path: string; text: string; request: string; errors?: CodeError[]; others?: string }): string {
  const rules = o.engine === "unity"
    ? "This is a Unity C# script. Use only Unity APIs that exist (UnityEngine, UnityEngine.UI, TMPro when the project has it). Keep [SerializeField] fields so values set in the Inspector stay. Fields shown in the Inspector keep their names (rename only if asked; then add [FormerlySerializedAs(\"old\")])."
    : "This is an Unreal Engine 5 C++ file. Keep UCLASS/UPROPERTY/UFUNCTION macros and GENERATED_BODY(); the .generated.h include stays last in a header; use only engine APIs that exist and add the module to Build.cs only if the user asks.";
  return [
    `You edit one file: ${o.path}. ${rules}`,
    "Do exactly what the user asks and nothing else: keep every other line, name, comment and the formatting as they are.",
    ...(o.errors?.length ? ["", "The compiler reports these errors; fix them:", ...o.errors.slice(0, 30).map((e) => `- ${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`)] : []),
    ...(o.others ? ["", "Other code of the project, for reference (do not repeat it):", o.others.slice(0, 6000)] : []),
    "",
    "The file now:",
    "```",
    o.text.slice(0, 120_000),
    "```",
    "",
    `The request: ${o.request || "Fix the errors."}`,
    "",
    "Answer with the WHOLE new file in one code block, then one short line saying what changed.",
  ].join("\n");
}
