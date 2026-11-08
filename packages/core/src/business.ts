import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Business mode: which connections may be used. */
export interface BusinessPolicy {
  enabled: boolean;
  /** Provider ids that stay on, e.g. `["copilot"]`. */
  allowed: string[];
}

/**
 * Reads an administrator's `policy.json` from the data folder, e.g.
 * `{ "business": { "enabled": true, "allowed": ["copilot"] } }`. While it is
 * there, business mode follows it and cannot be changed from the app.
 *
 * @param dataDir - KesherAI's data folder.
 * @returns The policy, or undefined when there is no (valid) file.
 */
export function managedPolicy(dataDir: string): BusinessPolicy | undefined {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, "policy.json"), "utf8")) as { business?: { enabled?: unknown; allowed?: unknown } };
    const b = j.business;
    if (!b || typeof b.enabled !== "boolean") return undefined;
    const allowed = Array.isArray(b.allowed) ? b.allowed.filter((x): x is string => typeof x === "string" && /^[\w-]+$/.test(x)) : [];
    return { enabled: b.enabled, allowed };
  } catch {
    return undefined;
  }
}

/**
 * @param policy - The policy in force.
 * @returns A check for the provider registry: whether a provider may be used.
 */
export function policyCheck(policy: BusinessPolicy): (providerId: string) => boolean {
  return (id) => !policy.enabled || policy.allowed.includes(id);
}
