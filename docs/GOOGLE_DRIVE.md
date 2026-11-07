# Google Drive sign-in

"Connect Google Drive" in **Settings** saves projects and conversations in a `KesherAI` folder in the user's Drive and loads them on their other computers. It asks only for the `drive.file` permission, which lets KesherAI see and change the files it created — never the rest of the user's Drive.

Google requires every app that signs users in to have its own **OAuth client**. You create it once:

- **As the KesherAI maintainer or a fork:** create the client and put its id and secret in `packages/shared/src/branding.config.ts` → `google`. Every user then just clicks **Connect Google Drive**.
- **As a user of a build without a client:** create your own and paste it in Settings → Google Drive. It is used only on your computer.

It takes about five minutes and is free.

## 1. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Project menu (top left) → **New project** → name it `KesherAI` → **Create**.

## 2. Turn on the Drive API

**APIs & Services → Library** → search for **Google Drive API** → **Enable**.

## 3. Set up the consent screen

**APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding**).

1. **User type:** External.
2. **App name:** KesherAI. **Support email** and **developer contact:** your email.
3. **Scopes** (Data Access): add `.../auth/drive.file`. It is listed as non-sensitive, so Google does not need to review the app for it.
4. **Audience / Publishing status:**
   - While testing, add your own Google account under **Test users**. In Testing mode, sign-ins expire after 7 days and only test users can connect.
   - For everyone, press **Publish app** (move to Production). With only `drive.file`, users may see a short "Google hasn't verified this app" notice until you complete Google's brand verification; they can continue past it.

## 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- **Application type: Desktop app** (this is what allows the `http://127.0.0.1` redirect KesherAI uses).
- Name: `KesherAI desktop`.

Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**.

A desktop client's secret is not truly secret — Google's documentation says it is expected to ship inside installed apps — so it is fine to commit it to `branding.config.ts`. KesherAI also uses PKCE, which is what actually protects the sign-in.

## 5. Use it

Paste both into `branding.config.ts` (for everyone) or Settings → Google Drive (just you), then **Connect Google Drive**. A browser window opens, you approve, and the page tells you it is connected.

## How syncing works

- Every save uploads that project or conversation to Drive about two seconds later.
- On start-up, and when you press **Sync now**, KesherAI downloads anything newer in Drive and uploads anything newer here. The newer `updatedAt` wins per item.
- Deleting a conversation moves its Drive file to the Drive trash (recoverable for 30 days).
- **Disconnect** revokes KesherAI's access at Google and forgets the token. Files already in Drive stay there.
- The sign-in token is stored in `~/.kesher/config.json` (readable only by you). Sign-in can only be started from the computer that runs KesherAI, because Google sends the browser back to `127.0.0.1`.
