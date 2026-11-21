# Kesher Cloud hub

**עברית בקצרה:** ה-Hub הוא ממסר קטן שרץ אצלך ב-Cloudflare (חינם). הוא מעביר משימות, תוצאות ואישורים מוצפנים בין המחשב לטלפון ומשגר התראות. מגדירים הכול בלוח הבקרה של Cloudflare: Worker מהמאגר, סודות (`ALLOWED_EMAIL`, `GOOGLE_CLIENT_ID`, מפתחות VAPID להתראות), ואז מזווגים מחשב וטלפון. אפשר גם לחבר אותו ל-Claude כ-custom connector. הטקסט המלא של ההגדרה: [apps/hub/README.md](../../apps/hub/README.md).

## What it does
An optional always-on relay for one person's devices: who is online, sealed (end-to-end encrypted) tasks, results and approvals, and phone notifications that say only "N waiting". It never sees task text, files or chat.

## Prerequisites
A free Cloudflare account; optionally a domain on Cloudflare; a Google Cloud OAuth client (web application) for sign-in; GitHub access to your copy of the repository; Node.js for the key tool.

## Steps
1. **Worker:** Cloudflare dashboard > Workers & Pages > Create > Import a repository. Root directory `apps/hub`, empty build command, deploy command `npx wrangler deploy`.
2. **Address (optional):** Worker > Settings > Domains & Routes > Custom domain, e.g. `hub.<your domain>`.
3. **Google client:** Google Cloud > APIs & Services > Credentials > OAuth client ID > Web application; authorised origin = your hub address. Copy the client ID (not secret, but keep it out of git).
4. **Variables and secrets** (Worker > Settings > Variables and Secrets):
   - `ALLOWED_EMAIL` (Secret): the one Google account allowed in. `GOOGLE_CLIENT_ID`: from step 3.
   - Notifications: `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` as Text; `VAPID_PRIVATE_KEY` as **Secret**. Make the pair once with `node tools/hub-vapid.mjs` (it prints, writes nothing). Keep the same pair; a new one makes every phone re-enable notifications.
   - Optional: `CLAUDE_TRIGGER_ID` / `CLAUDE_FIRE_TOKEN` (Claude cloud path), `HUB_DISABLED=1` (kill switch). Leave `HUB_PRIVATE_KEY` unset.
5. **Pair:** KesherAI on the PC > Settings > Cloud hub > type the address > "Connect to my hub". Approve the code on the hub page and check the 6-digit fingerprint matches on both screens. Choose what this PC accepts (a new PC accepts nothing until you say so).
6. **Phone notifications:** open the hub in Chrome (not an app's WebView), pair as a device, "Add to Home screen" (required on iPhone, iOS 16.4+), then in the installed hub page Settings > Notifications > "Notify this device".
7. **Claude custom connector:** on the hub page Settings > Connect to Claude, copy `https://<your hub>/mcp`. In Claude: Settings > Connectors > Add custom connector, name "Kesher Cloud", paste, leave client id and secret empty, Connect, approve on the hub's page. Claude then sees names, counts and ids only and can send a task to an accepting PC.

## Verify
The PC shows online on the hub page. Make something wait for approval on the PC: the phone gets "KesherAI: 1 waiting". In Claude, ask "list my Kesher devices".

## Troubleshooting
- Google button missing: you are inside an app's WebView; use "Open in the phone's browser".
- No notifications: all three VAPID values must be set; the hub page must be closed; the phone must be paired in Chrome.
- Sign-in refused: the account is not `ALLOWED_EMAIL` (the first sign-in pins that account's id).

## Safety
Put the private key only in the dashboard as a Secret. Kill switches: Pause hub, "Sign out everywhere and revoke all devices", Connected apps > Revoke, `HUB_DISABLED`. Connector tokens: access 1 hour, refresh 30 days; every tool call is logged by name.
