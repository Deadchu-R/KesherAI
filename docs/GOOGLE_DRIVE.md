# Google Drive sign-in

"Connect Google Drive" in **Settings** saves projects and conversations in a `KesherAI` folder in the user's Drive and loads them on their other computers. It asks only for the `drive.file` permission, which lets KesherAI see and change the files it created — never the rest of the user's Drive.

Google requires every app that signs users in to have its own **OAuth client**. You create it once:

- **As the KesherAI maintainer or a fork:** create the client and add its id and secret as repository secrets `KESHER_GOOGLE_CLIENT_ID` and `KESHER_GOOGLE_CLIENT_SECRET` (GitHub → Settings → Secrets and variables → Actions). The release workflow puts them into the app; they never appear in the source (GitHub's push protection blocks them there). Every user of a release then just clicks **Connect**. When running from source, set the same two environment variables.
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

## Gmail and Google Calendar

The same sign-in also connects Gmail and Calendar, from **Connections → Tools from other apps**. Each asks Google only when the user clicks it (incremental consent), and only the permissions ticked on Google's page are used.

| Service | Permissions | What models can do |
| --- | --- | --- |
| Gmail | `gmail.readonly`, `gmail.compose` | Search and read mail; write **drafts** (never send) |
| Calendar | `calendar.events` | List events; add an event (guests are not emailed) |
| Drive files | `drive.readonly` | Search and read the user's files (Docs as text, Sheets as CSV); create new Docs (through `drive.file`) |

Reading runs directly; writing a draft or adding an event shows an approval card first.

To offer them, also do this once in the same Google Cloud project:

1. **APIs & Services → Library:** enable **Gmail API** and **Google Calendar API**.
2. **Data Access (scopes):** add the scopes above.
3. Google treats `calendar.events` as *sensitive* and the Gmail scopes as *restricted*. Until Google verifies the app (for restricted scopes this includes a paid security assessment), users see a "Google hasn't verified this app" page and at most 100 people can connect. For personal use and testing that is fine: press **Advanced → Go to KesherAI**. In Testing mode, add yourself under Test users; note that Testing-mode sign-ins expire after 7 days.

## How syncing works

- Every save uploads that project or conversation to Drive about two seconds later.
- On start-up, and when you press **Sync now**, KesherAI downloads anything newer in Drive and uploads anything newer here. The newer `updatedAt` wins per item.
- Deleting a conversation moves its Drive file to the Drive trash (recoverable for 30 days).
- **Disconnect** revokes KesherAI's access at Google and forgets the token. Files already in Drive stay there.
- The sign-in token is stored in `~/.kesher/config.json` (readable only by you). Sign-in can only be started from the computer that runs KesherAI, because Google sends the browser back to `127.0.0.1`.

## The phone: "Sign in with Google"

The Android app can find your computers by itself: tap **Sign in with Google**, approve in the browser, and it reads `devices.json` from your KesherAI folder in Drive — the computers signed in to the same account with "Let my other devices use this computer" on, with their addresses and access tokens. The sign-in is the installed-app flow (browser → `127.0.0.1` on the phone → PKCE), with the same Desktop OAuth client as the desktop app (the APK workflow writes `www/google-client.json` from the repository secrets `KESHER_GOOGLE_CLIENT_ID` and `KESHER_GOOGLE_CLIENT_SECRET`). The only Drive scope is `drive.file`. The list refreshes each time the app opens, so a changed "anywhere" address is picked up.
