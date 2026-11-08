# OneDrive sign-in

"Connect OneDrive" in **Settings** saves projects and conversations in **OneDrive → Apps → KesherAI** and loads them on the user's other computers. It asks only for `Files.ReadWrite.AppFolder`, which lets KesherAI see and change that one folder — never the rest of the user's OneDrive. It works with personal Microsoft accounts (outlook.com, hotmail.com, live.com) and with work or school accounts.

Microsoft requires every app that signs users in to have its own **application (client) id**. KesherAI signs in as a *public client* with PKCE, so there is **no secret**: the id is not confidential and can be written straight into the source.

- **As the KesherAI maintainer or a fork:** register the app once and put its id in `packages/shared/src/branding.config.ts` (`onedrive.clientId`). Every user of a release then just clicks **Connect OneDrive**. When running from source you can set `KESHER_ONEDRIVE_CLIENT_ID` instead.
- **As a user of a build without an id:** register your own and paste it in Settings → OneDrive. It is used only on your computer.

It takes about five minutes and is free.

> No OneDrive sign-in? **Settings → Sync folder** already backs up to the OneDrive folder on your computer with one click, with no account or app registration.

## 1. Open App registrations

1. Open [entra.microsoft.com](https://entra.microsoft.com) (or [portal.azure.com](https://portal.azure.com) → search **App registrations**) and sign in with your Microsoft account.
2. **Identity → Applications → App registrations → New registration.**

Registering an app needs no Azure subscription. If the site asks for a payment card or a paid subscription, stop: you do not need it for this.

## 2. Register KesherAI

- **Name:** `KesherAI`
- **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts* (so outlook.com accounts can sign in).
- **Redirect URI:** platform **Public client/native (mobile & desktop)**, value:

  ```
  http://localhost/api/onedrive/callback
  ```

  Microsoft ignores the port for `localhost`, so this works whatever port KesherAI runs on.

Press **Register**.

## 3. Copy the id

On the app's **Overview** page, copy **Application (client) ID** (it looks like `0a1b2c3d-4e5f-…`). That is all KesherAI needs.

You do not need to add a client secret or certificate, and you do not need to add API permissions by hand: KesherAI asks for them when the user signs in (`Files.ReadWrite.AppFolder`, `User.Read`, `offline_access`, `openid`, `email`, `profile`).

## 4. Use it

- **Maintainer:** put the id in `branding.config.ts` → `onedrive: { clientId: "…" }` and release.
- **User:** KesherAI → **Settings → OneDrive** → paste the id → **Save** → **Connect OneDrive**.

The browser opens Microsoft's sign-in page; after you accept, it returns to KesherAI and the first sync starts. Sign-in starts only on the computer that runs KesherAI, because Microsoft sends the browser back to `localhost`.

## How the sync works

- Each project and conversation is a file `projects/<id>.json` or `conversations/<id>.json` in the app folder.
- Every save is uploaded about two seconds later. **Sync now** brings both sides up to date; the newer one wins.
- A deleted item goes to the OneDrive recycle bin, so it can be restored.
- **Disconnect** forgets the sign-in on this computer. To remove KesherAI's access completely, open [account.live.com/consent/Manage](https://account.live.com/consent/Manage) (personal accounts) or [myapps.microsoft.com](https://myapps.microsoft.com) (work or school accounts).
