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
  approvals 30 minutes). An activity log with event type, device id and time only (30 days).
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

## Kill switches
1. **Pause hub** (hub page): stops routing and closes every device connection; data kept.
2. **Sign out everywhere and revoke all devices** (hub page).
3. **Claude path:** switch it off on the hub page, or delete the scheduled task's token at claude.ai (fires stop at once).
4. **Whole hub:** set `HUB_DISABLED` to `1`, or disable the Worker in the Cloudflare dashboard.

## The hub's API (for the KesherAI clients)
- Open, rate limited: `POST /api/signin` `{credential}` (Google ID token, from the hub page only), `POST /api/pair/start`
  `{publicKey, kind, name}` → `{code, pollSecret, expiresIn, fingerprint}`, `POST /api/pair/poll` `{pollSecret}` →
  `pending` or `{deviceId, token, hubKey}` once.
- Device token (`Authorization: Bearer kh_…`): `POST /api/ticket` → a one-use 60-second `ticket` (and `rotateDue`
  after 30 days), `POST /api/rotate` → a new token (the old one stops at once). Tokens older than 180 days are refused.
- Socket: `GET /ws/device?ticket=…`. Frames in `packages/shared/src/hub-protocol.ts`.
- Signed in (cookie, same origin): `GET /api/state`, `POST /api/signout`, `POST /api/pair/approve` `{code, name}`,
  `POST /api/devices/:id/revoke`, `POST /api/kill` `{what: pause|resume|cloud-off|cloud-on|drop-queue|everything}`.

Live chat with a PC does not go through the hub; it stays on the direct links KesherAI already has.

## For developers
- Code: `src/hub.ts` (all logic, as a plain class), `src/hub-do.ts` (the Durable Object), `src/worker.ts` (entry),
  `src/sql-store.ts` / `src/store.ts` (storage), `src/google.ts`, `src/claude-cloud.ts`, `src/rate-limit.ts`. The
  protocol, sealing and routing are shared with the PC and the phone in `packages/shared/src/hub*.ts` (imported by
  path, so the Worker needs no install step).
- Checks from the repo root: `pnpm --filter @kesher/hub typecheck`, and
  `node --conditions=source --import tsx --test --test-force-exit apps/hub/src/*.test.ts`.
- With the Wrangler CLI, `npx wrangler dev` runs it locally and `npx wrangler deploy` deploys; secrets with
  `npx wrangler secret put NAME`.
