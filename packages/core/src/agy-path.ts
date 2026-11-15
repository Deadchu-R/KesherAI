import { join } from "node:path";

/** Where Antigravity CLI's Windows installer puts `agy` (KesherAI's own PATH is older than the install). */
export function agyPath(): string | undefined {
  return process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : undefined;
}
