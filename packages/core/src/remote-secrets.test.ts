import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPaths, loadConfig, saveConfig, useSecretBox, type SecretBox } from "./config.js";
import { fileSecretBox } from "./secret-file.js";
import { createKesherServer } from "./server.js";

/** Values a plain config.json of an older version holds; none may stay on disk or leave through an API. */
const PLAIN = {
  token: "plain-remote-token-0123456789abcdef",
  browserKey: "plain-browser-key-xyz",
  refresh: "1//plain-google-refresh-token",
  clientSecret: "GOCSPX-plain-client-secret",
};

/** A stand-in for the desktop app's own protection. */
const box: SecretBox = { seal: (t) => Buffer.from(`x${t}`).toString("base64"), unseal: (t) => Buffer.from(t, "base64").toString().slice(1) };

/** An older config with every secret in plain text. */
const plainConfig = () => ({
  remote: { enabled: true, token: PLAIN.token },
  browserKey: PLAIN.browserKey,
  google: { clientId: "id.apps.googleusercontent.com", clientSecret: PLAIN.clientSecret, refreshToken: PLAIN.refresh, email: "someone@example.test" },
});

test("migration: plain Google tokens, remote token and browser key are sealed, and still read back the same", async () => {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), "kesher-rsec-")));
  await writeFile(paths.config, JSON.stringify(plainConfig()));
  useSecretBox(box);
  try {
    const c = await loadConfig(paths);
    // Read the old plain values; nothing is regenerated (a paired phone keeps its token).
    assert.equal(c.remote.token, PLAIN.token);
    assert.equal(c.browserKey, PLAIN.browserKey);
    assert.equal(c.google.refreshToken, PLAIN.refresh);
    await saveConfig(paths, c);
    const raw = await readFile(paths.config, "utf8");
    for (const v of Object.values(PLAIN)) assert.ok(!raw.includes(v), `${v} is not on disk in plain text`);
    assert.ok(raw.includes("someone@example.test"), "the e-mail is not a secret and stays readable");
    // Round trip.
    const again = await loadConfig(paths);
    assert.equal(again.remote.token, PLAIN.token);
    assert.equal(again.browserKey, PLAIN.browserKey);
    assert.equal(again.google.refreshToken, PLAIN.refresh);
    assert.equal(again.google.clientSecret, PLAIN.clientSecret);
  } finally {
    useSecretBox(undefined);
  }
});

test("headless: the key file seals them on start, and a paired device and the shared token verify after migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-rsec-"));
  const data = join(root, "data");
  const paths = dataPaths(data);
  await rm(data, { recursive: true, force: true });
  // First run (plain config from an older version) pairs a phone.
  useSecretBox(fileSecretBox(`${data}.key`));
  await loadConfig(paths); // creates the folders
  await writeFile(paths.config, JSON.stringify(plainConfig()));
  useSecretBox(undefined);
  const s1 = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  let deviceToken: string;
  try {
    deviceToken = await s1.services.deviceKeys!.issue("Pixel 9");
    await s1.services.saveConfig();
  } finally {
    await s1.app.close();
  }
  const raw = await readFile(paths.config, "utf8");
  for (const v of Object.values(PLAIN)) assert.ok(!raw.includes(v), "sealed on disk after the first start");
  // A restart (reads the sealed values): same shared token, same device key, same Google connection.
  const s2 = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  try {
    assert.equal(s2.services.config.remote.token, PLAIN.token);
    assert.equal(s2.services.config.google.refreshToken, PLAIN.refresh);
    const phone = { remoteAddress: "192.168.1.50" };
    const as = (t: string) => ({ ...phone, headers: { authorization: `Bearer ${t}` } });
    assert.equal((await s2.app.inject({ method: "GET", url: "/api/conversations", ...as(deviceToken) })).statusCode, 200, "the paired device still works");
    assert.equal((await s2.app.inject({ method: "GET", url: "/api/conversations", ...as(PLAIN.token) })).statusCode, 200, "the shared token still works");
    assert.equal((await s2.app.inject({ method: "GET", url: "/api/conversations", ...as("wrong") })).statusCode, 401);
    // No route that shows settings gives a secret to a phone (the pairing token and the extension key are for this computer only).
    for (const url of ["/api/settings", "/api/google", "/api/remote", "/api/browser", "/api/remote/devices", "/api/hf-token", "/api/guests/google"]) {
      const res = await s2.app.inject({ method: "GET", url, ...as(deviceToken) });
      for (const v of Object.values(PLAIN)) assert.ok(!res.body.includes(v), `${url} does not echo a secret`);
    }
  } finally {
    await s2.app.close();
  }
});
