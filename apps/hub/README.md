# Kesher Cloud hub

A small always-on relay for one person's KesherAI devices: it knows which PCs and phones are on, passes **sealed**
(end-to-end encrypted) tasks, results and approvals between them, and, when no PC is on, can start a Claude Code
scheduled task under the owner's own Claude subscription. It runs on Cloudflare's free Workers plan (a Worker plus one
Durable Object with SQLite) and costs nothing at one person's scale.

Anyone can host their own hub on their own Cloudflare account and domain. Nothing owner-specific is in the code: the
owner, the domain and every key are set in the Cloudflare dashboard.

Design and reasons: `docs/RESEARCH_LOG.md`, entry "Kesher Cloud hub" (with its addendum and "How others do it").

## What the hub keeps, and what it never sees

- **Keeps:** each paired device's name, public key, a hash of its token, when it was last seen, and what it reports
  (busy, which work it accepts, its agents). Sealed messages only until the recipient acknowledges them (at most 7 days;
  approvals 30 minutes). An activity log with event type, device id and time only (30 days). For a phone with
  notifications on: its browser's push address and keys, and the last "waiting" count it was told (a number a PC sends
  in clear for this, nothing else); each PC's last such count. For the Claude connector: the registered Claude clients
  (name, redirect addresses), hashes of its codes and tokens, and the ids, PC and time of tasks it sent (no text).
- **Never:** task text, results, files, chat, passwords or tokens in plain form. Messages are sealed on the sending
  device to the receiving device's key. The one exception is a task you send to **Claude cloud**: the hub opens that
  one message in memory to start the scheduled task, and stores nothing of it.

## Set it up (dashboard only, no command line)

You need a Cloudflare account (the free plan is enough) and, for your own address, a domain on Cloudflare.

### 1. Create the Worker from the repository
1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**.
2. Connect GitHub and pick the KesherAI repository (your fork or your own copy).
3. Settings for the build:
   - **Root directory:** `apps/hub`
   - **Build command:** leave empty.
   - **Deploy command:** `npx wrangler deploy` (the default).
4. Save and deploy. Every push to the chosen branch deploys again (Workers Builds).

The first deploy creates the Durable Object and the 5-minute cleanup schedule from `wrangler.toml`.

### 2. Your own address (optional, recommended)
**Your Worker → Settings → Domains & Routes → Add → Custom domain**, for example `hub.<your domain>`. Cloudflare adds the
DNS record and the certificate. Your main site is not touched. When the custom domain works, you can turn the
`workers.dev` address off on the same screen.

### 3. Google sign-in (one OAuth client id)
1. In the Google Cloud console: **APIs & Services → Credentials → Create credentials → OAuth client ID → Web
   application**.
2. **Authorised JavaScript origins:** your hub address (for example `https://hub.<your domain>`).
3. Copy the **client ID** (it ends in `.apps.googleusercontent.com`; this is not a secret, but it stays out of git).

Google blocks its sign-in inside apps (WebViews). Inside the KesherAI app (`?app=`) or any Android WebView (`; wv)`)
the page shows no Google button: it pairs the phone with a code (approved on a signed-in screen) and offers "Open in
the phone's browser" (`?kesher-external=1`, which the app opens in the browser).

### 4. Variables and secrets
**Your Worker → Settings → Variables and Secrets → Add**. Choose type **Secret** for each:

| Name | What to put | Needed |
|---|---|---|
| `ALLOWED_EMAIL` | The one Google account allowed to sign in. On its first sign-in the hub pins that account's id; after that only it gets in, even if the email changes hands. | Yes |
| `GOOGLE_CLIENT_ID` | The client ID from step 3. | Yes |
| `CLAUDE_TRIGGER_ID` | The scheduled task's trigger id (step 5). | For the Claude path |
| `CLAUDE_FIRE_TOKEN` | The scheduled task's API token (step 5). | For the Claude path |
| `HUB_PRIVATE_KEY` | Leave unset: the hub makes its own key on first start and keeps it in its storage. | No |
| `HUB_DISABLED` | Set to `1` to switch the whole hub off at once (kill switch outside the hub). | No |
| `VAPID_PUBLIC_KEY` | Notifications (step 7): the public key. Type **Text** is fine (it is public). | For notifications |
| `VAPID_PRIVATE_KEY` | Notifications (step 7): the private key. **Secret**, never in a file or in git. | For notifications |
| `VAPID_SUBJECT` | Notifications (step 7): `https://` + your hub address (or `mailto:` an address you read). Type **Text**. | For notifications |

The dashboard keeps these on every deploy (`keep_vars = true`).

### 5. The Claude path (optional)
At **claude.ai/code** → scheduled tasks: create one task (for example "Kesher hub task") on your KesherAI repository,
with **only an API trigger**, and a saved prompt that treats the incoming text as the task to do. Generate its API token
(shown once) and put the trigger id and the token into the two secrets above. This runs under your Claude subscription
(it is not the Claude API). Keep usage credits off if you want nothing metered. It is a research preview: limits are 30
fires an hour per task, and the shape may change.

### 6. Pair your devices
In KesherAI on a PC: **Settings → Cloud hub**: type the hub address, press "Connect to my hub", and approve the code it
shows on the hub page (signed in), after checking that the 6-digit fingerprint matches on both screens. Then choose what
this PC accepts (tasks, local-model tasks, Antigravity tasks, vendor session links). A new PC accepts no tasks until you
turn that on.

### 7. Notifications on your phone (optional, free)
The hub can tell your phone "KesherAI: 2 waiting for you" when something on a PC waits for your approval or a Run press,
wherever the phone is, with the hub page closed. It is standard Web Push through the browser's own push service (Google's
for Chrome on Android), so there is no extra app and no cost. The notification carries a count only: the hub never
learns what waits.

1. Make a key pair once: `node tools/hub-vapid.mjs` (it prints three lines and writes nothing).
2. Put them into the Worker (step 4): `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` as Text, and paste `VAPID_PRIVATE_KEY`
   yourself as a **Secret**. Keep the same pair afterwards: a new pair means every phone turns notifications on again.
3. On the phone, open the hub **in Chrome** (inside the KesherAI app, Settings › Notifications has "Open in the phone's
   browser"; an app's WebView cannot get Web Push), pair it as a device, then Chrome's menu › **Add to Home screen** /
   **Install**. On an iPhone this step is required (iOS 16.4 or later).
4. Open the hub from the home screen: **Settings › Notifications › Notify this device**, and allow notifications.

A phone is notified only while its hub page is closed, at most once per 30 seconds, and only when the count grows; a tap
opens "Waiting for you". "Notify this device" off, "Forget this device" or revoking the device stops it.

### 8. Connect Claude (optional): the hub as a custom connector
The hub is also a remote MCP server at `https://<your hub>/mcp`, so Claude (claude.ai, the desktop and phone apps,
Claude Code) can list your devices and agents, see how much waits for approval, and send a task to a PC, inside your
own Claude plan. Nothing to set up on Cloudflare: it uses the Google sign-in you already have.
1. On the hub page (signed in): **Settings › Connect to Claude** shows the address; copy it.
2. In Claude: **Settings › Connectors › Add custom connector**, name it "Kesher Cloud", paste the address, leave the
   client id and secret empty, and press **Connect**.
3. The hub's approval page opens (sign in to the hub first if it asks). Check that it returns to `claude.ai` and approve.
4. In a chat, turn Kesher Cloud on in the tools menu.

What Claude gets: metadata only. Task text, results, approvals and agent steps are sealed between your devices and the
hub holds no key that opens them, so the tools answer with names, counts and ids plus a link to the hub page, where
your browser opens them. `send_task` is sealed by the hub with its own key (the same key the Claude cloud path uses):
the text came from Claude in plain form and is in the Worker's memory only for that call. The PC must have "accepts
tasks" and the kind (Antigravity, which still waits for your Run, or the local model) turned on.

Tokens: access 1 hour, refresh 30 days (rotated on each use; an old one coming back ends the connection), at most 90
days before you approve again, at most 10 connections. **Settings › Connected apps › Revoke** ends one at once;
"Disconnect all" ends all of them. Every tool call is in the activity log (tool name only).

## Kill switches
1. **Pause hub** (hub page): stops routing and closes every device connection; data kept.
2. **Sign out everywhere and revoke all devices** (hub page); this also ends every Claude connection.
3. **Claude connector:** Settings › Connected apps › Revoke (or remove the connector in Claude).
4. **Claude path:** switch it off on the hub page, or delete the scheduled task's token at claude.ai (fires stop at once).
5. **Whole hub:** set `HUB_DISABLED` to `1`, or disable the Worker in the Cloudflare dashboard.

## The hub's API (for the KesherAI clients)
- Open, rate limited: `POST /api/signin` `{credential}` (Google ID token, from the hub page only), `POST /api/pair/start`
  `{publicKey, kind, name}` → `{code, pollSecret, expiresIn, fingerprint}`, `POST /api/pair/poll` `{pollSecret}` →
  `pending` or `{deviceId, token, hubKey}` once.
- Device token (`Authorization: Bearer kh_…`): `POST /api/ticket` → a one-use 60-second `ticket` (and `rotateDue`
  after 30 days), `POST /api/rotate` → a new token (the old one stops at once). Tokens older than 180 days are refused.
  A phone or hub page: `POST /api/push/subscribe` `{endpoint, keys: {p256dh, auth}, lang}` (known push services only)
  and `POST /api/push/unsubscribe`.
- Socket: `GET /ws/device?ticket=…`. Frames in `packages/shared/src/hub-protocol.ts`.
- Claude connector: `GET /.well-known/oauth-protected-resource[/mcp]`, `GET /.well-known/oauth-authorization-server`,
  `POST /oauth/register` (only Claude's redirect addresses), `GET /oauth/authorize` (→ the approval page `/connect`),
  `POST /oauth/token` (code + PKCE S256, or refresh), `POST /mcp` (Bearer access token; tools `list_devices`,
  `get_agent_status`, `waiting_for_approval`, `list_tasks`, `send_task`). Signed in: `POST /api/oauth/check`,
  `POST /api/oauth/decide`, `POST /api/connections/:id/revoke`.
- Page: `GET /api/config` → `{googleClientId, vapidPublicKey}` (public; the key is empty until all three VAPID values are set).
- Signed in (cookie, same origin): `GET /api/state`, `POST /api/signout`, `POST /api/pair/check` `{code}` (the
  fingerprint, before approving), `POST /api/pair/approve` `{code, name}`,
  `POST /api/devices/:id/revoke`, `POST /api/kill` `{what: pause|resume|cloud-off|cloud-on|drop-queue|everything}`.

Live chat with a PC does not go through the hub; it stays on the direct links KesherAI already has.

## For developers
- Code: `src/hub.ts` (all logic, as a plain class), `src/hub-do.ts` (the Durable Object), `src/worker.ts` (entry),
  `src/sql-store.ts` / `src/store.ts` (storage), `src/google.ts`, `src/claude-cloud.ts`, `src/rate-limit.ts`,
  `src/oauth.ts`, `src/mcp.ts`, `src/connector.ts` (the Claude connector), `src/web-push.ts` (Web Push on WebCrypto; subscriptions are kept in settings as `push:<device id>`). The
  protocol, sealing and routing are shared with the PC and the phone in `packages/shared/src/hub*.ts` (imported by
  path, so the Worker needs no install step).
- The page: `page/*.ts` (no framework), compiled with the shared hub code into `public/js` by
  `pnpm --filter @kesher/hub build:page`; the output is committed, so Workers Builds needs no build step (a test checks
  it is current). `public/_headers` carries the same CSP as the API.
- Checks from the repo root: `pnpm --filter @kesher/hub typecheck`, and
  `node --conditions=source --import tsx --test --test-force-exit apps/hub/src/*.test.ts`.
- With the Wrangler CLI, `npx wrangler dev` runs it locally and `npx wrangler deploy` deploys; secrets with
  `npx wrangler secret put NAME`.
