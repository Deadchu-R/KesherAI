import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The phone app's cloud.html hands the hub page a Google token in the address fragment. Security scan 167: it must be
 * a fresh token asked for Drive's app folder alone (never the app's own token, which also opens Drive files), and it
 * must not replace the token the app keeps for itself.
 */
const cloudHtml = join(dirname(fileURLToPath(import.meta.url)), "../../android/www/cloud.html");

/** cloud.html's `driveToken`, built as a function over fake globals. */
function loadDriveToken(): (env: { window: unknown; localStorage: unknown; fetch: unknown }) => Promise<{ token: string; secs: number } | null> {
  const src = readFileSync(cloudHtml, "utf8");
  const body = /async function driveToken\(\) \{[\s\S]*?\n {2}\}\n/.exec(src)?.[0];
  assert.ok(body, "driveToken is in cloud.html");
  const make = new Function("window", "localStorage", "fetch", `${body}; return driveToken();`) as (w: unknown, l: unknown, f: unknown) => Promise<{ token: string; secs: number } | null>;
  return (env) => make(env.window, env.localStorage, env.fetch);
}

const APPDATA = "https://www.googleapis.com/auth/drive.appdata";

function fakes(scope: string) {
  const stored = JSON.stringify({ refreshToken: "r", accessToken: "full-scope-token", expires: Date.now() + 3600_000, scope: `openid email https://www.googleapis.com/auth/drive.file ${scope}`.trim() });
  const writes: string[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const Google = { refresh: async (o: Record<string, unknown>) => (asked.push(o), { accessToken: "narrow-token", expiresIn: 3599, scope: String(o.scope ?? "") }) };
  return {
    asked,
    writes,
    env: {
      window: { Capacitor: { Plugins: { KesherGoogle: Google } } },
      localStorage: { getItem: () => stored, setItem: (k: string) => void writes.push(k) },
      fetch: async () => ({ ok: true, json: async () => ({ clientId: "c" }) }),
    },
  };
}

test("the hub page gets a fresh token for the app folder only, and the app's own token stays as it was", async () => {
  const f = fakes(APPDATA);
  const t = await loadDriveToken()(f.env);
  assert.deepEqual(t, { token: "narrow-token", secs: 3599 });
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0]!.scope, APPDATA);
  assert.deepEqual(f.writes, [], "the app's stored token is not replaced");
});

test("no token is handed over when the sign-in never granted the app folder", async () => {
  const f = fakes("");
  assert.equal(await loadDriveToken()(f.env), null);
  assert.equal(f.asked.length, 0);
});
