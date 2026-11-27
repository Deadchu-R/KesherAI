/**
 * Unity `.meta` helpers: everything about deriving the GUID of a project asset from its path, so a generated
 * `.meta` file stays stable across runs (Unity keeps a GUID once it exists, so it must be reproducible).
 */

import { createHash } from "node:crypto";

/**
 * The deterministic GUID of a project-relative asset path: the 32 lowercase hex characters Unity uses in `.meta`
 * files, derived from a hash of the path, so the same path always yields the same GUID on every machine and run.
 *
 * The path is normalized first (backslashes to `/`, a leading `./` removed) so `Assets\Foo.png` and
 * `./Assets/Foo.png` produce the same GUID.
 *
 * @param path - The asset's path relative to the project root, e.g. `Assets/Textures/wall.png`.
 * @returns 32 lowercase hex characters.
 */
export function getGuidFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}