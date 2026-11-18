// An access token for a Google service account, from its JSON key (the env variable GOOGLE_KEY), by Google's own
// "JWT bearer" exchange: no other Google API has to be enabled. Prints only the token (the workflow masks it).
//   GOOGLE_KEY="$(cat key.json)" node scripts/google-token.mjs https://www.googleapis.com/auth/chromewebstore
import { createSign } from "node:crypto";

const key = JSON.parse(process.env.GOOGLE_KEY ?? "{}");
const scope = process.argv[2];
if (!key.client_email || !key.private_key || !scope) throw new Error("Needs GOOGLE_KEY (a service account's JSON key) and a scope.");
const url = key.token_uri || "https://oauth2.googleapis.com/token";
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope, aud: url, iat: now, exp: now + 600 })}`;
const jwt = `${body}.${createSign("RSA-SHA256").update(body).sign(key.private_key, "base64url")}`;
const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
const j = await r.json();
if (!j.access_token) throw new Error(`Google refused the key: ${j.error ?? r.status} ${j.error_description ?? ""}`);
process.stdout.write(j.access_token);
