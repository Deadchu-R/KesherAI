import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretBox } from "./config.js";

/** Marks a value sealed by the key file (so it is never mistaken for the desktop app's own protection). */
const TAG = "f1:";

/**
 * Keys at rest for a run without the desktop app (a headless server): AES-256-GCM with a random key kept in its own
 * file, written once with owner-only permissions. The key file lives next to the data folder, not in it, so a copy,
 * backup or sync of the data folder (config.json) does not carry the key. It stops a leaked config from showing the
 * keys; it is not a defence against someone who can already read the owner's files.
 *
 * @param keyFile - Where the key is (created on first use).
 * @returns A secret box that seals and unseals short texts.
 */
export function fileSecretBox(keyFile: string): SecretBox {
  let key: Buffer;
  if (existsSync(keyFile)) {
    key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("The key file is not valid, so the saved keys cannot be read.");
  } else {
    key = randomBytes(32);
    mkdirSync(dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    // Windows ignores the mode; on other systems make sure a umask did not widen it.
    try { chmodSync(keyFile, 0o600); } catch { /* not supported here */ }
  }
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return TAG + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    unseal(text) {
      if (!text.startsWith(TAG)) throw new Error("Not sealed by the key file.");
      const raw = Buffer.from(text.slice(TAG.length), "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
